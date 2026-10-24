import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { allocateByRatio, D, formatVnDate, formatVnNumber, PAYROLL_BUILTIN_COLUMNS, type Decimal, type PayrollColumn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { moneyCell } from '../reporting/print/excel.js';
import type { ReportColumn, ReportDoc } from '../reporting/print/html.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { regimeOf } from '../reporting/ledgers.js';
import { payrollAccountMaps } from './accounts.js';
import { monthRange } from './attendance.js';

// Báo cáo lương (Task 7): đọc từ các bảng lương đã tính hoặc đã hạch toán (không đọc nháp, không đọc bảng đã hủy) trong giao dịch chỉ đọc.
// Mọi báo cáo kèm bảng đối chiếu với chứng từ LU của các bảng đã hạch toán: số báo cáo phải khớp số trên sổ cái (diff = 0).
// Không in "Mẫu số": chưa đối chiếu văn bản gốc (QĐ #710).
type Trx = Transaction<Database>;
type Row = Record<string, unknown>;
const mmyyyy = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
const sum = (xs: Iterable<Decimal>) => { let s = D(0); for (const x of xs) s = s.plus(x); return s; };

// ---- Phạm vi kỳ ----
const year = z.coerce.number().int().min(2000).max(2100);
const month = z.coerce.number().int().min(1).max(12);
const quarter = z.coerce.number().int().min(1).max(4);
const idq = z.coerce.number().int().positive();
export const monthScope = z.object({ year, month, runId: idq.optional(), departmentId: idq.optional() });
export const periodScope = z.object({ year, month: month.optional(), quarter: quarter.optional(), departmentId: idq.optional() });
export const costScope = periodScope.extend({ groupBy: z.enum(['department', 'project']).default('department') });
export const pitScope = z.object({ year, month: month.optional(), departmentId: idq.optional() });
export const compareScope = z.object({ year, month, year2: year, month2: month, departmentId: idq.optional() });
export const slipScope = z.object({ runId: idq, employeeId: idq.optional() });
const monthsOf = (q: { month?: number | undefined; quarter?: number | undefined }) => (q.quarter ? [0, 1, 2].map((i) => q.quarter! * 3 - 2 + i) : q.month ? [q.month] : Array.from({ length: 12 }, (_, i) => i + 1));
// Báo cáo theo tháng hoặc quý: phải chọn đúng một trong hai.
function needPeriod(q: { month?: number | undefined; quarter?: number | undefined }) {
  if (!q.month === !q.quarter) throw new AppError('VALIDATION', 'Chọn tháng hoặc quý (đúng một trong hai)', 400);
  return monthsOf(q);
}
const periodLabel = (q: { year: number; month?: number | undefined; quarter?: number | undefined }) => (q.quarter ? `Quý ${q.quarter}/${q.year}` : q.month ? `Tháng ${mmyyyy(q.year, q.month)}` : `Năm ${q.year}`);

// ---- Đọc dữ liệu ----
interface LineRec {
  lineId: number; runId: number; month: number; posted: boolean; employeeId: number; code: string; name: string; taxCode: string | null; idNumber: string | null; siNo: string | null;
  departmentId: number | null; departmentCode: string | null; departmentName: string | null; defaultProject: { code: string; name: string } | null;
  flags: { si: boolean; hi: boolean; ui: boolean; occ: boolean } | null; startDate: string | null; endDate: string | null;
  gross: Decimal; siEmp: Decimal; siEr: Decimal; pit: Decimal; net: Decimal; v: Record<string, Decimal>;
}
export interface RunInfo { id: number; name: string; year: number; month: number; kind: string; status: string; voucherId: string | null }
interface Loaded { lines: LineRec[]; runs: RunInfo[] }
const BASES = new Set(['si_base', 'ui_base']); // mức lương đóng: nhiều bảng cùng tháng lấy mức lớn nhất, không cộng

async function load(trx: Trx, s: { year: number; months: number[]; runId?: number | undefined; departmentId?: number | undefined; employeeId?: number | undefined }, codes: string[] | 'all'): Promise<Loaded> {
  const rows = await trx.selectFrom('payroll_line as l').innerJoin('payroll_run as r', 'r.id', 'l.run_id').innerJoin('employee as e', 'e.id', 'l.employee_id')
    .leftJoin('department as d', 'd.id', 'e.department_id').leftJoin('employee_payroll as p', 'p.employee_id', 'e.id').leftJoin('project as pr', 'pr.id', 'p.default_project_id')
    .select(['l.id as lineId', 'l.run_id as runId', 'l.month', 'l.run_status', 'r.name as runName', 'r.kind', 'r.voucher_id as voucherId', 'e.id as employeeId', 'e.code', 'e.name', 'e.tax_code', 'e.id_number', 'p.si_no',
      'e.department_id', 'd.code as deptCode', 'd.name as deptName', 'pr.code as projectCode', 'pr.name as projectName', 'p.start_date', 'p.end_date',
      'p.si_participates', 'p.hi_participates', 'p.ui_participates', 'p.occupational_participates', 'l.gross', 'l.si_emp', 'l.si_er', 'l.pit', 'l.net'])
    .where('l.year', '=', s.year).where('l.month', 'in', s.months).where('l.run_status', 'in', ['calculated', 'posted'])
    .$if(s.runId !== undefined, (q) => q.where('l.run_id', '=', s.runId!)).$if(s.departmentId !== undefined, (q) => q.where('e.department_id', '=', s.departmentId!))
    .$if(s.employeeId !== undefined, (q) => q.where('l.employee_id', '=', s.employeeId!)).orderBy('e.code').orderBy('l.month').orderBy('l.run_id').execute();
  const vals = new Map<number, Record<string, Decimal>>();
  const ids = rows.map((r) => r.lineId);
  for (let i = 0; i < ids.length; i += 5000) {
    let q = trx.selectFrom('payroll_line_value').select(['line_id', 'column_code', 'value']).where('line_id', 'in', ids.slice(i, i + 5000));
    if (codes !== 'all') q = q.where('column_code', 'in', codes);
    for (const v of await q.execute()) (vals.get(v.line_id) ?? vals.set(v.line_id, {}).get(v.line_id)!)[v.column_code] = D(v.value);
  }
  const runs = new Map<number, RunInfo>();
  const lines = rows.map((r): LineRec => {
    runs.set(r.runId, { id: r.runId, name: r.runName, year: s.year, month: r.month, kind: r.kind, status: r.run_status, voucherId: r.voucherId });
    return {
      lineId: r.lineId, runId: r.runId, month: r.month, posted: r.run_status === 'posted', employeeId: r.employeeId, code: r.code, name: r.name, taxCode: r.tax_code, idNumber: r.id_number, siNo: r.si_no,
      departmentId: r.department_id, departmentCode: r.deptCode, departmentName: r.deptName, defaultProject: r.projectCode ? { code: r.projectCode, name: r.projectName! } : null,
      flags: r.si_participates === null ? null : { si: r.si_participates, hi: r.hi_participates!, ui: r.ui_participates!, occ: r.occupational_participates! }, startDate: r.start_date, endDate: r.end_date,
      gross: D(r.gross), siEmp: D(r.si_emp), siEr: D(r.si_er), pit: D(r.pit), net: D(r.net), v: vals.get(r.lineId) ?? {},
    };
  });
  return { lines, runs: [...runs.values()].sort((a, b) => a.id - b.id) };
}

// Một nhân viên một tháng: cộng các bảng (chính, thưởng, truy lĩnh); mức lương đóng lấy lớn nhất.
type Rec = LineRec
function perMonth(lines: LineRec[]): Rec[] {
  const m = new Map<string, Rec>();
  for (const l of lines) {
    const k = `${l.employeeId}|${l.month}`; const c = m.get(k);
    if (!c) { m.set(k, { ...l, v: { ...l.v } }); continue; }
    c.gross = c.gross.plus(l.gross); c.siEmp = c.siEmp.plus(l.siEmp); c.siEr = c.siEr.plus(l.siEr); c.pit = c.pit.plus(l.pit); c.net = c.net.plus(l.net);
    for (const [code, x] of Object.entries(l.v)) c.v[code] = BASES.has(code) ? ((c.v[code] ?? D(0)).gte(x) ? c.v[code]! : x) : (c.v[code] ?? D(0)).plus(x);
  }
  return [...m.values()];
}
// Một nhân viên cả kỳ: cộng các tháng (mức lương đóng cũng cộng: quỹ lương đóng bảo hiểm của kỳ).
function perEmployee(recs: Rec[]): Rec[] {
  const m = new Map<number, Rec>();
  for (const r of recs) {
    const c = m.get(r.employeeId);
    if (!c) { m.set(r.employeeId, { ...r, v: { ...r.v } }); continue; }
    c.gross = c.gross.plus(r.gross); c.siEmp = c.siEmp.plus(r.siEmp); c.siEr = c.siEr.plus(r.siEr); c.pit = c.pit.plus(r.pit); c.net = c.net.plus(r.net);
    for (const [code, x] of Object.entries(r.v)) c.v[code] = (c.v[code] ?? D(0)).plus(x);
  }
  return [...m.values()];
}
const v = (r: { v: Record<string, Decimal> }, code: string) => r.v[code] ?? D(0);
const s0 = (x: Decimal) => x.toFixed(0);

// ---- Đối chiếu với sổ cái (chứng từ LU của các bảng đã hạch toán trong phạm vi) ----
export interface Recon { postedRuns: number; unpostedRuns: number; ok: boolean; items: { label: string; report: string; ledger: string; diff: string }[] }
interface LuTotals { net: Map<string, Decimal>; employeeNet: Decimal; map: ReturnType<typeof payrollAccountMaps>[number] }
async function luTotals(trx: Trx, voucherIds: string[]): Promise<LuTotals> {
  const reg = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', voucherIds[0]!).limit(1).executeTakeFirstOrThrow();
  const maps = payrollAccountMaps(reg.regime);
  if (maps.length !== 1) throw new AppError('ACCOUNT_MISSING', `Chế độ kế toán ${reg.regime} chưa có ánh xạ tài khoản lương (coa-data/payroll/accounts.json)`, 400);
  const rows = (await sql<{ code: string; emp: boolean; net: string }>`SELECT a.code, (l.employee_id IS NOT NULL) AS emp, sum(l.credit - l.debit)::text AS net
    FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id IN (${sql.join(voucherIds)}) GROUP BY 1, 2`.execute(trx)).rows;
  const net = new Map<string, Decimal>(); let employeeNet = D(0);
  for (const r of rows) { net.set(r.code, (net.get(r.code) ?? D(0)).plus(r.net)); if (r.emp) employeeNet = employeeNet.plus(r.net); }
  return { net, employeeNet, map: maps[0]! };
}
type Check = { label: string; report: Decimal; ledger: (t: LuTotals) => Decimal };
async function reconcile(trx: Trx, l: Loaded, checks: (posted: LineRec[]) => Check[]): Promise<Recon> {
  const posted = l.lines.filter((x) => x.posted); const voucherIds = [...new Set(l.runs.filter((r) => r.status === 'posted' && r.voucherId).map((r) => r.voucherId!))];
  const base = { postedRuns: l.runs.filter((r) => r.status === 'posted').length, unpostedRuns: l.runs.filter((r) => r.status !== 'posted').length };
  if (!voucherIds.length) return { ...base, ok: true, items: [] };
  const t = await luTotals(trx, voucherIds);
  const items = checks(posted).map((c) => { const lg = c.ledger(t); return { label: c.label, report: s0(c.report), ledger: s0(lg), diff: s0(c.report.minus(lg)) }; });
  return { ...base, ok: items.every((i) => i.diff === '0'), items };
}
const cr = (t: LuTotals, code: string) => t.net.get(code) ?? D(0); // dư Có phát sinh trên tài khoản trong LU

// Dòng chữ "Dữ liệu minh họa" khi công ty còn dùng tham số lương ghi nguồn minh họa (D15): số liệu không có giá trị pháp lý.
async function banner(trx: Trx): Promise<string[]> {
  const ex = await trx.selectFrom('payroll_param').select('id').where('source', 'like', 'Dữ liệu minh họa%').limit(1).executeTakeFirst();
  return ex ? ['Dữ liệu minh họa: bảng lương dùng tham số ghi nguồn "Dữ liệu minh họa", không phải văn bản pháp lý. Kiểm tra tham số lương trước khi sử dụng.'] : [];
}
const notes = (runs: RunInfo[]) => (runs.some((r) => r.status !== 'posted') ? ['Số liệu gồm bảng lương chưa hạch toán: có thể thay đổi khi tính lại.'] : []);

export interface Report {
  title: string; subtitle: string; sheetName: string; fileName: string; columns: ReportColumn[]; rows: Row[]; footer?: Row; landscape?: boolean; intro: string[]; signatures?: string[];
  runs: RunInfo[]; reconciliation: Recon; from: string; to: string;
}
const num = (key: string, label: string, width?: string): ReportColumn => ({ key, label, type: 'number', ...(width && { width }) });
const stt = (rows: Row[]): Row[] => rows.map((r, i) => ({ stt: i + 1, ...r }));
const monthEnd = (y: number, ms: number[]) => ({ from: monthRange(y, Math.min(...ms)).from, to: monthRange(y, Math.max(...ms)).to });

async function finish(trx: Trx, l: Loaded, r: Omit<Report, 'runs' | 'reconciliation' | 'intro' | 'from' | 'to'>, range: { from: string; to: string }, recon: Recon): Promise<Report> {
  return { ...r, ...range, intro: [...(await banner(trx)), ...notes(l.runs)], runs: l.runs, reconciliation: recon };
}
const empCols: ReportColumn[] = [{ key: 'stt', label: 'STT', width: '4%' }, { key: 'code', label: 'Mã NV', width: '8%' }, { key: 'name', label: 'Họ và tên' }];

// ---- Bảng thanh toán tiền lương ----
export async function paymentSheet(trx: Trx, q: z.infer<typeof monthScope>): Promise<Report> {
  const l = await load(trx, { year: q.year, months: [q.month], runId: q.runId, departmentId: q.departmentId }, ['other_withholding']);
  const recs = perEmployee(perMonth(l.lines));
  const rows = stt(recs.map((r) => ({ code: r.code, name: r.name, department: r.departmentName ?? '', gross: s0(r.gross), siEmp: s0(r.siEmp), pit: s0(r.pit), other: s0(v(r, 'other_withholding')), net: s0(r.net) })));
  const recon = await reconcile(trx, l, (p) => [{ label: 'Thực lĩnh = dư Có phải trả người lao động (LU)', report: sum(p.map((x) => x.net)), ledger: (u) => u.employeeNet }]);
  return finish(trx, l, {
    title: 'Bảng thanh toán tiền lương', subtitle: `Tháng ${mmyyyy(q.year, q.month)}${q.runId && l.runs[0] ? ` – ${l.runs[0].name}` : ''}`, sheetName: 'Thanh toán lương', fileName: `bang-thanh-toan-luong-${q.year}-${q.month}`, landscape: true,
    columns: [...empCols, { key: 'department', label: 'Bộ phận', width: '10%' }, num('gross', 'Tổng thu nhập'), num('siEmp', 'BHXH, BHYT, BHTN trừ vào lương'), num('pit', 'Thuế TNCN'), num('other', 'Khấu trừ khác'), num('net', 'Thực lĩnh'), { key: 'sign', label: 'Ký nhận', width: '9%' }],
    rows, footer: { name: 'Cộng', gross: s0(sum(recs.map((r) => r.gross))), siEmp: s0(sum(recs.map((r) => r.siEmp))), pit: s0(sum(recs.map((r) => r.pit))), other: s0(sum(recs.map((r) => v(r, 'other_withholding')))), net: s0(sum(recs.map((r) => r.net))) }, signatures: ['Người lập biểu', 'Kế toán trưởng', 'Giám đốc'],
  }, monthEnd(q.year, [q.month]), recon);
}

// ---- Bảng tổng hợp bảo hiểm ----
const INS = ['si_base', 'ui_base', 'si_emp_si', 'si_emp_hi', 'si_emp_ui', 'si_er_si', 'si_er_hi', 'si_er_ui', 'si_er_occ', 'union_er'];
export async function insuranceSummary(trx: Trx, q: z.infer<typeof periodScope>): Promise<Report> {
  const months = needPeriod(q);
  const l = await load(trx, { year: q.year, months, departmentId: q.departmentId }, INS);
  const recs = perEmployee(perMonth(l.lines));
  const out = recs.map((r) => {
    const emp = v(r, 'si_emp_si').plus(v(r, 'si_emp_hi')).plus(v(r, 'si_emp_ui')); const er = v(r, 'si_er_si').plus(v(r, 'si_er_hi')).plus(v(r, 'si_er_ui')).plus(v(r, 'si_er_occ'));
    return { code: r.code, name: r.name, siBase: v(r, 'si_base'), uiBase: v(r, 'ui_base'), eSi: v(r, 'si_emp_si'), eHi: v(r, 'si_emp_hi'), eUi: v(r, 'si_emp_ui'), eTotal: emp, rSi: v(r, 'si_er_si'), rHi: v(r, 'si_er_hi'), rUi: v(r, 'si_er_ui'), rOcc: v(r, 'si_er_occ'), rTotal: er, union: v(r, 'union_er'), total: emp.plus(er) };
  });
  const keys = ['siBase', 'uiBase', 'eSi', 'eHi', 'eUi', 'eTotal', 'rSi', 'rHi', 'rUi', 'rOcc', 'rTotal', 'union', 'total'] as const;
  const fmt = (x: Row) => Object.fromEntries(Object.entries(x).map(([k, y]) => [k, typeof y === 'string' ? y : (y as Decimal).toFixed(0)]));
  const rows = stt(out.map((r) => fmt(r)));
  const footer = { name: 'Cộng', ...Object.fromEntries(keys.map((k) => [k, s0(sum(out.map((r) => r[k])))])) };
  const recon = await reconcile(trx, l, (p) => {
    const t = (...cs: string[]) => sum(p.flatMap((x) => cs.map((c) => v(x, c))));
    return [{ label: 'BHXH (người lao động + doanh nghiệp + TNLĐ-BNN) = Có bảo hiểm xã hội', report: t('si_emp_si', 'si_er_si', 'si_er_occ'), ledger: (u) => cr(u, u.map.si) },
      { label: 'BHYT = Có bảo hiểm y tế', report: t('si_emp_hi', 'si_er_hi'), ledger: (u) => cr(u, u.map.hi) },
      { label: 'BHTN = Có bảo hiểm thất nghiệp', report: t('si_emp_ui', 'si_er_ui'), ledger: (u) => cr(u, u.map.ui) },
      { label: 'Kinh phí công đoàn = Có kinh phí công đoàn', report: t('union_er'), ledger: (u) => cr(u, u.map.union) }];
  });
  return finish(trx, l, {
    title: 'Bảng tổng hợp bảo hiểm', subtitle: periodLabel(q), sheetName: 'Tong hop bao hiem', fileName: `bang-tong-hop-bao-hiem-${q.year}-${q.quarter ? `Q${q.quarter}` : q.month}`, landscape: true,
    columns: [...empCols, num('siBase', 'Lương đóng BHXH, BHYT'), num('uiBase', 'Lương đóng BHTN'), num('eSi', 'BHXH NLĐ'), num('eHi', 'BHYT NLĐ'), num('eUi', 'BHTN NLĐ'), num('eTotal', 'Cộng NLĐ'),
      num('rSi', 'BHXH DN'), num('rHi', 'BHYT DN'), num('rUi', 'BHTN DN'), num('rOcc', 'TNLĐ-BNN DN'), num('rTotal', 'Cộng DN'), num('union', 'KPCĐ'), num('total', 'Tổng cộng')],
    rows, footer,
  }, monthEnd(q.year, months), recon);
}

// ---- Chi phí lương theo bộ phận / vụ việc ----
const ER_COST = ['si_er_si', 'si_er_hi', 'si_er_ui', 'si_er_occ', 'union_er'];
export async function costReport(trx: Trx, q: z.infer<typeof costScope>): Promise<Report> {
  const months = needPeriod(q);
  const l = await load(trx, { year: q.year, months, departmentId: q.departmentId }, ['gross', ...ER_COST]);
  const ins = (x: LineRec) => sum(ER_COST.map((c) => v(x, c)));
  const grossOf = (x: LineRec) => (x.v['gross'] ?? x.gross);
  const groups = new Map<string, { code: string; name: string; emps: Set<number>; salary: Decimal; insurance: Decimal }>();
  const add = (code: string, name: string, emp: number, salary: Decimal, insurance: Decimal) => {
    const g = groups.get(code) ?? groups.set(code, { code, name, emps: new Set(), salary: D(0), insurance: D(0) }).get(code)!;
    g.emps.add(emp); g.salary = g.salary.plus(salary); g.insurance = g.insurance.plus(insurance);
  };
  if (q.groupBy === 'department') for (const x of l.lines) add(x.departmentCode ?? '', x.departmentName ?? '(Không có bộ phận)', x.employeeId, grossOf(x), ins(x));
  else {
    // Tách theo tỷ lệ phân bổ của nhân viên, phần dư theo phần lẻ lớn nhất: cùng cách hạch toán LU (post.ts).
    const empIds = [...new Set(l.lines.map((x) => x.employeeId))];
    const splits = new Map<number, { code: string; name: string; pct: string }[]>();
    for (let i = 0; i < empIds.length; i += 5000)
      for (const s of await trx.selectFrom('employee_cost_split as s').innerJoin('project as p', 'p.id', 's.project_id').select(['s.employee_id', 'p.code', 'p.name', 's.pct']).where('s.employee_id', 'in', empIds.slice(i, i + 5000)).orderBy('p.code').execute())
        (splits.get(s.employee_id) ?? splits.set(s.employee_id, []).get(s.employee_id)!).push({ code: s.code, name: s.name, pct: s.pct });
    for (const x of l.lines) {
      const own = splits.get(x.employeeId);
      const parts = own?.length ? own : [{ code: x.defaultProject?.code ?? '', name: x.defaultProject?.name ?? '(Chưa gán vụ việc)', pct: '100' }];
      const pcts = parts.map((p) => p.pct);
      const a = allocateByRatio(grossOf(x).toFixed(0), pcts), b = allocateByRatio(ins(x).toFixed(0), pcts);
      parts.forEach((p, i) => add(p.code, p.name, x.employeeId, D(a[i]!), D(b[i]!)));
    }
  }
  const list = [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
  const rows = stt(list.map((g) => ({ code: g.code, name: g.name, employees: String(g.emps.size), salary: s0(g.salary), insurance: s0(g.insurance), total: s0(g.salary.plus(g.insurance)) })));
  const salary = sum(list.map((g) => g.salary)), insurance = sum(list.map((g) => g.insurance));
  const recon = await reconcile(trx, l, (p) => [{
    label: 'Tổng chi phí lương, bảo hiểm, KPCĐ = Nợ các tài khoản chi phí (LU)', report: sum(p.map((x) => grossOf(x).plus(ins(x)))),
    ledger: (u) => { const m = u.map; const nonCost = new Set([m.payable, m.si, m.hi, m.ui, m.union, m.pit, ...(m.withholding ? [m.withholding] : [])]); return sum([...u.net].filter(([c]) => !nonCost.has(c)).map(([, x]) => x)).neg(); },
  }]);
  const by = q.groupBy === 'department' ? 'bộ phận' : 'vụ việc';
  return finish(trx, l, {
    title: `Báo cáo chi phí lương theo ${by}`, subtitle: periodLabel(q), sheetName: `Chi phi luong theo ${by}`.slice(0, 28), fileName: `chi-phi-luong-theo-${q.groupBy}-${q.year}-${q.quarter ? `Q${q.quarter}` : q.month}`,
    columns: [{ key: 'stt', label: 'STT', width: '5%' }, { key: 'code', label: q.groupBy === 'department' ? 'Mã bộ phận' : 'Mã vụ việc', width: '12%' }, { key: 'name', label: q.groupBy === 'department' ? 'Bộ phận' : 'Vụ việc' },
      { key: 'employees', label: 'Số nhân viên', type: 'number', width: '9%' }, num('salary', 'Chi phí tiền lương'), num('insurance', 'Chi phí bảo hiểm, KPCĐ'), num('total', 'Tổng chi phí')],
    rows, footer: { name: 'Cộng', salary: s0(salary), insurance: s0(insurance), total: s0(salary.plus(insurance)) },
  }, monthEnd(q.year, months), recon);
}

// ---- Thuế TNCN khấu trừ theo nhân viên và tháng ----
export async function pitReport(trx: Trx, q: z.infer<typeof pitScope>): Promise<Report> {
  const months = monthsOf(q);
  const l = await load(trx, { year: q.year, months, departmentId: q.departmentId }, ['taxable_income', 'pit_base']);
  // Thu nhập tính thuế lấy ở bảng lập sau cùng của tháng: bảng thưởng, truy lĩnh tính trên cả tháng (đã gồm các bảng trước, D12).
  const lastBase = new Map<string, Decimal>(); for (const x of l.lines) lastBase.set(`${x.employeeId}|${x.month}`, v(x, 'pit_base'));
  const recs = perMonth(l.lines).sort((a, b) => a.code.localeCompare(b.code) || a.month - b.month);
  const rows = stt(recs.map((r) => ({ month: mmyyyy(q.year, r.month), code: r.code, name: r.name, taxCode: r.taxCode ?? '', taxable: s0(v(r, 'taxable_income')), base: s0(lastBase.get(`${r.employeeId}|${r.month}`) ?? D(0)), pit: s0(r.pit) })));
  const recon = await reconcile(trx, l, (p) => [{ label: 'Thuế TNCN khấu trừ = Có thuế TNCN (LU)', report: sum(p.map((x) => x.pit)), ledger: (u) => cr(u, u.map.pit) }]);
  return finish(trx, l, {
    title: 'Báo cáo thuế thu nhập cá nhân khấu trừ', subtitle: q.month ? `Tháng ${mmyyyy(q.year, q.month)}` : `Năm ${q.year}`, sheetName: 'Thue TNCN khau tru', fileName: `thue-tncn-khau-tru-${q.year}${q.month ? `-${q.month}` : ''}`,
    columns: [{ key: 'stt', label: 'STT', width: '4%' }, { key: 'month', label: 'Tháng', width: '8%' }, { key: 'code', label: 'Mã NV', width: '8%' }, { key: 'name', label: 'Họ và tên' }, { key: 'taxCode', label: 'Mã số thuế', width: '12%' },
      num('taxable', 'Thu nhập chịu thuế'), num('base', 'Thu nhập tính thuế'), num('pit', 'Thuế TNCN khấu trừ')],
    rows, footer: { name: 'Cộng', taxable: s0(sum(recs.map((r) => v(r, 'taxable_income')))), pit: s0(sum(recs.map((r) => r.pit))) },
  }, monthEnd(q.year, months), recon);
}

// ---- So sánh hai kỳ ----
export async function compareReport(trx: Trx, q: z.infer<typeof compareScope>): Promise<Report> {
  const [la, lb] = [await load(trx, { year: q.year, months: [q.month], departmentId: q.departmentId }, ['gross']), await load(trx, { year: q.year2, months: [q.month2], departmentId: q.departmentId }, ['gross'])];
  const [ra, rb] = [perEmployee(perMonth(la.lines)), perEmployee(perMonth(lb.lines))];
  const ids = new Map<number, { code: string; name: string }>(); for (const r of [...ra, ...rb]) ids.set(r.employeeId, { code: r.code, name: r.name });
  const A = new Map(ra.map((r) => [r.employeeId, r])), B = new Map(rb.map((r) => [r.employeeId, r]));
  const get = (m: Map<number, Rec>, id: number, k: 'gross' | 'pit' | 'net') => m.get(id)?.[k] ?? D(0);
  const list = [...ids].sort(([, a], [, b]) => a.code.localeCompare(b.code));
  const rows = stt(list.map(([id, e]) => {
    const o: Row = { code: e.code, name: e.name };
    for (const k of ['gross', 'net', 'pit'] as const) { const [a, b] = [get(A, id, k), get(B, id, k)]; o[`${k}A`] = s0(a); o[`${k}B`] = s0(b); o[`${k}D`] = s0(b.minus(a)); }
    return o;
  }));
  const tot = (k: string) => s0(sum(rows.map((r) => D(r[k] as string))));
  const footer: Row = { name: 'Cộng' }; for (const k of ['gross', 'net', 'pit']) for (const s of ['A', 'B', 'D']) footer[`${k}${s}`] = tot(`${k}${s}`);
  const [pa, pb] = [mmyyyy(q.year, q.month), mmyyyy(q.year2, q.month2)];
  const cols = (k: string, label: string): ReportColumn[] => [num(`${k}A`, `${label} ${pa}`), num(`${k}B`, `${label} ${pb}`), num(`${k}D`, `${label} chênh lệch`)];
  const [recA, recB] = [await reconcile(trx, la, (p) => [{ label: `Thực lĩnh ${pa}`, report: sum(p.map((x) => x.net)), ledger: (u) => u.employeeNet }]), await reconcile(trx, lb, (p) => [{ label: `Thực lĩnh ${pb}`, report: sum(p.map((x) => x.net)), ledger: (u) => u.employeeNet }])];
  const runs = [...la.runs, ...lb.runs];
  const all: Loaded = { lines: [], runs };
  return finish(trx, all, {
    title: 'So sánh bảng lương hai kỳ', subtitle: `Tháng ${pa} và tháng ${pb}`, sheetName: 'So sanh hai ky', fileName: `so-sanh-luong-${q.year}-${q.month}-${q.year2}-${q.month2}`, landscape: true,
    columns: [...empCols, ...cols('gross', 'Tổng thu nhập'), ...cols('net', 'Thực lĩnh'), ...cols('pit', 'Thuế TNCN')], rows, footer,
  }, { from: monthRange(Math.min(q.year, q.year2), 1).from, to: monthRange(Math.max(q.year, q.year2), 12).to }, { postedRuns: recA.postedRuns + recB.postedRuns, unpostedRuns: recA.unpostedRuns + recB.unpostedRuns, ok: recA.ok && recB.ok, items: [...recA.items, ...recB.items] });
}

// ---- Danh sách tham gia BHXH, BHYT, BHTN (cột chung, không phải mẫu D02-LT/TK1-TS của cơ quan BHXH: QĐ #716) ----
export async function bhxhList(trx: Trx, q: z.infer<typeof monthScope>): Promise<Report> {
  const l = await load(trx, { year: q.year, months: [q.month], runId: q.runId, departmentId: q.departmentId }, ['si_base', 'ui_base', 'allowances']);
  const recs = perMonth(l.lines).filter((r) => r.flags && (r.flags.si || r.flags.hi || r.flags.ui || r.flags.occ));
  const rows = stt(recs.map((r) => ({
    siNo: r.siNo ?? '', name: r.name, idNumber: r.idNumber ?? '', code: r.code, siBase: s0(v(r, 'si_base')), uiBase: s0(v(r, 'ui_base')), allowances: s0(v(r, 'allowances')),
    joined: [r.flags!.si && 'BHXH', r.flags!.hi && 'BHYT', r.flags!.ui && 'BHTN', r.flags!.occ && 'TNLĐ-BNN'].filter(Boolean).join(', '), period: mmyyyy(q.year, q.month), startDate: r.startDate ?? '', endDate: r.endDate ?? '',
  })));
  return finish(trx, l, {
    title: 'Danh sách tham gia BHXH, BHYT, BHTN', subtitle: `Tháng ${mmyyyy(q.year, q.month)}`, sheetName: 'Tham gia BHXH', fileName: `danh-sach-tham-gia-bhxh-${q.year}-${q.month}`, landscape: true,
    columns: [{ key: 'stt', label: 'STT', width: '4%' }, { key: 'siNo', label: 'Mã số BHXH', width: '11%' }, { key: 'name', label: 'Họ và tên' }, { key: 'idNumber', label: 'Số CCCD', width: '11%' }, { key: 'code', label: 'Mã NV', width: '7%' },
      num('siBase', 'Lương đóng BHXH, BHYT'), num('uiBase', 'Lương đóng BHTN'), num('allowances', 'Phụ cấp'), { key: 'joined', label: 'Tham gia' }, { key: 'period', label: 'Tháng đóng', width: '8%' },
      { key: 'startDate', label: 'Ngày vào làm', type: 'date' }, { key: 'endDate', label: 'Ngày nghỉ việc', type: 'date' }],
    rows,
  }, monthEnd(q.year, [q.month]), { postedRuns: 0, unpostedRuns: 0, ok: true, items: [] });
}

// ---- Phiếu lương cá nhân ----
const NAME = new Map(PAYROLL_BUILTIN_COLUMNS.map((c) => [c.code, c.name]));
const INCOME_BUILTIN = ['base_salary', 'allowances', 'ot_pay', 'other_income'];
export interface Slip {
  employeeId: number; code: string; name: string; department: string | null; taxCode: string | null; workDays: string; otHours: string;
  income: { label: string; amount: string }[]; deductions: { label: string; amount: string }[]; gross: string; totalDeductions: string; net: string;
}
/** Chia các cột của bảng lương thành thu nhập và khấu trừ cho một nhân viên; khấu trừ khác chưa liệt kê dồn vào "Khấu trừ khác". Thu nhập - khấu trừ = thực lĩnh nếu cấu trúc theo công thức dựng sẵn. */
export function slipOf(columns: PayrollColumn[], value: (code: string) => Decimal, header: Pick<Slip, 'employeeId' | 'code' | 'name' | 'department' | 'taxCode'>, gross: Decimal, net: Decimal): Slip {
  const label = (c: string) => columns.find((x) => x.code === c)?.name ?? NAME.get(c) ?? c;
  const inCols = [...INCOME_BUILTIN, ...columns.filter((c) => c.kind !== 'builtin' && c.income && !INCOME_BUILTIN.includes(c.code)).map((c) => c.code)];
  const flagged = columns.filter((c) => c.kind !== 'builtin' && c.deduct).map((c) => c.code);
  const dedCols = ['si_emp_si', 'si_emp_hi', 'si_emp_ui', 'pit', ...flagged];
  const income = inCols.map((c) => ({ label: label(c), amount: value(c) })).filter((x, i) => i === 0 || !x.amount.isZero());
  const deductions = dedCols.map((c) => ({ label: label(c), amount: value(c) })).filter((x) => !x.amount.isZero());
  const rest = value('other_withholding').minus(sum(flagged.map(value)));
  if (!rest.isZero()) deductions.push({ label: 'Khấu trừ khác', amount: rest });
  return { ...header, workDays: value('work_days').toString(), otHours: value('ot_weekday_hours').plus(value('ot_rest_hours')).plus(value('ot_holiday_hours')).toString(),
    income: income.map((x) => ({ ...x, amount: s0(x.amount) })), deductions: deductions.map((x) => ({ ...x, amount: s0(x.amount) })), gross: s0(gross), totalDeductions: s0(sum(deductions.map((x) => x.amount))), net: s0(net) };
}
export async function slips(trx: Trx, q: z.infer<typeof slipScope>) {
  const run = await trx.selectFrom('payroll_run as r').innerJoin('payroll_structure as s', 's.id', 'r.structure_id').select(['r.id', 'r.name', 'r.year', 'r.month', 'r.status', 's.columns']).where('r.id', '=', q.runId).executeTakeFirst();
  if (!run) throw new AppError('PAYROLL_RUN_NOT_FOUND', 'Không tìm thấy bảng lương', 404);
  if (run.status !== 'calculated' && run.status !== 'posted') throw new AppError('PAYROLL_RUN_NOT_CALCULATED', 'Bảng lương chưa tính: tính lương trước khi in phiếu lương', 409);
  const l = await load(trx, { year: run.year, months: [run.month], runId: run.id, employeeId: q.employeeId }, 'all');
  if (q.employeeId !== undefined && !l.lines.length) throw new AppError('PAYROLL_LINE_NOT_FOUND', 'Nhân viên không có trong bảng lương này', 404);
  const columns = run.columns as PayrollColumn[];
  return {
    run: { id: run.id, name: run.name, year: run.year, month: run.month, status: run.status }, intro: await banner(trx),
    slips: l.lines.map((x) => slipOf(columns, (c) => v(x, c), { employeeId: x.employeeId, code: x.code, name: x.name, department: x.departmentName, taxCode: x.taxCode }, x.v['gross'] ?? x.gross, x.net)),
  };
}
export async function slipDocs(trx: Trx, tenantId: string, d: Awaited<ReturnType<typeof slips>>): Promise<ReportDoc[]> {
  const regime = await regimeOf(trx, monthRange(d.run.year, d.run.month));
  const c = await companyInfo(trx, tenantId, regime, null);
  return d.slips.map((s) => ({
    title: 'Phiếu lương', subtitle: `Tháng ${mmyyyy(d.run.year, d.run.month)}`, company: c, formNo: '', issuedBy: '',
    intro: [...d.intro, `Mã nhân viên: ${s.code} – Họ và tên: ${s.name}`, `Bộ phận: ${s.department ?? ''}${s.taxCode ? ` – Mã số thuế: ${s.taxCode}` : ''}`,
      `Ngày công hưởng lương: ${formatVnNumber(s.workDays, 2)}${D(s.otHours).isZero() ? '' : ` – Giờ làm thêm: ${formatVnNumber(s.otHours, 2)}`}`],
    columns: [{ key: 'label', label: 'Khoản mục' }, { key: 'amount', label: 'Số tiền (đồng)', type: 'number', width: '25%' }],
    rows: [{ label: 'I. Thu nhập', isBold: true }, ...s.income.map((x) => ({ label: x.label, amount: x.amount })), { label: 'Tổng thu nhập', amount: s.gross, isBold: true },
      { label: 'II. Khấu trừ', isBold: true }, ...s.deductions.map((x) => ({ label: x.label, amount: x.amount })), { label: 'Tổng khấu trừ', amount: s.totalDeductions, isBold: true },
      { label: 'Thực lĩnh (I - II)', amount: s.net, isBold: true }],
    signers: [{ title: 'Người lập phiếu' }, { title: 'Người nhận' }],
  }));
}

// ---- Tài liệu in / xuất ----
export async function toDoc(trx: Trx, tenantId: string, r: Report): Promise<ReportDoc> {
  const company = await companyInfo(trx, tenantId, await regimeOf(trx, r), null);
  return { title: r.title, subtitle: r.subtitle, sheetName: r.sheetName, columns: r.columns, rows: r.rows, ...(r.footer && { footer: r.footer }), ...(r.landscape && { landscape: true }),
    intro: r.intro, ...(r.signatures && { signatures: r.signatures }), company, formNo: '', issuedBy: '' };
}

// CSV UTF-8 có BOM (Excel mở đúng tiếng Việt); tiền là số thuần không dấu phân cách, ngày dd/MM/yyyy.
export function renderCsv(d: ReportDoc): Buffer {
  const q = (x: unknown) => { const t = String(x ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const cell = (c: ReportColumn, x: unknown) => (c.type === 'number' ? moneyCell(x, c.scale) : c.type === 'date' && x ? formatVnDate(String(x)) : x);
  const lines = [d.columns.map((c) => q(c.label)).join(','), ...[...d.rows, ...(d.footer ? [d.footer] : [])].map((r) => d.columns.map((c) => q(cell(c, r[c.key]))).join(','))];
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}
