import { D } from './money.js';
import { workDays, type AttendanceKind } from './payroll.js';

// Chấm công (GĐ6 Task 4): mã gõ nhanh trong ô lưới, kiểm số lượng theo loại. Quy đổi ngày công nằm ở workDays (payroll.ts), không viết lại ở đây.
export interface AttendanceItem { kind: AttendanceKind; qty: string }
export type AttendanceCheck = { code: 'ATTENDANCE_INVALID' | 'PAYROLL_SETTING_MISSING'; message: string } | null;

export const ATTENDANCE_KIND_LABEL: Record<AttendanceKind, string> = {
  work_day: 'Ngày công', half_day: 'Nửa ngày (buổi)', hour: 'Giờ làm việc', ot_weekday_hour: 'Làm thêm ngày thường (giờ)', ot_rest_hour: 'Làm thêm ngày nghỉ hằng tuần (giờ)',
  ot_holiday_hour: 'Làm thêm ngày lễ (giờ)', paid_leave: 'Nghỉ phép hưởng lương', sick_leave: 'Nghỉ ốm', unpaid_leave: 'Nghỉ không lương', holiday: 'Nghỉ lễ hưởng lương',
};
export const ATTENDANCE_KINDS = Object.keys(ATTENDANCE_KIND_LABEL) as AttendanceKind[];

// Chữ cái gõ trong ô: X = 1 ngày, N = nửa ngày, P = phép, O = ốm, K = không lương, H = nghỉ lễ (P/O/K/H có thể kèm số ngày), T/C/L + số giờ = làm thêm ngày thường/ngày nghỉ/ngày lễ, số trần = giờ làm việc.
const LETTER: Record<string, AttendanceKind> = { X: 'work_day', N: 'half_day', P: 'paid_leave', O: 'sick_leave', K: 'unpaid_leave', H: 'holiday', T: 'ot_weekday_hour', C: 'ot_rest_hour', L: 'ot_holiday_hour' };
const CODE_OF: Partial<Record<AttendanceKind, string>> = Object.fromEntries(Object.entries(LETTER).map(([c, k]) => [k, c]));
const NUM = /^\d{1,4}([.,]\d{1,2})?$/;
const asQty = (s: string) => D(s.replace(',', '.')).toString();

export function parseAttendanceCell(text: string): { ok: true; entries: AttendanceItem[] } | { ok: false; error: string } {
  const entries: AttendanceItem[] = [];
  for (const raw of text.trim().split(/[\s+;]+/).filter(Boolean)) {
    const t = raw.toUpperCase();
    let kind: AttendanceKind; let qty: string;
    if (NUM.test(t)) { kind = 'hour'; qty = asQty(t); } else {
      const k = LETTER[t[0]!]; const rest = t.slice(1);
      if (!k) return { ok: false, error: `Mã "${raw}" không hợp lệ (X, N, P, O, K, H, T, C, L hoặc số giờ)` };
      kind = k;
      if (rest === '') {
        if (k === 'ot_weekday_hour' || k === 'ot_rest_hour' || k === 'ot_holiday_hour') return { ok: false, error: `Làm thêm giờ phải kèm số giờ, ví dụ ${t}2` };
        qty = '1';
      } else if (!NUM.test(rest) || k === 'work_day' || k === 'half_day') return { ok: false, error: `Mã "${raw}" không hợp lệ` };
      else qty = asQty(rest);
    }
    if (entries.some((e) => e.kind === kind)) return { ok: false, error: `Mã "${raw}" bị lặp trong ô` };
    entries.push({ kind, qty });
  }
  return { ok: true, entries };
}

export function formatAttendanceCell(entries: AttendanceItem[]): string {
  const order = (k: AttendanceKind) => ATTENDANCE_KINDS.indexOf(k);
  return [...entries].sort((a, b) => order(a.kind) - order(b.kind)).map((e) => {
    const q = D(e.qty).toString().replace('.', ',');
    const c = CODE_OF[e.kind];
    if (e.kind === 'hour') return q;
    if (e.kind === 'work_day' || e.kind === 'half_day') return c!;
    return e.qty === '1' && !e.kind.startsWith('ot_') ? c! : `${c}${q}`;
  }).join(' ');
}

// Kiểm các dòng của MỘT ngày một nhân viên. Giờ làm việc cần giờ chuẩn/ngày (cài đặt công ty) để quy đổi và kiểm trần 1 ngày.
export function checkAttendanceDay(entries: AttendanceItem[], standardHoursPerDay: string | null): AttendanceCheck {
  const bad = (message: string): AttendanceCheck => ({ code: 'ATTENDANCE_INVALID', message });
  if (new Set(entries.map((e) => e.kind)).size !== entries.length) return bad('Một loại chỉ xuất hiện một lần trong ngày');
  for (const e of entries) {
    const q = D(e.qty);
    if (!(q.gt(0) && q.decimalPlaces() <= 2 && q.lt(10000))) return bad(`${ATTENDANCE_KIND_LABEL[e.kind]}: số lượng phải lớn hơn 0, tối đa 2 chữ số thập phân`);
    if ((e.kind === 'work_day' || e.kind === 'half_day') && !q.eq(1)) return bad(`${ATTENDANCE_KIND_LABEL[e.kind]}: số lượng phải bằng 1`);
    if ((e.kind === 'paid_leave' || e.kind === 'sick_leave' || e.kind === 'unpaid_leave' || e.kind === 'holiday') && q.gt(1)) return bad(`${ATTENDANCE_KIND_LABEL[e.kind]}: tối đa 1 ngày`);
    if ((e.kind === 'hour' || e.kind.startsWith('ot_')) && q.gt(24)) return bad(`${ATTENDANCE_KIND_LABEL[e.kind]}: tối đa 24 giờ`);
  }
  if (entries.some((e) => e.kind === 'hour') && !(standardHoursPerDay && D(standardHoursPerDay).gt(0)))
    return { code: 'PAYROLL_SETTING_MISSING', message: 'Chưa khai "Số giờ làm việc chuẩn mỗi ngày" trong cài đặt công ty nên không quy đổi được giờ làm việc ra ngày công' };
  const w = workDays(entries, standardHoursPerDay ?? '1');
  if (D(w.workDays).plus(w.paidLeave).plus(w.sickLeave).plus(w.unpaidLeave).plus(w.holiday).gt(1)) return bad('Tổng ngày công và ngày nghỉ trong một ngày vượt quá 1 ngày');
  return null;
}
