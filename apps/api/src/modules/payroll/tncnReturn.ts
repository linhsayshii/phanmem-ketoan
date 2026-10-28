import { isDeepStrictEqual } from 'node:util';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { isTncnTemplateComplete } from '@kt/coa-data';
import { D, Decimal, pitAnnualSettlement, type PitAnnualMonth, type PitBracket } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { ReportColumn, ReportDoc } from '../reporting/print/html.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { regimeOf } from '../reporting/ledgers.js';
import { payrollAccountMaps } from './accounts.js';
import { monthRange } from './attendance.js';
import { payrollParam } from './params.js';
import { banner, load, type LineRec } from './reports.js';

// Thuế TNCN (Task 9): bảng kê khấu trừ theo cá nhân, quyết toán năm thay cho người lao động, tờ khai 05/KK-TNCN và 05/QTT-TNCN (lưu trong tax_return).
// Nguồn số là bảng lương ĐÃ HẠCH TOÁN (mọi loại bảng: chính, thưởng, truy lĩnh; D12) và khoản thuế TNCN khấu trừ trên hóa đơn mua dịch vụ (mã TNCN_KT).
// Mẫu tờ khai TT 89/2026 Phụ lục I chưa có văn bản gốc (cổng 05KK_TNCN_TT89, 05QTT_TNCN_TT89 = false): tờ khai lưu bảng kê + tổng; XML, ký số trả 409 TNCN_TEMPLATE_UNAVAILABLE.
type Trx = Transaction<Database>;
const s0 = (x: Decimal) => x.toFixed(0);
const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), D(0));
const vnDate = (d: string) => d.split('-').reverse().join('/');

// ---- Kỳ ----
const year = z.coerce.number().int().min(2000).max(2100);
export const withholdingQuery = z.object({ year, month: z.coerce.number().int().min(1).max(12).optional(), quarter: z.coerce.number().int().min(1).max(4).optional() });
export const yearQuery = z.object({ year });
export const certificateQuery = z.object({ year, employeeId: z.coerce.number().int().positive().optional() });
export type PeriodKind = 'month' | 'quarter' | 'year';
interface Period { year: number; kind: PeriodKind; period: number; months: number[]; from: string; to: string; label: string }
export function periodOf(q: { year: number; month?: number | undefined; quarter?: number | undefined }): Period {
  if (q.month && q.quarter) throw new AppError('VALIDATION', 'Chọn tháng hoặc quý, không chọn cả hai', 400);
  const [kind, period, months]: [PeriodKind, number, number[]] = q.quarter ? ['quarter', q.quarter, [0, 1, 2].map((i) => q.quarter! * 3 - 2 + i)]
    : q.month ? ['month', q.month, [q.month]] : ['year', 1, Array.from({ length: 12 }, (_, i) => i + 1)];
  const label = kind === 'quarter' ? `Quý ${period}/${q.year}` : kind === 'month' ? `Tháng ${String(period).padStart(2, '0')}/${q.year}` : `Năm ${q.year}`;
  return { year: q.year, kind, period, months, from: monthRange(q.year, months[0]!).from, to: monthRange(q.year, months[months.length - 1]!).to, label };
}

// ---- Gộp theo tháng ----
// Một nhân viên một tháng cộng mọi bảng đã hạch toán. Giảm trừ bản thân/người phụ thuộc mỗi bảng đều tính lại cho cả tháng (D12) nên lấy lớn nhất, không cộng;
// thu nhập tính thuế của tháng = thu nhập chịu thuế cả tháng − các giảm trừ (không âm). Không cư trú, hợp đồng dưới 3 tháng: các giảm trừ bằng 0 nên bằng Σ thu nhập chịu thuế.
const CODES = ['taxable_income', 'deduction_self', 'deduction_dependents', 'deduction_si', 'deduction_other', 'dependents'];
interface Month { employeeId: number; month: number; gross: Decimal; taxable: Decimal; self: Decimal; dep: Decimal; deps: Decimal; si: Decimal; other: Decimal; pit: Decimal }
const val = (l: LineRec, c: string) => l.v[c] ?? D(0);
function byMonth(lines: LineRec[]): Month[] {
  const m = new Map<string, Month>();
  for (const l of lines) {
    const k = `${l.employeeId}|${l.month}`;
    const c = m.get(k) ?? m.set(k, { employeeId: l.employeeId, month: l.month, gross: D(0), taxable: D(0), self: D(0), dep: D(0), deps: D(0), si: D(0), other: D(0), pit: D(0) }).get(k)!;
    c.gross = c.gross.plus(l.gross); c.taxable = c.taxable.plus(val(l, 'taxable_income')); c.si = c.si.plus(val(l, 'deduction_si')); c.other = c.other.plus(val(l, 'deduction_other')); c.pit = c.pit.plus(l.pit);
    c.self = Decimal.max(c.self, val(l, 'deduction_self')); c.dep = Decimal.max(c.dep, val(l, 'deduction_dependents')); c.deps = Decimal.max(c.deps, val(l, 'dependents'));
  }
  return [...m.values()].sort((a, b) => a.month - b.month);
}
const monthBase = (x: Month) => Decimal.max(x.taxable.minus(x.self).minus(x.dep).minus(x.si).minus(x.other), 0);

