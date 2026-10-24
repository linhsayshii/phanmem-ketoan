import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { ATTENDANCE_KINDS, checkAttendanceDay, D, formatVnDate, workDays, type AttendanceItem, type AttendanceKind } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { getSettings } from '../core/settings.js';

type Trx = Kysely<Database> | Transaction<Database>;

// Móc cho Task 5/6: chấm công của kỳ đã hạch toán lương thì khóa (409 ATTENDANCE_LOCKED); hủy hạch toán thì mở lại. Chưa có bảng lương nên luôn false.
// Task 5/6 thay thân `locked` bằng truy vấn: có payroll_run posted của kỳ (year, month) chứa nhân viên (employeeId rỗng = chứa bất kỳ nhân viên nào).
export const attendanceGate = {
  locked: async (_trx: Trx, _year: number, _month: number, _employeeId?: number): Promise<boolean> => false,
};
export const attendanceLocked = (trx: Trx, year: number, month: number, employeeId?: number): Promise<boolean> => attendanceGate.locked(trx, year, month, employeeId);

export const MAX_CELLS = 10_000;
const kindEnum = z.enum(ATTENDANCE_KINDS as [AttendanceKind, ...AttendanceKind[]]);
const qtyStr = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'Số lượng tối đa 2 chữ số thập phân');
export const monthQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12), departmentId: z.coerce.number().int().positive().optional() });
export const cellsBody = z.object({
  cells: z.array(z.object({ employeeId: z.number().int().positive(), date: dateIso, entries: z.array(z.object({ kind: kindEnum, qty: qtyStr }).strict()).max(ATTENDANCE_KINDS.length) }).strict()).max(MAX_CELLS),
}).strict();
export type CellInput = z.infer<typeof cellsBody>['cells'][number];

export function monthRange(year: number, month: number) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { days, from: `${year}-${p(month)}-01`, to: `${year}-${p(month)}-${p(days)}` };
}

export interface AttendanceWarning { employeeId: number; code: 'ATTENDANCE_OUT_OF_EMPLOYMENT'; message: string; dates: string[] }
interface EmpRow { id: number; code: string; name: string; department_id: number | null; start_date: string | null; end_date: string | null }
const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const qtyOut = (q: string) => D(q).toString();

// Nhân viên có chấm công trong tháng nhưng ngoài thời gian làm việc theo hồ sơ lương (chưa vào làm hoặc đã nghỉ việc). Chỉ cảnh báo, vẫn lưu.
export function employmentWarnings(emps: EmpRow[], entries: { employeeId: number; date: string }[]): AttendanceWarning[] {
  const byEmp = new Map(emps.map((e) => [e.id, e]));
  const out = new Map<number, { before: Set<string>; after: Set<string> }>();
  for (const x of entries) {
    const e = byEmp.get(x.employeeId); if (!e) continue;
    const slot = out.get(x.employeeId) ?? { before: new Set<string>(), after: new Set<string>() };
    if (e.start_date && x.date < e.start_date) slot.before.add(x.date);
    if (e.end_date && x.date > e.end_date) slot.after.add(x.date);
    out.set(x.employeeId, slot);
  }
  const res: AttendanceWarning[] = [];
  for (const [id, s] of out) {
    const e = byEmp.get(id)!;
    if (s.before.size) res.push({ employeeId: id, code: 'ATTENDANCE_OUT_OF_EMPLOYMENT', dates: [...s.before].sort(), message: `${e.code} ${e.name}: có chấm công ${s.before.size} ngày trước ngày vào làm ${formatVnDate(e.start_date!)}` });
    if (s.after.size) res.push({ employeeId: id, code: 'ATTENDANCE_OUT_OF_EMPLOYMENT', dates: [...s.after].sort(), message: `${e.code} ${e.name}: có chấm công ${s.after.size} ngày sau ngày nghỉ việc ${formatVnDate(e.end_date!)}` });
  }
  return res;
}

const empBase = (trx: Trx) => trx.selectFrom('employee as e').leftJoin('employee_payroll as p', 'p.employee_id', 'e.id')
  .select(['e.id', 'e.code', 'e.name', 'e.department_id', 'p.start_date', 'p.end_date']);

