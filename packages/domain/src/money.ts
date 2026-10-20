import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

export { Decimal };
export const ZERO = new Decimal(0);

// Tiền VND hạch toán là numeric(20,0); 16 chữ số/dòng × tối đa 5.000 dòng/chứng từ vẫn nằm trong 20 chữ số khi cộng dồn.
export const VND_AMOUNT_RE = /^\d{1,16}$/;
export const VND_AMOUNT_MSG = 'Số tiền VND phải là số nguyên tối đa 16 chữ số';

export function D(v: string | number | Decimal): Decimal {
  if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`Số không hợp lệ: ${v}`);
  const d = new Decimal(v);
  if (!d.isFinite()) throw new Error(`Số không hợp lệ: ${String(v)}`);
  return d;
}

export function vnd(v: string | number | Decimal): Decimal {
  return D(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

export function sum(xs: Iterable<string | Decimal>): Decimal {
  let acc = ZERO;
  for (const x of xs) acc = acc.plus(D(x));
  return acc;
}

export function isBalanced(lines: { debit: string; credit: string }[]): boolean {
  return sum(lines.map((l) => l.debit)).equals(sum(lines.map((l) => l.credit)));
}
