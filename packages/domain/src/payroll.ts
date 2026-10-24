import { D, Decimal } from './money.js';
import { PayrollError, evaluatePayrollFormula, payrollFormulaRefs, parsePayrollFormula, type FormulaNode } from './payrollFormula.js';

export { PayrollError } from './payrollFormula.js';

// Động cơ tính lương thuần (GĐ6 Task 2). Không có giá trị pháp lý nào trong mã: thuế suất, giảm trừ, tỷ lệ/trần/sàn bảo hiểm, hệ số làm thêm
// đều đến qua đối số (tham số công ty/legal_param, Quy ước 1). Tiền là chuỗi số nguyên đồng; làm tròn đồng nửa lên một lần ở cuối mỗi cột.

// ---- Hình dạng tham số: trùng lược đồ zod ở apps/api/src/modules/payroll/params.ts ----
export interface PitBracket { upTo: string | null; rate: number | string }
export interface SiRates {
  employee: { si: number | string; hi: number | string; ui: number | string };
  employer: { si: number | string; hi: number | string; ui: number | string; occupational: number | string; union?: number | string; union_fee?: number | string };
  parts?: Record<string, number | string>;
}
export interface OtMultipliers { weekday: number | string; weekly_rest: number | string; holiday: number | string }
export type MinWageRegion = 'I' | 'II' | 'III' | 'IV';
export interface RawPayrollParams {
  pit_brackets?: PitBracket[];
  pit_brackets_annual?: PitBracket[];
  pit_deduction?: { self: string; dependent: string };
  si_rates?: SiRates;
  si_ceiling?: { si_base_max?: string; si_base_max_multiple_of_min_wage?: number; ui_base_max_multiple_of_min_wage?: number };
  si_floor?: { si_base_min?: string; si_base_min_multiple_of_min_wage?: number };
  min_wage_region?: Record<MinWageRegion, string>;
  ot_multipliers?: OtMultipliers;
  ot_tax_exempt_extra?: boolean;
  pit_non_resident_rate?: { rate: number | string };
  pit_flat_rate_no_contract?: { rate: number | string };
}

// Tham số đã quy về số tiền theo vùng; thiếu trường nào thì chỉ lỗi khi phép tính thật sự cần (PAYROLL_PARAM_MISSING nêu mã tham số).
export interface ResolvedParams {
  pitBrackets?: PitBracket[];
  pitBracketsAnnual?: PitBracket[];
  pitDeduction?: { self: string; dependent: string };
  siRates?: SiRates;
  siCeiling?: string;
  uiCeiling?: string; // không có thì BHTN dùng chung trần BHXH
  siFloor?: string;
  minWage?: string;
  otMultipliers?: OtMultipliers;
  otTaxExemptExtra?: boolean;
  pitNonResidentRate?: number | string;
  pitFlatRateNoContract?: number | string;
  constants?: Record<string, string>; // hằng công ty cho PARAM('...')
}

const missing = (param: string, column?: string): never => {
  throw new PayrollError('PAYROLL_PARAM_MISSING', `Chưa có tham số "${param}"`, column, param);
};

// Ánh xạ giá trị tham số (lược đồ zod của API) sang ResolvedParams. Trần/sàn theo bội số lương tối thiểu cần min_wage_region và vùng.
export function resolvePayrollParams(raw: RawPayrollParams, region?: MinWageRegion): ResolvedParams {
  const wage = () => (region && raw.min_wage_region?.[region]) ?? missing('min_wage_region');
  const times = (m: number) => D(wage()).times(m).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString();
  const c = raw.si_ceiling; const f = raw.si_floor;
  const r: ResolvedParams = {};
  if (raw.pit_brackets) r.pitBrackets = raw.pit_brackets;
  if (raw.pit_brackets_annual) r.pitBracketsAnnual = raw.pit_brackets_annual;
  if (raw.pit_deduction) r.pitDeduction = raw.pit_deduction;
  if (raw.si_rates) r.siRates = raw.si_rates;
  if (c?.si_base_max !== undefined) r.siCeiling = c.si_base_max;
  else if (c?.si_base_max_multiple_of_min_wage !== undefined) r.siCeiling = times(c.si_base_max_multiple_of_min_wage);
  if (c?.ui_base_max_multiple_of_min_wage !== undefined) r.uiCeiling = times(c.ui_base_max_multiple_of_min_wage);
  if (f?.si_base_min !== undefined) r.siFloor = f.si_base_min;
  else if (f?.si_base_min_multiple_of_min_wage !== undefined) r.siFloor = times(f.si_base_min_multiple_of_min_wage);
  if (region && raw.min_wage_region) r.minWage = raw.min_wage_region[region];
  if (raw.ot_multipliers) r.otMultipliers = raw.ot_multipliers;
  if (raw.ot_tax_exempt_extra !== undefined) r.otTaxExemptExtra = raw.ot_tax_exempt_extra;
  if (raw.pit_non_resident_rate) r.pitNonResidentRate = raw.pit_non_resident_rate.rate;
  if (raw.pit_flat_rate_no_contract) r.pitFlatRateNoContract = raw.pit_flat_rate_no_contract.rate;
  return r;
}

