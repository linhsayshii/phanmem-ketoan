import ExcelJS from 'exceljs';
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import type { CatalogDef, ColumnDef } from './catalogs.js';
import { resolveLookups } from './crud.js';

export interface ImportError { row: number; column: string; message: string }
const SHEET = 'Du_lieu';

const example = (c: ColumnDef): string | number | boolean | null =>
  c.type === 'boolean' ? true : c.type === 'number' ? 0 : c.type === 'date' ? '2026-01-01' : c.options ? c.options[0]!.value : c.key === 'code' ? 'VI_DU' : `Ví dụ ${c.label.toLowerCase()}`;

export async function buildTemplate(def: CatalogDef): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);
  ws.addRow(def.columns.map((c) => c.label + (c.required ? ' (*)' : '')));
  ws.addRow(def.columns.map((c) => c.key)); ws.getRow(2).hidden = true;
  ws.addRow(def.columns.map(example));
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 22; });
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow([`Mẫu nhập ${def.label}`]); hd.addRow(['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ, sẽ bị bỏ qua nếu ô A3 = VI_DU. Nhập dữ liệu từ dòng 3 hoặc 4.']);
  hd.addRow(['Cột tham chiếu nhập MÃ của danh mục liên quan (ví dụ nhóm đối tượng, bộ phận). Ngày dạng YYYY-MM-DD hoặc dd/MM/yyyy. Ô đúng/sai nhập TRUE/FALSE hoặc 1/0 hoặc x.']);
  for (const c of def.columns) hd.addRow([c.key, c.label, c.type, c.required ? 'bắt buộc' : '', c.options ? c.options.map((o) => `${o.value}=${o.label}`).join('; ') : c.lookup ? `mã ${c.lookup.catalog}` : '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellValue(c: ColumnDef, raw: ExcelJS.CellValue): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  // Công thức → kết quả; rich text và liên kết → chuỗi (nếu không String(object) sẽ ghi "[object Object]" vào dữ liệu).
  const v = typeof raw === 'object' && !(raw instanceof Date)
    ? ('result' in raw ? raw.result : 'richText' in raw ? raw.richText.map((t) => t.text).join('') : 'text' in raw ? raw.text : raw) : raw;
  switch (c.type) {
    case 'boolean': return typeof v === 'boolean' ? v : ['1', 'true', 'x', 'có', 'co'].includes(String(v).trim().toLowerCase());
    case 'number': return typeof v === 'number' ? (c.key.endsWith('_days') || c.key === 'minor_unit' ? v : String(v)) : String(v).replace(/[\s.]/g, '').replace(',', '.');
    case 'date': {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v).trim());
      return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : String(v).trim();
    }
    default: return String(v).trim();
  }
}

export async function parseWorkbook(def: CatalogDef, buffer: Buffer): Promise<{ rows: Record<string, unknown>[]; errors: ImportError[] }> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', `Không tìm thấy sheet ${SHEET}`, 400);
  const keys = def.columns.map((c) => c.key);
  const rows: Record<string, unknown>[] = []; const errors: ImportError[] = []; const seen = new Map<string, number>();
  ws.eachRow((row, rowNo) => {
    if (rowNo <= 2) return;
    if (rowNo === 3 && String(row.getCell(1).value ?? '') === 'VI_DU') return;
    const obj: Record<string, unknown> = {};
    def.columns.forEach((c, i) => { const v = cellValue(c, row.getCell(i + 1).value); if (v !== null) obj[c.key] = v; });
    if (Object.keys(obj).length === 0) return;
    const parsed = def.schema.safeParse(obj);
    if (!parsed.success) { for (const issue of parsed.error.issues) errors.push({ row: rowNo, column: String(issue.path[0] ?? keys[0]), message: issue.message }); return; }
    const uk = def.uniqueBy.map((k) => String(obj[k] ?? '')).join('|');
    if (seen.has(uk)) errors.push({ row: rowNo, column: def.uniqueBy[0]!, message: `Trùng với dòng ${seen.get(uk)}` }); else seen.set(uk, rowNo);
    rows.push({ __row: rowNo, ...parsed.data });
  });
  return { rows, errors };
}

export async function importRows(trx: Transaction<Database>, tenantId: string, def: CatalogDef, rows: Record<string, unknown>[], errors: ImportError[]): Promise<number> {
  const resolved: Record<string, unknown>[] = [];
  for (const r of rows) {
    const { __row, ...data } = r as { __row: number } & Record<string, unknown>;
    try { resolved.push({ ...(await resolveLookups(trx, def, data)), tenant_id: tenantId }); }
    catch (e) { errors.push({ row: __row, column: (e as AppError).message.match(/Cột (\w+)/)?.[1] ?? '', message: (e as Error).message }); }
  }
  if (errors.length) throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, errors);
  for (let i = 0; i < resolved.length; i += 200) {
    await trx.insertInto(def.table as never).values(resolved.slice(i, i + 200) as never).execute();
  }
  return resolved.length;
}
