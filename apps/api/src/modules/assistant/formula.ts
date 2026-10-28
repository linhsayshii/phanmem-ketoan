import { D, Decimal } from '@kt/domain';

// Công thức số tiền của mẫu bút toán định kỳ. Tự viết bộ phân tích đệ quy xuống (không eval, không Function): chỉ số, biến, + - * /, ngoặc, ROUND/MIN/MAX.
// Mọi phép tính bằng decimal.js. Kết quả làm tròn nửa lên về đồng nguyên và phải nằm trong 0..9.999.999.999.999.999 (16 chữ số).
export const FORMULA_VARS = ['THANG', 'QUY', 'NAM', 'SO_NGAY'] as const;
export type FormulaVars = Record<(typeof FORMULA_VARS)[number], number>;
export const MAX_FORMULA_LEN = 200;
const MAX_DEPTH = 20;
const MAX_NODES = 200;
const MAX_VND = new Decimal('9999999999999999');

export class FormulaError extends Error { constructor(message: string) { super(message); this.name = 'FormulaError'; } }

type Tok = { t: 'num'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };
function tokenize(src: string): Tok[] {
  if (src.length > MAX_FORMULA_LEN) throw new FormulaError(`Công thức dài quá ${MAX_FORMULA_LEN} ký tự`);
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/\d/.test(c)) {
      const m = /^\d{1,16}(\.\d{1,6})?/.exec(src.slice(i));
      if (!m) throw new FormulaError('Số sai dạng');
      out.push({ t: 'num', v: m[0] }); i += m[0].length;
      if (/[\d.]/.test(src[i] ?? '')) throw new FormulaError('Số quá dài hoặc sai dạng');
      continue;
    }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i))!; out.push({ t: 'id', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ('+-*/(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new FormulaError(`Ký tự không được dùng trong công thức: "${c}"`);
  }
  return out;
}

const FUNCS: Record<string, (a: Decimal[]) => Decimal> = {
  ROUND: (a) => {
    if (a.length < 1 || a.length > 2) throw new FormulaError('ROUND(x) hoặc ROUND(x, số lẻ)');
    const n = a[1]?.toNumber() ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new FormulaError('ROUND: số chữ số lẻ từ 0 đến 6');
    return a[0]!.toDecimalPlaces(n, Decimal.ROUND_HALF_UP);
  },
  MIN: (a) => { if (a.length < 2) throw new FormulaError('MIN cần ít nhất hai số'); return Decimal.min(...a); },
  MAX: (a) => { if (a.length < 2) throw new FormulaError('MAX cần ít nhất hai số'); return Decimal.max(...a); },
};

// Tính công thức theo biến của kỳ; trả số nguyên đồng dạng chuỗi.
export function evalAmount(src: string, vars: FormulaVars): string {
  const toks = tokenize(src); let pos = 0; let nodes = 0;
  const peek = () => toks[pos]; const next = () => toks[pos++];
  const isOp = (v: string) => { const t = peek(); return t?.t === 'op' && t.v === v; };
  function expr(depth: number): Decimal {
    if (depth > MAX_DEPTH) throw new FormulaError('Công thức lồng quá sâu');
    let acc = term(depth);
    while (isOp('+') || isOp('-')) { const op = next()!.v; const r = term(depth); acc = op === '+' ? acc.plus(r) : acc.minus(r); }
    return acc;
  }
  function term(depth: number): Decimal {
    let acc = factor(depth);
    while (isOp('*') || isOp('/')) {
      const op = next()!.v; const r = factor(depth);
      if (op === '/') { if (r.isZero()) throw new FormulaError('Chia cho 0'); acc = acc.div(r); } else acc = acc.times(r);
    }
    return acc;
  }
  function factor(depth: number): Decimal {
    if (++nodes > MAX_NODES) throw new FormulaError('Công thức quá phức tạp');
    if (depth > MAX_DEPTH) throw new FormulaError('Công thức lồng quá sâu');
    const t = next();
    if (!t) throw new FormulaError('Công thức thiếu vế');
    if (t.t === 'num') return D(t.v);
    if (t.t === 'op' && t.v === '-') return factor(depth + 1).neg();
    if (t.t === 'op' && t.v === '(') { const v = expr(depth + 1); if (!isOp(')')) throw new FormulaError('Thiếu dấu )'); next(); return v; }
    if (t.t === 'id') {
      if (isOp('(')) {
        const fn = FUNCS[t.v];
        if (!fn) throw new FormulaError(`Hàm không có: ${t.v}`);
        next(); const args: Decimal[] = [];
        if (!isOp(')')) { args.push(expr(depth + 1)); while (isOp(',')) { next(); args.push(expr(depth + 1)); } }
        if (!isOp(')')) throw new FormulaError('Thiếu dấu )');
        next();
        return fn(args);
      }
      if ((FORMULA_VARS as readonly string[]).includes(t.v)) return D(vars[t.v as keyof FormulaVars]);
      throw new FormulaError(`Biến không có: ${t.v} (dùng ${FORMULA_VARS.join(', ')})`);
    }
    throw new FormulaError(`Công thức sai cú pháp gần "${t.v}"`);
  }
  const v = expr(0);
  if (pos < toks.length) throw new FormulaError(`Công thức sai cú pháp gần "${toks[pos]!.v}"`);
  const r = v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (r.isNegative() && !r.isZero()) throw new FormulaError('Số tiền âm: dùng bên Nợ hoặc Có đối ứng thay vì số âm');
  if (r.gt(MAX_VND)) throw new FormulaError('Số tiền vượt 16 chữ số');
  return r.toFixed(0);
}

// Kiểm cú pháp khi lưu mẫu: tính thử với biến của một tháng mẫu.
export function checkFormula(src: string): void { evalAmount(src, { THANG: 1, QUY: 1, NAM: 2026, SO_NGAY: 31 }); }
