import { D, Decimal, ZERO } from './money.js';

// Thuế thu nhập doanh nghiệp: thuế suất theo bậc doanh thu năm trước (tham số cit_rate, Luật 67/2025/QH15 Điều 10), miễn thuế doanh thu thấp (cit_exempt_revenue,
// NĐ 141/2026 Điều 2), tạm tính quý và tính tờ khai 03/TNDN từ mẫu dữ liệu (@kt/coa-data data/tax/03tndn-tt89.json). Tiền là chuỗi số nguyên VND, thuế suất là phần trăm.
export type CitErrorCode = 'CIT_RATE_REQUIRED' | 'CIT_INVALID';
export class CitError extends Error {
  constructor(public code: CitErrorCode, message: string) { super(message); this.name = 'CitError'; }
}
export interface CitRateParam { standard: number; tiers: { maxRevenue: string; rate: number }[] }

const RATE_RE = /^\d{1,3}(\.\d{1,4})?$/;
const INT_RE = /^-?\d{1,20}$/;
const int = (s: string, what: string): Decimal => { if (!INT_RE.test(s)) throw new CitError('CIT_INVALID', `${what}: "${s}" không phải số nguyên VND`); return D(s); };
const rateOf = (s: string, what: string): Decimal => {
  if (!RATE_RE.test(s) || D(s).gt(100)) throw new CitError('CIT_INVALID', `${what}: thuế suất "${s}" phải là số phần trăm từ 0 đến 100`);
  return D(s);
};
const money = (x: Decimal): string => { const v = x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP); return (v.isZero() ? ZERO : v).toFixed(0); };

// Thuế suất áp dụng: nhập tay (override) thắng; không thì theo doanh thu năm trước: từ exemptMax trở xuống miễn thuế (rate '0'), rồi bậc nhỏ nhất có
// maxRevenue ≥ doanh thu, còn lại thuế suất phổ thông. Thiếu tham số hoặc thiếu doanh thu năm trước mà không nhập tay: CIT_RATE_REQUIRED (không đoán).
export function citRateFor(prevYearRevenue: string | null, param: CitRateParam | null, override?: string, exemptMax?: string | null): { rate: string; basis: string; exempt: boolean } {
  if (override !== undefined && override !== '') return { rate: rateOf(override, 'Thuế suất nhập tay').toString(), basis: 'Thuế suất nhập tay', exempt: false };
  if (!param) throw new CitError('CIT_RATE_REQUIRED', 'Chưa có tham số thuế suất thuế TNDN cho kỳ này: nhập thuế suất');
  if (prevYearRevenue === null) throw new CitError('CIT_RATE_REQUIRED', 'Chưa có doanh thu năm trước: nhập doanh thu năm trước hoặc thuế suất');
  const rev = int(prevYearRevenue, 'Doanh thu năm trước');
  const fmt = (x: string) => D(x).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (exemptMax && rev.lte(exemptMax)) return { rate: '0', basis: `Miễn thuế: doanh thu năm trước ${fmt(rev.toFixed(0))} từ ${fmt(exemptMax)} trở xuống (NĐ 141/2026/NĐ-CP Điều 2)`, exempt: true };
  const tier = [...param.tiers].sort((a, b) => D(a.maxRevenue).cmp(D(b.maxRevenue))).find((x) => rev.lte(x.maxRevenue));
  return tier
    ? { rate: String(tier.rate), basis: `Thuế suất ${tier.rate}%: doanh thu năm trước ${fmt(rev.toFixed(0))} không quá ${fmt(tier.maxRevenue)} (Luật 67/2025/QH15 Điều 10)`, exempt: false }
    : { rate: String(param.standard), basis: `Thuế suất phổ thông ${param.standard}% (Luật 67/2025/QH15 Điều 10 khoản 1)`, exempt: false };
}

// Tạm tính lũy kế từ đầu năm: thu nhập tính thuế = lợi nhuận lũy kế + điều chỉnh - lỗ được chuyển (âm thì 0); thuế lũy kế = thu nhập × thuế suất, làm tròn đồng;
// số phải nộp quý = thuế lũy kế - đã tạm nộp (âm thì 0).
export function quarterlyEstimate(i: { ytdProfit: string; adjustments: string; lossCarried: string; rate: string; paidYtd: string }): { taxableIncome: string; taxYtd: string; payable: string } {
  const taxable = Decimal.max(0, int(i.ytdProfit, 'Lợi nhuận lũy kế').plus(int(i.adjustments, 'Điều chỉnh')).minus(int(i.lossCarried, 'Lỗ được chuyển')));
  const tax = taxable.times(rateOf(i.rate, 'Thuế suất')).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return { taxableIncome: money(taxable), taxYtd: money(tax), payable: money(Decimal.max(0, tax.minus(int(i.paidYtd, 'Đã tạm nộp')))) };
}

// ---- Tờ khai 03/TNDN ----
// Kiểu là phần cấu trúc @kt/domain cần; CitTemplate của @kt/coa-data gán được vào.
export interface CitFormLine { code: string; kind: 'section' | 'ledger' | 'input' | 'formula' | 'rate' | 'text'; formula?: string; clamp?: 'positivePart'; overridable?: boolean }
export interface CitReturnInputs { ledger: Record<string, string>; defaults: Record<string, string>; overrides: Record<string, string> }