interface Emp { code: string; name: string; taxCode: string | null; idNumber: string | null; residency: string; contractType: string; pitAuthorized: boolean }
async function loadPosted(trx: Trx, p: Period, employeeId?: number) {
  const l = await load(trx, { year: p.year, months: p.months, postedOnly: true, ...(employeeId !== undefined && { employeeId }) }, CODES);
  const ids = [...new Set(l.lines.map((x) => x.employeeId))];
  const prof = new Map<number, { tax_residency: string; contract_type: string; pit_authorized: boolean }>();
  for (let i = 0; i < ids.length; i += 5000)
    for (const r of await trx.selectFrom('employee_payroll').select(['employee_id', 'tax_residency', 'contract_type', 'pit_authorized']).where('employee_id', 'in', ids.slice(i, i + 5000)).execute()) prof.set(r.employee_id, r);
  const emps = new Map<number, Emp>();
  for (const x of l.lines) if (!emps.has(x.employeeId)) {
    const pr = prof.get(x.employeeId);
    emps.set(x.employeeId, { code: x.code, name: x.name, taxCode: x.taxCode, idNumber: x.idNumber, residency: pr?.tax_residency ?? 'resident', contractType: pr?.contract_type ?? 'long', pitAuthorized: pr?.pit_authorized ?? false });
  }
  const months = new Map<number, Month[]>();
  for (const m of byMonth(l.lines)) (months.get(m.employeeId) ?? months.set(m.employeeId, []).get(m.employeeId)!).push(m);
  const ordered = [...emps].sort(([, a], [, b]) => a.code.localeCompare(b.code));
  return { emps: ordered, months };
}
// Bảng lương trong kỳ chưa hạch toán (nháp, đã tính): không vào bảng kê, nhắc người dùng.
async function unpostedWarning(trx: Trx, p: Period): Promise<string[]> {
  const n = await trx.selectFrom('payroll_run').select(sql<number>`count(*)::int`.as('n')).where('year', '=', p.year).where('month', 'in', p.months).where('status', 'in', ['draft', 'calculated']).executeTakeFirstOrThrow();
  return n.n ? [`Có ${n.n} bảng lương trong kỳ chưa hạch toán: không đưa vào bảng kê (chỉ lấy bảng lương đã hạch toán).`] : [];
}
async function timingWarning(trx: Trx, date: string): Promise<string[]> {
  const t = await payrollParam<string>(trx, 'pit_income_timing', date).catch((e: unknown) => { if (e instanceof AppError && e.code === 'PAYROLL_PARAM_MISSING') return null; throw e; });
  // shortcut: chỉ tính theo kỳ lương; khi cần theo thời điểm chi trả thì đọc ngày chứng từ chi lương (payroll_run_voucher) thay cho tháng lương.
  return t?.value === 'payment_date' ? ['Tham số pit_income_timing = theo thời điểm chi trả chưa được hỗ trợ: bảng kê đang tính thu nhập theo kỳ lương.'] : [];
}

