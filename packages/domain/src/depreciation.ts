import { D, Decimal, ZERO } from './money.js';

// Động cơ khấu hao/phân bổ thuần (quy ước 3–5 kế hoạch GĐ4): đơn vị tiêu thụ theo kỳ, lũy kế mục tiêu T(c), lịch theo phiên bản.
export type Proration = 'day' | 'month';
export type DepreciationUnit = 'month_day' | 'month_whole' | 'period';
export interface PeriodSpan { fiscalYear: number; periodNo: number; from: string; to: string } // ngày ISO, from ≤ to
// start: ngày bắt đầu khấu hao (tính); end: ngày ghi giảm (không tính ngày đó và sau đó); pause: from tính là dừng, to là ngày tiếp tục (null = dừng chưa tiếp tục).
export interface ActiveWindow { start: string; end: string | null; pauses: { from: string; to: string | null }[] }
export interface ScheduleLine { fiscalYear: number; periodNo: number; units: string; amount: string; accumulated: string }

const DAY = 86_400_000;
const dayNo = (iso: string): number => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) throw new Error(`Ngày không hợp lệ: ${iso}`);
  return t / DAY;
};
const isoOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const ymOf = (n: number) => { const x = new Date(n * DAY); return { y: x.getUTCFullYear(), m: x.getUTCMonth() }; };
const units12 = (d: Decimal) => d.toDecimalPlaces(12, Decimal.ROUND_HALF_UP).toString();

function activeFn(w: ActiveWindow) {
  const s = dayNo(w.start); const e = w.end === null ? Infinity : dayNo(w.end);
  const ps = w.pauses.map((p) => [dayNo(p.from), p.to === null ? Infinity : dayNo(p.to)] as const);
  return { s, e, active: (d: number) => d >= s && d < e && !ps.some(([f, t]) => d >= f && d < t) };
}

/**
 * Đơn vị một kỳ tiêu thụ (thập phân, 12 chữ số).
 * - month_day: Σ theo tháng dương lịch của (ngày hoạt động trong kỳ / số ngày của tháng).
 * - month_whole: mỗi tháng tính 1 nếu có ngày bắt đầu khấu hao hoặc hoạt động vào ngày 1; 0 nếu ngày ghi giảm nằm trong tháng đó hoặc trước.
 *   Tháng thuộc kỳ chứa "mốc" của nó: ngày bắt đầu nếu bắt đầu trong tháng, nếu không là ngày 1.
 * - period: 1 nếu là kỳ bắt đầu, hoặc đang hoạt động vào ngày đầu kỳ (không dừng, chưa ghi giảm); không chia theo ngày.
 * Kỳ 0 và kỳ > 12 (kỳ điều chỉnh) trả '0'.
 */
export function periodUnits(span: PeriodSpan, w: ActiveWindow, unit: DepreciationUnit): string {
  if (span.periodNo < 1 || span.periodNo > 12) return '0';
  const from = dayNo(span.from); const to = dayNo(span.to);
  const { s, e, active } = activeFn(w);
  if (unit === 'period') {
    if (s > to || e <= from || e <= s) return '0';
    return s >= from || active(from) ? '1' : '0';
  }
  if (unit === 'month_day') {
    const perMonth = new Map<string, { n: number; dim: number }>();
    for (let d = Math.max(from, s); d <= Math.min(to, e - 1); d++) {
      if (!active(d)) continue;
      const { y, m } = ymOf(d); const k = `${y}-${m}`;
      const c = perMonth.get(k) ?? { n: 0, dim: new Date(Date.UTC(y, m + 1, 0)).getUTCDate() };
      c.n++; perMonth.set(k, c);
    }
    return units12([...perMonth.values()].reduce((t, c) => t.plus(D(c.n).div(c.dim)), ZERO));
  }
  let n = 0;
  for (let { y, m } = ymOf(from); Date.UTC(y, m, 1) / DAY <= to; m === 11 ? (y++, m = 0) : m++) {
    const first = Date.UTC(y, m, 1) / DAY; const last = Date.UTC(y, m + 1, 0) / DAY;
    const anchor = s >= first && s <= last ? s : first;
    if (anchor >= from && anchor <= to && (anchor === s || active(anchor)) && e > last) n++;
  }
  return String(n);
}

const target = (B: Decimal, U: Decimal, c: Decimal): Decimal => (U.isZero() || c.gte(U) ? B : B.times(c).div(U).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));

/** Lũy kế mục tiêu T(c) = c ≥ U ? B : round_half_up(B × c / U) (quy ước 4); U = 0 trả B. */
export function targetAccumulated(basis: string, units: string, consumed: string): string {
  return target(D(basis), D(units), D(consumed)).toString();
}

