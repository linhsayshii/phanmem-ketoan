import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import FormData from 'form-data';
import { withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { attendanceGate, attendanceHash, attendanceLocked } from '../../src/modules/payroll/attendance.js';
import { buildAttendanceTemplate } from '../../src/modules/payroll/attendanceImport.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let owner: string; let tenantId: string; let other: string; let viewer: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const Y = 2026, M = 3, Q = `year=${Y}&month=${M}`, d = (n: number) => `2026-03-${String(n).padStart(2, '0')}`;
const put = (cells: object[], cookie = owner, q = Q) => call('PUT', `/api/attendance?${q}`, cookie, { cells });
const cell = (employeeId: number, day: number, ...entries: [string, string][]) => ({ employeeId, date: d(day), entries: entries.map(([kind, qty]) => ({ kind, qty })) });
let seq = 0;
async function newEmployee(prefix: string, extra: Json = {}, cookie = owner): Promise<number> {
  const r = await call('POST', '/api/catalogs/employee', cookie, { code: `${prefix}${++seq}`, name: `Nhân viên ${prefix}${seq}`, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return Number(r.json().id);
}
async function userWith(roleCode: string) {
  const username = `ac_${roleCode}_${Math.random().toString(36).slice(2, 8)}`;
  const made = await call('POST', '/api/users', owner, { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags: [] });
  expect(made.statusCode, made.body).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const setSettings = (v: Json) => call('PUT', '/api/settings', owner, v);

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `AC${Date.now()}` }));
  ({ cookie: other } = await bootstrapTenant(ctx, { code: `AD${Date.now()}` }));
  viewer = await userWith('xem');
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('chấm công: quy đổi và tổng hợp', () => {
  it('giờ làm việc cần giờ chuẩn mỗi ngày; cài đặt sai là 400', async () => {
    const e = await newEmployee('G');
    const r = await put([cell(e, 2, ['hour', '4'])]);
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('PAYROLL_SETTING_MISSING');
    expect((await setSettings({ payroll_standard_hours_per_day: '25' })).statusCode).toBe(400);
    expect((await setSettings({ payroll_standard_days_per_month: 'abc' })).statusCode).toBe(400);
    expect((await setSettings({ payroll_standard_hours_per_day: '8', payroll_standard_days_per_month: '26' })).statusCode).toBe(200);
    expect((await put([cell(e, 2, ['hour', '4'])])).statusCode).toBe(200);
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ payroll_standard_hours_per_day: '8', payroll_standard_days_per_month: '26' });
  });

  it('ngày, buổi, giờ, nghỉ và ba loại làm thêm quy đúng ngày công và giờ làm thêm', async () => {
    await setSettings({ payroll_standard_hours_per_day: '8' });
    const e = await newEmployee('S');
    const saved = await put([
      cell(e, 2, ['work_day', '1']), cell(e, 3, ['work_day', '1']), cell(e, 4, ['work_day', '1']), // 3 ngày
      cell(e, 5, ['half_day', '1']), // 0,5
      cell(e, 6, ['hour', '4']), // 4 ÷ 8 = 0,5
      cell(e, 9, ['paid_leave', '1']), cell(e, 10, ['sick_leave', '1']), cell(e, 11, ['unpaid_leave', '0.5']), cell(e, 12, ['holiday', '1']),
      cell(e, 13, ['work_day', '1'], ['ot_weekday_hour', '2']), // +1 ngày, 2 giờ ngày thường
      cell(e, 14, ['ot_rest_hour', '3']), cell(e, 15, ['ot_holiday_hour', '4.5']), cell(e, 16, ['ot_weekday_hour', '1.5']),
    ]);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ changedCells: 13, inserted: 14, updated: 0, deleted: 0 });
    const s = (await call('GET', `/api/attendance/summary?${Q}`)).json();
    const row = s.employees.find((x: Json) => x.employeeId === e);
    expect(row).toMatchObject({ code: expect.stringMatching(/^S/), workDays: '5', paidLeave: '1', sickLeave: '1', unpaidLeave: '0.5', holiday: '1', otWeekdayHours: '3.5', otRestHours: '3', otHolidayHours: '4.5' });
    expect(row.otHours).toEqual({ weekday: '3.5', rest: '3', holiday: '4.5' });
    expect(s).toMatchObject({ standardHoursPerDay: '8', standardDaysPerMonth: '26' });
    // Tháng khác không có chấm công
    expect((await call('GET', `/api/attendance/summary?year=${Y}&month=4`)).json().employees).toHaveLength(0);
  });

  it('kiểm ngày: vượt 1 ngày, số lượng sai, ngoài tháng, ô lặp, nhân viên không có', async () => {
    const e = await newEmployee('V');
    const err = async (cells: object[], status: number, code?: string) => { const r = await put(cells); expect(r.statusCode, r.body).toBe(status); if (code) expect(r.json().error.code).toBe(code); };
    await err([cell(e, 2, ['work_day', '1'], ['half_day', '1'])], 400, 'ATTENDANCE_INVALID');
    await err([cell(e, 2, ['work_day', '2'])], 400, 'ATTENDANCE_INVALID');
    await err([cell(e, 2, ['hour', '6'], ['paid_leave', '0.5'])], 400, 'ATTENDANCE_INVALID');
    await err([cell(e, 2, ['ot_rest_hour', '25'])], 400, 'ATTENDANCE_INVALID');
    await err([cell(e, 2, ['work_day', '1.234'])], 400); // zod: 3 chữ số thập phân
    await err([cell(e, 2, ['nghi_la', '1'])], 400);
    await err([{ employeeId: e, date: '2026-04-01', entries: [{ kind: 'work_day', qty: '1' }] }], 400, 'ATTENDANCE_DATE_OUT_OF_MONTH');
    await err([cell(e, 2, ['work_day', '1']), cell(e, 2, ['half_day', '1'])], 400, 'ATTENDANCE_DUPLICATE_CELL');
    await err([cell(999999, 2, ['work_day', '1'])], 404, 'EMPLOYEE_NOT_FOUND');
    // Lỗi một ô thì không ghi ô nào
    await err([cell(e, 3, ['work_day', '1']), cell(e, 2, ['work_day', '3'])], 400, 'ATTENDANCE_INVALID');
    expect((await call('GET', `/api/attendance?${Q}`)).json().entries.filter((x: Json) => x.employeeId === e)).toHaveLength(0);
  });

  it('sửa ô: đổi số lượng là UPDATE có audit trước/sau, thêm/bớt loại, ghi lại y nguyên thì không đổi gì', async () => {
    const e = await newEmployee('U');
    await put([cell(e, 2, ['work_day', '1'], ['ot_weekday_hour', '2'])]);
    const same = await put([cell(e, 2, ['work_day', '1'], ['ot_weekday_hour', '2'])]);
    expect(same.json()).toMatchObject({ changedCells: 0, unchangedCells: 1, inserted: 0, updated: 0, deleted: 0 });
    const r = await put([cell(e, 2, ['work_day', '1'], ['ot_weekday_hour', '3.5'], ['ot_rest_hour', '1'])]);
    expect(r.json()).toMatchObject({ changedCells: 1, inserted: 1, updated: 1, deleted: 0 });
    const upd = (await sql<{ before: Json; after: Json }>`SELECT before, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'attendance_entry' AND action = 'update' AND (after->>'employee_id')::bigint = ${e}`.execute(ctx.t.admin)).rows;
    expect(upd).toHaveLength(1); expect(Number(upd[0]!.before.qty)).toBe(2); expect(Number(upd[0]!.after.qty)).toBe(3.5);
    const del = await put([cell(e, 2)]); // ô rỗng = xóa ô
    expect(del.json()).toMatchObject({ changedCells: 1, deleted: 3 });
    const dels = (await sql`SELECT 1 FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'attendance_entry' AND action = 'delete' AND (before->>'employee_id')::bigint = ${e}`.execute(ctx.t.admin)).rows;
    expect(dels).toHaveLength(3);
    expect((await call('GET', `/api/attendance?${Q}`)).json().entries.filter((x: Json) => x.employeeId === e)).toHaveLength(0);
  });
});

