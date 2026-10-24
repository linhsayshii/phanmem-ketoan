import { Decimal } from './money.js';

// Ngôn ngữ công thức cột lương (GĐ6 D11): bộ phân tích riêng, không eval/Function. Số là Decimal; so sánh và &&, || trả 1/0.
export class PayrollError extends Error {
  constructor(public code: string, message: string, public column?: string, public param?: string) { super(message); this.name = 'PayrollError'; }
}

export type FormulaNode =
  | { t: 'num'; v: Decimal }
  | { t: 'str'; v: string }
  | { t: 'ref'; code: string }
  | { t: 'neg'; a: FormulaNode }
  | { t: 'bin'; op: string; a: FormulaNode; b: FormulaNode }
  | { t: 'call'; fn: string; args: FormulaNode[] };

// [số đối số tối thiểu, tối đa]
const FUNCS: Record<string, [number, number]> = {
  MIN: [1, 99], MAX: [1, 99], SUM: [1, 99], IF: [3, 3], ROUND: [1, 2], ABS: [1, 1], PIT: [1, 1], SI_EMP: [1, 1], SI_ER: [1, 1], PARAM: [1, 1],
};
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|\[([A-Za-z_][A-Za-z0-9_]*)\]|([A-Za-z_][A-Za-z0-9_]*)|'([^']*)'|"([^"]*)"|(>=|<=|==|!=|&&|\|\||[-+*/<>(),]))/y;
type Tok = { k: 'num' | 'ref' | 'id' | 'str' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new PayrollError('FORMULA_SYNTAX', `Công thức sai cú pháp tại vị trí ${at + 1}: "${src.slice(at, at + 10).trim()}"`);
    if (m[1] !== undefined) out.push({ k: 'num', v: m[1] });
    else if (m[2] !== undefined) out.push({ k: 'ref', v: m[2] });
    else if (m[3] !== undefined) out.push({ k: 'id', v: m[3].toUpperCase() });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ k: 'str', v: m[4] ?? m[5]! });
    else out.push({ k: 'op', v: m[6]! });
  }
  return out;
}

const LEVELS = [['||'], ['&&'], ['>', '<', '>=', '<=', '==', '!='], ['+', '-'], ['*', '/']];

export function parsePayrollFormula(src: string): FormulaNode {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new PayrollError('FORMULA_SYNTAX', `Công thức thiếu "${v}"`); i++; };
  const level = (n: number): FormulaNode => {
    if (n === LEVELS.length) return unary();
    let a = level(n + 1);
    // so sánh không nối chuỗi (a < b < c sai cú pháp); các mức khác kết hợp trái
    while (peek()?.k === 'op' && LEVELS[n]!.includes(peek()!.v)) {
      const op = toks[i++]!.v;
      a = { t: 'bin', op, a, b: level(n + 1) };
      if (n === 2) break;
    }
    return a;
  };
  const unary = (): FormulaNode => {
    if (isOp('-')) { i++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { i++; return unary(); }
    return primary();
  };
  const primary = (): FormulaNode => {
    const t = toks[i++];
    if (!t) throw new PayrollError('FORMULA_SYNTAX', 'Công thức kết thúc đột ngột');
    if (t.k === 'num') return { t: 'num', v: new Decimal(t.v) };
    if (t.k === 'ref') return { t: 'ref', code: t.v };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'op' && t.v === '(') { const e = level(0); expect(')'); return e; }
    if (t.k === 'id') {
      const arity = FUNCS[t.v];
      if (!arity) throw new PayrollError('FORMULA_UNKNOWN_FUNCTION', `Hàm không hỗ trợ: ${t.v}`);
      expect('(');
      const args: FormulaNode[] = [];
      if (!isOp(')')) { args.push(level(0)); while (isOp(',')) { i++; args.push(level(0)); } }
      expect(')');
      if (args.length < arity[0] || args.length > arity[1]) throw new PayrollError('FORMULA_ARGS', `Hàm ${t.v} nhận ${arity[0] === arity[1] ? arity[0] : `${arity[0]}–${arity[1]}`} đối số`);
      if ((t.v === 'PARAM') !== args.some((a) => a.t === 'str')) throw new PayrollError('FORMULA_ARGS', t.v === 'PARAM' ? "PARAM nhận tên tham số trong nháy, ví dụ PARAM('deduction_self')" : 'Chuỗi chỉ dùng trong PARAM');
      return { t: 'call', fn: t.v, args };
    }
    throw new PayrollError('FORMULA_SYNTAX', `Công thức sai cú pháp tại "${t.v}"`);
  };
  const ast = level(0);
  if (i < toks.length) throw new PayrollError('FORMULA_SYNTAX', `Công thức thừa "${toks[i]!.v}"`);
  return ast;
}

