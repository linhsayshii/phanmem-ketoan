import { D, Decimal, ZERO, sum } from './money.js';

export type LandedCostBasis = 'value' | 'quantity';
export interface LandedCostLine { id: string; qty: string; value: string }

export class LandedCostError extends Error {
  constructor(public code: 'LANDED_COST_BASIS_ZERO' | 'LANDED_COST_INVALID', message: string) { super(message); this.name = 'LandedCostError'; }
}

const byId = (a: string, b: string): number => (/^\d+$/.test(a) && /^\d+$/.test(b) ? D(a).comparedTo(b) : a < b ? -1 : a > b ? 1 : 0);

// Phân bổ tổng chi phí mua hàng (VND, đồng nguyên) cho các dòng nhập theo tỷ lệ giá trị hoặc số lượng. Làm tròn xuống từng dòng rồi chia phần dư từng đồng
// cho dòng có phần lẻ lớn nhất (cùng phần lẻ: dòng tỷ trọng lớn hơn, rồi id nhỏ hơn): tổng phân bổ luôn đúng bằng tổng chi phí, không dòng nào âm,
// mỗi dòng lệch tỷ lệ chính xác dưới 1 đồng. Dòng có cơ sở 0 nhận 0; mọi dòng cơ sở 0 thì LANDED_COST_BASIS_ZERO.
export function allocateLandedCost(costs: string[], lines: LandedCostLine[], basis: LandedCostBasis): Record<string, string> {
  if (costs.some((c) => !/^\d{1,16}$/.test(c))) throw new LandedCostError('LANDED_COST_INVALID', 'Chi phí phải là số tiền nguyên đồng không âm');
  const total = sum(costs);
  const weights = lines.map((l) => D(basis === 'value' ? l.value : l.qty));
  if (weights.some((w) => w.isNeg())) throw new LandedCostError('LANDED_COST_INVALID', 'Giá trị hoặc số lượng của dòng nhập không được âm');
  const wTotal = sum(weights);
  if (!lines.length || (wTotal.isZero() && !total.isZero())) throw new LandedCostError('LANDED_COST_BASIS_ZERO', `Các dòng nhập có tổng ${basis === 'value' ? 'giá trị' : 'số lượng'} bằng 0, không phân bổ được`);
  const exact = weights.map((w) => (wTotal.isZero() ? ZERO : total.times(w).div(wTotal)));
  const out = exact.map((x) => x.toDecimalPlaces(0, Decimal.ROUND_DOWN));
  let left = total.minus(sum(out)).toNumber(); // < số dòng
  const order = lines.map((_, i) => i).sort((a, b) => exact[b]!.minus(out[b]!).comparedTo(exact[a]!.minus(out[a]!)) || weights[b]!.comparedTo(weights[a]!) || byId(lines[a]!.id, lines[b]!.id));
  for (const i of order) { if (left <= 0) break; out[i] = out[i]!.plus(1); left--; }
  return Object.fromEntries(lines.map((l, i) => [l.id, out[i]!.toFixed(0)]));
}