// Nhân viên hiện trong lưới tháng: đang làm trong tháng (theo hồ sơ lương; chưa có hồ sơ coi là đang làm) hoặc đã có chấm công trong tháng, lọc theo bộ phận.
export async function monthEmployees(trx: Trx, year: number, month: number, departmentId?: number): Promise<EmpRow[]> {
  const { from, to } = monthRange(year, month);
  let q = empBase(trx).where((eb) => eb.or([
    eb.and([eb('e.is_active', '=', true), eb.or([eb('p.start_date', 'is', null), eb('p.start_date', '<=', to)]), eb.or([eb('p.end_date', 'is', null), eb('p.end_date', '>=', from)])]),
    eb.exists(eb.selectFrom('attendance_entry as a').select('a.id').whereRef('a.employee_id', '=', 'e.id').where('a.work_date', '>=', from).where('a.work_date', '<=', to)),
  ])).orderBy('e.code');
  if (departmentId !== undefined) q = q.where('e.department_id', '=', departmentId);
  return q.execute() as Promise<EmpRow[]>;
}

async function monthEntries(trx: Trx, year: number, month: number, employeeIds?: number[]) {
  const { from, to } = monthRange(year, month);
  const out: { id: number; sheetId: number; employeeId: number; date: string; kind: AttendanceKind; qty: string }[] = [];
  for (const ids of employeeIds ? chunks(employeeIds, 5000) : [undefined]) {
    let q = trx.selectFrom('attendance_entry').select(['id', 'sheet_id', 'employee_id', 'work_date', 'kind', 'qty']).where('work_date', '>=', from).where('work_date', '<=', to).orderBy('work_date').orderBy('id');
    if (ids) q = q.where('employee_id', 'in', ids);
    for (const r of await q.execute()) out.push({ id: r.id, sheetId: r.sheet_id, employeeId: r.employee_id, date: r.work_date, kind: r.kind as AttendanceKind, qty: qtyOut(r.qty) });
  }
  return out;
}

export async function getGrid(trx: Trx, tenantId: string, q: z.infer<typeof monthQuery>) {
  const { days } = monthRange(q.year, q.month);
  const employees = await monthEmployees(trx, q.year, q.month, q.departmentId);
  const entries = await monthEntries(trx, q.year, q.month, employees.map((e) => e.id));
  const s = await getSettings(trx as Transaction<Database>, tenantId);
  const sheet = await trx.selectFrom('attendance_sheet').select('id').where('year', '=', q.year).where('month', '=', q.month)
    .where((eb) => (q.departmentId === undefined ? eb('department_id', 'is', null) : eb('department_id', '=', q.departmentId))).executeTakeFirst();
  return {
    year: q.year, month: q.month, departmentId: q.departmentId ?? null, days, sheetId: sheet?.id ?? null,
    standardHoursPerDay: s.payroll_standard_hours_per_day, standardDaysPerMonth: s.payroll_standard_days_per_month,
    employees: employees.map((e) => ({ id: e.id, code: e.code, name: e.name, departmentId: e.department_id, startDate: e.start_date, endDate: e.end_date })),
    entries: entries.map(({ employeeId, date, kind, qty }) => ({ employeeId, date, kind, qty })),
    warnings: employmentWarnings(employees, entries),
  };
}

async function sheetFor(trx: Trx, tenantId: string, year: number, month: number, departmentId: number | undefined): Promise<number> {
  const find = () => trx.selectFrom('attendance_sheet').select('id').where('year', '=', year).where('month', '=', month)
    .where((eb) => (departmentId === undefined ? eb('department_id', 'is', null) : eb('department_id', '=', departmentId))).executeTakeFirst();
  const hit = await find(); if (hit) return hit.id;
  if (departmentId !== undefined && !(await trx.selectFrom('department').select('id').where('id', '=', departmentId).executeTakeFirst())) throw new AppError('DEPARTMENT_NOT_FOUND', 'Không tìm thấy bộ phận', 404);
  return (await trx.insertInto('attendance_sheet').values({ tenant_id: tenantId, year, month, department_id: departmentId ?? null }).returning('id').executeTakeFirstOrThrow()).id;
}

async function assertUnlocked(trx: Trx, year: number, month: number, employeeIds: number[]) {
  for (const id of new Set(employeeIds)) if (await attendanceLocked(trx, year, month, id))
    throw new AppError('ATTENDANCE_LOCKED', 'Chấm công của kỳ này đã được hạch toán lương: hủy hạch toán bảng lương trước khi sửa chấm công', 409);
}

