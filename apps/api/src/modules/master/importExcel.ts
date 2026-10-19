import ExcelJS from 'exceljs';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { parseVnNumber } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { CatalogDef, ColumnDef } from './catalogs.js';
import { resolveLookups } from './crud.js';

export interface ImportError { row: number; column: string; message: string }
const SHEET = 'Du_lieu';
const KEY_ROW = 2;
const FIRST_DATA_ROW = 4; // dòng 1 nhãn, dòng 2 khóa kỹ thuật (ẩn), dòng 3 ví dụ (luôn bị bỏ qua)
export const MAX_ROWS = 20_000;
export const MAX_ERRORS = 500;

const example = (c: ColumnDef): string | number | boolean | null =>
  c.type === 'boolean' ? true : c.type === 'number' ? 0 : c.type === 'date' ? '2026-01-01' : c.options ? c.options[0]!.value : c.key === 'code' ? 'VI_DU' : `Ví dụ ${c.label.toLowerCase()}`;

export async function buildTemplate(def: CatalogDef): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);
  ws.addRow(def.columns.map((c) => c.label + (c.required ? ' (*)' : '')));
  ws.addRow(def.columns.map((c) => c.key)); ws.getRow(KEY_ROW).hidden = true;
  ws.addRow(def.columns.map(example));
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 22; });
  // Cột chữ định dạng văn bản (@) để Excel giữ số 0 đầu (điện thoại, MST, số tài khoản).
  def.columns.forEach((c, i) => { if (c.type === 'text' || c.type === 'select') ws.getColumn(i + 1).numFmt = '@'; });
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow([`Mẫu nhập ${def.label}`]); hd.addRow(['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ và luôn bị bỏ qua. Nhập dữ liệu từ dòng 4.']);
  hd.addRow(['Cột tham chiếu nhập MÃ của danh mục liên quan (ví dụ nhóm đối tượng, bộ phận). Ngày dạng YYYY-MM-DD hoặc dd/MM/yyyy. Ô đúng/sai nhập TRUE/FALSE hoặc 1/0 hoặc x.']);
  for (const c of def.columns) hd.addRow([c.key, c.label, c.type, c.required ? 'bắt buộc' : '', c.options ? c.options.map((o) => `${o.value}=${o.label}`).join('; ') : c.lookup ? `mã ${c.lookup.catalog}` : '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

type Parsed = { v: unknown } | { err: string };
const BAD_DATE: Parsed = { err: 'Ngày không hợp lệ' };
const isInt = (key: string) => key.endsWith('_days') || key === 'minor_unit';
// Ngày hợp lệ → 'YYYY-MM-DD'; ngày hỏng (NaN) hoặc ngoài năm 0000-9999 → null (không bao giờ ném lỗi).
const isoOf = (t: Date): string | null => { if (Number.isNaN(t.getTime())) return null; const s = t.toISOString(); return /^\d{4}-/.test(s) ? s.slice(0, 10) : null; };
const ymd = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? isoOf(t) : null;
};

// Đọc một ô theo kiểu cột; không bao giờ ném lỗi, ô sai trả { err }.
function cellValue(c: ColumnDef, cell: ExcelJS.Cell): Parsed {
  const raw = cell.value;
  // Công thức → kết quả đã tính; rich text và liên kết → chuỗi thuần (nếu không String(object) ghi "[object Object]" vào dữ liệu).
  const v: unknown = typeof raw === 'object' && raw !== null && !(raw instanceof Date)
    ? ('result' in raw ? raw.result : 'richText' in raw ? raw.richText.map((t) => t.text).join('') : 'text' in raw ? raw.text : raw) : raw;
  if (v === null || v === undefined) return { v: null };
  if (typeof v === 'object' && !(v instanceof Date)) return { err: 'Ô lỗi' };
  const s = typeof v === 'string' ? v.trim() : null;
  if (s === '') return { v: null };
  switch (c.type) {
    case 'boolean': return { v: typeof v === 'boolean' ? v : ['1', 'true', 'x', 'có', 'co'].includes(String(v).trim().toLowerCase()) };
    case 'number': {
      // Ô số → chuỗi thập phân; ô chữ chỉ nhận định dạng Việt Nam chặt (1.234,5), dấu chấm đơn lẻ như "8.5" là mơ hồ nên báo lỗi.
      const n = typeof v === 'number' ? (/^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : null) : s === null ? null : parseVnNumber(s);
      return n === null ? { err: 'Số không hợp lệ' } : { v: isInt(c.key) ? Number(n) : n };
    }
    case 'date': {
      let iso: string | null = null;
      if (v instanceof Date) iso = isoOf(v);
      else if (typeof v === 'number') iso = Number.isFinite(v) ? isoOf(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000)) : null; // số ngày Excel
      else if (s !== null) {
        const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
        iso = a ? ymd(+a[1]!, +a[2]!, +a[3]!) : b ? ymd(+b[3]!, +b[2]!, +b[1]!) : null;
      }
      return iso === null ? BAD_DATE : { v: iso };
    }
    default: {
      if (v instanceof Date) { const iso = isoOf(v); return iso === null ? { err: 'Ô lỗi' } : { v: iso }; }
      // Ô số trong cột chữ: ô định dạng 0000000000 giữ lại số 0 đầu theo độ rộng định dạng.
      if (typeof v === 'number') return { v: /^0+$/.test(cell.numFmt ?? '') ? String(v).padStart(cell.numFmt.length, '0') : String(v) };
      return { v: s ?? String(v) };
    }
  }
}

