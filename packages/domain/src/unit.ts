import { D, Decimal } from './money.js';

// Quy đổi số lượng giữa ĐVT nhập và ĐVT cơ sở của hàng: factor = số đơn vị cơ sở trong một ĐVT (1 thùng = 24 chai → 24), 4 chữ số thập phân nửa lên.
function factorOf(factor: string): Decimal {
  const f = D(factor);
  if (!f.gt(0)) throw new Error(`Hệ số quy đổi phải dương: ${factor}`);
  return f;
}
const qtyStr = (d: Decimal): string => { const r = d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP); return r.isZero() ? '0' : r.toString(); };

export function toBaseQty(qty: string, factor: string): string {
  return qtyStr(D(qty).times(factorOf(factor)));
}

export function fromBaseQty(base: string, factor: string): string {
  return qtyStr(D(base).div(factorOf(factor)));
}