/**
 * Dòng lịch của một phiên bản: đi qua các kỳ theo thứ tự, kỳ tiêu thụ 0 đơn vị không có dòng; số kỳ = T(c sau) − T(c trước);
 * dừng khi đã tiêu thụ đủ `units` hoặc hết kỳ. `units` của dòng là units(P) đầy đủ (không cắt ở phần còn lại) để so lại khi chạy kỳ.
 */
export function buildSchedule(a: { basisValue: string; basisAcc: string; units: string; periods: PeriodSpan[]; window: ActiveWindow; unit: DepreciationUnit }): ScheduleLine[] {
  const B = D(a.basisValue); const acc0 = D(a.basisAcc); const U = D(a.units);
  if (U.isNegative()) throw new Error(`Số đơn vị còn lại không được âm: ${a.units}`);
  const out: ScheduleLine[] = [];
  let c = ZERO;
  for (const p of a.periods) {
    if (c.gte(U)) break;
    const u = periodUnits(p, a.window, a.unit);
    if (D(u).isZero()) continue;
    const before = target(B, U, c); c = c.plus(u); const after = target(B, U, c);
    out.push({ fiscalYear: p.fiscalYear, periodNo: p.periodNo, units: u, amount: after.minus(before).toString(), accumulated: acc0.plus(after).toString() });
  }
  return out;
}

/**
 * Chia số tiền nguyên theo tỷ lệ (tỷ lệ tương đối, thường tổng 100) bằng phần dư lớn nhất: mỗi phần lấy phần nguyên,
 * đồng dư chia cho phần có phần lẻ lớn nhất, hòa thì phần đứng trước. Tổng đúng amount, không phần nào trái dấu amount.
 * Khác `splitByRatio` (stock.ts, phần cuối nhận dư, dùng cho lắp ráp/giá vốn) để không đổi số liệu GĐ3.
 */
export function allocateByRatio(amount: string, ratios: string[]): string[] {
  const a = D(amount); if (!a.isInteger()) throw new Error(`Số tiền phải là đồng nguyên: ${amount}`);
  const rs = ratios.map((r) => D(r));
  const sumR = rs.reduce((t, r) => t.plus(r), ZERO);
  if (rs.some((r) => r.isNegative()) || !sumR.gt(0)) throw new Error('Tỷ lệ phân bổ không được âm và tổng phải dương');
  const abs = a.abs();
  const parts = rs.map((r, i) => { const q = abs.times(r).div(sumR); const f = q.floor(); return { i, f, frac: q.minus(f) }; });
  let rem = abs.minus(parts.reduce((t, p) => t.plus(p.f), ZERO)).toNumber();
  for (const p of [...parts].sort((x, y) => y.frac.comparedTo(x.frac) || x.i - y.i)) { if (rem <= 0) break; p.f = p.f.plus(1); rem--; }
  return parts.map((p) => (a.isNegative() && !p.f.isZero() ? p.f.neg() : p.f).toString());
}

/**
 * `count` kỳ liên tiếp từ (fromYear, fromPeriod): dùng kỳ đã có trong `known` (chỉ kỳ 1..12); năm chưa có giả định 12 kỳ tháng dương lịch,
 * kỳ 1 bắt đầu cùng tháng với kỳ 1 của năm đã có đầu tiên trong `known` (không có thì tháng 1).
 */
export function futurePeriods(known: PeriodSpan[], fromYear: number, fromPeriod: number, count: number): PeriodSpan[] {
  const byYear = new Map<number, PeriodSpan[]>();
  for (const p of [...known].filter((p) => p.periodNo >= 1 && p.periodNo <= 12).sort((x, y) => x.fiscalYear - y.fiscalYear || x.periodNo - y.periodNo)) {
    const l = byYear.get(p.fiscalYear) ?? []; l.push(p); byYear.set(p.fiscalYear, l);
  }
  const p1 = [...byYear.values()].map((l) => l.find((p) => p.periodNo === 1)).find((p) => p);
  const m0 = p1 ? ymOf(dayNo(p1.from)).m : 0;
  const out: PeriodSpan[] = [];
  for (let y = fromYear; out.length < count; y++) {
    const year = byYear.get(y) ?? Array.from({ length: 12 }, (_, k) => ({ fiscalYear: y, periodNo: k + 1, from: isoOf(y, m0 + k, 1), to: isoOf(y, m0 + k + 1, 0) }));
    for (const p of year) if ((y > fromYear || p.periodNo >= fromPeriod) && out.length < count) out.push(p);
  }
  return out;
}
