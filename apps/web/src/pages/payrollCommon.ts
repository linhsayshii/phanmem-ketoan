import { D, PAYROLL_BUILTIN_COLUMNS, formatVnNumber, parseVnNumber, validateStructure, PayrollError, VND_AMOUNT_RE, type PayrollColumn } from '@kt/domain';
import { ApiError } from '../api/client.js';

// Logic thuần dùng chung cho ba màn hình lương (bảng lương, cấu trúc, tham số). Không có giá trị pháp lý nào ở đây: chỉ nhãn, hình dạng nhập liệu và định dạng.

export const money = (s: string | null | undefined) => formatVnNumber(s ?? '0', 0);
export const RUN_KIND: Record<string, string> = { regular: 'Bảng lương', bonus: 'Bảng thưởng', retro: 'Bảng truy lĩnh' };
export const RUN_STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: 'Nháp', color: 'default' }, calculated: { label: 'Đã tính', color: 'blue' }, posted: { label: 'Đã hạch toán', color: 'green' }, cancelled: { label: 'Đã hủy', color: 'red' },
};
export const PRORATION: { value: string; label: string }[] = [
  { value: 'calendar', label: 'Chia theo ngày công chuẩn của công ty' }, { value: 'standard_26', label: 'Chia cho 26 ngày' },
  { value: 'standard_22', label: 'Chia cho 22 ngày' }, { value: 'fixed', label: 'Lương cố định, không theo ngày công' },
];

// ---- Cột bảng lương ----
const BUILTIN = new Map(PAYROLL_BUILTIN_COLUMNS.map((c) => [c.code, c]));
export const builtinName = (code: string) => BUILTIN.get(code)?.name ?? code;
// Số chữ số thập phân hiển thị của một cột: cột dựng sẵn theo định nghĩa, cột người dùng theo `round` (mặc định 0).
export const columnRound = (c: PayrollColumn): number => (c.kind === 'builtin' ? BUILTIN.get(c.code)?.round ?? 0 : c.round ?? 0);
// Cột không cộng tổng được (ngày công chuẩn là hằng số của tháng; số người phụ thuộc cộng lại không có nghĩa trên bảng).
const NOT_SUMMED = new Set(['std_days', 'dependents']);

export interface RunLine {
  lineId: number; employeeId: number; employeeCode: string; employeeName: string; departmentName: string | null; values: Record<string, string>; manual: string[];
  gross: string; siEmp: string; siEr: string; pit: string; net: string; warnings: { code: string; message: string }[]; stale: boolean;
}
export interface GridRow { employeeId: number; code: string; name: string; dept: string; vals: Record<string, string>; manual: Set<string>; warnings: { code: string; message: string }[]; stale: boolean; isTotal?: boolean }

export const lineToRow = (l: RunLine): GridRow => ({
  employeeId: l.employeeId, code: l.employeeCode, name: l.employeeName, dept: l.departmentName ?? '', vals: { ...l.values }, manual: new Set(l.manual), warnings: l.warnings, stale: l.stale,
});
export function patchRow(row: GridRow, l: RunLine): void { row.vals = { ...l.values }; row.manual = new Set(l.manual); row.warnings = l.warnings; row.stale = l.stale; }

// Hàng tổng cộng tính tại chỗ từ các dòng đang hiện, nên cập nhật ngay khi sửa ô tay mà không cần tải lại cả bảng.
export function totalRow(columns: PayrollColumn[], rows: GridRow[]): GridRow {
  const vals: Record<string, string> = {};
  for (const c of columns) {
    if (NOT_SUMMED.has(c.code)) continue;
    vals[c.code] = rows.reduce((s, r) => s.plus(r.vals[c.code] || 0), D(0)).toString();
  }
  return { employeeId: 0, code: 'Tổng cộng', name: `${rows.length} nhân viên`, dept: '', vals, manual: new Set(), warnings: [], stale: false, isTotal: true };
}