const R0 = (x: Decimal) => x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const pct = (base: Decimal, rate: number | string | undefined) => base.times(D(rate ?? 0)).div(100);
const num = (v: string | undefined, what: string): Decimal => {
  if (v === undefined || v === '') return new Decimal(0);
  try { return D(v); } catch { throw new PayrollError('PAYROLL_INPUT_INVALID', `Giá trị không hợp lệ ở "${what}": ${v}`, what); }
};

// ---- TNCN lũy tiến từng phần ----
export interface PitBreakdown { from: string; to: string | null; rate: string; amount: string; tax: string }

function checkBrackets(b: PitBracket[]) {
  const bad = !b.length || b[b.length - 1]!.upTo !== null || b.slice(0, -1).some((x, i) => x.upTo === null || (i > 0 && D(x.upTo).lte(D(b[i - 1]!.upTo!))));
  if (bad) throw new PayrollError('PAYROLL_PARAM_INVALID', 'Biểu thuế lũy tiến phải có mức trần tăng dần và bậc cuối không giới hạn', undefined, 'pit_brackets');
}

// Thuế từng bậc không làm tròn; tổng làm tròn một lần. Thuế mỗi bậc trong breakdown = làm tròn(lũy kế đến bậc) − làm tròn(lũy kế bậc trước), nên Σ = tổng.
export function pitProgressive(taxable: string, brackets: PitBracket[]): { tax: string; breakdown: PitBreakdown[] } {
  checkBrackets(brackets);
  const x = D(taxable);
  const breakdown: PitBreakdown[] = [];
  let lo = new Decimal(0); let cum = new Decimal(0); let cumRounded = new Decimal(0);
  for (const b of brackets) {
    if (x.lte(lo)) break;
    const hi = b.upTo === null ? x : Decimal.min(x, D(b.upTo));
    const amount = hi.minus(lo);
    cum = cum.plus(pct(amount, b.rate));
    const r = R0(cum);
    breakdown.push({ from: lo.toString(), to: b.upTo, rate: D(b.rate).toString(), amount: amount.toString(), tax: r.minus(cumRounded).toString() });
    cumRounded = r;
    if (b.upTo === null) break;
    lo = D(b.upTo);
  }
  return { tax: cumRounded.toString(), breakdown };
}

// ---- Bảo hiểm bắt buộc ----
export interface SiFlags { si: boolean; hi: boolean; ui: boolean; occupational: boolean }
export interface SiResult { base: string; uiBase: string; employee: Record<'si' | 'hi' | 'ui', string>; employer: Record<'si' | 'hi' | 'ui' | 'occupational', string> }

// Mức đóng = min(max(lương đóng, sàn), trần); BHTN có trần riêng (uiCeiling, không có thì dùng trần chung). Không tham gia loại nào thì mức đóng 0.
export function siContributions(base: string, p: { rates: SiRates; ceiling: string; floor?: string; uiCeiling?: string }, flags: SiFlags): SiResult {
  const any = flags.si || flags.hi || flags.ui || flags.occupational;
  const raw = D(base);
  const floored = p.floor ? Decimal.max(raw, D(p.floor)) : raw;
  const b = any ? Decimal.min(floored, D(p.ceiling)) : new Decimal(0);
  const ub = any ? Decimal.min(floored, D(p.uiCeiling ?? p.ceiling)) : new Decimal(0);
  const c = (on: boolean, x: Decimal, rate: number | string | undefined) => (on ? R0(pct(x, rate)) : new Decimal(0)).toString();
  const e = p.rates.employee; const r = p.rates.employer;
  return {
    base: b.toString(), uiBase: ub.toString(),
    employee: { si: c(flags.si, b, e.si), hi: c(flags.hi, b, e.hi), ui: c(flags.ui, ub, e.ui) },
    employer: { si: c(flags.si, b, r.si), hi: c(flags.hi, b, r.hi), ui: c(flags.ui, ub, r.ui), occupational: c(flags.occupational, b, r.occupational) },
  };
}

// ---- Làm thêm giờ ----
// Đơn giá giờ = hourlyRate ÷ per (truyền lương tháng và số giờ chuẩn tháng làm per để không làm tròn đơn giá).
// 'full': trả cả phần giờ thường (giờ làm thêm chưa có trong lương ngày công); 'extra_only': chỉ phần chênh lệch (giờ đã tính trong ngày công).
// Phần chênh lệch so với giờ thường không chịu thuế chỉ khi taxExemptExtra (tham số ot_tax_exempt_extra do người dùng nhập).
export function overtimePay(hourlyRate: string, hours: { weekday: string; rest: string; holiday: string }, mult: OtMultipliers, mode: 'full' | 'extra_only', taxExemptExtra: boolean, per = '1'): { pay: string; taxExempt: string } {
  const h = [D(hours.weekday), D(hours.rest), D(hours.holiday)];
  const m = [D(mult.weekday), D(mult.weekly_rest), D(mult.holiday)];
  const extra = h.reduce((s, x, i) => s.plus(x.times(m[i]!.minus(1))), new Decimal(0));
  const weighted = mode === 'full' ? h.reduce((s, x, i) => s.plus(x.times(m[i]!)), new Decimal(0)) : extra;
  const rate = D(hourlyRate);
  return { pay: R0(rate.times(weighted).div(D(per))).toString(), taxExempt: taxExemptExtra ? R0(rate.times(extra).div(D(per))).toString() : '0' };
}

