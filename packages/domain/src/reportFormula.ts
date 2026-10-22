import { D, ZERO, type Decimal } from './money.js';

export type Side = 'debit' | 'credit' | 'net_debit' | 'net_credit';
export type Source = 'balance' | 'movement' | 'pair' | 'lines';
export type Expr = { kind: 'bin'; op: '+' | '-'; left: Expr; right: Expr } | { kind: 'line'; code: string } | { kind: 'pair'; debit: string[]; credit: string[] } | { kind: 'account'; prefix: string; exclude: string[]; excludeReval?: true } | { kind: 'reval'; side: 'gain' | 'loss' } | { kind: 'num'; value: string };
export interface ReportLineDef { lineCode: string; formula: string | null; source: Source; side: Side }
// excludeReval (hậu tố !REVAL): trừ các dòng thuộc nhóm đánh giá lại ngoại tệ cuối kỳ. reval(): lãi/lỗ thuần của nhóm đó (luôn >= 0, một trong hai bằng 0).
export interface Resolver {
  account(ref: { prefix: string; exclude: string[]; excludeReval?: true }, source: 'balance' | 'movement', side: Side): Promise<Decimal>;
  pair(debit: string[], credit: string[]): Promise<Decimal>;
  reval(): Promise<{ gain: Decimal; loss: Decimal }>;
}

// Lỗi công thức (cú pháp, vòng lặp, dòng không tồn tại): tầng API dịch thành 400 FORMULA_INVALID.
export class FormulaError extends Error {
  constructor(message: string) { super(message); this.name = 'FormulaError'; }
}

type Tok = { t: 'code' | 'line' | 'op' | 'lp' | 'rp' | 'comma' | 'N' | 'C' | 'slash' | 'noreval' | 'reval'; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '[') { const j = src.indexOf(']', i); if (j < 0) throw new FormulaError(`Công thức "${src}": thiếu ]`); out.push({ t: 'line', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    if (ch === '+' || ch === '-') { out.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(') { out.push({ t: 'lp', v: ch }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp', v: ch }); i++; continue; }
    if (ch === ',') { out.push({ t: 'comma', v: ch }); i++; continue; }
    if (ch === '/') { out.push({ t: 'slash', v: ch }); i++; continue; }
    const word = /^(!REVAL|REVAL_GAIN|REVAL_LOSS)(?![\w])/.exec(src.slice(i));
    if (word) { const w = word[1]!; out.push({ t: w === '!REVAL' ? 'noreval' : 'reval', v: w }); i += w.length; continue; }
    if (ch === 'N' || ch === 'C') { out.push({ t: ch, v: ch }); i++; continue; }
    if (/\d/.test(ch)) {
      let j = i; while (j < src.length && /[\d.]/.test(src[j]!)) j++;
      const v = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(v)) throw new FormulaError(`Công thức "${src}": số không hợp lệ "${v}"`);
      out.push({ t: 'code', v }); i = j; continue;
    }
    throw new FormulaError(`Công thức "${src}": ký tự không hợp lệ "${ch}"`);
  }
  return out;
}