// ---- Bảng kê khấu trừ ----
export interface WithholdingRow {
  employeeId: number; code: string; name: string; taxCode: string | null; idNumber: string | null; residency: string; contractType: string; months: number;
  taxableIncome: string; exemptIncome: string; deductionSelf: string; deductionDependents: string; deductionSi: string; deductionOther: string; pitBase: string; pit: string;
}
export type OtherRow = { partyCode: string | null; partyName: string | null; taxCode: string | null; pit: string };
const SUM_KEYS = ['taxableIncome', 'exemptIncome', 'deductionSelf', 'deductionDependents', 'deductionSi', 'deductionOther', 'pitBase', 'pit'] as const;

// Thuế TNCN khấu trừ ngoài lương: Có trừ Nợ tài khoản thuế TNCN trên hóa đơn mua dịch vụ/hàng hóa đã ghi sổ (mã TNCN_KT), theo đối tượng.
// shortcut: không có thu nhập trả cho cá nhân (hóa đơn không lưu cơ sở tính TNCN); khi cần, lưu base của dòng thuế TNCN ở hóa đơn.
async function otherWithholding(trx: Trx, p: Period): Promise<OtherRow[]> {
  const regime = await regimeOf(trx, p);
  const pitCodes = [...new Set(payrollAccountMaps(regime).map((m) => m.pit))];
  const r = await sql<{ code: string | null; name: string | null; tax_code: string | null; pit: string }>`
    SELECT pa.code, pa.name, pa.tax_code, sum(l.credit - l.debit)::text AS pit
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN party pa ON pa.id = coalesce(l.party_id, v.party_id)
    WHERE v.state IN ('posted', 'reversed') AND v.voucher_type IN ('HDM', 'MH', 'GGM', 'TLM') AND l.posting_date BETWEEN ${p.from}::date AND ${p.to}::date
      AND (${sql.join(pitCodes.map((c) => sql`a.code LIKE ${c + '%'}`), sql` OR `)})
    GROUP BY 1, 2, 3 HAVING sum(l.credit - l.debit) <> 0 ORDER BY 1`.execute(trx);
  return r.rows.map((x) => ({ partyCode: x.code, partyName: x.name, taxCode: x.tax_code, pit: x.pit }));
}

export async function withholding(trx: Trx, q: { year: number; month?: number | undefined; quarter?: number | undefined }) {
  const p = periodOf(q);
  const { emps, months } = await loadPosted(trx, p);
  const rows: WithholdingRow[] = emps.map(([id, e]) => {
    const ms = months.get(id)!; const t = (f: (m: Month) => Decimal) => s0(sum(ms.map(f)));
    return { employeeId: id, code: e.code, name: e.name, taxCode: e.taxCode, idNumber: e.idNumber, residency: e.residency, contractType: e.contractType, months: ms.length,
      taxableIncome: t((m) => m.taxable), exemptIncome: t((m) => m.gross.minus(m.taxable)), deductionSelf: t((m) => m.self), deductionDependents: t((m) => m.dep),
      deductionSi: t((m) => m.si), deductionOther: t((m) => m.other), pitBase: t(monthBase), pit: t((m) => m.pit) };
  });
  const others = await otherWithholding(trx, p);
  const salaryTotals = Object.fromEntries(SUM_KEYS.map((k) => [k, s0(sum(rows.map((r) => D(r[k]))))])) as Record<(typeof SUM_KEYS)[number], string>;
  const othersPit = sum(others.map((o) => D(o.pit)));
  const totals = { persons: rows.length, ...salaryTotals, othersPit: s0(othersPit), totalPit: s0(D(salaryTotals.pit).plus(othersPit)) };
  const warnings = [...(await unpostedWarning(trx, p)), ...(await timingWarning(trx, p.to))];
  return { year: p.year, periodKind: p.kind, period: p.period, label: p.label, from: p.from, to: p.to, rows, others, totals, warnings, intro: await banner(trx) };
}