// ---- Ngày công ----
export type AttendanceKind = 'work_day' | 'half_day' | 'hour' | 'ot_weekday_hour' | 'ot_rest_hour' | 'ot_holiday_hour' | 'paid_leave' | 'sick_leave' | 'unpaid_leave' | 'holiday';
export interface WorkDaysSummary { workDays: string; paidLeave: string; sickLeave: string; unpaidLeave: string; holiday: string; otWeekdayHours: string; otRestHours: string; otHolidayHours: string }

// Quy về ngày công: ngày = 1, buổi = 0,5, giờ ÷ giờ chuẩn/ngày (không làm tròn; nơi lưu tự làm tròn theo cột).
export function workDays(entries: { kind: AttendanceKind; qty: string }[], standardHoursPerDay: string): WorkDaysSummary {
  const t: Record<keyof WorkDaysSummary, Decimal> = { workDays: new Decimal(0), paidLeave: new Decimal(0), sickLeave: new Decimal(0), unpaidLeave: new Decimal(0), holiday: new Decimal(0), otWeekdayHours: new Decimal(0), otRestHours: new Decimal(0), otHolidayHours: new Decimal(0) };
  const key: Record<AttendanceKind, keyof WorkDaysSummary> = { work_day: 'workDays', half_day: 'workDays', hour: 'workDays', ot_weekday_hour: 'otWeekdayHours', ot_rest_hour: 'otRestHours', ot_holiday_hour: 'otHolidayHours', paid_leave: 'paidLeave', sick_leave: 'sickLeave', unpaid_leave: 'unpaidLeave', holiday: 'holiday' };
  for (const e of entries) {
    const q = D(e.qty);
    t[key[e.kind]] = t[key[e.kind]].plus(e.kind === 'half_day' ? q.div(2) : e.kind === 'hour' ? q.div(D(standardHoursPerDay)) : q);
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toString()])) as unknown as WorkDaysSummary;
}

export type ProrationMode = 'calendar' | 'standard_26' | 'standard_22' | 'fixed';
const divisor = (mode: ProrationMode, standardDays: string) => (mode === 'standard_26' ? new Decimal(26) : mode === 'standard_22' ? new Decimal(22) : D(standardDays));

// 'calendar': chia cho số ngày công chuẩn của tháng theo lịch công ty (standardDays); 'standard_26'/'standard_22': chia 26/22; 'fixed': lương khoán cả tháng.
export function prorate(monthlySalary: string, days: string, standardDays: string, mode: ProrationMode): string {
  if (mode === 'fixed') return D(monthlySalary).toString();
  const d = divisor(mode, standardDays);
  if (d.isZero()) throw new PayrollError('PAYROLL_INPUT_INVALID', 'Số ngày công chuẩn phải lớn hơn 0', 'std_days');
  return R0(D(monthlySalary).times(D(days)).div(d)).toString();
}

// ---- Cấu trúc bảng lương ----
export interface PayrollColumn {
  code: string; name: string; kind: 'builtin' | 'input' | 'formula';
  formula?: string;
  round?: number; // số chữ số thập phân khi làm tròn cuối cột (mặc định 0 = đồng)
  income?: boolean; // cộng vào Tổng thu nhập
  taxable?: boolean; // với cột thu nhập: false = không chịu thuế (mặc định chịu thuế)
  siBase?: boolean; // cộng vào lương đóng bảo hiểm
  pitRelief?: boolean; // giảm trừ khác khi tính thuế (từ thiện, hưu trí tự nguyện…)
  deduct?: boolean; // khấu trừ khác vào thực lĩnh
}
export interface PayrollStructure { columns: PayrollColumn[] }

