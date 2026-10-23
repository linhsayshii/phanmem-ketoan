// Ký hiệu mẫu số và ký hiệu hóa đơn điện tử theo Thông tư 91/2026/TT-BTC, Phụ lục I mục 1 (ký hiệu mẫu: một chữ số 1-9)
// và mục 2 (sáu ký tự: C|K, hai chữ số năm, một chữ loại hóa đơn, hai chữ cái do người bán đặt, không có nhu cầu thì YY).
export type InvoiceSymbol =
  | { ok: true; formNo: string; withCode: boolean; year: number; typeLetter: string; suffix: string }
  | { ok: false; message: string };

const SERIAL_RE = /^([CK])(\d{2})([TDLMNBGHXF])([A-Z]{2})$/;

export function parseInvoiceSymbol(formNo: string, serial: string): InvoiceSymbol {
  if (!/^[1-9]$/.test(formNo)) return { ok: false, message: 'Ký hiệu mẫu số hóa đơn phải là một chữ số từ 1 đến 9' };
  const m = SERIAL_RE.exec(serial);
  if (!m) return { ok: false, message: 'Ký hiệu hóa đơn gồm sáu ký tự: C hoặc K, hai chữ số năm, một chữ loại hóa đơn (T, D, L, M, N, B, G, H, X, F) và hai chữ cái in hoa, ví dụ C26TAA' };
  return { ok: true, formNo, withCode: m[1] === 'C', year: 2000 + Number(m[2]), typeLetter: m[3]!, suffix: m[4]! };
}
