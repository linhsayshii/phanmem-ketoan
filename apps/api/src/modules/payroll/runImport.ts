import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import type { PayrollColumn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { ColumnDef } from '../master/catalogs.js';
import { buildSheetTemplate, readSheet, type ImportError } from '../master/excelSheet.js';
import { MAX_ERRORS, MAX_ROWS } from '../master/importExcel.js';
import { applyManual, assertEditable, lockRun, structureOf } from './runs.js';

// Nhập bảng lương từ Excel (Task 7): mỗi dòng một nhân viên của bảng lương, các cột là cột nhập tay (kind 'input') của cấu trúc bảng lương.
// Ô có giá trị thì đặt (hoặc thay) ô nhập tay của cột đó; ô trống giữ nguyên. Hai lượt Kiểm tra / Nhập; có lỗi dòng nào thì không ghi dòng nào.
// Không tính lại: giá trị nhập tay đổi chữ ký đầu vào nên bảng "Cần tính lại", người dùng bấm Tính (không bắt tham số lương khi chỉ muốn nhập số liệu).
type Trx = Transaction<Database>;
const SHEET = 'Du_lieu', KEY_ROW = 2, FIRST_DATA_ROW = 4;
const MONEY_RE = /^\d{1,16}$/, QTY_RE = /^\d{1,16}(\.\d{1,6})?$/;
// Cột tiền (thu nhập, khấu trừ, giảm trừ) là số nguyên đồng; cột khác (số lượng, hệ số) cho tối đa 6 chữ số thập phân. Không nhập số âm: sửa tay trên bảng lương.
const isMoney = (c: PayrollColumn) => !!(c.income || c.deduct || c.pitRelief);

const inputColumns = (columns: PayrollColumn[]) => columns.filter((c) => c.kind === 'input');
export const importColumns = (columns: PayrollColumn[]): ColumnDef[] => [
  { key: 'employee_code', label: 'Mã nhân viên', type: 'text', required: true },
  ...inputColumns(columns).map((c): ColumnDef => ({ key: c.code, label: c.name, type: 'number' })),
];

export async function buildRunImportTemplate(trx: Trx, runId: number): Promise<Buffer> {
  const run = await trx.selectFrom('payroll_run').select(['name', 'structure_id']).where('id', '=', runId).executeTakeFirst();
  if (!run) throw new AppError('PAYROLL_RUN_NOT_FOUND', 'Không tìm thấy bảng lương', 404);
  const cols = (await structureOf(trx, run.structure_id)).columns;
  const lines = await trx.selectFrom('payroll_line as l').innerJoin('employee as e', 'e.id', 'l.employee_id').select('e.code').where('l.run_id', '=', runId).orderBy('e.code').limit(1).executeTakeFirst();
  return buildSheetTemplate({
    sheet: SHEET, columns: importColumns(cols), keyRow: KEY_ROW, example: (c) => (c.key === 'employee_code' ? (lines?.code ?? 'NV01') : 0),
    help: [
      [`Mẫu nhập số liệu cho ${run.name}`],
      ['Mỗi dòng một nhân viên của bảng lương; cột là các cột nhập tay của cấu trúc bảng lương. Dòng 1: tên cột; dòng 3 là ví dụ và luôn bị bỏ qua; nhập từ dòng 4.'],
      ['Ô có giá trị thì thay giá trị nhập tay của cột đó; ô để trống thì giữ nguyên. Số tiền là số nguyên đồng, không âm; có lỗi ở bất kỳ dòng nào thì không nhập dòng nào.'],
      ['Sau khi nhập, bảng lương ở trạng thái "Cần tính lại": bấm Tính để tính lại.'],
    ],
  });
}

export interface RunImportReport { total: number; employees: number; cells: number; errors: ImportError[]; errorCount: number; changedCells?: number }

export async function importRun(trx: Trx, tenantId: string, runId: number, buf: Buffer, mode: 'validate' | 'commit'): Promise<RunImportReport> {
  const run = await lockRun(trx, runId); assertEditable(run);
  const all = (await structureOf(trx, run.structure_id)).columns;
  const columns = inputColumns(all);
  const defs = importColumns(all);
  if (!columns.length) throw new AppError('PAYROLL_NO_INPUT_COLUMNS', 'Cấu trúc bảng lương không có cột nhập tay nào để nhập từ Excel', 409);
  let sh;
  try { sh = await readSheet(buf, { sheet: SHEET, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns: defs, strictKeys: true }); } catch (e) {
    if (e instanceof AppError && e.code === 'IMPORT_BAD_TEMPLATE') throw new AppError(e.code, 'File không đúng mẫu nhập bảng lương (tải lại mẫu của bảng lương này)', 400);
    throw e;
  }
  const errors: ImportError[] = [...sh.errors];
  const bad = new Set(errors.map((e) => e.row));
  const err = (row: number, column: string, message: string) => { errors.push({ row, column, message }); bad.add(row); };
  const lines = new Map((await trx.selectFrom('payroll_line as l').innerJoin('employee as e', 'e.id', 'l.employee_id').select(['l.id', 'l.employee_id', 'e.code']).where('l.run_id', '=', runId).execute()).map((l) => [l.code, l]));

  const seen = new Map<string, number>();
  const updates: { line: { id: number; employee_id: number }; values: Record<string, string> }[] = [];
  for (const { row, values } of sh.rows) {
    if (bad.has(row)) continue;
    const code = String(values.employee_code ?? '').trim();
    if (!code) { err(row, 'employee_code', 'Bắt buộc nhập mã nhân viên'); continue; }
    const line = lines.get(code); if (!line) { err(row, 'employee_code', `Nhân viên "${code}" không có trong bảng lương này`); continue; }
    if (seen.has(code)) { err(row, 'employee_code', `Trùng với dòng ${seen.get(code)} (cùng nhân viên)`); continue; }
    seen.set(code, row);
    const out: Record<string, string> = {}; let ok = true;
    for (const c of columns) {
      const raw = values[c.code]; if (raw === undefined) continue;
      const text = String(raw);
      if (!(isMoney(c) ? MONEY_RE : QTY_RE).test(text)) { err(row, c.code, isMoney(c) ? `${c.name}: nhập số tiền nguyên đồng, không âm, tối đa 16 chữ số` : `${c.name}: nhập số không âm, tối đa 6 chữ số thập phân`); ok = false; continue; }
      out[c.code] = text;
    }
    if (ok && Object.keys(out).length) updates.push({ line, values: out });
  }

  const report: RunImportReport = { total: sh.rows.length, employees: updates.length, cells: updates.reduce((n, u) => n + Object.keys(u.values).length, 0), errors: [...errors].sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS), errorCount: errors.length };
  if (errors.length) {
    if (mode === 'commit') throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, report.errors);
    return report;
  }
  if (mode === 'validate') return report;
  let changed = 0;
  for (const u of updates) changed += await applyManual(trx, tenantId, runId, u.line, u.values);
  return { ...report, changedCells: changed };
}