describe('chấm công: lưới, bộ phận, nhân viên đã nghỉ việc', () => {
  it('lưới chỉ có nhân viên đang làm trong tháng; chấm công ngoài thời gian làm việc vẫn lưu nhưng cảnh báo', async () => {
    const depCode = `BP${Date.now()}`;
    const dep = await call('POST', '/api/catalogs/department', owner, { code: depCode, name: 'Bộ phận kiểm thử' });
    expect(dep.statusCode, dep.body).toBe(201);
    const depId = Number(dep.json().id);
    const active = await newEmployee('A', { department_code: depCode });
    const left = await newEmployee('L', { department_code: depCode }); // nghỉ việc 15/03
    const gone = await newEmployee('N', { department_code: depCode }); // nghỉ việc từ tháng 2
    const future = await newEmployee('F', { department_code: depCode }); // vào làm từ tháng 5
    const noDep = await newEmployee('X'); // không bộ phận
    const profile = (id: number, startDate: string | null, endDate: string | null) => call('PUT', `/api/payroll/profiles/${id}`, owner, { startDate, endDate });
    expect((await profile(left, '2025-01-01', d(15))).statusCode).toBe(200);
    expect((await profile(gone, '2025-01-01', '2026-02-10')).statusCode).toBe(200);
    expect((await profile(future, '2026-05-01', null)).statusCode).toBe(200);

    const grid = (await call('GET', `/api/attendance?${Q}&departmentId=${depId}`)).json();
    expect(grid.employees.map((x: Json) => x.id).sort()).toEqual([active, left].sort());
    expect(grid).toMatchObject({ days: 31, departmentId: depId, sheetId: null });
    expect((await call('GET', `/api/attendance?${Q}`)).json().employees.map((x: Json) => x.id)).toEqual(expect.arrayContaining([active, left, noDep]));

    // Chấm công sau ngày nghỉ việc và trước ngày vào làm: lưu được, trả cảnh báo; nhân viên đó hiện trong lưới
    const r = await put([cell(left, 14, ['work_day', '1']), cell(left, 20, ['work_day', '1']), cell(left, 21, ['work_day', '1']), cell(future, 5, ['work_day', '1']), cell(active, 5, ['work_day', '1'])], owner, `${Q}&departmentId=${depId}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ employeeId: left, code: 'ATTENDANCE_OUT_OF_EMPLOYMENT', dates: [d(20), d(21)], message: expect.stringContaining('sau ngày nghỉ việc 15/03/2026') }),
      expect.objectContaining({ employeeId: future, message: expect.stringContaining('trước ngày vào làm 01/05/2026') })]));
    expect(r.json().warnings).toHaveLength(2);
    const g2 = (await call('GET', `/api/attendance?${Q}&departmentId=${depId}`)).json();
    expect(g2.warnings.map((w: Json) => w.employeeId).sort()).toEqual([left, future].sort()); // chưa vào làm vẫn hiện trong lưới vì đã có chấm công
    expect(g2.employees.map((x: Json) => x.id)).toContain(future);
    expect(g2.sheetId).toEqual(expect.any(Number));
    const sum = (await call('GET', `/api/attendance/summary?${Q}`)).json();
    expect(sum.warnings.map((w: Json) => w.employeeId)).toEqual(expect.arrayContaining([left, future]));
  });

  it('bộ phận không có: 404 khi ghi', async () => {
    const e = await newEmployee('D');
    expect((await put([cell(e, 2, ['work_day', '1'])], owner, `${Q}&departmentId=999999`)).json().error.code).toBe('DEPARTMENT_NOT_FOUND');
  });
});

describe('chấm công: sao chép tháng trước', () => {
  it('sao chép khung công cùng ngày trong tháng, chỉ vào ô trống, bỏ ngày không có trong tháng', async () => {
    const e = await newEmployee('C'); const ended = await newEmployee('CE');
    expect((await call('PUT', `/api/payroll/profiles/${ended}`, owner, { startDate: '2025-01-01', endDate: '2026-01-15' })).statusCode).toBe(200);
    // Tháng 2 (28 ngày) làm mẫu cho tháng 3 (31 ngày); nghỉ phép và làm thêm không được chép
    const feb = (id: number, n: number, ...entries: [string, string][]) => ({ employeeId: id, date: `2026-02-${String(n).padStart(2, '0')}`, entries: entries.map(([kind, qty]) => ({ kind, qty })) });
    expect((await call('PUT', `/api/attendance?year=${Y}&month=2`, owner, { cells: [feb(e, 2, ['work_day', '1']), feb(e, 3, ['half_day', '1']), feb(e, 4, ['hour', '4']), feb(e, 5, ['paid_leave', '1']), feb(e, 6, ['work_day', '1'], ['ot_weekday_hour', '2']), feb(ended, 2, ['work_day', '1'])] })).statusCode).toBe(200);
    expect((await put([cell(e, 3, ['work_day', '1'])])).statusCode).toBe(200); // ô 3/3 đã có: không bị ghi đè
    const r = await call('POST', `/api/attendance/copy-previous?${Q}`);
    expect(r.statusCode, r.body).toBe(200);
    // e: 2 (work_day), 4 (hour), 6 (work_day; làm thêm bỏ qua) = 3 dòng; ngày 3 đã có thì bỏ; ended nghỉ việc từ 15/01 nên không có ai trong lưới để chép
    expect(r.json()).toMatchObject({ copied: 3, from: { year: 2026, month: 2 } });
    const mine = (await call('GET', `/api/attendance?${Q}`)).json().entries.filter((x: Json) => x.employeeId === e);
    expect(mine.map((x: Json) => `${x.date.slice(8)}:${x.kind}:${x.qty}`).sort()).toEqual(['02:work_day:1', '03:work_day:1', '04:hour:4', '06:work_day:1']);
    // Chạy lại: mọi ô đã đầy nên không chép thêm
    expect((await call('POST', `/api/attendance/copy-previous?${Q}`)).json().copied).toBe(0);
  });
});

describe('chấm công: nhập Excel', () => {
  type Cell = ExcelJS.CellValue;
  async function workbook(rows: Record<string, Cell>[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await buildAttendanceTemplate() as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Du_lieu')!; const col = new Map<string, number>();
    ws.getRow(2).eachCell((c, n) => { col.set(String(c.value), n); });
    rows.forEach((r, i) => { const row = ws.getRow(4 + i); for (const [k, v] of Object.entries(r)) row.getCell(col.get(k)!).value = v; row.commit(); });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const upload = (buf: Buffer, mode: 'validate' | 'commit', q = Q, cookie = owner) => {
    const fd = new FormData(); fd.append('file', buf, { filename: 'cc.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return ctx.app.inject({ method: 'POST', url: `/api/attendance/import?${q}&mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
  };

  it('mẫu tải được; kiểm tra rồi nhập; loại nhận mã hoặc tên tiếng Việt; loại cũ trong ô được giữ', async () => {
    const t = await call('GET', '/api/attendance/import/template.xlsx');
    expect(t.statusCode).toBe(200); expect(t.headers['content-type']).toContain('spreadsheetml');
    const e = await newEmployee('I'); const code = (await call('GET', `/api/attendance?${Q}`)).json().employees.find((x: Json) => x.id === e).code;
    await put([cell(e, 2, ['ot_weekday_hour', '2'])]);
    const buf = await workbook([
      { employee_code: code, work_date: d(2), kind: 'work_day', qty: 1 },
      { employee_code: code, work_date: d(3), kind: 'Làm thêm ngày nghỉ hằng tuần (giờ)', qty: 4 },
      { employee_code: code, work_date: d(4), kind: 'half_day', qty: 1 },
      { employee_code: code, work_date: new Date(Date.UTC(2026, 2, 5)), kind: 'hour', qty: 6.5 },
    ]);
    const v = await upload(buf, 'validate'); expect(v.statusCode, v.body).toBe(200);
    expect(v.json()).toMatchObject({ total: 4, cells: 4, errorCount: 0 });
    expect((await call('GET', `/api/attendance?${Q}`)).json().entries.filter((x: Json) => x.employeeId === e)).toHaveLength(1); // kiểm tra không ghi
    const c = await upload(buf, 'commit'); expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ inserted: 4, updated: 0 });
    const mine = (await call('GET', `/api/attendance?${Q}`)).json().entries.filter((x: Json) => x.employeeId === e).map((x: Json) => `${x.date.slice(8)}:${x.kind}:${x.qty}`).sort();
    expect(mine).toEqual(['02:ot_weekday_hour:2', '02:work_day:1', '03:ot_rest_hour:4', '04:half_day:1', '05:hour:6.5']);
  });

  it('lỗi từng dòng: báo đúng dòng, không ghi nửa chừng; nhập thật có lỗi là 409 IMPORT_ERRORS', async () => {
    const e = await newEmployee('J'); const code = (await call('GET', `/api/attendance?${Q}`)).json().employees.find((x: Json) => x.id === e).code;
    const buf = await workbook([
      { employee_code: code, work_date: d(2), kind: 'work_day', qty: 1 }, // dòng 4: hợp lệ
      { employee_code: 'KHONGCO', work_date: d(3), kind: 'work_day', qty: 1 }, // dòng 5
      { employee_code: code, work_date: '2026-04-02', kind: 'work_day', qty: 1 }, // dòng 6: ngoài tháng
      { employee_code: code, work_date: d(6), kind: 'nghi_che', qty: 1 }, // dòng 7: loại sai
      { employee_code: code, work_date: d(7), kind: 'work_day', qty: 2 }, // dòng 8: công 2
      { employee_code: code, work_date: d(8), kind: 'paid_leave', qty: 1 }, // dòng 9
      { employee_code: code, work_date: d(8), kind: 'paid_leave', qty: 1 }, // dòng 10: trùng dòng 9
      { employee_code: code, work_date: d(9), kind: 'work_day', qty: 1 }, // dòng 11 + 12: vượt 1 ngày
      { employee_code: code, work_date: d(9), kind: 'sick_leave', qty: 0.5 },
    ]);
    const v = (await upload(buf, 'validate')).json();
    expect(v.errorCount).toBe(6);
    expect(v.errors.map((x: Json) => x.row)).toEqual([5, 6, 7, 8, 10, 11]);
    expect(v.errors[0].message).toContain('KHONGCO'); expect(v.errors[4].message).toContain('dòng 9');
    const c = await upload(buf, 'commit');
    expect(c.statusCode).toBe(409); expect(c.json().error.code).toBe('IMPORT_ERRORS'); expect(c.json().error.details).toHaveLength(6);
    expect((await call('GET', `/api/attendance?${Q}`)).json().entries.filter((x: Json) => x.employeeId === e)).toHaveLength(0);
    // Tệp sai mẫu
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu'); ws.addRow(['x']); ws.addRow(['cot_la']); ws.addRow(['v']);
    expect((await upload(Buffer.from(await wb.xlsx.writeBuffer()), 'commit')).statusCode).toBe(400);
  });
});

