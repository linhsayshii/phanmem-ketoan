import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, formatVnDate } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';

// Khấu trừ thuế GTGT cuối kỳ: số khấu trừ = min(dư Có 33311, tổng dư Nợ các tài khoản chi tiết 133x) tại ngày chọn; chứng từ KTT Nợ 33311 / Có 1331, rồi 1332 (theo mã) nếu chưa đủ.
// Mỗi ngày một nguồn (source_doc_id = md5('<công ty>:vat_offset:<ngày>')::uuid). Chạy lại cùng ngày: số liệu tính không kể KTT của chính ngày đó (gốc và bản đảo cùng nguồn);
// trùng hệt KTT đang hiệu lực thì không chạm sổ, khác thì đảo cũ cùng ngày rồi sinh mới, như phân bổ và tỷ giá xuất quỹ. KTT là chứng từ hệ thống: không bỏ ghi sổ/hủy được (0030).
type Trx = Transaction<Database>;
export const offsetInput = z.object({ date: S.dateIso });
const OUTPUT = '33311';

export async function runVatOffset(trx: Trx, ctx: { tenantId: string; userId: string; canBackdate: boolean }, input: z.infer<typeof offsetInput>) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('vat_offset'), hashtext(${ctx.tenantId}::text))`.execute(trx);
  const { date } = input;
  const p = await trx.selectFrom('fiscal_period').select(['regime', 'status']).where('date_from', '<=', date).where('date_to', '>=', date).where('period_no', '>', 0).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ kế toán chứa ngày ${formatVnDate(date)}`, 404);
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ chứa ngày ${formatVnDate(date)} đã khóa cứng: không khấu trừ thuế`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ chứa ngày ${formatVnDate(date)} đã khóa sổ, cần quyền ghi lùi ngày`, 409);
  const sourceId = (await sql<{ id: string }>`SELECT md5(${`${ctx.tenantId}:vat_offset:${date}`})::uuid::text AS id`.execute(trx)).rows[0]!.id;

  const bal = (await sql<{ code: string; balance: string }>`
    SELECT a.code, coalesce(sum(l.debit - l.credit), 0)::text AS balance
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${date}::date AND a.regime = ${p.regime} AND (a.code = ${OUTPUT} OR (a.code LIKE '133%' AND NOT a.is_group))
      AND NOT coalesce(v.source_doc_type = 'vat_offset' AND v.source_doc_id = ${sourceId}::uuid, false)
    GROUP BY a.code ORDER BY a.code`.execute(trx)).rows;
  const output = D(bal.find((b) => b.code === OUTPUT)?.balance ?? 0).neg(); // dư Có
  const inputs = bal.filter((b) => b.code !== OUTPUT && D(b.balance).gt(0));
  const amount = Decimal.max(0, Decimal.min(output, inputs.reduce((s, b) => s.plus(b.balance), D(0))));

  const description = `Khấu trừ thuế GTGT đến ngày ${formatVnDate(date)}`;
  const lines: { accountCode: string; debit: string; credit: string; description: string }[] = [];
  if (amount.gt(0)) {
    lines.push({ accountCode: OUTPUT, debit: amount.toFixed(0), credit: '0', description });
    let left = amount;
    for (const b of inputs) {
      if (left.isZero()) break;
      const take = Decimal.min(left, b.balance); left = left.minus(take);
      lines.push({ accountCode: b.code, debit: '0', credit: take.toFixed(0), description });
    }
  }

  const prev = await trx.selectFrom('voucher').select('id').where('source_doc_type', '=', 'vat_offset').where('source_doc_id', '=', sourceId).where('state', '=', 'posted').where('reversal_of_id', 'is', null).execute();
  const active = prev.length ? await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').select(['a.code', 'l.debit', 'l.credit']).where('l.voucher_id', 'in', prev.map((v) => v.id)).execute() : [];
  const key = (x: { code?: string; accountCode?: string; debit: string; credit: string }[]) => x.map((l) => `${l.code ?? l.accountCode}|${D(l.debit).toFixed(0)}|${D(l.credit).toFixed(0)}`).sort().join(';');
  const unchanged = key(active) === key(lines);
  const reversed = unchanged ? [] : prev.map((v) => v.id);
  for (const id of reversed) await S.reverseVoucher(trx, id, { postingDate: date });
  let voucherId: string | null = unchanged ? prev[0]?.id ?? null : null;
  if (!unchanged && lines.length) {
    const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'KTT', postingDate: date, documentDate: date, description, currencyCode: 'VND', lines }, { type: 'vat_offset', id: sourceId });
    await S.postVoucher(trx, v.id);
    voucherId = v.id;
  }
  // KTT của các ngày sau đã tính trên số dư cũ: không tự chạy lại (kỳ sau có thể đã khóa), báo để chạy lại theo thứ tự ngày.
  const laterOffsetDates = (await trx.selectFrom('voucher').select('posting_date').distinct().where('source_doc_type', '=', 'vat_offset').where('state', '=', 'posted').where('reversal_of_id', 'is', null)
    .where('posting_date', '>', date).orderBy('posting_date').execute()).map((r) => r.posting_date);
  const warnings = !unchanged && laterOffsetDates.length ? [`Đã có khấu trừ thuế các ngày sau tính trên số dư cũ: chạy lại khấu trừ thuế theo thứ tự các ngày ${laterOffsetDates.map(formatVnDate).join(', ')}`] : [];
  return { date, amount: amount.toFixed(0), laterOffsetDates, warnings, outputBalance: output.toFixed(0), inputBalances: inputs.map((b) => ({ accountCode: b.code, balance: D(b.balance).toFixed(0) })), voucherId, reversedVoucherIds: reversed, unchanged };
}