// ---- Quyết toán năm (tổ chức quyết toán thay) ----
// Chỉ quyết toán thay cho người cư trú, hợp đồng từ 3 tháng, có ủy quyền (employee_payroll.pit_authorized); người không ủy quyền (có thu nhập nơi khác) tự quyết toán.
// Biểu thuế năm pit_brackets_annual và giảm trừ pit_deduction lấy tại ngày 31/12 (D13); số tháng giảm trừ bản thân = số tháng công ty đã tính giảm trừ bản thân.
export interface SettlementRow {
  employeeId: number; code: string; name: string; taxCode: string | null; residency: string; contractType: string; pitAuthorized: boolean; eligible: boolean; excludeReason: string | null; months: number;
  taxableIncome: string; deductionSelf: string | null; deductionDependents: string | null; deductionSi: string | null; deductionOther: string | null; pitBase: string | null; pitDue: string | null; pitWithheld: string; difference: string | null;
}
export async function settlement(trx: Trx, q: { year: number }) {
  const p = periodOf({ year: q.year });
  const { emps, months } = await loadPosted(trx, p);
  const end = `${q.year}-12-31`; const warnings = [...(await unpostedWarning(trx, p)), ...(await timingWarning(trx, end))];
  let params: { brackets: PitBracket[]; deduction: { self: string; dependent: string } } | undefined;
  const rows: SettlementRow[] = [];
  for (const [id, e] of emps) {
    const ms = months.get(id)!;
    const base = { employeeId: id, code: e.code, name: e.name, taxCode: e.taxCode, residency: e.residency, contractType: e.contractType, pitAuthorized: e.pitAuthorized, months: ms.length,
      taxableIncome: s0(sum(ms.map((m) => m.taxable))), pitWithheld: s0(sum(ms.map((m) => m.pit))) };
    const excludeReason = e.residency !== 'resident' || e.contractType !== 'long' ? 'Không cư trú hoặc hợp đồng dưới 3 tháng: không quyết toán thay'
      : !e.pitAuthorized ? 'Không ủy quyền quyết toán (có thu nhập nơi khác): cá nhân tự quyết toán' : null;
    if (excludeReason) { rows.push({ ...base, eligible: false, excludeReason, deductionSelf: null, deductionDependents: null, deductionSi: null, deductionOther: null, pitBase: null, pitDue: null, difference: null }); continue; }
    params ??= { brackets: (await payrollParam<PitBracket[]>(trx, 'pit_brackets_annual', end)).value, deduction: (await payrollParam<{ self: string; dependent: string }>(trx, 'pit_deduction', end)).value };
    const input: PitAnnualMonth[] = ms.map((m) => ({ taxableIncome: m.taxable.toString(), siEmployee: m.si.toString(), otherRelief: m.other.toString(), dependents: m.deps.toNumber(), pitWithheld: m.pit.toString() }));
    const r = pitAnnualSettlement(input, params, { selfMonths: ms.filter((m) => m.self.gt(0)).length });
    if (!D(r.deductionSelf).plus(r.deductionDependents).eq(sum(ms.map((m) => m.self.plus(m.dep)))))
      warnings.push(`${e.code} ${e.name}: giảm trừ gia cảnh cả năm theo tham số ngày ${vnDate(end)} khác tổng giảm trừ đã tính hằng tháng (tham số đổi trong năm?): kiểm tra trước khi chốt.`);
    rows.push({ ...base, eligible: true, excludeReason: null, deductionSelf: r.deductionSelf, deductionDependents: r.deductionDependents, deductionSi: r.deductionSi, deductionOther: r.deductionOther,
      pitBase: r.pitBase, pitDue: r.pitDue, difference: r.difference });
  }
  const el = rows.filter((r) => r.eligible); const diff = el.map((r) => D(r.difference!));
  const totals = { persons: rows.length, settled: el.length, excluded: rows.length - el.length, taxableIncome: s0(sum(el.map((r) => D(r.taxableIncome)))), pitDue: s0(sum(el.map((r) => D(r.pitDue!)))),
    pitWithheld: s0(sum(el.map((r) => D(r.pitWithheld)))), payable: s0(sum(diff.filter((x) => x.gt(0)))), refund: s0(sum(diff.filter((x) => x.lt(0))).neg()) };
  return { year: q.year, periodKind: 'year' as const, period: 1, label: p.label, from: p.from, to: p.to, rows, totals, warnings, intro: await banner(trx) };
}