// Cột dựng sẵn: mã, tên, số chữ số làm tròn. Người dùng thêm cột input/formula; cột trùng mã builtin mà kind khác 'builtin' là ghi đè cách tính cột đó.
export const PAYROLL_BUILTIN_COLUMNS: { code: string; name: string; round: number }[] = [
  { code: 'std_days', name: 'Ngày công chuẩn', round: 2 },
  { code: 'work_days', name: 'Ngày công hưởng lương', round: 2 },
  { code: 'base_salary', name: 'Lương theo ngày công', round: 0 },
  { code: 'allowances', name: 'Phụ cấp', round: 0 },
  { code: 'allowances_exempt', name: 'Phụ cấp không chịu thuế', round: 0 },
  { code: 'ot_weekday_hours', name: 'Giờ làm thêm ngày thường', round: 2 },
  { code: 'ot_rest_hours', name: 'Giờ làm thêm ngày nghỉ', round: 2 },
  { code: 'ot_holiday_hours', name: 'Giờ làm thêm ngày lễ', round: 2 },
  { code: 'ot_pay', name: 'Tiền lương làm thêm giờ', round: 0 },
  { code: 'ot_exempt', name: 'Làm thêm giờ không chịu thuế', round: 0 },
  { code: 'other_income', name: 'Thu nhập khác', round: 0 },
  { code: 'other_income_exempt', name: 'Thu nhập khác không chịu thuế', round: 0 },
  { code: 'gross', name: 'Tổng thu nhập', round: 0 },
  { code: 'si_base', name: 'Lương đóng BHXH, BHYT', round: 0 },
  { code: 'ui_base', name: 'Lương đóng BHTN', round: 0 },
  { code: 'si_emp_si', name: 'BHXH người lao động', round: 0 },
  { code: 'si_emp_hi', name: 'BHYT người lao động', round: 0 },
  { code: 'si_emp_ui', name: 'BHTN người lao động', round: 0 },
  { code: 'si_emp', name: 'Bảo hiểm người lao động', round: 0 },
  { code: 'si_er_si', name: 'BHXH doanh nghiệp', round: 0 },
  { code: 'si_er_hi', name: 'BHYT doanh nghiệp', round: 0 },
  { code: 'si_er_ui', name: 'BHTN doanh nghiệp', round: 0 },
  { code: 'si_er_occ', name: 'BH tai nạn lao động, bệnh nghề nghiệp', round: 0 },
  { code: 'si_er', name: 'Bảo hiểm doanh nghiệp', round: 0 },
  { code: 'union_er', name: 'Kinh phí công đoàn', round: 0 },
  { code: 'union_fee', name: 'Đoàn phí công đoàn', round: 0 },
  { code: 'taxable_income', name: 'Thu nhập chịu thuế', round: 0 },
  { code: 'dependents', name: 'Số người phụ thuộc', round: 0 },
  { code: 'deduction_self', name: 'Giảm trừ bản thân', round: 0 },
  { code: 'deduction_dependents', name: 'Giảm trừ người phụ thuộc', round: 0 },
  { code: 'deduction_si', name: 'Giảm trừ bảo hiểm bắt buộc', round: 0 },
  { code: 'deduction_other', name: 'Giảm trừ khác', round: 0 },
  { code: 'pit_base', name: 'Thu nhập tính thuế', round: 0 },
  { code: 'pit', name: 'Thuế TNCN khấu trừ', round: 0 },
  { code: 'other_withholding', name: 'Khấu trừ khác', round: 0 },
  { code: 'net', name: 'Thực lĩnh', round: 0 },
];
const BUILTIN = new Map(PAYROLL_BUILTIN_COLUMNS.map((c) => [c.code, c]));

// Cấu trúc mặc định "Lương cơ bản": mọi cột dựng sẵn + ba cột nhập tay thường gặp (quyết định #620: dữ liệu ở domain, không ở coa-data).
export const DEFAULT_PAYROLL_STRUCTURE: PayrollStructure = {
  columns: [
    ...PAYROLL_BUILTIN_COLUMNS.slice(0, 11).map((c) => ({ code: c.code, name: c.name, kind: 'builtin' as const })),
    { code: 'bonus', name: 'Thưởng', kind: 'input', income: true },
    { code: 'charity', name: 'Đóng góp từ thiện, quỹ hưu trí tự nguyện', kind: 'input', pitRelief: true, deduct: true },
    { code: 'advance', name: 'Tạm ứng trừ lương', kind: 'input', deduct: true },
    ...PAYROLL_BUILTIN_COLUMNS.slice(11).map((c) => ({ code: c.code, name: c.name, kind: 'builtin' as const })),
  ],
};

// ---- Đầu vào một nhân viên ----
export interface PayrollInput {
  period: { year: number; month: number };
  segments: { monthlySalary: string; paidDays: string }[]; // đoạn lương trong kỳ (đổi lương, vào/nghỉ việc giữa tháng); bảng thưởng: []
  proration: ProrationMode;
  standardDays: string; // ngày công chuẩn của tháng ('calendar', và đơn giá giờ khi 'fixed')
  standardHoursPerDay: string;
  otHours?: { weekday: string; rest: string; holiday: string };
  allowances?: { code: string; amount: string; taxable: boolean; siBase: boolean }[];
  siSalary?: string | null; // mức lương đóng BH trong hồ sơ; không có thì lương tháng của đoạn cuối
  insurance: SiFlags; // bảng thưởng: tất cả false
  union?: { employer?: boolean; member?: boolean }; // NSDLĐ đóng kinh phí công đoàn; NLĐ là đoàn viên (đoàn phí)
  dependents?: { from: string; to?: string | null }[]; // 'YYYY-MM' hoặc 'YYYY-MM-DD': tính theo tháng
  taxResidency: 'resident' | 'non_resident';
  contractType: 'long' | 'short' | 'none'; // từ 3 tháng | dưới 3 tháng | không hợp đồng
  manual?: Record<string, string>; // giá trị cột kind 'input'
  prior?: { taxableIncome: string; siEmployee: string; otherRelief: string; pit: string }; // các bảng lương khác cùng tháng (D12)
}