// Ô nhập tay: '' → null (bỏ ô nhập tay); số Việt Nam ("1.000.000", "1000000", "1000,5") → chuỗi thập phân; sai → undefined. Khớp ràng buộc của API (tối đa 16 chữ số nguyên, 6 thập phân).
export function parseManualInput(text: string): string | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const p = parseVnNumber(t);
  return p !== null && /^-?\d{1,16}(\.\d{1,6})?$/.test(p) ? p : undefined;
}

// ---- Gợi ý và kiểm công thức ----
export interface Suggestion { value: string; label: string }
// Gợi ý mã cột cho từ đang gõ ở cuối công thức (sau "[" hoặc chữ cái): chọn thì thay từ đó bằng [mã]. Không gợi ý chính cột đang soạn.
export function formulaSuggestions(formula: string, columns: { code: string; name: string; kind: string }[], selfCode: string, limit = 8): Suggestion[] {
  const m = /(?<![\p{L}\p{N}_])\[?([A-Za-z_][A-Za-z0-9_]*)?$/u.exec(formula);
  if (!m || m[0] === '') return [];
  const word = m[1] ?? '';
  if (!m[0].startsWith('[') && /[A-Z]/.test(word) && word === word.toUpperCase()) return []; // đang gõ tên hàm (IF, MIN…), mã cột luôn viết thường
  const start = formula.length - m[0].length; const q = word.toLowerCase();
  return columns.filter((c) => c.code && c.code !== selfCode && (q === '' || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)))
    .slice(0, limit).map((c) => ({ value: `${formula.slice(0, start)}[${c.code}]`, label: `${c.code} - ${c.name}` }));
}
export const FORMULA_HELP = 'Tham chiếu cột bằng [mã_cột]. Hàm: MIN, MAX, SUM, IF(điều_kiện, giá_trị_đúng, giá_trị_sai), ROUND, ABS, PIT(thu_nhập), SI_EMP(lương_đóng), SI_ER(lương_đóng), PARAM(\'tên\') với tên: deduction_self, deduction_dependent, si_ceiling, ui_ceiling, si_floor, min_wage, ot_weekday, ot_weekly_rest, ot_holiday. Toán tử: + - * / > < >= <= == != && ||.';

// Kiểm cấu trúc phía trình duyệt bằng chính bộ kiểm của domain (trùng mã, công thức sai, vòng tham chiếu…); trả thông báo hoặc null.
export function structureProblem(columns: PayrollColumn[]): string | null {
  try { validateStructure({ columns }); return null; } catch (e) { if (e instanceof PayrollError) return e.message; throw e; }
}

export interface EditRow { key: number; code: string; name: string; kind: PayrollColumn['kind']; formula: string; round: number | null; income: boolean; taxable: boolean; siBase: boolean; pitRelief: boolean; deduct: boolean; creditAccount: string }
export const columnToRow = (c: PayrollColumn, key: number): EditRow => ({
  key, code: c.code, name: c.name, kind: c.kind, formula: c.formula ?? '', round: c.round ?? null, income: !!c.income, taxable: c.taxable !== false, siBase: !!c.siBase, pitRelief: !!c.pitRelief, deduct: !!c.deduct, creditAccount: c.creditAccount ?? '',
});
// Chỉ ghi cờ khi khác mặc định, để cấu trúc lưu gọn và giống cấu trúc mặc định của hệ thống. Cột dựng sẵn không mang cờ/công thức.
export function rowToColumn(r: EditRow): PayrollColumn {
  const c: PayrollColumn = { code: r.code.trim(), name: r.name.trim(), kind: r.kind };
  if (r.kind === 'builtin') return c;
  if (r.kind === 'formula') c.formula = r.formula.trim();
  if (r.round !== null) c.round = r.round;
  if (r.income) c.income = true;
  if (r.income && !r.taxable) c.taxable = false;
  if (r.siBase) c.siBase = true;
  if (r.pitRelief) c.pitRelief = true;
  if (r.deduct) c.deduct = true;
  if (r.deduct && r.creditAccount.trim()) c.creditAccount = r.creditAccount.trim();
  return c;
}

