import { describe, expect, it } from 'vitest';
import { checkAttendanceDay, formatAttendanceCell, parseAttendanceCell, workDays } from '../src/index.js';

describe('mã chấm công trong ô', () => {
  it('X, N, số giờ, nghỉ và làm thêm ba loại', () => {
    expect(parseAttendanceCell('x')).toEqual({ ok: true, entries: [{ kind: 'work_day', qty: '1' }] });
    expect(parseAttendanceCell('N')).toEqual({ ok: true, entries: [{ kind: 'half_day', qty: '1' }] });
    expect(parseAttendanceCell('4,5')).toEqual({ ok: true, entries: [{ kind: 'hour', qty: '4.5' }] });
    expect(parseAttendanceCell('X T2 C1,5 L3')).toEqual({ ok: true, entries: [{ kind: 'work_day', qty: '1' }, { kind: 'ot_weekday_hour', qty: '2' }, { kind: 'ot_rest_hour', qty: '1.5' }, { kind: 'ot_holiday_hour', qty: '3' }] });
    expect(parseAttendanceCell('P0,5')).toEqual({ ok: true, entries: [{ kind: 'paid_leave', qty: '0.5' }] });
    expect(parseAttendanceCell('')).toEqual({ ok: true, entries: [] });
  });
  it('mã sai: lặp, làm thêm thiếu giờ, X kèm số, chữ lạ', () => {
    for (const t of ['X X', 'T', 'X2', 'Z', '1,234', '4 5']) expect(parseAttendanceCell(t).ok, t).toBe(false);
  });
  it('định dạng rồi phân tích lại ra đúng nội dung', () => {
    const e = [{ kind: 'work_day' as const, qty: '1' }, { kind: 'ot_weekday_hour' as const, qty: '2.5' }];
    expect(formatAttendanceCell(e)).toBe('X T2,5');
    expect(parseAttendanceCell(formatAttendanceCell(e))).toEqual({ ok: true, entries: e });
    expect(formatAttendanceCell([{ kind: 'paid_leave', qty: '0.5' }, { kind: 'hour', qty: '4' }])).toBe('4 P0,5');
  });
});

describe('kiểm một ngày chấm công', () => {
  it('giờ làm việc cần giờ chuẩn; quy đổi giờ và buổi ra ngày công', () => {
    expect(checkAttendanceDay([{ kind: 'hour', qty: '4' }], null)?.code).toBe('PAYROLL_SETTING_MISSING');
    expect(checkAttendanceDay([{ kind: 'hour', qty: '4' }], '8')).toBeNull();
    expect(workDays([{ kind: 'hour', qty: '4' }, { kind: 'half_day', qty: '1' }, { kind: 'work_day', qty: '1' }], '8').workDays).toBe('2');
  });
  it('vượt 1 ngày, số lượng sai, làm thêm không tính vào trần ngày', () => {
    expect(checkAttendanceDay([{ kind: 'work_day', qty: '1' }, { kind: 'half_day', qty: '1' }], '8')?.code).toBe('ATTENDANCE_INVALID');
    expect(checkAttendanceDay([{ kind: 'hour', qty: '6' }, { kind: 'paid_leave', qty: '0.5' }], '8')?.code).toBe('ATTENDANCE_INVALID');
    expect(checkAttendanceDay([{ kind: 'work_day', qty: '2' }], '8')?.code).toBe('ATTENDANCE_INVALID');
    expect(checkAttendanceDay([{ kind: 'ot_rest_hour', qty: '25' }], '8')?.code).toBe('ATTENDANCE_INVALID');
    expect(checkAttendanceDay([{ kind: 'work_day', qty: '1' }, { kind: 'ot_weekday_hour', qty: '4' }], null)).toBeNull();
  });
});