export async function parseWorkbook(def: CatalogDef, buffer: Buffer): Promise<{ rows: Record<string, unknown>[]; errors: ImportError[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw new AppError('IMPORT_BAD_FILE', 'Không đọc được file Excel', 400); }
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', `Không tìm thấy sheet ${SHEET}`, 400);
  // Ánh xạ cột theo khóa kỹ thuật ở dòng 2 (thứ tự cột có thể khác), không theo vị trí.
  const colOf = new Map<string, number>(); let keyCount = 0;
  ws.getRow(KEY_ROW).eachCell((cell, n) => { const k = String(cell.value ?? '').trim(); if (k) { colOf.set(k, n); keyCount++; } });
  if (keyCount !== def.columns.length || !def.columns.every((c) => colOf.has(c.key))) throw new AppError('IMPORT_BAD_TEMPLATE', 'File không đúng mẫu của danh mục ' + def.label, 400);
  if (ws.rowCount - (FIRST_DATA_ROW - 1) > MAX_ROWS) throw new AppError('IMPORT_TOO_LARGE', 'File vượt quá 20.000 dòng', 400);
  const rows: Record<string, unknown>[] = []; const errors: ImportError[] = []; const seen = new Map<string, number>();
  ws.eachRow((row, rowNo) => {
    if (rowNo < FIRST_DATA_ROW) return;
    const obj: Record<string, unknown> = {}; const bad = new Set<string>();
    for (const c of def.columns) {
      const r = cellValue(c, row.getCell(colOf.get(c.key)!));
      if ('err' in r) { errors.push({ row: rowNo, column: c.key, message: r.err }); bad.add(c.key); } else if (r.v !== null) obj[c.key] = r.v;
    }
    if (Object.keys(obj).length === 0 && bad.size === 0) return;
    const parsed = def.schema.safeParse(obj);
    if (!parsed.success) { for (const issue of parsed.error.issues) { const column = String(issue.path[0] ?? def.columns[0]!.key); if (!bad.has(column)) errors.push({ row: rowNo, column, message: issue.message }); } return; }
    if (bad.size) return;
    const uk = def.uniqueBy.map((k) => String(obj[k] ?? '')).join('|');
    if (seen.has(uk)) { errors.push({ row: rowNo, column: def.uniqueBy[0]!, message: `Trùng với dòng ${seen.get(uk)}` }); return; }
    seen.set(uk, rowNo);
    rows.push({ __row: rowNo, ...parsed.data });
  });
  return { rows, errors };
}

// Dòng đã có trong DB theo khóa duy nhất của danh mục? (cột lookup đã được đổi sang `<x>_id`)
async function exists(trx: Transaction<Database>, def: CatalogDef, values: Record<string, unknown>): Promise<boolean> {
  const conds = [];
  for (const k of def.uniqueBy) {
    const col = def.columns.find((c) => c.key === k);
    const dbCol = col?.lookup && col.lookup.catalog !== 'currency' ? k.replace(/_code$/, '_id') : k;
    if (values[dbCol] === null || values[dbCol] === undefined) return false; // khóa có NULL không bao giờ vi phạm UNIQUE
    conds.push(sql`${sql.ref(dbCol)} = ${values[dbCol]}`);
  }
  return (await sql`SELECT 1 FROM ${sql.table(def.table as string)} WHERE ${sql.join(conds, sql` AND `)} LIMIT 1`.execute(trx)).rows.length > 0;
}

// Toàn bộ hoặc không gì: ghi từng dòng (tra cứu ngay trước khi ghi nên dòng cha trong cùng file được dòng con tham chiếu), gom lỗi,
// có lỗi thì ném IMPORT_ERRORS để giao dịch của người gọi hoàn tác các dòng đã ghi.
export async function importRows(trx: Transaction<Database>, tenantId: string, def: CatalogDef, rows: Record<string, unknown>[], errors: ImportError[]): Promise<number> {
  const cache = new Map<string, unknown>(); let inserted = 0;
  for (const r of rows) {
    const { __row, ...data } = r as { __row: number } & Record<string, unknown>;
    try {
      const values = { ...(await resolveLookups(trx, def, data, cache)), tenant_id: tenantId };
      if (await exists(trx, def, values)) { errors.push({ row: __row, column: def.uniqueBy[0]!, message: 'Mã đã tồn tại trong hệ thống' }); continue; }
      await trx.insertInto(def.table as never).values(values as never).execute();
      inserted++;
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'LOOKUP_NOT_FOUND')) throw e;
      errors.push({ row: __row, column: e.message.match(/Cột (\w+)/)?.[1] ?? '', message: e.message });
    }
  }
  if (errors.length) throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, errors.sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS));
  return inserted;
}