type Expr = { k: 'n'; v: Decimal } | { k: 'r'; code: string } | { k: 'b'; op: '+' | '-' | '*' | '/'; l: Expr; r: Expr };
// Cú pháp công thức: mã chỉ tiêu (A1, C3a, E...), số, + - * / và ngoặc; * / ưu tiên hơn + -.
export function parseCitFormula(src: string): Expr {
  const toks = src.match(/[A-I]\d*[a-z]?|\d+(?:\.\d+)?|[-+*/()]|\S/g) ?? []; let p = 0;
  const fail = (why: string): never => { throw new CitError('CIT_INVALID', `Công thức "${src}": ${why}`); };
  const factor = (): Expr => {
    const t = toks[p++]; if (t === undefined) return fail('thiếu hạng tử');
    if (t === '(') { const e = expr(); if (toks[p++] !== ')') fail('thiếu )'); return e; }
    if (t === '-') return { k: 'b', op: '-', l: { k: 'n', v: ZERO }, r: factor() };
    if (/^\d/.test(t)) return { k: 'n', v: D(t) };
    if (/^[A-I]/.test(t)) return { k: 'r', code: t };
    return fail(`ký tự không hợp lệ "${t}"`);
  };
  const term = (): Expr => { let e = factor(); while (toks[p] === '*' || toks[p] === '/') { const op = toks[p++] as '*' | '/'; e = { k: 'b', op, l: e, r: factor() }; } return e; };
  const expr = (): Expr => { let e = term(); while (toks[p] === '+' || toks[p] === '-') { const op = toks[p++] as '+' | '-'; e = { k: 'b', op, l: e, r: term() }; } return e; };
  const e = expr(); if (p < toks.length) fail(`thừa "${toks[p]}"`);
  return e;
}

// Giá trị chỉ tiêu: ledger (số từ sổ cái), input (mặc định của phần mềm hoặc 0), rate (thuế suất %), text (chữ), formula (tính, làm tròn đồng; clamp positivePart: âm thì 0).
// Ghi đè (số người dùng nhập) chỉ cho chỉ tiêu overridable và thắng mọi nguồn. Dòng tiêu đề (section) không có trong kết quả.
export function evalCitReturn(t: { lines: CitFormLine[] }, inputs: CitReturnInputs): Record<string, string> {
  const byCode = new Map(t.lines.map((l) => [l.code, l]));
  if (byCode.size !== t.lines.length) throw new CitError('CIT_INVALID', 'Mẫu tờ khai có mã chỉ tiêu trùng');
  for (const [c, v] of Object.entries(inputs.overrides)) {
    const l = byCode.get(c);
    if (!l?.overridable) throw new CitError('CIT_INVALID', `Chỉ tiêu [${c}] không ghi đè được`);
    if (l.kind === 'text') { if (v.length > 500) throw new CitError('CIT_INVALID', `Chỉ tiêu [${c}] tối đa 500 ký tự`); }
    else if (l.kind === 'rate') rateOf(v, `Chỉ tiêu [${c}]`);
    else if (!/^-?\d{1,16}$/.test(v)) throw new CitError('CIT_INVALID', `Chỉ tiêu [${c}]: "${v}" phải là số nguyên VND tối đa 16 chữ số`);
  }
  const parsed = new Map<string, Expr>();
  for (const l of t.lines) if (l.kind === 'formula') parsed.set(l.code, parseCitFormula(l.formula ?? ''));
  const value = new Map<string, Decimal>(); const visiting = new Set<string>();
  const evalExpr = (e: Expr): Decimal => {
    if (e.k === 'n') return e.v;
    if (e.k === 'r') return num(e.code);
    const a = evalExpr(e.l); const b = evalExpr(e.r);
    if (e.op === '/') { if (b.isZero()) throw new CitError('CIT_INVALID', 'Chia cho 0 trong công thức'); return a.div(b); }
    return e.op === '+' ? a.plus(b) : e.op === '-' ? a.minus(b) : a.times(b);
  };
  const num = (code: string): Decimal => {
    const done = value.get(code); if (done !== undefined) return done;
    const l = byCode.get(code); if (!l) throw new CitError('CIT_INVALID', `Chỉ tiêu [${code}] không có trong mẫu`);
    if (l.kind === 'section' || l.kind === 'text') throw new CitError('CIT_INVALID', `Chỉ tiêu [${code}] không có số`);
    if (visiting.has(code)) throw new CitError('CIT_INVALID', `Vòng lặp tại chỉ tiêu [${code}]`);
    visiting.add(code);
    const o = inputs.overrides[code];
    let v: Decimal;
    if (l.kind === 'rate') v = rateOf(o ?? inputs.defaults[code] ?? '0', `Chỉ tiêu [${code}]`);
    else if (o !== undefined) v = D(o);
    else if (l.kind === 'formula') { v = evalExpr(parsed.get(code)!).toDecimalPlaces(0, Decimal.ROUND_HALF_UP); if (l.clamp === 'positivePart') v = Decimal.max(0, v); }
    else v = int((l.kind === 'ledger' ? inputs.ledger[code] : undefined) ?? inputs.defaults[code] ?? '0', `Chỉ tiêu [${code}]`);
    visiting.delete(code); value.set(code, v); return v;
  };
  const out: Record<string, string> = {};
  for (const l of t.lines) {
    if (l.kind === 'section') continue;
    out[l.code] = l.kind === 'text' ? inputs.overrides[l.code] ?? inputs.defaults[l.code] ?? '' : l.kind === 'rate' ? num(l.code).toString() : money(num(l.code));
  }
  return out;
}
