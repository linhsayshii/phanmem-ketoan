import type { Kysely, Transaction } from 'kysely';
import type { z } from 'zod';
import type { Database } from '@kt/db';
import { ATTENDANCE_KIND_LABEL, ATTENDANCE_KINDS, checkAttendanceDay, D, formatVnDate, type AttendanceKind } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { ColumnDef } from '../master/catalogs.js';
import { buildSheetTemplate, readSheet, type ImportError } from '../master/excelSheet.js';
import { MAX_ERRORS, MAX_ROWS } from '../master/importExcel.js';
import { getSettings } from '../core/settings.js';
import { monthRange, saveCells, type CellInput, type monthQuery } from './attendance.js';

// Nhập chấm công từ Excel: mỗi dòng một (mã nhân viên, ngày, loại, số lượng); đặt (hoặc thay) đúng loại đó của ô, các loại khác của ô giữ nguyên.
// Hai lượt: Kiểm tra (không ghi gì) rồi Nhập; có lỗi dòng nào thì không ghi dòng nào.
type Trx = Kysely<Database> | Transaction<Database>;
const SHEET = 'Du_lieu', KEY_ROW = 2, FIRST_DATA_ROW = 4;
export const ATTENDANCE_COLUMNS: ColumnDef[] = [
  { key: 'employee_code', label: 'Mã nhân viên', type: 'text', required: true },
  { key: 'work_date', label: 'Ngày (dd/MM/yyyy)', type: 'date', required: true },
  { key: 'kind', label: 'Loại', type: 'select', required: true, options: ATTENDANCE_KINDS.map((value) => ({ value, label: ATTENDANCE_KIND_LABEL[value] })) },
  { key: 'qty', label: 'Số lượng', type: 'number', required: true },
];

export function buildAttendanceTemplate(): Promise<Buffer> {
  return buildSheetTemplate({
    sheet: SHEET, columns: ATTENDANCE_COLUMNS, keyRow: KEY_ROW,
    example: (c) => (c.key === 'employee_code' ? 'NV01' : c.key === 'work_date' ? '2026-01-05' : c.key === 'kind' ? 'work_day' : 1),
    help: [
      ['Mẫu nhập chấm công theo tháng'],
      ['Mỗi dòng một khoản chấm công của một nhân viên trong một ngày. Dòng 1: tên cột; dòng 3 là ví dụ và luôn bị bỏ qua; nhập từ dòng 4. Chọn tháng cần nhập trên màn hình trước khi tải tệp lên: mọi ngày phải thuộc tháng đó.'],
      ['Cột Loại nhận mã (work_day...) hoặc tên tiếng Việt như dưới đây. Ngày công và nửa ngày: số lượng 1; nghỉ phép, ốm, không lương, nghỉ lễ: tối đa 1 ngày; giờ và làm thêm: số giờ.'],
      ['Một ô (nhân viên, ngày) có thể có nhiều loại ở nhiều dòng, ví dụ ngày công và làm thêm ngày thường. Loại đã có trong ô được thay bằng số lượng mới; có lỗi ở bất kỳ dòng nào thì không nhập dòng nào.'],
      ...ATTENDANCE_KINDS.map((k) => [k, ATTENDANCE_KIND_LABEL[k]]),
    ],
  });
}

const norm = (s: string) => s.trim().toLowerCase();
const KIND_BY_TEXT = new Map<string, AttendanceKind>(ATTENDANCE_KINDS.flatMap((k) => [[norm(k), k], [norm(ATTENDANCE_KIND_LABEL[k]), k]] as [string, AttendanceKind][]));

export interface AttendanceImportReport { total: number; cells: number; errors: ImportError[]; errorCount: number; inserted?: number; updated?: number; deleted?: number }

