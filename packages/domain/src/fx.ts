import { D, Decimal } from './money.js';

// Quy đổi nguyên tệ ra đồng: làm tròn nửa lên (xa số 0) về đồng nguyên, cùng cách round() của PostgreSQL khi kiểm dòng ngoại tệ (fn_line_before).
export function toVnd(amountCurrency: string, rate: string): string {
  const v = D(amountCurrency).times(D(rate)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return v.isZero() ? '0' : v.toFixed(0); // -0,4 làm tròn ra -0: trả "0"
}

// Tỷ giá ghi sổ bình quân = số dư VND / số dư nguyên tệ, 10 chữ số thập phân (numeric(20,10)); nguyên tệ bằng 0 thì không có tỷ giá.
export function avgRate(balanceVnd: string, balanceCurrency: string): string | null {
  const cur = D(balanceCurrency);
  return cur.isZero() ? null : D(balanceVnd).div(cur).toDecimalPlaces(10, Decimal.ROUND_HALF_UP).toFixed(10);
}

// Giá trị VND của `part` nguyên tệ lấy ra từ số dư (residualVnd, residualCurrency) theo bình quân di động.
// Lấy hết nguyên tệ thì lấy đúng hết số dư VND, để nguyên tệ về 0 không còn số dư VND lẻ do làm tròn tỷ giá.
export function proportionalVnd(residualVnd: string, residualCurrency: string, part: string): string {
  if (D(part).eq(D(residualCurrency))) return D(residualVnd).toFixed(0);
  const rate = avgRate(residualVnd, residualCurrency);
  if (rate === null) throw new Error('Số dư nguyên tệ bằng 0: không có tỷ giá bình quân');
  return toVnd(part, rate);
}
