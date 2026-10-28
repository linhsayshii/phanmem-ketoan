import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, sum } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { accountsUnder, generalJournal, openingNet, type Side } from './ledgers.js';

// Hình thức sổ là lớp trình bày: mọi hàm ở đây chỉ ĐỌC voucher_line/voucher_pair; chỉ fiscal_year_setting và ledger_voucher_set* được ghi.
type Trx = Transaction<Database>;
export const BOOK_FORMS = ['NKC', 'CTGS', 'NKSC', 'NKCT'] as const;
export type BookForm = (typeof BOOK_FORMS)[number];
const POSTED = sql`v.state IN ('posted','reversed')`;
const side = (net: ReturnType<typeof D>): Side => ({ debit: net.gt(0) ? net.toString() : '0', credit: net.lt(0) ? net.neg().toString() : '0' });

export async function getBookForm(trx: Trx, year: number): Promise<BookForm> {
  const r = await trx.selectFrom('fiscal_year_setting').select('book_form').where('fiscal_year', '=', year).executeTakeFirst();
  return (r?.book_form ?? 'NKC') as BookForm;
}
export async function setBookForm(trx: Trx, tenantId: string, year: number, form: BookForm): Promise<void> {
  if (!(await trx.selectFrom('fiscal_period').select('fiscal_year').where('fiscal_year', '=', year).executeTakeFirst())) throw new AppError('PERIOD_NOT_FOUND', `Không có năm tài chính ${year}`, 404);
  await trx.insertInto('fiscal_year_setting').values({ tenant_id: tenantId, fiscal_year: year, book_form: form })
    .onConflict((oc) => oc.columns(['tenant_id', 'fiscal_year']).doUpdateSet({ book_form: form, updated_at: sql`now()` })).execute();
}

// ---- Nhật ký – Sổ Cái: các dòng như Nhật ký chung kèm cộng phát sinh theo từng tài khoản ----
export async function nksc(trx: Trx, f: { from: string; to: string }) {
  const j = await generalJournal(trx, f);
  const by = new Map<string, { accountCode: string; accountName: string; debit: string; credit: string }>();
  for (const r of j.rows) { const a = by.get(r.accountCode) ?? { accountCode: r.accountCode, accountName: r.accountName, debit: '0', credit: '0' }; a.debit = D(a.debit).plus(r.debit).toString(); a.credit = D(a.credit).plus(r.credit).toString(); by.set(r.accountCode, a); }
  return { rows: j.rows, accounts: [...by.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode)), totalDebit: j.totalDebit, totalCredit: j.totalCredit };
}

// ---- Nhật ký – Chứng từ theo bên Có của một tài khoản: mỗi cột là một tài khoản Nợ đối ứng ----
export async function nkctCreditAccounts(trx: Trx, regime: string, f: { from: string; to: string }): Promise<string[]> {
  const r = await sql<{ code: string }>`SELECT DISTINCT ac.code FROM voucher_pair p JOIN voucher v ON v.id = p.voucher_id JOIN account ac ON ac.id = p.credit_account_id
    WHERE ${POSTED} AND p.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND ac.regime = ${regime} ORDER BY ac.code`.execute(trx);
  return r.rows.map((x) => x.code);
}
export async function nkct(trx: Trx, regime: string, f: { from: string; to: string; creditAccountCode: string }) {
  const acc = (await accountsUnder(trx, regime, f.creditAccountCode)).find((a) => a.code === f.creditAccountCode)!;
  const pairs = (await sql<{ voucherId: string; postingDate: string; voucherNo: string; description: string | null; debitCode: string; amount: string }>`
    SELECT v.id AS "voucherId", p.posting_date AS "postingDate", v.voucher_no AS "voucherNo", v.description, ad.code AS "debitCode", p.amount::text AS amount
    FROM voucher_pair p JOIN voucher v ON v.id = p.voucher_id JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
    WHERE ${POSTED} AND p.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND ad.regime = ${regime} AND ac.regime = ${regime} AND starts_with(ac.code, ${f.creditAccountCode})
    ORDER BY p.posting_date, v.voucher_type, v.seq_no, v.id, ad.code`.execute(trx)).rows;
  const rows = new Map<string, { voucherId: string; postingDate: string; voucherNo: string; description: string | null; amounts: Record<string, string>; total: string }>();
  const totals: Record<string, string> = {};
  for (const p of pairs) {
    const r = rows.get(p.voucherId) ?? { voucherId: p.voucherId, postingDate: p.postingDate, voucherNo: p.voucherNo, description: p.description, amounts: {}, total: '0' };
    r.amounts[p.debitCode] = D(r.amounts[p.debitCode] ?? '0').plus(p.amount).toString(); r.total = D(r.total).plus(p.amount).toString(); rows.set(p.voucherId, r);
    totals[p.debitCode] = D(totals[p.debitCode] ?? '0').plus(p.amount).toString();
  }
  return { creditAccountCode: f.creditAccountCode, creditAccountName: acc.name, debitAccounts: Object.keys(totals).sort(), rows: [...rows.values()], totals, total: sum(Object.values(totals)).toString() };
}