export async function importAttendance(trx: Trx, tenantId: string, q: z.infer<typeof monthQuery>, buf: Buffer, mode: 'validate' | 'commit'): Promise<AttendanceImportReport & { warnings?: unknown[] }> {
  let sh;
  try { sh = await readSheet(buf, { sheet: SHEET, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns: ATTENDANCE_COLUMNS, strictKeys: true }); } catch (e) {
    if (e instanceof AppError && e.code === 'IMPORT_BAD_TEMPLATE') throw new AppError(e.code, 'File không đúng mẫu chấm công', 400);
    throw e;
  }
  const errors: ImportError[] = [...sh.errors];
  const bad = new Set(errors.map((e) => e.row));
  const err = (row: number, column: string, message: string) => { errors.push({ row, column, message }); bad.add(row); };
  const { from, to } = monthRange(q.year, q.month);
  const codes = [...new Set(sh.rows.flatMap((r) => (typeof r.values.employee_code === 'string' ? [r.values.employee_code.trim()] : [])))];
  const emp = new Map<string, number>();
  for (let i = 0; i < codes.length; i += 5000) for (const e of await trx.selectFrom('employee').select(['id', 'code']).where('code', 'in', codes.slice(i, i + 5000)).execute()) emp.set(e.code, e.id);

  // Gom các dòng hợp lệ về từng ô; trùng (nhân viên, ngày, loại) trong tệp là lỗi.
  type Cell = { employeeId: number; date: string; items: Map<AttendanceKind, { qty: string; row: number }> };
  const cells = new Map<string, Cell>();
  for (const { row, values: v } of sh.rows) {
    if (bad.has(row)) continue;
    const code = String(v.employee_code ?? '').trim(); const date = v.work_date as string | undefined; const kindText = String(v.kind ?? '');
    const kind = KIND_BY_TEXT.get(norm(kindText));
    if (!code) { err(row, 'employee_code', 'Bắt buộc nhập mã nhân viên'); continue; }
    const employeeId = emp.get(code); if (employeeId === undefined) { err(row, 'employee_code', `Không có nhân viên mã "${code}" trong danh mục Nhân viên`); continue; }
    if (!date) { err(row, 'work_date', 'Bắt buộc nhập ngày'); continue; }
    if (date < from || date > to) { err(row, 'work_date', `Ngày ${formatVnDate(date)} không thuộc tháng ${String(q.month).padStart(2, '0')}/${q.year}`); continue; }
    if (!kind) { err(row, 'kind', kindText ? `Loại "${kindText}" không hợp lệ` : 'Bắt buộc nhập loại'); continue; }
    if (v.qty === undefined || !/^\d{1,4}(\.\d{1,2})?$/.test(String(v.qty))) { err(row, 'qty', 'Số lượng phải lớn hơn 0, tối đa 2 chữ số thập phân'); continue; }
    const key = `${employeeId}|${date}`; const cell = cells.get(key) ?? { employeeId, date, items: new Map() };
    if (cell.items.has(kind)) { err(row, 'kind', `Trùng với dòng ${cell.items.get(kind)!.row} (cùng nhân viên, ngày, loại)`); continue; }
    cell.items.set(kind, { qty: D(String(v.qty)).toString(), row }); cells.set(key, cell);
  }

  // Ô cuối cùng = nội dung đang có (các loại khác) + các loại trong tệp; kiểm theo ngày như khi nhập tay.
  const { payroll_standard_hours_per_day: std } = await getSettings(trx as Transaction<Database>, tenantId);
  const current = new Map<string, { kind: AttendanceKind; qty: string }[]>();
  const ids = [...new Set([...cells.values()].map((c) => c.employeeId))];
  for (let i = 0; i < ids.length; i += 5000) {
    for (const r of await trx.selectFrom('attendance_entry').select(['employee_id', 'work_date', 'kind', 'qty']).where('employee_id', 'in', ids.slice(i, i + 5000)).where('work_date', '>=', from).where('work_date', '<=', to).execute())
      (current.get(`${r.employee_id}|${r.work_date}`) ?? current.set(`${r.employee_id}|${r.work_date}`, []).get(`${r.employee_id}|${r.work_date}`)!).push({ kind: r.kind as AttendanceKind, qty: D(r.qty).toString() });
  }
  const finals: CellInput[] = [];
  for (const [key, c] of cells) {
    const merged = new Map((current.get(key) ?? []).map((x) => [x.kind, x.qty] as const));
    for (const [k, x] of c.items) merged.set(k, x.qty);
    const entries = [...merged].map(([kind, qty]) => ({ kind, qty }));
    const bad1 = checkAttendanceDay(entries, std);
    if (bad1) { err(Math.min(...[...c.items.values()].map((x) => x.row)), 'qty', bad1.message); continue; }
    finals.push({ employeeId: c.employeeId, date: c.date, entries });
  }

  const total = sh.rows.length;
  const sorted = [...errors].sort((a, b) => a.row - b.row);
  const report: AttendanceImportReport = { total, cells: finals.length, errors: sorted.slice(0, MAX_ERRORS), errorCount: errors.length };
  if (mode === 'validate' || errors.length) {
    if (mode === 'commit') throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, report.errors);
    return report;
  }
  const saved = await saveCells(trx, tenantId, q, finals);
  return { ...report, inserted: saved.inserted, updated: saved.updated, deleted: saved.deleted, warnings: saved.warnings };
}
