// Lịch của mẫu bút toán định kỳ: kỳ đến hạn theo tần suất. Thuần, không đọc cơ sở dữ liệu.
export type Frequency = 'monthly' | 'quarterly' | 'yearly';
export interface ScheduleSpec { frequency: Frequency; dayOfMonth: number; startDate: string; endDate: string | null; catchUp: boolean; createdAt: string }
export interface Occurrence { periodKey: string; date: string; year: number; month: number }

const STEP: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const isoDate = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
// Ngày phát sinh của tháng: ngày cấu hình, tháng ngắn hơn thì cuối tháng.
export const dayInMonth = (year: number, month: number, day: number): string => isoDate(year, month, Math.min(day, daysInMonth(year, month)));
// Giới hạn một lần quét: đủ cho 10 năm theo tháng; mẫu bắt đầu xa hơn sinh dần qua các lần chạy.
export const MAX_OCCURRENCES = 120;

// Các kỳ đến hạn (ngày phát sinh <= upTo), từ cũ đến mới. Kỳ k: tháng của start_date cộng k × bước. Không bù (catchUp = false): bỏ kỳ trước tháng lập mẫu.
export function dueOccurrences(s: ScheduleSpec, upTo: string): Occurrence[] {
  const [sy, sm] = s.startDate.split('-').map(Number) as [number, number];
  const created = `${s.createdAt.slice(0, 7)}-01`;
  const floor = s.catchUp || created < s.startDate ? s.startDate : created;
  const out: Occurrence[] = [];
  for (let k = 0; out.length < MAX_OCCURRENCES; k++) {
    const idx = sy * 12 + (sm - 1) + k * STEP[s.frequency];
    const y = Math.floor(idx / 12); const m = (idx % 12) + 1;
    const date = dayInMonth(y, m, s.dayOfMonth);
    if (date > upTo || (s.endDate !== null && date > s.endDate)) break;
    if (date < floor) continue;
    out.push({ periodKey: `${pad(y, 4)}-${pad(m)}`, date, year: y, month: m });
  }
  return out;
}