// ---- Chứng từ khấu trừ thuế TNCN cấp cho cá nhân (tổng hợp theo năm; không in số mẫu, ký hiệu: chưa có văn bản gốc mẫu) ----
export async function certificates(trx: Trx, q: z.infer<typeof certificateQuery>) {
  const p = periodOf({ year: q.year });
  const { emps, months } = await loadPosted(trx, p, q.employeeId);
  if (q.employeeId !== undefined && !emps.length) throw new AppError('PIT_CERTIFICATE_EMPTY', 'Nhân viên không có bảng lương đã hạch toán trong năm', 404);
  return { year: q.year, intro: await banner(trx), items: emps.map(([id, e]) => {
    const ms = months.get(id)!;
    return { employeeId: id, code: e.code, name: e.name, taxCode: e.taxCode, idNumber: e.idNumber, residency: e.residency,
      months: ms.map((m) => ({ month: m.month, taxableIncome: s0(m.taxable), pit: s0(m.pit) })), taxableIncome: s0(sum(ms.map((m) => m.taxable))), pit: s0(sum(ms.map((m) => m.pit))) };
  }) };
}

// ---- Tài liệu in / Excel ----
const RES: Record<string, string> = { resident: 'Cư trú', non_resident: 'Không cư trú' };
const CT: Record<string, string> = { long: 'HĐ từ 3 tháng', short: 'HĐ dưới 3 tháng', none: 'Không HĐ' };
const num = (key: string, label: string): ReportColumn => ({ key, label, type: 'number' });
const NOTE = 'Bảng kê số liệu nguồn từ bảng lương đã hạch toán. Chưa phải tờ khai theo mẫu TT 89/2026 (Phụ lục I): mẫu chưa được nhập từ văn bản gốc.';
async function company(trx: Trx, tenantId: string, p: { from: string; to: string }) { return companyInfo(trx, tenantId, await regimeOf(trx, p), null); }
const stt = <T extends object>(rows: T[]) => rows.map((r, i) => ({ stt: i + 1, ...r }));

