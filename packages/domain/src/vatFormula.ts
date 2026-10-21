import { D, Decimal, ZERO } from './money.js';
import { FormulaError, parseFormula, type Expr } from './reportFormula.js';

// Tính tờ khai 01/GTGT từ mẫu dữ liệu (@kt/coa-data data/tax/01gtgt-*.json). Kiểu ở đây là phần cấu trúc @kt/domain cần: VatTemplate của @kt/coa-data gán được vào
// (@kt/coa-data phụ thuộc @kt/domain nên không nhập ngược kiểu của nó).
// Công thức: [mã] nối bằng + và - (cú pháp parseFormula của báo cáo tài chính, chỉ được dùng chỉ tiêu và số; mã tài khoản, đối ứng bị từ chối).
export interface VatFormLine {
  code: string; kind: 'flag' | 'carry' | 'invoice' | 'formula' | 'manual';
  invoice?: { direction: 'purchase' | 'sale'; groups: string[]; field: 'base' | 'tax'; importOnly?: boolean };
  formula?: string; clamp?: 'positivePart' | 'negativePart'; overridable?: boolean;
}
export interface VatFormTemplate { lines: VatFormLine[] }
export interface VatReturnInputs { invoice: Record<string, string>; carry: string; manual: Record<string, string>; overrides: Record<string, string> }

// Khóa số liệu hóa đơn: tổng giá trị (base) hoặc thuế (tax) của một nhóm kê khai theo chiều mua/bán; ':import' là phần hàng nhập khẩu của nhóm (đã gồm trong khóa không ':import').
export const vatInvoiceKey = (direction: 'purchase' | 'sale', group: string, field: 'base' | 'tax', importOnly = false): string => `${direction}:${group}:${field}${importOnly ? ':import' : ''}`;

// Phân bổ thuế đầu vào dùng chung (cách tính của phần mềm, ghi chú của [25] trong mẫu): chỉ tiêu mua vào cột thuế được ghi đè có nhóm 03 thì phần nhóm 03 nhân tỷ lệ
// doanh thu chịu thuế [27]/[34] (TT89: [34] = [26]+[27]+[34a]), làm tròn đồng; [34] ≤ 0 (không có doanh thu) thì khấu trừ cả nhóm 03, người dùng ghi đè khi cần.
export const VAT_SHARED_GROUP = '03';
const TAXABLE = '27'; const TOTAL = '34';

function refsOnlyLines(e: Expr, src: string): void {
  if (e.kind === 'bin') { refsOnlyLines(e.left, src); refsOnlyLines(e.right, src); return; }
  if (e.kind !== 'line' && e.kind !== 'num') throw new FormulaError(`Công thức "${src}": chỉ được tham chiếu chỉ tiêu [mã] và số`);
}

export function evalVatReturn(t: VatFormTemplate, inputs: VatReturnInputs): Record<string, string> {
  const byCode = new Map(t.lines.map((l) => [l.code, l]));
  if (byCode.size !== t.lines.length) throw new FormulaError('Mẫu tờ khai có mã chỉ tiêu trùng');
  const parsed = new Map<string, Expr>();
  for (const l of t.lines) if (l.kind === 'formula') { const e = parseFormula(l.formula ?? ''); refsOnlyLines(e, l.formula ?? ''); parsed.set(l.code, e); }
  for (const c of Object.keys(inputs.overrides)) if (!byCode.get(c)?.overridable) throw new FormulaError(`Chỉ tiêu [${c}] không ghi đè được`);
  const int = (s: string, what: string): Decimal => { if (!/^-?\d{1,20}$/.test(s)) throw new FormulaError(`${what}: "${s}" không phải số nguyên`); return D(s); };
  const inv = (key: string) => int(inputs.invoice[key] ?? '0', `Số liệu hóa đơn ${key}`);

  const value = new Map<string, Decimal>(); const visiting = new Set<string>();
  const evalExpr = (e: Expr): Decimal => e.kind === 'bin' ? (e.op === '+' ? evalExpr(e.left).plus(evalExpr(e.right)) : evalExpr(e.left).minus(evalExpr(e.right))) : e.kind === 'line' ? evalLine(e.code) : e.kind === 'num' ? D(e.value) : ZERO;
  const evalInvoice = (l: VatFormLine): Decimal => {
    const i = l.invoice!;
    const part = (g: string) => inv(vatInvoiceKey(i.direction, g, i.field, i.importOnly ?? false));
    const shared = l.overridable && i.direction === 'purchase' && i.field === 'tax' && !i.importOnly && i.groups.includes(VAT_SHARED_GROUP);
    let v = i.groups.filter((g) => !shared || g !== VAT_SHARED_GROUP).reduce((s, g) => s.plus(part(g)), ZERO);
    if (shared) {
      const s = part(VAT_SHARED_GROUP); const total = s.isZero() ? ZERO : evalLine(TOTAL);
      const ratio = total.lte(0) ? D(1) : Decimal.min(1, Decimal.max(0, evalLine(TAXABLE).div(total)));
      v = v.plus(s.times(ratio).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
    }
    return v;
  };
  const evalLine = (code: string): Decimal => {
    const done = value.get(code); if (done !== undefined) return done;
    const l = byCode.get(code); if (!l) throw new FormulaError(`Chỉ tiêu [${code}] không có trong mẫu`);
    if (visiting.has(code)) throw new FormulaError(`Vòng lặp tại chỉ tiêu [${code}]`);
    visiting.add(code);
    let v = l.kind === 'carry' ? int(inputs.carry, 'Chỉ tiêu chuyển kỳ') : l.kind === 'manual' ? int(inputs.manual[code] ?? '0', `Chỉ tiêu [${code}]`)
      : l.kind === 'invoice' ? evalInvoice(l) : l.kind === 'formula' ? evalExpr(parsed.get(code)!) : ZERO;
    if (l.clamp === 'positivePart') v = Decimal.max(0, v);
    if (l.clamp === 'negativePart') v = Decimal.max(0, v.neg()); // lưu phần âm đổi dấu; mẫu in [41] là số ≤ 0
    const o = inputs.overrides[code]; if (o !== undefined) v = int(o, `Ghi đè [${code}]`);
    visiting.delete(code); value.set(code, v); return v;
  };

  const noInvoice = Object.values(inputs.invoice).every((x) => int(x, 'Số liệu hóa đơn').isZero());
  return Object.fromEntries(t.lines.map((l) => [l.code, l.kind === 'flag' ? (noInvoice ? 'X' : '') : evalLine(l.code).toFixed(0)]));
}
