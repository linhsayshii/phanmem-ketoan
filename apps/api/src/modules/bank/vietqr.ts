import QRCode from 'qrcode';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, todayVn, vietQrPayload, vietQrContent } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { assertSensitive } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
export interface VietQrAccount { bin: string; accountNo: string; accountName: string | null; bankName: string }

// Tài khoản nhận tiền của công ty: tài khoản ngân hàng đang dùng, VND, ngân hàng đã khai BIN NAPAS, nhỏ số nhất (chưa có cờ "mặc định" riêng).
export async function defaultVietQrAccount(trx: Trx): Promise<VietQrAccount | null> {
  const r = await trx.selectFrom('bank_account as a').innerJoin('bank as b', 'b.id', 'a.bank_id')
    .select(['b.napas_bin', 'b.short_name', 'b.name', 'a.account_no', 'a.account_name'])
    .where('a.is_active', '=', true).where('a.currency_code', '=', 'VND').where('b.napas_bin', 'is not', null).orderBy('a.id').executeTakeFirst();
  return r ? { bin: r.napas_bin!, accountNo: r.account_no, accountName: r.account_name, bankName: r.short_name ?? r.name } : null;
}

export const noQrAccount = () => new AppError('QR_NO_BANK_ACCOUNT', 'Chưa có tài khoản ngân hàng VND nào của công ty có BIN NAPAS; khai BIN ở danh mục Ngân hàng', 409);

export async function qrSvg(payload: string): Promise<string> { return QRCode.toString(payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); }

// Mã QR thanh toán cho hóa đơn bán đã ghi sổ: số tiền = dư còn phải thu (sau đối trừ) của các khoản công nợ phải thu phát sinh từ chứng từ.
export async function voucherQr(trx: Trx, auth: { sensitive: Set<string> }, voucherId: string) {
  const v = await trx.selectFrom('voucher').select(['id', 'voucher_no', 'voucher_type', 'state']).where('id', '=', voucherId).executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  if (!['HDB', 'BH'].includes(v.voucher_type) || v.state !== 'posted') throw new AppError('QR_VOUCHER_STATE', 'Chỉ lập mã QR cho hóa đơn bán (HDB, BH) đã ghi sổ', 409);
  const items = (await sql<{ code: string; subledger_kind: string | null; residual: string; doc_no: string | null }>`SELECT a.code, a.subledger_kind, o.doc_no,
      (o.amount - coalesce((SELECT sum(s.amount) FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.debit_item_id = o.id), 0)
        + coalesce((SELECT sum(s.amount) FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.credit_item_id = o.id), 0))::text AS residual
    FROM open_item o JOIN account a ON a.id = o.account_id WHERE o.voucher_id = ${voucherId}::uuid AND a.subledger_kind = 'receivable'`.execute(trx)).rows;
  for (const i of items) assertSensitive(auth, i);
  const amount = items.reduce((t, i) => t.plus(i.residual), D(0));
  if (amount.lte(0)) throw new AppError('QR_NOTHING_DUE', 'Hóa đơn không còn khoản phải thu', 409);
  const acc = await defaultVietQrAccount(trx);
  if (!acc) throw noQrAccount();
  const inv = await trx.selectFrom('voucher_invoice').select('invoice_no').where('voucher_id', '=', voucherId).where('invoice_no', 'is not', null).orderBy('id').executeTakeFirst();
  const content = vietQrContent(`${inv?.invoice_no ?? v.voucher_no ?? ''}`);
  const amt = amount.toFixed(0);
  return { payload: vietQrPayload({ bin: acc.bin, accountNo: acc.accountNo, amount: amt, content }), bankName: acc.bankName, accountNo: acc.accountNo, accountName: acc.accountName, amount: amt, content, asOf: todayVn() };
}