export async function withholdingDocs(trx: Trx, tenantId: string, w: Awaited<ReturnType<typeof withholding>>): Promise<ReportDoc[]> {
  const c = await company(trx, tenantId, w);
  const main: ReportDoc = {
    title: 'Bảng kê thu nhập chịu thuế và thuế thu nhập cá nhân đã khấu trừ', subtitle: w.label, sheetName: 'Bang ke TNCN', company: c, formNo: '', issuedBy: '', landscape: true,
    intro: [...w.intro, NOTE, ...w.warnings],
    columns: [{ key: 'stt', label: 'STT', width: '4%' }, { key: 'code', label: 'Mã NV', width: '7%' }, { key: 'name', label: 'Họ và tên' }, { key: 'taxCode', label: 'Mã số thuế', width: '9%' }, { key: 'status', label: 'Cư trú, hợp đồng', width: '10%' },
      num('taxableIncome', 'Thu nhập chịu thuế'), num('exemptIncome', 'Thu nhập miễn thuế'), num('deductionSelf', 'Giảm trừ bản thân'), num('deductionDependents', 'Giảm trừ người phụ thuộc'),
      num('deductionSi', 'Bảo hiểm bắt buộc'), num('deductionOther', 'Giảm trừ khác'), num('pitBase', 'Thu nhập tính thuế'), num('pit', 'Thuế TNCN đã khấu trừ')],
    rows: stt(w.rows.map((r) => ({ ...r, taxCode: r.taxCode ?? '', status: `${RES[r.residency] ?? r.residency}, ${CT[r.contractType] ?? r.contractType}` }))),
    footer: { name: 'Cộng', ...w.totals },
  };
  if (!w.others.length) return [main];
  return [main, { title: 'Thuế thu nhập cá nhân khấu trừ ngoài lương (hóa đơn mua dịch vụ)', subtitle: w.label, sheetName: 'Khau tru ngoai luong', company: c, formNo: '', issuedBy: '',
    columns: [{ key: 'stt', label: 'STT', width: '5%' }, { key: 'partyCode', label: 'Mã đối tượng', width: '12%' }, { key: 'partyName', label: 'Tên cá nhân' }, { key: 'taxCode', label: 'Mã số thuế', width: '14%' }, num('pit', 'Thuế TNCN đã khấu trừ')],
    rows: stt(w.others), footer: { partyName: 'Cộng', pit: w.totals.othersPit } }];
}
export async function settlementDocs(trx: Trx, tenantId: string, s: Awaited<ReturnType<typeof settlement>>): Promise<ReportDoc[]> {
  return [{
    title: 'Bảng quyết toán thuế thu nhập cá nhân thay cho người lao động', subtitle: s.label, sheetName: 'Quyet toan TNCN', company: await company(trx, tenantId, s), formNo: '', issuedBy: '', landscape: true,
    intro: [...s.intro, 'Số liệu nguồn từ bảng lương đã hạch toán, biểu thuế năm và giảm trừ theo tham số lương ngày 31/12. Chưa phải mẫu 05/QTT-TNCN theo TT 89/2026.', ...s.warnings],
    columns: [{ key: 'stt', label: 'STT', width: '4%' }, { key: 'code', label: 'Mã NV', width: '7%' }, { key: 'name', label: 'Họ và tên' }, { key: 'taxCode', label: 'Mã số thuế', width: '9%' },
      num('taxableIncome', 'Thu nhập chịu thuế'), num('deductionSelf', 'Giảm trừ bản thân'), num('deductionDependents', 'Giảm trừ người phụ thuộc'), num('deductionSi', 'Bảo hiểm bắt buộc'),
      num('deductionOther', 'Giảm trừ khác'), num('pitBase', 'Thu nhập tính thuế'), num('pitDue', 'Thuế phải nộp cả năm'), num('pitWithheld', 'Thuế đã khấu trừ'), num('difference', 'Còn phải nộp (+) / nộp thừa (-)'),
      { key: 'note', label: 'Ghi chú', width: '14%' }],
    rows: stt(s.rows.map((r) => ({ ...r, taxCode: r.taxCode ?? '', note: r.excludeReason ?? '' }))),
    footer: { name: 'Cộng (người được quyết toán thay)', taxableIncome: s.totals.taxableIncome, pitDue: s.totals.pitDue, pitWithheld: s.totals.pitWithheld },
  }];
}
export async function certificateDocs(trx: Trx, tenantId: string, d: Awaited<ReturnType<typeof certificates>>): Promise<ReportDoc[]> {
  const c = await company(trx, tenantId, periodOf({ year: d.year }));
  return d.items.map((x) => ({
    title: 'Chứng từ khấu trừ thuế thu nhập cá nhân', subtitle: `Năm ${d.year}`, company: c, formNo: '', issuedBy: '',
    intro: [...d.intro, `Tổ chức trả thu nhập: ${c.name}${c.taxCode ? ` – Mã số thuế: ${c.taxCode}` : ''}`, `Người nộp thuế: ${x.name} (${x.code})${x.taxCode ? ` – Mã số thuế: ${x.taxCode}` : ''}${x.idNumber ? ` – Số định danh: ${x.idNumber}` : ''}`,
      `Cá nhân ${x.residency === 'resident' ? 'cư trú' : 'không cư trú'}`],
    columns: [{ key: 'label', label: 'Tháng' }, num('taxableIncome', 'Thu nhập chịu thuế đã trả'), num('pit', 'Số thuế TNCN đã khấu trừ')],
    rows: x.months.map((m) => ({ label: `Tháng ${String(m.month).padStart(2, '0')}/${d.year}`, taxableIncome: m.taxableIncome, pit: m.pit })),
    footer: { label: 'Cộng', taxableIncome: x.taxableIncome, pit: x.pit },
    outro: ['Bản tổng hợp do phần mềm lập, không có mẫu số, ký hiệu, số chứng từ: mẫu chứng từ khấu trừ thuế TNCN chưa được nhập từ văn bản gốc.'],
    signers: [{ title: 'Đại diện tổ chức trả thu nhập' }],
  }));
}

// ---- Tờ khai 05/KK-TNCN (tháng/quý), 05/QTT-TNCN (năm) trong tax_return ----
export const TNCN_FORMS = { '05/KK-TNCN': { gate: '05KK', kinds: ['month', 'quarter'] }, '05/QTT-TNCN': { gate: '05QTT', kinds: ['year'] } } as const;
export type TncnForm = keyof typeof TNCN_FORMS;
const FORM_CODES = Object.keys(TNCN_FORMS) as TncnForm[];
const TEMPLATE = 'BANG_KE'; // chưa có mẫu: tờ khai chỉ lưu bảng kê số liệu nguồn
export function assertTncnTemplate(form: TncnForm) {
  if (!isTncnTemplateComplete(TNCN_FORMS[form].gate))
    throw new AppError('TNCN_TEMPLATE_UNAVAILABLE', `Chưa có mẫu tờ khai ${form} theo TT 89/2026 (Phụ lục I) đối chiếu văn bản gốc (status.json ${TNCN_FORMS[form].gate}_TNCN_TT89): xuất bảng kê Excel`, 409);
}
export const formOfDocKind = (k: string): TncnForm | null => (k === '05kk_tncn' ? '05/KK-TNCN' : k === '05qtt_tncn' ? '05/QTT-TNCN' : null);