// ---- Lỗi ----
// Thiếu tham số: máy chủ nêu mã tham số, nhân viên, ngày; giao diện thêm liên kết sang màn Tham số lương.
export function paramMissing(e: unknown): { code: string | null; label: string | null; date: string | null; employeeCode: string | null } | null {
  if (!(e instanceof ApiError) || e.code !== 'PAYROLL_PARAM_MISSING') return null;
  const d = (e.details ?? {}) as { param?: string | null; date?: string | null; employeeCode?: string | null };
  return { code: d.param ?? null, label: d.param ? PARAM_DEFS.find((p) => p.code === d.param)?.label ?? d.param : null, date: d.date ?? null, employeeCode: d.employeeCode ?? null };
}

// ---- Tham số lương: hình dạng nhập liệu theo mã (không có giá trị mặc định nào) ----
export type FieldType = 'vnd' | 'pct' | 'num' | 'bool' | 'enum';
export interface ParamField { path: string; label: string; type: FieldType; optional?: boolean; options?: { value: string; label: string }[] }
export interface ParamDef { code: string; label: string; hint: string; brackets?: boolean; fields: ParamField[] }
const opt = (path: string, label: string, type: FieldType): ParamField => ({ path, label, type, optional: true });
export const PARAM_DEFS: ParamDef[] = [
  { code: 'pit_brackets', label: 'Biểu thuế thu nhập cá nhân lũy tiến (theo tháng)', hint: 'Mỗi bậc: thu nhập tính thuế đến mức nào (đồng/tháng) và thuế suất. Bậc cuối không giới hạn.', brackets: true, fields: [] },
  { code: 'pit_brackets_annual', label: 'Biểu thuế thu nhập cá nhân (quyết toán năm)', hint: 'Biểu dùng khi quyết toán năm, nhập riêng; mức trần mỗi bậc tính theo đồng/năm.', brackets: true, fields: [] },
  { code: 'pit_deduction', label: 'Mức giảm trừ gia cảnh', hint: 'Đồng mỗi tháng.', fields: [
    { path: 'self', label: 'Giảm trừ bản thân (đồng/tháng)', type: 'vnd' }, { path: 'dependent', label: 'Giảm trừ mỗi người phụ thuộc (đồng/tháng)', type: 'vnd' }] },
  { code: 'pit_income_timing', label: 'Thời điểm tính thu nhập chịu thuế', hint: 'Dùng cho tờ khai thuế và quyết toán.', fields: [
    { path: '', label: 'Tính theo', type: 'enum', options: [{ value: 'period', label: 'Kỳ lương' }, { value: 'payment_date', label: 'Thời điểm chi trả' }] }] },
  { code: 'pit_non_resident_rate', label: 'Thuế suất cá nhân không cư trú', hint: 'Phần trăm trên thu nhập.', fields: [{ path: 'rate', label: 'Thuế suất (%)', type: 'pct' }] },
  { code: 'pit_flat_rate_no_contract', label: 'Thuế suất khấu trừ khi không có hợp đồng lao động', hint: 'Phần trăm trên thu nhập.', fields: [{ path: 'rate', label: 'Thuế suất (%)', type: 'pct' }] },
  { code: 'si_rates', label: 'Tỷ lệ bảo hiểm và kinh phí công đoàn', hint: 'Phần trăm trên lương đóng bảo hiểm.', fields: [
    { path: 'employee.si', label: 'Người lao động: BHXH (%)', type: 'pct' }, { path: 'employee.hi', label: 'Người lao động: BHYT (%)', type: 'pct' }, { path: 'employee.ui', label: 'Người lao động: BHTN (%)', type: 'pct' },
    { path: 'employer.si', label: 'Doanh nghiệp: BHXH (%)', type: 'pct' }, { path: 'employer.hi', label: 'Doanh nghiệp: BHYT (%)', type: 'pct' }, { path: 'employer.ui', label: 'Doanh nghiệp: BHTN (%)', type: 'pct' },
    { path: 'employer.occupational', label: 'Doanh nghiệp: BH tai nạn lao động, bệnh nghề nghiệp (%)', type: 'pct' },
    opt('employer.union', 'Kinh phí công đoàn doanh nghiệp đóng (%)', 'pct'), opt('employer.union_fee', 'Đoàn phí người lao động đóng (%)', 'pct')] },
  { code: 'si_ceiling', label: 'Mức trần lương đóng bảo hiểm', hint: 'Nhập ít nhất một mức: số tiền cụ thể hoặc bội số lương tối thiểu vùng.', fields: [
    opt('si_base_max', 'Trần BHXH, BHYT (đồng/tháng)', 'vnd'), opt('si_base_max_multiple_of_min_wage', 'Trần BHXH, BHYT (số lần lương tối thiểu vùng)', 'num'),
    opt('ui_base_max_multiple_of_min_wage', 'Trần BHTN (số lần lương tối thiểu vùng)', 'num')] },
  { code: 'si_floor', label: 'Mức sàn lương đóng bảo hiểm', hint: 'Nhập ít nhất một mức.', fields: [
    opt('si_base_min', 'Sàn đóng bảo hiểm (đồng/tháng)', 'vnd'), opt('si_base_min_multiple_of_min_wage', 'Sàn đóng bảo hiểm (số lần lương tối thiểu vùng)', 'num')] },
  { code: 'min_wage_region', label: 'Lương tối thiểu vùng', hint: 'Đồng mỗi tháng, theo bốn vùng.', fields: ['I', 'II', 'III', 'IV'].map((v) => ({ path: v, label: `Vùng ${v} (đồng/tháng)`, type: 'vnd' as const })) },
  { code: 'ot_multipliers', label: 'Hệ số tiền lương làm thêm giờ', hint: 'Nhân với đơn giá giờ làm việc bình thường (ví dụ nhập 1,5).', fields: [
    { path: 'weekday', label: 'Ngày thường (hệ số)', type: 'num' }, { path: 'weekly_rest', label: 'Ngày nghỉ hằng tuần (hệ số)', type: 'num' }, { path: 'holiday', label: 'Ngày lễ, tết (hệ số)', type: 'num' }] },
  { code: 'ot_tax_exempt_extra', label: 'Làm thêm giờ: phần chênh lệch không chịu thuế', hint: 'Chọn Có nếu văn bản áp dụng cho phép loại phần chênh lệch so với giờ ngày thường khỏi thu nhập chịu thuế.', fields: [
    { path: '', label: 'Phần chênh lệch không chịu thuế', type: 'bool' }] },
];
export const paramDef = (code: string) => PARAM_DEFS.find((p) => p.code === code);
export const isIllustrative = (source: string | null | undefined) => /^dữ liệu minh họa/i.test((source ?? '').trim());