// Thay nội dung từng ô (nhân viên × ngày) bằng đúng danh sách `entries` của ô (rỗng = xóa ô). Chỉ ghi phần khác biệt: cùng loại đổi số lượng thì UPDATE (audit_event có trước/sau),
// loại mới thì INSERT, loại không còn thì DELETE. Ô nằm ở bảng chấm công khác của cùng tháng vẫn được tìm thấy (một ô chỉ có một bản).
export async function saveCells(trx: Trx, tenantId: string, q: z.infer<typeof monthQuery>, cells: CellInput[]) {
  const { from, to } = monthRange(q.year, q.month);
  const seen = new Set<string>();
  for (const c of cells) {
    if (c.date < from || c.date > to) throw new AppError('ATTENDANCE_DATE_OUT_OF_MONTH', `Ngày ${formatVnDate(c.date)} không thuộc tháng ${String(q.month).padStart(2, '0')}/${q.year}`, 400);
    const k = `${c.employeeId}|${c.date}`;
    if (seen.has(k)) throw new AppError('ATTENDANCE_DUPLICATE_CELL', `Ô ${formatVnDate(c.date)} của cùng một nhân viên xuất hiện hai lần`, 400);
    seen.add(k);
  }
  const ids = [...new Set(cells.map((c) => c.employeeId))];
  const emps: EmpRow[] = [];
  for (const part of chunks(ids, 5000)) emps.push(...(await empBase(trx).where('e.id', 'in', part).execute() as EmpRow[]));
  const byId = new Map(emps.map((e) => [e.id, e]));
  const missing = ids.find((i) => !byId.has(i)); if (missing !== undefined) throw new AppError('EMPLOYEE_NOT_FOUND', `Không tìm thấy nhân viên (mã nội bộ ${missing})`, 404);

  const std = (await getSettings(trx as Transaction<Database>, tenantId)).payroll_standard_hours_per_day;
  const errors: { employeeId: number; date: string; code: string; message: string }[] = [];
  for (const c of cells) {
    const bad = checkAttendanceDay(c.entries, std);
    if (bad) errors.push({ employeeId: c.employeeId, date: c.date, code: bad.code, message: `${byId.get(c.employeeId)!.code} ${formatVnDate(c.date)}: ${bad.message}` });
  }
  if (errors.length) throw new AppError(errors[0]!.code, errors[0]!.message, errors[0]!.code === 'PAYROLL_SETTING_MISSING' ? 409 : 400, errors.slice(0, 50));
  await assertUnlocked(trx, q.year, q.month, ids);

  await sql`SELECT pg_advisory_xact_lock(hashtext('attendance'), hashtext(${`${tenantId}:${q.year}-${q.month}`}))`.execute(trx);
  const sheetId = await sheetFor(trx, tenantId, q.year, q.month, q.departmentId);
  const existing = new Map<string, { id: number; kind: string; qty: string }[]>();
  for (const e of await monthEntries(trx, q.year, q.month, ids)) {
    const k = `${e.employeeId}|${e.date}`; if (!seen.has(k)) continue;
    (existing.get(k) ?? existing.set(k, []).get(k)!).push(e);
  }
  const toInsert: { tenant_id: string; sheet_id: number; employee_id: number; work_date: string; kind: string; qty: string }[] = [];
  const toDelete: number[] = []; const toUpdate = new Map<string, number[]>(); let changedCells = 0;
  for (const c of cells) {
    const old = existing.get(`${c.employeeId}|${c.date}`) ?? []; let changed = false;
    for (const n of c.entries) {
      const o = old.find((x) => x.kind === n.kind);
      if (!o) { toInsert.push({ tenant_id: tenantId, sheet_id: sheetId, employee_id: c.employeeId, work_date: c.date, kind: n.kind, qty: n.qty }); changed = true; } else if (!D(o.qty).eq(n.qty)) {
        (toUpdate.get(n.qty) ?? toUpdate.set(n.qty, []).get(n.qty)!).push(o.id); changed = true;
      }
    }
    for (const o of old) if (!c.entries.some((n) => n.kind === o.kind)) { toDelete.push(o.id); changed = true; }
    if (changed) changedCells++;
  }
  for (const part of chunks(toDelete, 5000)) await trx.deleteFrom('attendance_entry').where('id', 'in', part).execute();
  for (const [qty, part] of toUpdate) for (const p of chunks(part, 5000)) await trx.updateTable('attendance_entry').set({ qty }).where('id', 'in', p).execute();
  for (const part of chunks(toInsert, 2000)) await trx.insertInto('attendance_entry').values(part).execute();
  return {
    changedCells, unchangedCells: cells.length - changedCells, inserted: toInsert.length, updated: [...toUpdate.values()].reduce((s, a) => s + a.length, 0), deleted: toDelete.length,
    warnings: employmentWarnings(emps, cells.flatMap((c) => (c.entries.length ? [{ employeeId: c.employeeId, date: c.date }] : []))),
  };
}