export const tncnReturnInput = z.object({ formCode: z.enum(FORM_CODES as [TncnForm, ...TncnForm[]]), year: z.number().int().min(2000).max(2100), periodKind: z.enum(['month', 'quarter', 'year']), period: z.number().int().min(1).max(12),
  revision: z.number().int().min(0).optional() }).strict();
export const tncnListQuery = z.object({ year: year.optional(), formCode: z.enum(FORM_CODES as [TncnForm, ...TncnForm[]]).optional() });
const lock = (trx: Trx, tenantId: string) => sql`SELECT pg_advisory_xact_lock(hashtext('tax_return'), hashtext(${tenantId}::text))`.execute(trx);

async function compute(trx: Trx, form: TncnForm, y: number, kind: PeriodKind, period: number) {
  if (!(TNCN_FORMS[form].kinds as readonly string[]).includes(kind) || (kind === 'quarter' && period > 4) || (kind === 'year' && period !== 1))
    throw new AppError('VALIDATION', form === '05/QTT-TNCN' ? 'Tờ khai quyết toán 05/QTT-TNCN lập theo năm (period 1)' : 'Tờ khai 05/KK-TNCN lập theo tháng (1–12) hoặc quý (1–4)', 400);
  const r = form === '05/QTT-TNCN' ? await settlement(trx, { year: y }) : await withholding(trx, { year: y, ...(kind === 'month' ? { month: period } : { quarter: period }) });
  return { ...r, intro: undefined }; // intro (dòng "Dữ liệu minh họa") tính lại khi in, không lưu vào tờ khai
}

const COLS = ['id', 'form_code', 'template_version', 'period_kind', 'year', 'period', 'revision', 'status', 'values', 'created_at', 'finalized_at'] as const;
interface Row { id: number; form_code: string; template_version: string; period_kind: string; year: number; period: number; revision: number; status: string; values: unknown; created_at: string; finalized_at: string | null }
const dto = (r: Row) => ({ id: r.id, formCode: r.form_code as TncnForm, templateVersion: r.template_version, periodKind: r.period_kind as PeriodKind, year: r.year, period: r.period, revision: r.revision,
  status: r.status as 'draft' | 'final', values: r.values as Awaited<ReturnType<typeof compute>>, createdAt: r.created_at, finalizedAt: r.finalized_at });
async function rowOf(trx: Trx, id: number, forUpdate = false): Promise<Row> {
  let q = trx.selectFrom('tax_return').select(COLS).where('id', '=', id).where('form_code', 'in', FORM_CODES);
  if (forUpdate) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw new AppError('TAX_RETURN_NOT_FOUND', 'Không tìm thấy tờ khai', 404);
  return r as Row;
}
export const getTncnReturn = async (trx: Trx, id: number) => dto(await rowOf(trx, id));
export async function listTncnReturns(trx: Trx, q: z.infer<typeof tncnListQuery>) {
  const rows = await trx.selectFrom('tax_return').select(COLS).where('form_code', 'in', q.formCode ? [q.formCode] : FORM_CODES).$if(q.year !== undefined, (b) => b.where('year', '=', q.year!))
    .orderBy('year', 'desc').orderBy('period', 'desc').orderBy('form_code').orderBy('revision', 'desc').execute();
  // Danh sách không kèm bảng kê từng người (nặng): chỉ tổng.
  return rows.map((r) => { const d = dto(r as Row); return { ...d, values: { totals: d.values.totals } }; });
}

