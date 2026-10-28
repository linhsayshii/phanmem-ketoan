// Bản TS của fn_format_voucher_no / fn_format_voucher_no_b (migration 0005, 0007, 0280): thay {YYYY}/{YY} trong tiền tố và hậu tố, số thứ tự đệm 0 bên trái.
// branchCode: đánh số theo chi nhánh. undefined/null = tắt ({BR} bị bỏ); có mã mà không có {BR} thì thêm "<mã>-" ở đầu.
export function formatVoucherNo(i: { prefix: string; suffix: string; padLength: number; seq: number; year: number; branchCode?: string | null }): string {
  const hasToken = (i.prefix + i.suffix).includes('{BR}');
  const br = i.branchCode ?? '';
  const sub = (s: string) => s.replace(/\{BR\}/g, br).replace(/\{YYYY\}/g, String(i.year)).replace(/\{YY\}/g, String(i.year).slice(-2));
  const core = sub(i.prefix) + String(i.seq).padStart(i.padLength, '0') + sub(i.suffix);
  return i.branchCode && !hasToken ? `${i.branchCode}-${core}` : core;
}
