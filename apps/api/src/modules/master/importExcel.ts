import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import type { CatalogDef, ColumnDef } from './catalogs.js';
import { resolveLookups } from './crud.js';
import { buildSheetTemplate, readSheet, zodIssueVi, type ImportError } from './excelSheet.js';

// Giữ các tên cũ cho nơi khác (openingBalance) nhập từ đây.
export { excelDate, plainCell, type ImportError } from './excelSheet.js';
const SHEET = 'Du_lieu';
const KEY_ROW = 2;
const FIRST_DATA_ROW = 4; // dòng 1 nhãn, dòng 2 khóa kỹ thuật (ẩn), dòng 3 ví dụ (luôn bị bỏ qua)
export const MAX_ROWS = 20_000;
export const MAX_ERRORS = 500;
const BATCH = 500; // số dòng mỗi câu INSERT ... VALUES

const example = (c: ColumnDef): string | number | boolean | null =>
  c.type === 'boolean' ? true : c.type === 'number' ? 0 : c.type === 'date' ? '2026-01-01' : c.options ? c.options[0]!.value : c.key === 'code' ? 'VI_DU' : `Ví dụ ${c.label.toLowerCase()}`;

export function buildTemplate(def: CatalogDef): Promise<Buffer> {
  return buildSheetTemplate({
    sheet: SHEET, columns: def.columns, example, keyRow: KEY_ROW,
    help: [
      [`Mẫu nhập ${def.label}`],
      ['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ và luôn bị bỏ qua. Nhập dữ liệu từ dòng 4.'],
      ['Cột tham chiếu nhập MÃ của danh mục liên quan (ví dụ nhóm đối tượng, bộ phận). Ngày dạng YYYY-MM-DD hoặc dd/MM/yyyy. Ô đúng/sai nhập TRUE/FALSE hoặc 1/0 hoặc x.'],
      ...def.columns.map((c) => [c.key, c.label, c.type, c.required ? 'bắt buộc' : '', c.options ? c.options.map((o) => `${o.value}=${o.label}`).join('; ') : c.lookup ? `mã ${c.lookup.catalog}` : '']),
    ],
  });
}

export async function parseWorkbook(def: CatalogDef, buffer: Buffer): Promise<{ rows: Record<string, unknown>[]; errors: ImportError[] }> {
  // Ánh xạ cột theo khóa kỹ thuật ở dòng 2; khóa lạ (file của danh mục khác) bị từ chối.
  let sheet;
  try { sheet = await readSheet(buffer, { sheet: SHEET, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns: def.columns, strictKeys: true }); } catch (e) {
    if (e instanceof AppError && e.code === 'IMPORT_BAD_TEMPLATE') throw new AppError(e.code, 'File không đúng mẫu của danh mục ' + def.label, 400);
    throw e;
  }
  const errors = [...sheet.errors]; const rows: Record<string, unknown>[] = []; const seen = new Map<string, number>();
  const label = (key: string) => def.columns.find((c) => c.key === key)?.label ?? key;
  const badCols = new Map<number, Set<string>>();
  for (const e of sheet.errors) { if (!badCols.has(e.row)) badCols.set(e.row, new Set()); badCols.get(e.row)!.add(e.column); }
  for (const { row, values } of sheet.rows) {
    const bad = badCols.get(row) ?? new Set<string>();
    const parsed = def.schema.safeParse(values);
    if (!parsed.success) { for (const issue of parsed.error.issues) { const column = String(issue.path[0] ?? def.columns[0]!.key); if (!bad.has(column)) errors.push({ row, column, message: zodIssueVi(issue, label(column)) }); } continue; }
    if (bad.size) continue;
    const uk = def.uniqueBy.map((k) => String(values[k] ?? '')).join('|');
    if (seen.has(uk)) { errors.push({ row, column: def.uniqueBy[0]!, message: `Trùng với dòng ${seen.get(uk)}` }); continue; }
    seen.set(uk, row);
    rows.push({ __row: row, ...parsed.data });
  }
  return { rows, errors: errors.sort((a, b) => a.row - b.row) };
}

// Dòng đã có trong DB theo khóa duy nhất của danh mục? (cột lookup đã được đổi sang `<x>_id`)
async function exists(trx: Transaction<Database>, def: CatalogDef, values: Record<string, unknown>): Promise<boolean> {
  const conds = [];
  for (const k of def.uniqueBy) {
    const col = def.columns.find((c) => c.key === k);
    const dbCol = col?.lookup && col.lookup.catalog !== 'currency' ? k.replace(/_code$/, '_id') : k;
    if (values[dbCol] === null || values[dbCol] === undefined) {
      if (!def.nullsNotDistinct) return false; // khóa có NULL không bao giờ vi phạm UNIQUE thường
      conds.push(sql`${sql.ref(dbCol)} IS NULL`); continue;
    }
    conds.push(sql`${sql.ref(dbCol)} = ${values[dbCol]}`);
  }
  return (await sql`SELECT 1 FROM ${sql.table(def.table as string)} WHERE ${sql.join(conds, sql` AND `)} LIMIT 1`.execute(trx)).rows.length > 0;
}

// Toàn bộ hoặc không gì: tra cứu và kiểm trùng từng dòng, gom lỗi; chỉ khi không có lỗi mới ghi, mỗi câu INSERT tối đa 500 dòng.
// Dòng tham chiếu chính danh mục này (bộ phận cha...) ghi trước các dòng chờ để dòng cha trong cùng file tra cứu được.
// Có lỗi thì ném IMPORT_ERRORS; giao dịch của người gọi hoàn tác mọi dòng đã ghi.
export async function importRows(trx: Transaction<Database>, tenantId: string, def: CatalogDef, rows: Record<string, unknown>[], errors: ImportError[]): Promise<number> {
  const cache = new Map<string, unknown>(); let inserted = 0; let pending: Record<string, unknown>[] = [];
  const selfRef = def.columns.filter((c) => c.lookup?.catalog === def.name).map((c) => c.key);
  const flush = async () => {
    if (!pending.length || errors.length) { pending = []; return; }
    await trx.insertInto(def.table as never).values(pending as never).execute();
    inserted += pending.length; pending = [];
  };
  for (const r of rows) {
    const { __row, ...data } = r as { __row: number } & Record<string, unknown>;
    try {
      if (selfRef.some((k) => data[k] !== undefined && data[k] !== null && data[k] !== '')) await flush();
      const values = { ...(await resolveLookups(trx, def, data, cache)), tenant_id: tenantId };
      if (await exists(trx, def, values)) { errors.push({ row: __row, column: def.uniqueBy[0]!, message: 'Mã đã tồn tại trong hệ thống' }); continue; }
      pending.push(values);
      if (pending.length >= BATCH) await flush();
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'LOOKUP_NOT_FOUND')) throw e;
      errors.push({ row: __row, column: e.message.match(/Cột (\w+)/)?.[1] ?? '', message: e.message });
    }
  }
  await flush();
  if (errors.length) throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, errors.sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS));
  return inserted;
}