// Lập lần đầu (revision 0) hoặc bổ sung (revision n + 1) khi bản trước đã chốt; nháp chỉ có một (như 01/GTGT, 03/TNDN).
export async function createTncnReturn(trx: Trx, ctx: { tenantId: string; userId: string }, b: z.infer<typeof tncnReturnInput>) {
  await lock(trx, ctx.tenantId);
  const latest = await trx.selectFrom('tax_return').select(['id', 'revision', 'status']).where('form_code', '=', b.formCode).where('year', '=', b.year).where('period_kind', '=', b.periodKind).where('period', '=', b.period)
    .orderBy('revision', 'desc').executeTakeFirst();
  if (latest?.status === 'draft') throw new AppError('TAX_RETURN_DRAFT_EXISTS', `Kỳ này đã có tờ khai nháp${latest.revision ? ` bổ sung lần ${latest.revision}` : ''}: tính lại hoặc chốt tờ khai đó`, 409, { id: latest.id });
  const revision = latest ? latest.revision + 1 : 0;
  if (b.revision !== undefined && b.revision !== revision) throw new AppError('TAX_RETURN_REVISION', revision === 0 ? 'Kỳ này chưa có tờ khai: lập lần đầu (revision 0)' : `Lần bổ sung tiếp theo của kỳ này là lần ${revision}`, 409);
  const values = await compute(trx, b.formCode, b.year, b.periodKind, b.period);
  const r = await trx.insertInto('tax_return').values({ tenant_id: ctx.tenantId, form_code: b.formCode, template_version: TEMPLATE, period_kind: b.periodKind, year: b.year, period: b.period, revision,
    values: JSON.stringify(values), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow()
    .catch((e: { code?: string; constraint?: string }) => { throw e.code === '23505' && e.constraint?.startsWith('tax_return_tenant_id_form_code') ? new AppError('TAX_RETURN_DRAFT_EXISTS', 'Kỳ này vừa có tờ khai được lập, tải lại danh sách', 409) : e; });
  return getTncnReturn(trx, r.id);
}
async function draftOf(trx: Trx, tenantId: string, id: number): Promise<Row> {
  await lock(trx, tenantId);
  const r = await rowOf(trx, id, true);
  if (r.status === 'final') throw new AppError('TAX_RETURN_FINAL', 'Tờ khai đã chốt, không sửa được; lập tờ khai bổ sung', 409);
  return r;
}
// Tính lại nháp theo bảng lương hiện tại (tờ khai TNCN không có chỉ tiêu nhập tay).
export async function refreshTncnReturn(trx: Trx, tenantId: string, id: number) {
  const r = await draftOf(trx, tenantId, id);
  const values = await compute(trx, r.form_code as TncnForm, r.year, r.period_kind as PeriodKind, r.period);
  await trx.updateTable('tax_return').set({ values: JSON.stringify(values) }).where('id', '=', id).execute();
  return getTncnReturn(trx, id);
}
export async function deleteTncnReturn(trx: Trx, tenantId: string, id: number) {
  await draftOf(trx, tenantId, id);
  await trx.deleteFrom('tax_return').where('id', '=', id).execute();
}
// Chốt: số tính lại phải khớp số đã lưu (bảng lương đổi sau lần tính trước thì 409 TAX_RETURN_STALE).
export async function finalizeTncnReturn(trx: Trx, ctx: { tenantId: string; userId: string }, id: number) {
  const r = await draftOf(trx, ctx.tenantId, id);
  const values = await compute(trx, r.form_code as TncnForm, r.year, r.period_kind as PeriodKind, r.period);
  const saved = r.values as typeof values;
  if (!isDeepStrictEqual(saved.rows, values.rows) || !isDeepStrictEqual(saved.totals, values.totals))
    throw new AppError('TAX_RETURN_STALE', 'Bảng lương đã thay đổi kể từ lần tính trước: tính lại tờ khai và kiểm tra trước khi chốt', 409);
  await trx.updateTable('tax_return').set({ status: 'final', finalized_by: ctx.userId, finalized_at: sql<string>`now()` }).where('id', '=', id).execute();
  return getTncnReturn(trx, id);
}
// XML theo mẫu chỉ khi cổng mẫu bật; hiện chưa có mẫu nên luôn 409.
export async function renderTncnXml(trx: Trx, id: number): Promise<never> {
  const r = await rowOf(trx, id);
  assertTncnTemplate(r.form_code as TncnForm);
  // shortcut: cổng chỉ bật được khi đã nhập chỉ tiêu mẫu từ văn bản gốc; lúc đó dựng bộ XML theo khuôn tax/xml/htkk03tndn.ts.
  throw new AppError('TNCN_TEMPLATE_UNAVAILABLE', `Chưa có định dạng XML cho tờ khai ${r.form_code}`, 409);
}