export interface BracketRow { upTo: string | null; rate: string | null }
export interface ParamForm { fields: Record<string, string | null>; brackets: BracketRow[]; keep: Record<string, unknown> }
export const emptyForm = (code: string): ParamForm => ({ fields: {}, brackets: paramDef(code)?.brackets ? [{ upTo: null, rate: null }] : [], keep: {} });

const num = (v: unknown) => (v === undefined || v === null ? null : String(v));
const get = (o: unknown, path: string): unknown => (path === '' ? o : path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o));
export function valueToForm(code: string, value: unknown): ParamForm {
  const d = paramDef(code); const f = emptyForm(code);
  if (!d) return f;
  if (d.brackets) { f.brackets = (Array.isArray(value) ? value : []).map((b: { upTo: string | null; rate: number }) => ({ upTo: b.upTo, rate: num(b.rate) })); return f; }
  for (const x of d.fields) { const v = get(value, x.path); f.fields[x.path] = x.type === 'bool' ? (typeof v === 'boolean' ? String(v) : null) : num(v); }
  if (code === 'si_rates' && value && typeof value === 'object' && 'parts' in value) f.keep['parts'] = (value as { parts: unknown }).parts; // tách quỹ BHXH: không có ô nhập, giữ nguyên khi sửa
  return f;
}