export function payrollFormulaRefs(n: FormulaNode, acc = new Set<string>()): Set<string> {
  if (n.t === 'ref') acc.add(n.code);
  else if (n.t === 'neg') payrollFormulaRefs(n.a, acc);
  else if (n.t === 'bin') { payrollFormulaRefs(n.a, acc); payrollFormulaRefs(n.b, acc); }
  else if (n.t === 'call') n.args.forEach((a) => payrollFormulaRefs(a, acc));
  return acc;
}

export interface FormulaContext {
  column: string;
  get(code: string): Decimal;
  pit(x: Decimal): Decimal;
  siEmp(x: Decimal): Decimal;
  siEr(x: Decimal): Decimal;
  param(name: string): Decimal;
}

const b2d = (b: boolean) => new Decimal(b ? 1 : 0);

export function evaluatePayrollFormula(n: FormulaNode, ctx: FormulaContext): Decimal {
  const ev = (x: FormulaNode) => evaluatePayrollFormula(x, ctx);
  switch (n.t) {
    case 'num': return n.v;
    case 'str': throw new PayrollError('FORMULA_ARGS', 'Chuỗi chỉ dùng trong PARAM', ctx.column);
    case 'ref': return ctx.get(n.code);
    case 'neg': return ev(n.a).neg();
    case 'bin': {
      if (n.op === '&&') return b2d(!ev(n.a).isZero() && !ev(n.b).isZero());
      if (n.op === '||') return b2d(!ev(n.a).isZero() || !ev(n.b).isZero());
      const a = ev(n.a); const b = ev(n.b);
      switch (n.op) {
        case '+': return a.plus(b);
        case '-': return a.minus(b);
        case '*': return a.times(b);
        case '/': if (b.isZero()) throw new PayrollError('FORMULA_DIV_ZERO', `Cột "${ctx.column}": công thức chia cho 0`, ctx.column); return a.div(b);
        case '>': return b2d(a.gt(b));
        case '<': return b2d(a.lt(b));
        case '>=': return b2d(a.gte(b));
        case '<=': return b2d(a.lte(b));
        case '==': return b2d(a.eq(b));
        default: return b2d(!a.eq(b)); // '!='
      }
    }
    case 'call': {
      const a = n.args;
      switch (n.fn) {
        case 'IF': return ev(a[0]!).isZero() ? ev(a[2]!) : ev(a[1]!);
        case 'MIN': return Decimal.min(...a.map(ev));
        case 'MAX': return Decimal.max(...a.map(ev));
        case 'SUM': return a.map(ev).reduce((s, x) => s.plus(x), new Decimal(0));
        case 'ABS': return ev(a[0]!).abs();
        case 'ROUND': {
          const dp = a[1] ? ev(a[1]) : new Decimal(0);
          if (!dp.isInteger() || dp.abs().gt(9)) throw new PayrollError('FORMULA_ARGS', `Cột "${ctx.column}": ROUND nhận số chữ số nguyên từ −9 đến 9`, ctx.column);
          const k = dp.toNumber(); const x = ev(a[0]!);
          if (k >= 0) return x.toDecimalPlaces(k, Decimal.ROUND_HALF_UP);
          const s = new Decimal(10).pow(-k);
          return x.div(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(s);
        }
        case 'PIT': return ctx.pit(ev(a[0]!));
        case 'SI_EMP': return ctx.siEmp(ev(a[0]!));
        case 'SI_ER': return ctx.siEr(ev(a[0]!));
        default: return ctx.param((a[0] as { v: string }).v); // PARAM
      }
    }
  }
}
