// Bản TS của fn_format_voucher_no (migration 0005): thay {YYYY}/{YY} trong tiền tố và hậu tố, số thứ tự đệm 0 bên trái.
export function formatVoucherNo(i: { prefix: string; suffix: string; padLength: number; seq: number; year: number }): string {
  const sub = (s: string) => s.replace(/\{YYYY\}/g, String(i.year)).replace(/\{YY\}/g, String(i.year).slice(-2));
  return sub(i.prefix) + String(i.seq).padStart(i.padLength, '0') + sub(i.suffix);
}