export interface PayrollWarning { code: string; message: string }
export interface PayrollLineResult { values: Record<string, string>; gross: string; siEmp: string; siEr: string; pit: string; net: string; warnings: PayrollWarning[] }

interface Node { deps: string[]; round: number; calc: (get: (c: string) => Decimal) => Decimal }

const CODE_RE = /^[a-z_][a-z0-9_]*$/;

// Kiểm cấu trúc (lưu cấu trúc → 400): mã hợp lệ và không trùng, builtin có thật, công thức đúng cú pháp, tham chiếu có cột, không vòng. Trả thứ tự tính.
export function validateStructure(structure: PayrollStructure): string[] {
  return order(graph(structure, null, null));
}

function graph(structure: PayrollStructure, input: PayrollInput | null, params: ResolvedParams | null, warnings: PayrollWarning[] = []): Map<string, Node> {
  const seen = new Set<string>();
  for (const c of structure.columns) {
    const bad = (m: string) => { throw new PayrollError('STRUCTURE_INVALID', `Cột "${c.code}": ${m}`, c.code); };
    if (!CODE_RE.test(c.code)) bad('mã cột chỉ gồm chữ thường, số, gạch dưới');
    if (seen.has(c.code)) bad('mã cột bị trùng');
    seen.add(c.code);
    if (c.kind === 'builtin' && !BUILTIN.has(c.code)) bad('không phải cột dựng sẵn');
    if (c.kind === 'formula' && !c.formula?.trim()) bad('thiếu công thức');
    if (c.round !== undefined && (!Number.isInteger(c.round) || c.round < 0 || c.round > 6)) bad('số chữ số làm tròn từ 0 đến 6');
  }
  const user = structure.columns.filter((c) => c.kind !== 'builtin');
  const nodes = builtinNodes(user, input, params, warnings);
  for (const c of user) {
    let ast: FormulaNode | null = null;
    if (c.kind === 'formula') {
      try { ast = parsePayrollFormula(c.formula!); } catch (e) { if (e instanceof PayrollError) { e.column = c.code; e.message = `Cột "${c.code}": ${e.message}`; } throw e; }
    }
    const round = c.round ?? 0;
    nodes.set(c.code, {
      deps: ast ? [...payrollFormulaRefs(ast)] : [], round,
      calc: (get) => (ast ? evaluatePayrollFormula(ast, formulaCtx(c.code, get, input, params)) : num(input?.manual?.[c.code], c.code)),
    });
  }
  for (const [code, n] of nodes) {
    for (const d of n.deps) if (!nodes.has(d)) throw new PayrollError('FORMULA_UNKNOWN_COLUMN', `Cột "${code}": tham chiếu cột không có [${d}]`, code);
  }
  return nodes;
}

// Sắp xếp tô-pô (DFS, duyệt mã theo thứ tự chữ cái để kết quả không phụ thuộc thứ tự khai báo); vòng → FORMULA_CYCLE nêu đường vòng.
function order(nodes: Map<string, Node>): string[] {
  const state = new Map<string, 1 | 2>(); const out: string[] = []; const stack: string[] = [];
  const visit = (c: string) => {
    const s = state.get(c);
    if (s === 2) return;
    if (s === 1) { const cyc = [...stack.slice(stack.indexOf(c)), c]; throw new PayrollError('FORMULA_CYCLE', `Vòng tham chiếu: ${cyc.join(' → ')}`, c); }
    state.set(c, 1); stack.push(c);
    for (const d of [...nodes.get(c)!.deps].sort()) visit(d);
    stack.pop(); state.set(c, 2); out.push(c);
  };
  for (const c of [...nodes.keys()].sort()) visit(c);
  return out;
}

function formulaCtx(column: string, get: (c: string) => Decimal, input: PayrollInput | null, p: ResolvedParams | null) {
  const need = <T>(v: T | undefined, name: string): T => v ?? missing(name, column);
  const si = (x: Decimal, side: 'employee' | 'employer') => {
    const r = siContributions(Decimal.max(x, 0).toString(), { rates: need(p?.siRates, 'si_rates'), ceiling: need(p?.siCeiling, 'si_ceiling'), ...(p?.siFloor ? { floor: p.siFloor } : {}), ...(p?.uiCeiling ? { uiCeiling: p.uiCeiling } : {}) }, input?.insurance ?? { si: true, hi: true, ui: true, occupational: true });
    return Object.values(r[side]).reduce((s, v) => s.plus(v), new Decimal(0));
  };
  const named: Record<string, string | number | undefined> = {
    deduction_self: p?.pitDeduction?.self, deduction_dependent: p?.pitDeduction?.dependent, si_ceiling: p?.siCeiling, ui_ceiling: p?.uiCeiling, si_floor: p?.siFloor,
    min_wage: p?.minWage, ot_weekday: p?.otMultipliers?.weekday, ot_weekly_rest: p?.otMultipliers?.weekly_rest, ot_holiday: p?.otMultipliers?.holiday,
    pit_non_resident_rate: p?.pitNonResidentRate, pit_flat_rate_no_contract: p?.pitFlatRateNoContract, ...p?.constants,
  };
  return {
    column, get,
    pit: (x: Decimal) => D(pitProgressive(x.toString(), need(p?.pitBrackets, 'pit_brackets')).tax),
    siEmp: (x: Decimal) => si(x, 'employee'), siEr: (x: Decimal) => si(x, 'employer'),
    param: (n: string) => D(need(named[n], n)),
  };
}

