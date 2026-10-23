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

/**
 * Lãi kỳ [from, to] (quy ước 8): Σ ngày d của dư nợ gốc cuối ngày d × lãi suất năm hiệu lực ngày d / 100 / dayBasis, làm tròn một lần (`decimals`).
 * `balances`: các bậc dư nợ cuối ngày (bậc có ngày lớn nhất ≤ d áp cho d; chưa có bậc nào thì 0); `rates` tương tự theo `validFrom` (chưa hiệu lực thì 0).
 */
export function periodInterest(a: { from: string; to: string; balances: { date: string; balance: string }[]; rates: { validFrom: string; annualRate: string }[]; dayBasis: 360 | 365; decimals: 0 | 2 }): string {
  const at = <T>(xs: T[], key: (x: T) => string, d: string) => xs.reduce<T | undefined>((best, x) => (key(x) <= d && (!best || key(x) >= key(best)) ? x : best), undefined);
  let sum = ZERO; // Σ dư nợ × lãi suất theo ngày, chia một lần ở cuối để không trôi số
  for (let t = Date.parse(`${a.from}T00:00:00Z`), end = Date.parse(`${a.to}T00:00:00Z`); t <= end; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const b = at(a.balances, (x) => x.date, d); const r = at(a.rates, (x) => x.validFrom, d);
    if (b && r) sum = sum.plus(D(b.balance).times(r.annualRate));
  }
  return sum.div(100 * a.dayBasis).toDecimalPlaces(a.decimals).toFixed(a.decimals);
}