// Phần trăm, hệ số: gõ "1,5" hoặc "1.5"; trả số hoặc null khi sai.
export function parseDecimalText(t: string): number | null {
  const s = t.trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
const set = (o: Record<string, unknown>, path: string, v: unknown) => {
  const ks = path.split('.'); let cur = o;
  ks.slice(0, -1).forEach((k) => { cur = (cur[k] ??= {}) as Record<string, unknown>; });
  cur[ks[ks.length - 1]!] = v;
};
export function formToValue(code: string, form: ParamForm): { ok: true; value: unknown } | { ok: false; error: string } {
  const d = paramDef(code);
  if (!d) return { ok: false, error: 'Chọn tham số' };
  if (d.brackets) {
    const b = form.brackets; const out: { upTo: string | null; rate: number }[] = []; let prev = D(0);
    for (let i = 0; i < b.length; i++) {
      const last = i === b.length - 1; const rate = parseDecimalText(b[i]!.rate ?? '');
      if (rate === null || rate > 100) return { ok: false, error: `Bậc ${i + 1}: thuế suất phải là số từ 0 đến 100` };
      if (last) { out.push({ upTo: null, rate }); continue; }
      const u = b[i]!.upTo;
      if (!u || !VND_AMOUNT_RE.test(u)) return { ok: false, error: `Bậc ${i + 1}: nhập mức trần là số tiền nguyên` };
      if (D(u).lte(prev)) return { ok: false, error: `Bậc ${i + 1}: mức trần phải lớn hơn bậc trước` };
      prev = D(u); out.push({ upTo: u, rate });
    }
    return out.length ? { ok: true, value: out } : { ok: false, error: 'Nhập ít nhất một bậc' };
  }
  const value: Record<string, unknown> = {}; let scalar: unknown; let any = false;
  for (const x of d.fields) {
    const raw = (form.fields[x.path] ?? '').toString().trim();
    if (raw === '') { if (x.optional) continue; return { ok: false, error: `Nhập "${x.label}"` }; }
    let v: unknown;
    if (x.type === 'vnd') { if (!VND_AMOUNT_RE.test(raw)) return { ok: false, error: `"${x.label}": nhập số tiền nguyên không âm` }; v = raw; }
    else if (x.type === 'pct' || x.type === 'num') {
      const n = parseDecimalText(raw);
      if (n === null || (x.type === 'pct' && n > 100) || (x.type === 'num' && (n <= 0 || n > 100))) return { ok: false, error: `"${x.label}": nhập số hợp lệ${x.type === 'pct' ? ' từ 0 đến 100' : ' lớn hơn 0'}` };
      v = n;
    } else if (x.type === 'bool') v = raw === 'true';
    else v = raw;
    any = true;
    if (x.path === '') scalar = v; else set(value, x.path, v);
  }
  if (!any) return { ok: false, error: 'Nhập ít nhất một mức' };
  if (d.fields.length === 1 && d.fields[0]!.path === '') return { ok: true, value: scalar };
  return { ok: true, value: { ...value, ...(form.keep['parts'] !== undefined ? { parts: form.keep['parts'] } : {}) } };
}

// Tóm tắt một giá trị tham số thành một dòng chữ cho bảng.
export function summarizeParam(code: string, value: unknown): string {
  const d = paramDef(code);
  if (!d) return JSON.stringify(value);
  if (d.brackets) {
    const rows = Array.isArray(value) ? (value as { upTo: string | null; rate: number }[]) : [];
    return `${rows.length} bậc: ${rows.map((b, i) => `${b.upTo ? `đến ${money(b.upTo)}` : `trên ${money(rows[i - 1]?.upTo ?? '0')}`}: ${String(b.rate).replace('.', ',')}%`).join('; ')}`;
  }
  return d.fields.flatMap((x) => {
    const v = get(value, x.path);
    if (v === undefined || v === null) return [];
    const t = x.type === 'vnd' ? money(String(v)) : x.type === 'pct' ? `${String(v).replace('.', ',')}%` : x.type === 'bool' ? (v ? 'Có' : 'Không')
      : x.type === 'enum' ? x.options?.find((o) => o.value === v)?.label ?? String(v) : String(v).replace('.', ',');
    return [x.path === '' ? t : `${x.label.replace(/ \(.*\)$/, '')}: ${t}`];
  }).join('; ');
}
