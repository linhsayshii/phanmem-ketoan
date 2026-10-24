import ExcelJS from 'exceljs';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { moneyCell } from '../reporting/print/excel.js';

type Trx = Transaction<Database>;
export interface ReconQuery { bankAccountId: number; from: string; to: string }
export interface ReconReport {
  bankAccountId: number; accountNo: string; glAccountCode: string; currency: string; from: string; to: string;
  ledgerOpening: string; ledgerClosing: string; statementBalance: string | null; statementBalanceDate: string | null; difference: string | null;
  unmatchedTransactions: { id: number; valueDate: string; amountIn: string; amountOut: string; description: string | null; reference: string | null; counterName: string | null }[];
  unmatchedLedgerLines: { voucherId: string; voucherNo: string | null; voucherType: string; postingDate: string; description: string | null; debit: string; credit: string }[];
}

// Đối chiếu sổ phụ: số dư sổ cái của tài khoản ngân hàng (chứng từ đã ghi sổ hoặc đã đảo) so với số dư cuối kỳ trên sao kê, kèm hai danh sách chênh.
export async function bankReconciliation(trx: Trx, q: ReconQuery): Promise<ReconReport> {
  const ba = await trx.selectFrom('bank_account').select(['id', 'account_no', 'gl_account_code', 'currency_code']).where('id', '=', q.bankAccountId).executeTakeFirst();
  if (!ba) throw new AppError('BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng', 404);
  const vnd = ba.currency_code === 'VND';
  const dp = vnd ? 0 : 4;
  // Dòng chưa ghi tài khoản ngân hàng (ví dụ số dư đầu kỳ) tính cho tài khoản ngân hàng duy nhất của tài khoản kế toán đó.
  const sole = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM bank_account WHERE gl_account_code = ${ba.gl_account_code}`.execute(trx)).rows[0]!.n === 1;
  const scope = sql`l.account_id IN (SELECT id FROM account WHERE code = ${ba.gl_account_code}) AND v.state IN ('posted', 'reversed') AND l.currency_code = ${ba.currency_code}
    AND (l.bank_account_id = ${ba.id} ${sole ? sql`OR l.bank_account_id IS NULL` : sql``})`;
  const net = vnd ? sql`l.debit - l.credit` : sql`l.amount_currency`;
  const bal = await sql<{ opening: string; closing: string }>`SELECT coalesce(sum(${net}) FILTER (WHERE l.posting_date < ${q.from}::date), 0)::text AS opening,
      coalesce(sum(${net}) FILTER (WHERE l.posting_date <= ${q.to}::date), 0)::text AS closing
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE ${scope}`.execute(trx);
  const st = await sql<{ balance: string; value_date: string }>`SELECT balance_after::text AS balance, value_date::text FROM bank_transaction
    WHERE bank_account_id = ${ba.id} AND value_date <= ${q.to}::date AND balance_after IS NOT NULL ORDER BY value_date DESC, txn_time DESC NULLS LAST, id DESC LIMIT 1`.execute(trx);
  const txns = await sql<ReconReport['unmatchedTransactions'][number]>`SELECT id, value_date::text AS "valueDate", amount_in::text AS "amountIn", amount_out::text AS "amountOut", description, reference, counter_name AS "counterName"
    FROM bank_transaction WHERE bank_account_id = ${ba.id} AND status = 'new' AND value_date BETWEEN ${q.from}::date AND ${q.to}::date ORDER BY value_date, id`.execute(trx);
  const lines = await sql<ReconReport['unmatchedLedgerLines'][number]>`SELECT v.id AS "voucherId", v.voucher_no AS "voucherNo", v.voucher_type AS "voucherType", l.posting_date::text AS "postingDate",
      coalesce(l.description, v.description) AS description, ${vnd ? sql`l.debit` : sql`greatest(l.amount_currency, 0)`}::text AS debit, ${vnd ? sql`l.credit` : sql`greatest(-l.amount_currency, 0)`}::text AS credit
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    WHERE ${scope} AND l.posting_date BETWEEN ${q.from}::date AND ${q.to}::date
      AND NOT EXISTS (SELECT 1 FROM bank_transaction x WHERE x.tenant_id = v.tenant_id AND x.voucher_id = v.id)
    ORDER BY l.posting_date, v.voucher_no, l.line_no`.execute(trx);
  const closing = D(bal.rows[0]!.closing).toFixed(dp);
  const s = st.rows[0];
  return { bankAccountId: ba.id, accountNo: ba.account_no, glAccountCode: ba.gl_account_code, currency: ba.currency_code, from: q.from, to: q.to,
    ledgerOpening: D(bal.rows[0]!.opening).toFixed(dp), ledgerClosing: closing,
    statementBalance: s ? D(s.balance).toFixed(dp) : null, statementBalanceDate: s?.value_date ?? null, difference: s ? D(s.balance).minus(closing).toFixed(dp) : null,
    unmatchedTransactions: txns.rows, unmatchedLedgerLines: lines.rows };
}

export async function reconXlsx(r: ReconReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const scale = r.currency === 'VND' ? 0 : 4;
  const fmt = scale ? `#,##0.${'0'.repeat(scale)};[Red]-#,##0.${'0'.repeat(scale)}` : '#,##0;[Red]-#,##0';
  const num = (v: string | null) => moneyCell(v, scale); // chuỗi thập phân thành ô số chỉ khi không mất chữ số, như các báo cáo khác
  const s = wb.addWorksheet('Tổng hợp');
  s.addRows([['Đối chiếu sổ phụ ngân hàng'], ['Tài khoản ngân hàng', r.accountNo], ['Tài khoản kế toán', r.glAccountCode], ['Từ ngày', r.from], ['Đến ngày', r.to],
    ['Số dư đầu kỳ sổ cái', num(r.ledgerOpening)], ['Số dư cuối kỳ sổ cái', num(r.ledgerClosing)], ['Số dư theo sao kê', r.statementBalance === null ? 'Chưa có' : num(r.statementBalance)], ['Ngày số dư sao kê', r.statementBalanceDate ?? ''], ['Chênh lệch (sao kê trừ sổ cái)', num(r.difference)]]);
  for (const row of [6, 7, 8, 10]) { const c = s.getCell(row, 2); c.numFmt = fmt; c.alignment = { horizontal: 'right' }; }
  s.getColumn(1).width = 34; s.getColumn(2).width = 24; s.getRow(1).font = { bold: true };
  const t = wb.addWorksheet('Giao dịch chưa đối chiếu');
  t.addRow(['Ngày', 'Số tiền vào', 'Số tiền ra', 'Diễn giải', 'Số tham chiếu', 'Đối tác']).font = { bold: true };
  for (const x of r.unmatchedTransactions) t.addRow([x.valueDate, num(x.amountIn), num(x.amountOut), x.description, x.reference, x.counterName]);
  const l = wb.addWorksheet('Dòng sổ cái không có giao dịch');
  l.addRow(['Ngày', 'Loại', 'Số chứng từ', 'Diễn giải', 'Nợ', 'Có']).font = { bold: true };
  for (const x of r.unmatchedLedgerLines) l.addRow([x.postingDate, x.voucherType, x.voucherNo, x.description, num(x.debit), num(x.credit)]);
  for (const [w, cols] of [[t, [2, 3]], [l, [5, 6]]] as const) { w.columns.forEach((c) => { c.width = 22; }); for (const k of cols) { const c = w.getColumn(k); c.numFmt = fmt; c.alignment = { horizontal: 'right' }; } }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