export function parseFormula(src: string): Expr {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++]!;
  const fail = (why: string): never => { throw new FormulaError(`Công thức "${src}": ${why}`); };
  const codes = (): string[] => { const cs: string[] = []; do { const t = next(); if (!t || t.t !== 'code') fail('cần mã tài khoản'); cs.push(t.v); } while (peek()?.t === 'comma' && next()); return cs; };
  const term = (): Expr => {
    const t = peek(); if (!t) return fail('thiếu hạng tử');
    if (t.t === 'line') { next(); return { kind: 'line', code: t.v }; }
    if (t.t === 'reval') { next(); return { kind: 'reval', side: t.v === 'REVAL_GAIN' ? 'gain' : 'loss' }; }
    if (t.t === 'N') { next(); const d = codes(); if (peek()?.t !== 'slash') fail('cần / sau danh sách Nợ'); next(); if (peek()?.t !== 'C') fail('cần C sau /'); next(); return { kind: 'pair', debit: d, credit: codes() }; }
    if (t.t === 'code') {
      next();
      if (t.v.includes('.')) return { kind: 'num', value: t.v };
      let exclude: string[] = [];
      if (peek()?.t === 'lp') { next(); exclude = codes(); if (peek()?.t !== 'rp') fail('thiếu )'); next(); }
      const excludeReval = peek()?.t === 'noreval' && !!next();
      // '0' đứng một mình là số không, không phải tiền tố tài khoản.
      if (t.v === '0' && exclude.length === 0) { if (excludeReval) fail('!REVAL cần mã tài khoản'); return { kind: 'num', value: '0' }; }
      return excludeReval ? { kind: 'account', prefix: t.v, exclude, excludeReval: true } : { kind: 'account', prefix: t.v, exclude };
    }
    return fail(`hạng tử không hợp lệ "${t.v}"`);
  };
  let left = term();
  while (peek()?.t === 'op') { const op = next().v as '+' | '-'; const right = term(); left = { kind: 'bin', op, left, right }; }
  if (p < toks.length) fail(`dư ký hiệu "${toks[p]!.v}"`);
  return left;
}

export function formulaRefs(e: Expr): { lines: string[]; accounts: string[] } {
  const lines: string[] = []; const accounts: string[] = [];
  const walk = (x: Expr) => {
    if (x.kind === 'bin') { walk(x.left); walk(x.right); } else if (x.kind === 'line') lines.push(x.code);
    else if (x.kind === 'account') accounts.push(x.prefix, ...x.exclude); else if (x.kind === 'pair') accounts.push(...x.debit, ...x.credit);
  };
  walk(e); return { lines, accounts };
}

export async function evaluateReport(lines: ReportLineDef[], resolver: Resolver): Promise<Map<string, Decimal>> {
  const byCode = new Map(lines.map((l) => [l.lineCode, l])); const parsed = new Map<string, Expr | null>(); const value = new Map<string, Decimal>(); const visiting = new Set<string>();
  for (const l of lines) parsed.set(l.lineCode, l.formula && l.formula.trim() !== '' ? parseFormula(l.formula) : null);
  const evalExpr = async (e: Expr, l: ReportLineDef): Promise<Decimal> => {
    switch (e.kind) {
      case 'num': return D(e.value);
      case 'bin': { const a = await evalExpr(e.left, l); const b = await evalExpr(e.right, l); return e.op === '+' ? a.plus(b) : a.minus(b); }
      case 'line': return evalLine(e.code);
      case 'pair': return resolver.pair(e.debit, e.credit);
      case 'account':
        if (e.excludeReval && l.source !== 'movement') throw new FormulaError(`Dòng [${l.lineCode}]: !REVAL chỉ dùng cho dòng lấy phát sinh (nguồn movement)`);
        return resolver.account({ prefix: e.prefix, exclude: e.exclude, ...(e.excludeReval && { excludeReval: true as const }) }, l.source === 'movement' ? 'movement' : 'balance', l.side);
      case 'reval': {
        if (l.source !== 'movement') throw new FormulaError(`Dòng [${l.lineCode}]: REVAL_GAIN, REVAL_LOSS chỉ dùng cho dòng lấy phát sinh (nguồn movement)`);
        const r = await resolver.reval(); return e.side === 'gain' ? r.gain : r.loss;
      }
    }
  };
  const evalLine = async (code: string): Promise<Decimal> => {
    if (value.has(code)) return value.get(code)!;
    const l = byCode.get(code); if (!l) throw new FormulaError(`Dòng [${code}] không tồn tại`);
    if (visiting.has(code)) throw new FormulaError(`Vòng lặp tại dòng [${code}]`);
    visiting.add(code);
    const e = parsed.get(code) ?? null; const v = e ? await evalExpr(e, l) : ZERO;
    visiting.delete(code); value.set(code, v); return v;
  };
  for (const l of lines) await evalLine(l.lineCode);
  return value;
}