describe('chấm công: băm nội dung, khóa, quyền, chéo công ty', () => {
  it('attendanceHash đổi khi sửa chấm công, giữ nguyên khi ghi lại y nguyên hoặc xóa rồi nhập lại cùng nội dung', async () => {
    const e = await newEmployee('H'); const f = await newEmployee('H');
    const h = () => withTenant(ctx.t.db, { tenantId }, (trx) => attendanceHash(trx, Y, M, e));
    const empty = await h();
    await put([cell(e, 2, ['work_day', '1']), cell(e, 3, ['ot_weekday_hour', '2'])]);
    const h1 = await h(); expect(h1).not.toBe(empty); expect(h1).toMatch(/^[0-9a-f]{64}$/);
    await put([cell(e, 2, ['work_day', '1']), cell(e, 3, ['ot_weekday_hour', '2'])]);
    expect(await h()).toBe(h1);
    await put([cell(f, 2, ['work_day', '1'])]); // nhân viên khác không ảnh hưởng
    expect(await h()).toBe(h1);
    await put([cell(e, 3, ['ot_weekday_hour', '2.5'])]); const h2 = await h(); expect(h2).not.toBe(h1);
    await put([cell(e, 3)]); await put([cell(e, 3, ['ot_weekday_hour', '2'])]);
    expect(await h()).toBe(h1);
    await put([cell(e, 4, ['work_day', '1'])]); expect(await h()).not.toBe(h1);
  });

  it('khóa chấm công: hàm móc luôn false; khi bị khóa các đường ghi trả 409 ATTENDANCE_LOCKED', async () => {
    const e = await newEmployee('K');
    expect(await withTenant(ctx.t.db, { tenantId }, (trx) => attendanceLocked(trx, Y, M, e))).toBe(false);
    const spy = vi.spyOn(attendanceGate, 'locked').mockResolvedValue(true);
    try {
      const r = await put([cell(e, 2, ['work_day', '1'])]); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('ATTENDANCE_LOCKED');
      expect((await call('POST', `/api/attendance/copy-previous?${Q}`)).json().error.code).toBe('ATTENDANCE_LOCKED');
      expect((await call('GET', `/api/attendance?${Q}`)).statusCode).toBe(200); // đọc vẫn được
      expect(spy).toHaveBeenCalledWith(expect.anything(), Y, M, e);
    } finally { spy.mockRestore(); }
    expect((await put([cell(e, 2, ['work_day', '1'])])).statusCode).toBe(200);
  });

  it('thiếu attendance.* → 403 mọi route; chỉ xem thì đọc được, không ghi được', async () => {
    const e = await newEmployee('P');
    expect((await call('GET', `/api/attendance?${Q}`, viewer)).statusCode).toBe(200);
    expect((await call('GET', `/api/attendance/summary?${Q}`, viewer)).statusCode).toBe(200);
    const writes = [['PUT', `/api/attendance?${Q}`, { cells: [cell(e, 2, ['work_day', '1'])] }], ['POST', `/api/attendance/copy-previous?${Q}`, undefined], ['POST', `/api/attendance/import?${Q}&mode=validate`, undefined]] as const;
    for (const [m, u, b] of writes) expect((await call(m, u, viewer, b)).statusCode, `${m} ${u}`).toBe(403);
    // Vai trò không có quyền chấm công nào (chỉ xem báo cáo)
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, owner, { permissions: ['report.view'] })).statusCode).toBe(200);
    const nobody = await userWith('xem');
    for (const [m, u, b] of [['GET', `/api/attendance?${Q}`], ['GET', `/api/attendance/summary?${Q}`], ['GET', '/api/attendance/import/template.xlsx'], ...writes.map((w) => [...w])] as [string, string, object?][])
      expect((await call(m as 'GET', u, nobody, b)).statusCode, `${m} ${u}`).toBe(403);
    // Chấm công không cần view_salary: người dùng không có cờ vẫn ghi được
    const vien = await userWith('ketoan_vien');
    expect((await put([cell(e, 2, ['work_day', '1'])], vien)).statusCode).toBe(200);
  });

  it('công ty khác không thấy và không ghi được chấm công của công ty này (RLS)', async () => {
    const e = await newEmployee('R');
    await put([cell(e, 2, ['work_day', '1'])]);
    const g = (await call('GET', `/api/attendance?${Q}`, other)).json();
    expect(g.employees).toHaveLength(0); expect(g.entries).toHaveLength(0);
    expect((await call('GET', `/api/attendance/summary?${Q}`, other)).json().employees).toHaveLength(0);
    expect((await put([cell(e, 2, ['work_day', '1'])], other)).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    expect((await call('POST', `/api/attendance/copy-previous?${Q}`, other)).json().copied).toBe(0);
    const direct = (await sql`SELECT count(*)::int AS n FROM attendance_entry WHERE tenant_id <> ${tenantId}::uuid AND employee_id = ${e}`.execute(ctx.t.admin)).rows[0] as { n: number };
    expect(direct.n).toBe(0);
  });
});

