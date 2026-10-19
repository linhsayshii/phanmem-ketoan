import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export const ZERO = new Decimal(0);

export function D(v: string | number | Decimal): Decimal {
  const d = new Decimal(v);
  if (d.isNaN()) throw new Error(`Số không hợp lệ: ${String(v)}`);
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