const monthKey = (s: string) => s.slice(0, 7);

function builtinNodes(user: PayrollColumn[], input: PayrollInput | null, p: ResolvedParams | null, warnings: PayrollWarning[]): Map<string, Node> {
  const i = input; // null khi chỉ kiểm cấu trúc: calc không bao giờ chạy
  const sumOf = (pred: (c: PayrollColumn) => boolean) => {
    const deps = user.filter(pred).map((c) => c.code);
    return { deps, calc: (get: (c: string) => Decimal) => deps.reduce((s, c) => s.plus(get(c)), new Decimal(0)) };
  };
  const need = <T>(v: T | undefined, name: string, column: string): T => v ?? missing(name, column);
  const longResident = () => i!.taxResidency === 'resident' && i!.contractType === 'long';
  const segs = () => i!.segments.map((s, k) => ({ m: num(s.monthlySalary, `segments[${k}].monthlySalary`), d: num(s.paidDays, `segments[${k}].paidDays`) }));
  const lastSalary = () => segs().at(-1)?.m ?? new Decimal(0);
  const div = () => divisor(i!.proration, i!.standardDays);
  const ot = () => i!.otHours ?? { weekday: '0', rest: '0', holiday: '0' };
  const otResult = () => {
    const h = ot();
    if ([h.weekday, h.rest, h.holiday].every((x) => num(x, 'otHours').isZero())) return { pay: '0', taxExempt: '0' };
    const per = div().times(num(i!.standardHoursPerDay, 'standardHoursPerDay'));
    if (per.isZero()) throw new PayrollError('PAYROLL_INPUT_INVALID', 'Ngày công chuẩn và giờ chuẩn/ngày phải lớn hơn 0', 'ot_pay');
    return overtimePay(lastSalary().toString(), h, need(p?.otMultipliers, 'ot_multipliers', 'ot_pay'), 'full', need(p?.otTaxExemptExtra, 'ot_tax_exempt_extra', 'ot_exempt'), per.toString());
  };
  const allow = () => i!.allowances ?? [];
  const allowSum = (pred: (a: { taxable: boolean; siBase: boolean }) => boolean) => allow().filter(pred).reduce((s, a) => s.plus(num(a.amount, `allowances.${a.code}`)), new Decimal(0));
  const anyIns = () => i!.insurance.si || i!.insurance.hi || i!.insurance.ui || i!.insurance.occupational;
  const siRaw = (get: (c: string) => Decimal) => (i!.siSalary ? num(i!.siSalary, 'siSalary') : lastSalary()).plus(allowSum((a) => a.siBase)).plus(siExtra.calc(get));
  const capped = (get: (c: string) => Decimal, ceiling: string | undefined, col: string) => {
    if (!anyIns()) return new Decimal(0);
    const raw = siRaw(get);
    const floor = p?.siFloor ? D(p.siFloor) : null;
    const cap = D(need(ceiling ?? p?.siCeiling, 'si_ceiling', col));
    if (floor && raw.lt(floor)) warn('SI_FLOOR_APPLIED', `Lương đóng bảo hiểm ${raw.toString()} thấp hơn mức sàn, đóng theo mức sàn ${floor.toString()}`);
    if (raw.gt(cap)) warn('SI_CEILING_APPLIED', `Lương đóng bảo hiểm ${raw.toString()} vượt mức trần ${cap.toString()} (${col === 'ui_base' ? 'BHTN' : 'BHXH, BHYT'})`);
    return Decimal.min(floor ? Decimal.max(raw, floor) : raw, cap);
  };
  const warn = (code: string, message: string) => { if (!warnings.some((w) => w.message === message)) warnings.push({ code, message }); };
  const rate = (on: boolean, base: string, side: 'employee' | 'employer', k: string, col: string) => (get: (c: string) => Decimal) =>
    on ? pct(get(base), (need(p?.siRates, 'si_rates', col)[side] as Record<string, number | string | undefined>)[k]) : new Decimal(0);
  const ins = (k: keyof SiFlags) => i?.insurance[k] ?? false;
  const prior = () => i!.prior;
  const deps = () => (i!.dependents ?? []).filter((d) => {
    const ym = `${i!.period.year}-${String(i!.period.month).padStart(2, '0')}`;
    return monthKey(d.from) <= ym && (!d.to || monthKey(d.to) >= ym);
  }).length;

  const income = sumOf((c) => !!c.income);
  const incomeExempt = sumOf((c) => !!c.income && c.taxable === false);
  const siExtra = sumOf((c) => !!c.siBase);
  const relief = sumOf((c) => !!c.pitRelief);
  const withhold = sumOf((c) => !!c.deduct);

  const defs: Record<string, Omit<Node, 'round'>> = {
    std_days: { deps: [], calc: () => div() },
    work_days: { deps: [], calc: () => segs().reduce((s, x) => s.plus(x.d), new Decimal(0)) },
    base_salary: { deps: [], calc: () => {
      if (i!.proration === 'fixed') return lastSalary();
      if (div().isZero()) throw new PayrollError('PAYROLL_INPUT_INVALID', 'Số ngày công chuẩn phải lớn hơn 0', 'base_salary');
      return segs().reduce((s, x) => s.plus(x.m.times(x.d)), new Decimal(0)).div(div()); // cộng tử số rồi chia một lần
    } },
    allowances: { deps: [], calc: () => allowSum(() => true) },
    allowances_exempt: { deps: [], calc: () => allowSum((a) => !a.taxable) },
    ot_weekday_hours: { deps: [], calc: () => num(ot().weekday, 'otHours.weekday') },
    ot_rest_hours: { deps: [], calc: () => num(ot().rest, 'otHours.rest') },
    ot_holiday_hours: { deps: [], calc: () => num(ot().holiday, 'otHours.holiday') },
    ot_pay: { deps: [], calc: () => D(otResult().pay) },
    ot_exempt: { deps: [], calc: () => D(otResult().taxExempt) },
    other_income: income,
    other_income_exempt: incomeExempt,
    gross: { deps: ['base_salary', 'allowances', 'ot_pay', 'other_income'], calc: (g) => g('base_salary').plus(g('allowances')).plus(g('ot_pay')).plus(g('other_income')) },
    si_base: { deps: siExtra.deps, calc: (g) => capped(g, p?.siCeiling, 'si_base') },
    ui_base: { deps: siExtra.deps, calc: (g) => capped(g, p?.uiCeiling, 'ui_base') },
    si_emp_si: { deps: ['si_base'], calc: rate(ins('si'), 'si_base', 'employee', 'si', 'si_emp_si') },
    si_emp_hi: { deps: ['si_base'], calc: rate(ins('hi'), 'si_base', 'employee', 'hi', 'si_emp_hi') },
    si_emp_ui: { deps: ['ui_base'], calc: rate(ins('ui'), 'ui_base', 'employee', 'ui', 'si_emp_ui') },
    si_emp: { deps: ['si_emp_si', 'si_emp_hi', 'si_emp_ui'], calc: (g) => g('si_emp_si').plus(g('si_emp_hi')).plus(g('si_emp_ui')) },
    si_er_si: { deps: ['si_base'], calc: rate(ins('si'), 'si_base', 'employer', 'si', 'si_er_si') },
    si_er_hi: { deps: ['si_base'], calc: rate(ins('hi'), 'si_base', 'employer', 'hi', 'si_er_hi') },
    si_er_ui: { deps: ['ui_base'], calc: rate(ins('ui'), 'ui_base', 'employer', 'ui', 'si_er_ui') },
    si_er_occ: { deps: ['si_base'], calc: rate(ins('occupational'), 'si_base', 'employer', 'occupational', 'si_er_occ') },
    si_er: { deps: ['si_er_si', 'si_er_hi', 'si_er_ui', 'si_er_occ'], calc: (g) => g('si_er_si').plus(g('si_er_hi')).plus(g('si_er_ui')).plus(g('si_er_occ')) },
    // Kinh phí công đoàn và đoàn phí tính trên lương đóng BHXH (tỷ lệ là tham số si_rates.employer.union / union_fee; không có thì lỗi khi cần)
    union_er: { deps: ['si_base'], calc: (g) => (i!.union?.employer ? pct(g('si_base'), need(p?.siRates?.employer.union, 'si_rates.employer.union', 'union_er')) : new Decimal(0)) },
    union_fee: { deps: ['si_base'], calc: (g) => (i!.union?.member ? pct(g('si_base'), need(p?.siRates?.employer.union_fee, 'si_rates.employer.union_fee', 'union_fee')) : new Decimal(0)) },
    taxable_income: { deps: ['gross', 'allowances_exempt', 'ot_exempt', 'other_income_exempt'], calc: (g) => g('gross').minus(g('allowances_exempt')).minus(g('ot_exempt')).minus(g('other_income_exempt')) },
    dependents: { deps: [], calc: () => new Decimal(deps()) },
    deduction_self: { deps: [], calc: () => (longResident() ? D(need(p?.pitDeduction, 'pit_deduction', 'deduction_self').self) : new Decimal(0)) },
    deduction_dependents: { deps: ['dependents'], calc: (g) => (longResident() ? g('dependents').times(D(need(p?.pitDeduction, 'pit_deduction', 'deduction_dependents').dependent)) : new Decimal(0)) },
    deduction_si: { deps: ['si_emp'], calc: (g) => (longResident() ? g('si_emp') : new Decimal(0)) },
    deduction_other: { deps: relief.deps, calc: (g) => (longResident() ? relief.calc(g) : new Decimal(0)) },
    // Cư trú, hợp đồng từ 3 tháng: tính trên cả tháng (cộng các bảng lương khác cùng tháng ở prior). Không cư trú/hợp đồng ngắn: cơ sở áp thuế suất toàn phần.
    pit_base: { deps: ['taxable_income', 'deduction_self', 'deduction_dependents', 'deduction_si', 'deduction_other'], calc: (g) => {
      if (!longResident()) return g('taxable_income');
      const pr = prior();
      const t = g('taxable_income').plus(num(pr?.taxableIncome, 'prior.taxableIncome'))
        .minus(g('deduction_self')).minus(g('deduction_dependents')).minus(g('deduction_si')).minus(g('deduction_other'))
        .minus(num(pr?.siEmployee, 'prior.siEmployee')).minus(num(pr?.otherRelief, 'prior.otherRelief'));
      return Decimal.max(t, 0);
    } },
    pit: { deps: ['pit_base'], calc: (g) => {
      if (longResident()) {
        const due = D(pitProgressive(g('pit_base').toString(), need(p?.pitBrackets, 'pit_brackets', 'pit')).tax).minus(num(prior()?.pit, 'prior.pit'));
        if (due.isNeg()) warn('PIT_PRIOR_EXCEEDS', 'Thuế đã khấu trừ ở bảng lương khác cùng tháng lớn hơn thuế cả tháng: bảng này không khấu trừ thêm');
        return Decimal.max(due, 0);
      }
      const [r, name] = i!.taxResidency === 'non_resident' ? [p?.pitNonResidentRate, 'pit_non_resident_rate'] : [p?.pitFlatRateNoContract, 'pit_flat_rate_no_contract'];
      if (r === undefined) { warn('PIT_RATE_MISSING', `Chưa có tham số "${name}": chưa khấu trừ thuế TNCN`); return new Decimal(0); }
      return Decimal.max(pct(g('pit_base'), r), 0);
    } },
    other_withholding: { deps: [...withhold.deps, 'union_fee'], calc: (g) => withhold.calc(g).plus(g('union_fee')) },
    net: { deps: ['gross', 'si_emp', 'pit', 'other_withholding'], calc: (g) => g('gross').minus(g('si_emp')).minus(g('pit')).minus(g('other_withholding')) },
  };
  return new Map(PAYROLL_BUILTIN_COLUMNS.map((c) => [c.code, { ...defs[c.code]!, round: c.round }]));
}