// ---- Chứng từ ghi sổ ----
export interface VoucherSetInput { fiscalYear: number; setDate: string; description: string; dateFrom: string; dateTo: string; voucherType?: string | undefined }
export async function createVoucherSet(trx: Trx, tenantId: string, userId: string, i: VoucherSetInput) {
  const ps = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to']).where('fiscal_year', '=', i.fiscalYear).where('period_no', '>=', 1).orderBy('period_no').execute();
  if (!ps.length) throw new AppError('PERIOD_NOT_FOUND', `Không có năm tài chính ${i.fiscalYear}`, 404);
  if (i.dateTo < i.dateFrom) throw new AppError('VALIDATION', 'Từ ngày phải trước hoặc bằng đến ngày', 400);
  if (i.dateFrom < ps[0]!.date_from || i.dateTo > ps.at(-1)!.date_to) throw new AppError('VALIDATION', 'Khoảng ngày phải nằm trong năm tài chính', 400);
  await sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId + ':ctgs:' + i.fiscalYear}))`.execute(trx);
  const ids = (await sql<{ id: string }>`SELECT v.id FROM voucher v WHERE ${POSTED} AND v.posting_date BETWEEN ${i.dateFrom}::date AND ${i.dateTo}::date
    ${i.voucherType ? sql`AND v.voucher_type = ${i.voucherType}` : sql``} AND NOT EXISTS (SELECT 1 FROM ledger_voucher_set_item x WHERE x.voucher_id = v.id)`.execute(trx)).rows.map((r) => r.id);
  if (!ids.length) throw new AppError('NO_VOUCHERS', 'Không có chứng từ đã ghi sổ nào chưa vào Chứng từ ghi sổ trong khoảng ngày này', 409);
  const next = (await sql<{ n: number }>`SELECT coalesce(max(set_no), 0) + 1 AS n FROM ledger_voucher_set WHERE fiscal_year = ${i.fiscalYear}`.execute(trx)).rows[0]!.n;
  const set = await trx.insertInto('ledger_voucher_set').values({ tenant_id: tenantId, fiscal_year: i.fiscalYear, set_no: next, set_date: i.setDate, description: i.description, date_from: i.dateFrom, date_to: i.dateTo, voucher_type: i.voucherType ?? null, created_by: userId }).returning(['id', 'set_no']).executeTakeFirstOrThrow();
  await trx.insertInto('ledger_voucher_set_item').values(ids.map((voucher_id) => ({ tenant_id: tenantId, set_id: set.id, voucher_id }))).execute();
  return { id: set.id, setNo: set.set_no, vouchers: ids.length };
}
export async function deleteVoucherSet(trx: Trx, id: number): Promise<void> {
  const r = await trx.deleteFrom('ledger_voucher_set').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw new AppError('VOUCHER_SET_NOT_FOUND', 'Không có Chứng từ ghi sổ này', 404);
}
// Sổ đăng ký Chứng từ ghi sổ: theo ngày Chứng từ ghi sổ; số tiền = tổng phát sinh Nợ của các chứng từ gốc trong đó.
export async function voucherSetRegister(trx: Trx, f: { from: string; to: string; fiscalYear?: number | undefined }) {
  const rows = (await sql<{ id: number; fiscalYear: number; setNo: number; setDate: string; description: string; dateFrom: string; dateTo: string; vouchers: number; amount: string }>`
    SELECT s.id, s.fiscal_year AS "fiscalYear", s.set_no AS "setNo", s.set_date AS "setDate", s.description, s.date_from AS "dateFrom", s.date_to AS "dateTo", count(DISTINCT v.id)::int AS vouchers, coalesce(sum(l.debit), 0)::text AS amount
    FROM ledger_voucher_set s LEFT JOIN ledger_voucher_set_item i ON i.set_id = s.id LEFT JOIN voucher v ON v.id = i.voucher_id AND ${POSTED} LEFT JOIN voucher_line l ON l.voucher_id = v.id
    WHERE s.set_date BETWEEN ${f.from}::date AND ${f.to}::date ${f.fiscalYear === undefined ? sql`` : sql`AND s.fiscal_year = ${f.fiscalYear}`}
    GROUP BY s.id ORDER BY s.set_date, s.fiscal_year, s.set_no`.execute(trx)).rows;
  return { rows, total: sum(rows.map((r) => r.amount)).toString() };
}
// Chứng từ ghi sổ (S02a): từng cặp Nợ/Có của các chứng từ gốc trong nhóm.
export async function voucherSetDetail(trx: Trx, id: number) {
  const s = await trx.selectFrom('ledger_voucher_set').selectAll().where('id', '=', id).executeTakeFirst();
  if (!s) throw new AppError('VOUCHER_SET_NOT_FOUND', 'Không có Chứng từ ghi sổ này', 404);
  const rows = (await sql<{ voucherId: string; voucherNo: string; documentDate: string; description: string | null; debitCode: string; creditCode: string; amount: string }>`
    SELECT v.id AS "voucherId", v.voucher_no AS "voucherNo", v.document_date AS "documentDate", v.description, ad.code AS "debitCode", ac.code AS "creditCode", p.amount::text AS amount
    FROM ledger_voucher_set_item i JOIN voucher v ON v.id = i.voucher_id JOIN voucher_pair p ON p.voucher_id = v.id JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
    WHERE i.set_id = ${id} AND ${POSTED} ORDER BY p.posting_date, v.voucher_type, v.seq_no, v.id, p.id`.execute(trx)).rows;
  return { id: s.id, fiscalYear: s.fiscal_year, setNo: s.set_no, setDate: s.set_date, description: s.description, dateFrom: s.date_from, dateTo: s.date_to, rows, total: sum(rows.map((r) => r.amount)).toString() };
}
export async function listVoucherSets(trx: Trx, fiscalYear: number) {
  return voucherSetRegister(trx, { from: '1900-01-01', to: '2999-12-31', fiscalYear });
}
// Sổ Cái theo hình thức CTGS (S02c1): chỉ các chứng từ đã vào Chứng từ ghi sổ; dòng ghi theo số/ngày Chứng từ ghi sổ; `unassigned` = số chứng từ trong kỳ chưa vào nhóm nào (sổ thiếu đúng phần đó).
export async function ctgsLedger(trx: Trx, tenantId: string, regime: string, f: { accountCode: string; from: string; to: string }) {
  const acc = (await accountsUnder(trx, regime, f.accountCode)).find((a) => a.code === f.accountCode)!;
  const opening = await openingNet(trx, tenantId, regime, f.accountCode, f.from);
  const rows = (await sql<{ setId: number; setNo: number; setDate: string; fiscalYear: number; voucherNo: string; postingDate: string; description: string | null; counterAccountCode: string; debit: string; credit: string }>`
    WITH pr AS (SELECT p.voucher_id, p.posting_date, ad.code AS dcode, ac.code AS ccode, p.amount, p.id AS pid FROM voucher_pair p JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
      WHERE p.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND ad.regime = ${regime} AND ac.regime = ${regime} AND (starts_with(ad.code, ${f.accountCode}) OR starts_with(ac.code, ${f.accountCode})))
    SELECT s.id AS "setId", s.set_no AS "setNo", s.set_date AS "setDate", s.fiscal_year AS "fiscalYear", v.voucher_no AS "voucherNo", x.posting_date AS "postingDate", v.description, x.counter AS "counterAccountCode", x.debit::text AS debit, x.credit::text AS credit
    FROM (SELECT voucher_id, posting_date, ccode AS counter, amount AS debit, 0 AS credit, pid, 0 AS ord FROM pr WHERE starts_with(dcode, ${f.accountCode})
          UNION ALL SELECT voucher_id, posting_date, dcode, 0, amount, pid, 1 FROM pr WHERE starts_with(ccode, ${f.accountCode})) x
    JOIN voucher v ON v.id = x.voucher_id JOIN ledger_voucher_set_item i ON i.voucher_id = v.id JOIN ledger_voucher_set s ON s.id = i.set_id
    WHERE ${POSTED} ORDER BY s.set_date, s.fiscal_year, s.set_no, x.posting_date, v.id, x.pid, x.ord`.execute(trx)).rows;
  const unassigned = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher v WHERE ${POSTED} AND v.posting_date BETWEEN ${f.from}::date AND ${f.to}::date
    AND NOT EXISTS (SELECT 1 FROM ledger_voucher_set_item x WHERE x.voucher_id = v.id)`.execute(trx)).rows[0]!.n;
  const totalDebit = sum(rows.map((r) => r.debit)); const totalCredit = sum(rows.map((r) => r.credit));
  return { accountCode: f.accountCode, accountName: acc.name, opening: side(opening), rows, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), closing: side(opening.plus(totalDebit).minus(totalCredit)), unassigned };
}