// Sao chép khung chấm công của tháng trước sang tháng này: cùng ngày trong tháng, chỉ loại ngày công/nửa ngày/giờ làm việc (nghỉ phép, ốm, làm thêm không lặp theo tháng),
// chỉ vào ô còn trống, bỏ ngày không có trong tháng này và ngày ngoài thời gian làm việc của nhân viên.
export async function copyPrevious(trx: Trx, tenantId: string, q: z.infer<typeof monthQuery>) {
  const prev = q.month === 1 ? { year: q.year - 1, month: 12 } : { year: q.year, month: q.month - 1 };
  const { days, from, to } = monthRange(q.year, q.month);
  const emps = (await monthEmployees(trx, q.year, q.month, q.departmentId)).filter((e) => (!e.start_date || e.start_date <= to) && (!e.end_date || e.end_date >= from));
  const ids = emps.map((e) => e.id);
  await assertUnlocked(trx, q.year, q.month, ids);
  await sql`SELECT pg_advisory_xact_lock(hashtext('attendance'), hashtext(${`${tenantId}:${q.year}-${q.month}`}))`.execute(trx);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const filled = new Set((await monthEntries(trx, q.year, q.month, ids)).map((e) => `${e.employeeId}|${e.date}`));
  const sheetId = await sheetFor(trx, tenantId, q.year, q.month, q.departmentId);
  const rows: { tenant_id: string; sheet_id: number; employee_id: number; work_date: string; kind: string; qty: string }[] = [];
  let skipped = 0;
  for (const e of await monthEntries(trx, prev.year, prev.month, ids)) {
    if (e.kind !== 'work_day' && e.kind !== 'half_day' && e.kind !== 'hour') continue;
    const day = Number(e.date.slice(8));
    if (day > days) { skipped++; continue; }
    const date = `${from.slice(0, 8)}${String(day).padStart(2, '0')}`; const emp = byId.get(e.employeeId)!;
    if (filled.has(`${e.employeeId}|${date}`) || (emp.start_date && date < emp.start_date) || (emp.end_date && date > emp.end_date)) { skipped++; continue; }
    rows.push({ tenant_id: tenantId, sheet_id: sheetId, employee_id: e.employeeId, work_date: date, kind: e.kind, qty: e.qty });
  }
  for (const part of chunks(rows, 2000)) await trx.insertInto('attendance_entry').values(part).execute();
  return { copied: rows.length, skipped, from: prev };
}

// Tổng hợp theo nhân viên, đúng hình dạng đầu vào PayrollInput (workDays + otHours); chỉ các nhân viên có chấm công trong tháng.
export async function summary(trx: Trx, tenantId: string, year: number, month: number) {
  const s = await getSettings(trx as Transaction<Database>, tenantId);
  const entries = await monthEntries(trx, year, month);
  const std = s.payroll_standard_hours_per_day;
  if (entries.some((e) => e.kind === 'hour') && !(std && D(std).gt(0)))
    throw new AppError('PAYROLL_SETTING_MISSING', 'Chưa khai "Số giờ làm việc chuẩn mỗi ngày" trong cài đặt công ty nên không quy đổi được giờ làm việc ra ngày công', 409);
  const by = new Map<number, AttendanceItem[]>();
  for (const e of entries) (by.get(e.employeeId) ?? by.set(e.employeeId, []).get(e.employeeId)!).push({ kind: e.kind, qty: e.qty });
  const ids = [...by.keys()];
  const emps: EmpRow[] = [];
  for (const part of chunks(ids, 5000)) emps.push(...(await empBase(trx).where('e.id', 'in', part).execute() as EmpRow[]));
  emps.sort((a, b) => (a.code < b.code ? -1 : 1));
  return {
    year, month, standardHoursPerDay: std, standardDaysPerMonth: s.payroll_standard_days_per_month,
    employees: emps.map((e) => {
      const w = workDays(by.get(e.id)!, std ?? '1');
      return { employeeId: e.id, code: e.code, name: e.name, ...w, otHours: { weekday: w.otWeekdayHours, rest: w.otRestHours, holiday: w.otHolidayHours } };
    }),
    warnings: employmentWarnings(emps, entries),
  };
}

// Băm ổn định nội dung chấm công của một nhân viên trong tháng (không phụ thuộc thứ tự dòng, bảng chấm công hay mã dòng): Task 5 dùng làm một phần input_hash của bảng lương.
export async function attendanceHash(trx: Trx, year: number, month: number, employeeId: number): Promise<string> {
  const lines = (await monthEntries(trx, year, month, [employeeId])).map((e) => `${e.date}|${e.kind}|${D(e.qty).toFixed(2)}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