// Tính một dòng bảng lương: mọi cột dựng sẵn và cột người dùng theo thứ tự phụ thuộc; mỗi cột làm tròn một lần (nửa lên) và cột sau dùng giá trị đã làm tròn.
export function computePayrollLine(input: PayrollInput, structure: PayrollStructure, params: ResolvedParams): PayrollLineResult {
  const warnings: PayrollWarning[] = [];
  const nodes = graph(structure, input, params, warnings);
  const vals = new Map<string, Decimal>();
  const get = (c: string) => vals.get(c)!;
  for (const c of order(nodes)) {
    const n = nodes.get(c)!;
    vals.set(c, n.calc(get).toDecimalPlaces(n.round, Decimal.ROUND_HALF_UP).plus(0)); // plus(0): bỏ -0
  }
  const values = Object.fromEntries([...vals].map(([k, v]) => [k, v.toString()]));
  return { values, gross: values.gross!, siEmp: values.si_emp!, siEr: values.si_er!, pit: values.pit!, net: values.net!, warnings };
}

// ---- Quyết toán thuế TNCN năm (biểu năm pit_brackets_annual nhập riêng, không suy 12 lần biểu tháng) ----
export interface PitAnnualMonth { taxableIncome: string; siEmployee: string; otherRelief?: string; dependents: number; pitWithheld: string }
export interface PitAnnualResult { taxableIncome: string; deductionSelf: string; deductionDependents: string; deductionSi: string; deductionOther: string; pitBase: string; pitDue: string; pitWithheld: string; difference: string }

