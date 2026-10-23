import { D, ZERO } from './money.js';

// Cộng n tháng vào ngày ISO, giữ ngày trong tháng; ngày vượt số ngày của tháng đích thì lùi về ngày cuối tháng.
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = y * 12 + (m - 1) + n; const ny = Math.floor(t / 12); const nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Phần dư nợ gốc dài hạn của một khế ước vay tại `reportDate` (dùng cho B01).
 * Có lịch trả: số đã trả phân bổ vào kỳ trả sớm nhất trước; phần còn lại của kỳ trả hạn ≤ reportDate + 12 tháng (kể cả quá hạn) là ngắn hạn;
 * dài hạn = max(0, dư nợ − ngắn hạn). Không có lịch: dài hạn = dư nợ nếu ngày đáo hạn sau reportDate + 12 tháng, không thì 0.
 */
export function loanLongTermPart(outstanding: string, repaidTotal: string, installments: { dueDate: string; principal: string }[], reportDate: string, maturity: string | null): string {
  const out = D(outstanding); if (out.lte(0)) return '0';
  const cutoff = addMonthsIso(reportDate, 12);
  if (!installments.length) return maturity !== null && maturity > cutoff ? out.toString() : '0';
  let repaid = D(repaidTotal); let short = ZERO;
  for (const i of [...installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    const p = D(i.principal); const paid = repaid.lt(p) ? repaid : p; repaid = repaid.minus(paid);
    if (i.dueDate <= cutoff) short = short.plus(p.minus(paid));
  }
  const long = out.minus(short);
  return long.gt(0) ? long.toString() : '0';
}
