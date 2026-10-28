import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, ZERO } from '@kt/domain';
import { SALARY_HIDDEN, salaryAccountIds, withSalary } from '../payroll/accounts.js';
import { assertSensitive } from '../reporting/ledgers.js';
import { getBudget, isDebitNormal, yearRegime } from './service.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };

// Dòng ngân sách khớp dòng chứng từ: tài khoản bắt đầu bằng tiền tố (cùng hệ tài khoản của kỳ), kỳ 1..12 của năm, chứng từ đã ghi sổ (kể cả đã đảo, bút toán đảo triệt tiêu), bỏ bút toán kết chuyển,
// chiều phân tích (khoản mục phí, bộ phận, dự án) bỏ trống nghĩa là mọi giá trị.
export const matchFrom = (year: number): RawBuilder<unknown> => sql`FROM budget_line bl
  JOIN fiscal_period fp ON fp.fiscal_year = ${year} AND fp.period_no BETWEEN 1 AND 12
  JOIN account a ON a.regime = fp.regime AND starts_with(a.code, bl.account_prefix)
  JOIN voucher_line l ON l.account_id = a.id
  JOIN voucher v ON v.id = l.voucher_id AND v.fiscal_year = fp.fiscal_year AND v.period_no = fp.period_no`;
export const matchWhere: RawBuilder<unknown> = sql`v.state IN ('posted', 'reversed') AND NOT v.is_closing
  AND (bl.cost_item_id IS NULL OR l.cost_item_id = bl.cost_item_id) AND (bl.department_id IS NULL OR l.department_id = bl.department_id) AND (bl.project_id IS NULL OR l.project_id = bl.project_id)`;
// Số phát sinh theo bên bình thường của tài khoản dòng ngân sách.
export const signedAmount: RawBuilder<unknown> = sql`CASE WHEN left(bl.account_prefix, 1) IN ('1', '2', '6', '8') THEN l.debit - l.credit ELSE l.credit - l.debit END`;

// Cờ nhạy cảm che các tài khoản nằm dưới tiền tố của ngân sách (như sổ chi tiết): 403 nếu người dùng không đủ cờ. `skipHidden`: bỏ qua dòng bị che thay vì chặn.
export async function hiddenPrefixes(trx: Trx, auth: Auth, year: number, prefixes: string[]): Promise<Set<string>> {
  const regime = await yearRegime(trx, year);
  const hidden = new Set<string>();
  for (const p of new Set(prefixes)) {
    const accs = withSalary(regime, await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).where(sql<boolean>`starts_with(code, ${p})`).execute());
    try { for (const a of accs) assertSensitive(auth, a); } catch { hidden.add(p); }
  }
  return hidden;
}
export async function assertPrefixesViewable(trx: Trx, auth: Auth, year: number, prefixes: string[]) {
  const regime = await yearRegime(trx, year);
  for (const p of new Set(prefixes)) {
    for (const a of withSalary(regime, await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).where(sql<boolean>`starts_with(code, ${p})`).execute())) assertSensitive(auth, a);
  }
}

// Thực tế từng dòng ngân sách theo tháng 1..12 (chuỗi số nguyên).
export async function actualMatrix(trx: Trx, budgetId: number, year: number): Promise<Map<number, string[]>> {
  const r = await sql<{ line_id: string; period_no: number; amt: string }>`SELECT bl.id::text AS line_id, v.period_no, sum(${signedAmount})::text AS amt ${matchFrom(year)}
    WHERE bl.budget_id = ${budgetId} AND ${matchWhere} GROUP BY bl.id, v.period_no`.execute(trx);
  const out = new Map<number, string[]>();
  for (const x of r.rows) { const m = out.get(Number(x.line_id)) ?? Array<string>(12).fill('0'); m[x.period_no - 1] = x.amt; out.set(Number(x.line_id), m); }
  return out;
}

interface Cell { budget: string; actual: string; diff: string; pct: string | null }
const cell = (budget: string, actual: string): Cell => ({ budget, actual, diff: D(actual).minus(budget).toString(), pct: D(budget).isZero() ? null : D(actual).div(budget).times(100).toDecimalPlaces(1).toString() });
const sumRange = (xs: string[], from: number, to: number) => xs.slice(from, to).reduce((a, x) => a.plus(x), ZERO).toString();