describe('chấm công: hiệu năng ghi', () => {
  it('lưu 2.000 nhân viên × 22 ngày trong một lần (44.000 dòng, audit từng dòng)', async () => {
    await sql`INSERT INTO employee(tenant_id, code, name) SELECT ${tenantId}::uuid, 'BIG' || g, 'Nhân viên lớn ' || g FROM generate_series(1, 2000) g`.execute(ctx.t.admin);
    const ids = (await sql<{ id: string }>`SELECT id FROM employee WHERE tenant_id = ${tenantId}::uuid AND code LIKE 'BIG%'`.execute(ctx.t.admin)).rows.map((r) => Number(r.id));
    const days = Array.from({ length: 31 }, (_, i) => i + 1).filter((n) => ((n + 2) % 7) % 6 !== 0).slice(0, 22); // 22 ngày
    // Gửi theo lô 500 ô như màn hình lưu (giới hạn 10.000 ô mỗi lần)
    const cells = ids.flatMap((id) => days.map((n) => cell(id, n, ['work_day', '1'])));
    const t0 = Date.now();
    for (let i = 0; i < cells.length; i += 10_000) {
      const r = await put(cells.slice(i, i + 10_000)); expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    }
    const ms = Date.now() - t0;
    console.info(`[perf] chấm công ${cells.length} ô: ${ms} ms`);
    expect(ms).toBeLessThan(45_000);
    const n = (await sql`SELECT count(*)::int AS n FROM attendance_entry WHERE tenant_id = ${tenantId}::uuid AND employee_id = ANY(${ids})`.execute(ctx.t.admin)).rows[0] as { n: number };
    expect(n.n).toBe(ids.length * 22);
    const s = (await call('GET', `/api/attendance/summary?${Q}`)).json();
    expect(s.employees.find((x: Json) => x.code === 'BIG7').workDays).toBe('22');
  });
});