// selfMonths: số tháng tính giảm trừ bản thân (đầu vào của người quyết toán, không suy). difference > 0 nộp thêm, < 0 hoàn/bù trừ.
export function pitAnnualSettlement(months: PitAnnualMonth[], p: { brackets: PitBracket[]; deduction: { self: string; dependent: string } }, opts: { selfMonths: number }): PitAnnualResult {
  const s = (f: (m: PitAnnualMonth) => string | number | undefined) => months.reduce((a, m) => a.plus(D(f(m) ?? 0)), new Decimal(0));
  const taxable = s((m) => m.taxableIncome);
  const self = D(p.deduction.self).times(opts.selfMonths);
  const dep = D(p.deduction.dependent).times(s((m) => m.dependents));
  const si = s((m) => m.siEmployee); const other = s((m) => m.otherRelief);
  const base = Decimal.max(taxable.minus(self).minus(dep).minus(si).minus(other), 0);
  const due = D(pitProgressive(base.toString(), p.brackets).tax);
  const withheld = s((m) => m.pitWithheld);
  return {
    taxableIncome: taxable.toString(), deductionSelf: self.toString(), deductionDependents: dep.toString(), deductionSi: si.toString(), deductionOther: other.toString(),
    pitBase: base.toString(), pitDue: due.toString(), pitWithheld: withheld.toString(), difference: due.minus(withheld).toString(),
  };
}