// Báo cáo thực hiện so với ngân sách đến tháng `month`: tháng, lũy kế từ đầu năm, cả năm; chênh lệch = thực tế - ngân sách (dương là vượt với chi phí, vượt kế hoạch với doanh thu).
export async function budgetReport(trx: Trx, auth: Auth, id: number, month: number) {
  const b = await getBudget(trx, id);
  await assertPrefixesViewable(trx, auth, b.fiscalYear, b.lines.map((l) => l.accountPrefix));
  const actual = await actualMatrix(trx, id, b.fiscalYear);
  const tot = { expense: { b: Array<string>(12).fill('0'), a: Array<string>(12).fill('0') }, revenue: { b: Array<string>(12).fill('0'), a: Array<string>(12).fill('0') } };
  const lines = b.lines.map((l) => {
    const a = actual.get(l.id) ?? Array<string>(12).fill('0');
    const t = isDebitNormal(l.accountPrefix) ? tot.expense : tot.revenue;
    for (let i = 0; i < 12; i++) { t.b[i] = D(t.b[i]!).plus(l.months[i]!).toString(); t.a[i] = D(t.a[i]!).plus(a[i]!).toString(); }
    return { lineId: l.id, lineNo: l.lineNo, accountPrefix: l.accountPrefix, costItemCode: l.costItemCode, departmentCode: l.departmentCode, projectCode: l.projectCode, kind: isDebitNormal(l.accountPrefix) ? 'expense' : 'revenue',
      month: cell(l.months[month - 1]!, a[month - 1]!), ytd: cell(sumRange(l.months, 0, month), sumRange(a, 0, month)), year: cell(sumRange(l.months, 0, 12), sumRange(a, 0, 12)),
      months: l.months.map((bm, i) => ({ budget: bm, actual: a[i]! })) };
  });
  const sum = (t: { b: string[]; a: string[] }) => ({ month: cell(t.b[month - 1]!, t.a[month - 1]!), ytd: cell(sumRange(t.b, 0, month), sumRange(t.a, 0, month)), year: cell(sumRange(t.b, 0, 12), sumRange(t.a, 0, 12)),
    months: t.b.map((bm, i) => ({ budget: bm, actual: t.a[i]! })) });
  return { budget: { id: b.id, name: b.name, fiscalYear: b.fiscalYear, version: b.version, status: b.status }, month, lines, totals: { expense: sum(tot.expense), revenue: sum(tot.revenue) } };
}

// Truy ngược: các dòng chứng từ tạo nên số thực tế của một dòng ngân sách (một tháng hoặc cả năm), tối đa 500 dòng.
export const DRILL_LIMIT = 500;
export async function budgetDrill(trx: Trx, auth: Auth, id: number, lineId: number, month: number | null) {
  const b = await getBudget(trx, id);
  const line = b.lines.find((l) => l.id === lineId);
  if (!line) return null;
  await assertPrefixesViewable(trx, auth, b.fiscalYear, [line.accountPrefix]);
  const r = await sql<{ voucher_id: string; voucher_no: string | null; voucher_type: string; posting_date: string; description: string | null; account_code: string; amount: string }>`
    SELECT v.id AS voucher_id, v.voucher_no, v.voucher_type, v.posting_date::text, coalesce(l.description, v.description) AS description, a.code AS account_code, (${signedAmount})::text AS amount
    ${matchFrom(b.fiscalYear)} WHERE bl.id = ${lineId} AND ${matchWhere} ${month === null ? sql`` : sql`AND v.period_no = ${month}`}
    ORDER BY v.posting_date, v.voucher_no, l.line_no LIMIT ${DRILL_LIMIT + 1}`.execute(trx);
  let rows = r.rows.slice(0, DRILL_LIMIT).map((x) => ({ voucherId: x.voucher_id, voucherNo: x.voucher_no, voucherType: x.voucher_type, postingDate: x.posting_date, description: x.description, accountCode: x.account_code, amount: x.amount }));
  // Thiếu view_salary: dòng của chứng từ có dòng lương (LU, chi lương, nộp bảo hiểm: một dòng cho mỗi nhân viên) gộp một dòng theo (chứng từ, tài khoản) và bỏ diễn giải, như sổ sách (hideSalary).
  if (!auth.sensitive.has('view_salary') && rows.length) {
    const salaryIds = await salaryAccountIds(trx);
    const withSalaryLines = salaryIds.length ? new Set((await sql<{ id: string }>`SELECT DISTINCT voucher_id::text AS id FROM voucher_line WHERE voucher_id = ANY (${[...new Set(rows.map((x) => x.voucherId))]}::uuid[]) AND account_id = ANY (${salaryIds}::bigint[])`.execute(trx)).rows.map((x) => x.id)) : new Set<string>();
    if (withSalaryLines.size) {
      const out: typeof rows = []; const groups = new Map<string, (typeof rows)[number]>();
      for (const x of rows) {
        if (!withSalaryLines.has(x.voucherId)) { out.push(x); continue; }
        const k = `${x.voucherId}|${x.accountCode}`; const g = groups.get(k);
        if (g) { g.amount = D(g.amount).plus(x.amount).toString(); continue; }
        const row = { ...x, description: SALARY_HIDDEN }; groups.set(k, row); out.push(row);
      }
      rows = out;
    }
  }
  return { lineId, month, truncated: r.rows.length > DRILL_LIMIT, rows };
}
