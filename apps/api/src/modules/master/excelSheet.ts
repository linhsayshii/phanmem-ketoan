import ExcelJS from 'exceljs';
import type { ZodIssue } from 'zod';
import { parseVnNumber } from '@kt/domain';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import { AppError } from '../../plugins/errors.js';
import type { ColumnDef } from './catalogs.js';

// Đọc bảng tính Excel dùng chung cho mọi lối nhập: ánh xạ cột theo dòng khóa kỹ thuật, đọc ô theo kiểu cột, lỗi tiếng Việt theo dòng/cột.
export interface ImportError { row: number; column: string; message: string }
// optional: sheet vắng thì trả không có dòng (mặc định lấy sheet đầu tiên khi không thấy tên sheet).
export interface SheetOptions { sheet: string; keyRow: number; firstDataRow: number; maxRows: number; columns: ColumnDef[]; strictKeys?: boolean; optional?: boolean }

const UNREADABLE = 'Ô không đọc được';
const BAD_DATE = 'Ngày không hợp lệ';
const isInt = (key: string) => key.endsWith('_days') || key === 'minor_unit';
// Ngày hợp lệ → 'YYYY-MM-DD'; ngày hỏng (NaN) hoặc ngoài năm 0000-9999 → null (không bao giờ ném lỗi).
const isoOf = (t: Date): string | null => { if (Number.isNaN(t.getTime())) return null; const s = t.toISOString(); return /^\d{4}-/.test(s) ? s.slice(0, 10) : null; };
const ymd = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? isoOf(t) : null;
};

// Ô ngày Excel (Date), số ngày kiểu Excel, chữ YYYY-MM-DD hoặc dd/MM/yyyy → 'YYYY-MM-DD'; giá trị khác hoặc ngày không có thật → null.
// Số ngày có phần thập phân (giờ trong ngày) lấy phần nguyên: 45672.75 vẫn là ngày 45672.
export function excelDate(v: unknown): string | null {
  if (v instanceof Date) return isoOf(v);
  if (typeof v === 'number') return Number.isFinite(v) ? isoOf(new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000)) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim(); const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return a ? ymd(+a[1]!, +a[2]!, +a[3]!) : b ? ymd(+b[3]!, +b[2]!, +b[1]!) : null;
}

// Công thức → kết quả đã tính; rich text và liên kết → chuỗi thuần (nếu không String(object) ghi "[object Object]" vào dữ liệu). Bóc lặp vì kết quả/chữ của liên kết cũng có thể là rich text.
export function plainCell(raw: ExcelJS.CellValue): unknown {
  if (typeof raw !== 'object' || raw === null || raw instanceof Date) return raw;
  if ('result' in raw) return plainCell(raw.result as ExcelJS.CellValue);
  if ('richText' in raw) return raw.richText.map((t) => t.text).join('');
  if ('text' in raw) return plainCell(raw.text as ExcelJS.CellValue);
  return raw; // ô lỗi {error} và đối tượng lạ: giữ nguyên để cellValue báo "Ô không đọc được"
}

type Parsed = { v: unknown } | { err: string };
// Đọc một ô theo kiểu cột; không bao giờ ném lỗi, ô sai trả { err }.
function cellValue(c: ColumnDef, cell: ExcelJS.Cell): Parsed {
  const v = plainCell(cell.value);
  if (v === null || v === undefined) return { v: null };
  if (typeof v === 'object' && !(v instanceof Date)) return { err: UNREADABLE };
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
      const iso = excelDate(v);
      return iso === null ? { err: BAD_DATE } : { v: iso };
    }
    default: {
      if (v instanceof Date) { const iso = isoOf(v); return iso === null ? { err: UNREADABLE } : { v: iso }; }
      // Ô số trong cột chữ: ô định dạng 0000000000 giữ lại số 0 đầu theo độ rộng định dạng.
      if (typeof v === 'number') return { v: /^0+$/.test(cell.numFmt ?? '') ? String(v).padStart(cell.numFmt.length, '0') : String(v) };
      return { v: s ?? String(v) };
    }
  }
}

const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const ZIP_LIMITS = { total: 200 * 1024 * 1024, entry: 100 * 1024 * 1024, entries: 10_000 };
// Chống zip bomb: kích thước giải nén khai báo trong zip là dữ liệu do người gửi tệp khai nên không tin. Nạp mục lục bằng chính JSZip mà exceljs dùng (cùng phiên bản, nên cùng cách đọc thư mục trung tâm: không lệch pha) rồi giải nén từng mục theo luồng, đếm byte thật và hủy luồng khi vượt trần.
// Chi phí: giải nén hai lần (một lần ở đây, một lần khi exceljs nạp); bộ nhớ chỉ ở mức một mảnh luồng vì không gom dữ liệu.
export async function assertZipSafe(buf: Buffer, limits: Partial<typeof ZIP_LIMITS> = {}): Promise<void> {
  const lim = { ...ZIP_LIMITS, ...limits };
  const invalid = () => new AppError('IMPORT_BAD_FILE', 'Tệp không phải xlsx hợp lệ', 400);
  const tooBig = (m: string) => new AppError('IMPORT_FILE_TOO_LARGE', m, 400);
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw invalid(); }
  const files = Object.values(zip.files);
  if (files.length > lim.entries) throw tooBig(`Tệp nén có hơn ${group(lim.entries)} mục`);
  let total = 0;
  for (const f of files) {
    if (f.dir) continue;
    const cap = Math.min(lim.entry, lim.total - total);
    total += await new Promise<number>((resolve, reject) => {
      let size = 0; const st = f.nodeStream() as Readable;
      st.on('data', (c: Buffer) => {
        size += c.length;
        if (size > cap) { st.destroy(); reject(tooBig(cap === lim.entry ? 'Tệp Excel giải nén quá lớn (một mục vượt 100 MB)' : 'Tệp Excel giải nén quá lớn (vượt 200 MB)')); }
      });
      // Bắt buộc giữ: sau destroy JSZip còn phát lỗi "stream.push() after EOF" nhiều lần, thiếu listener là lỗi không bắt làm sập tiến trình.
      st.on('error', () => reject(invalid()));
      st.on('end', () => resolve(size));
    });
  }
}

// Đọc sheet: kiểm số dòng TRƯỚC khi đọc ô nào (actualRowCount chỉ đếm dòng có giá trị); cột ánh xạ theo khóa ở dòng `keyRow` (thứ tự cột tùy ý, cột không bắt buộc có thể vắng).
// Trả các dòng có dữ liệu (chỉ chứa ô đọc được) và lỗi cấp ô; dòng trống bị bỏ qua. Kiểm tra nghiệp vụ theo từng dòng là việc của người gọi.
export async function readSheet(buf: Buffer, opts: SheetOptions): Promise<{ rows: { row: number; values: Record<string, unknown> }[]; errors: ImportError[] }> {
  await assertZipSafe(buf);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw new AppError('IMPORT_BAD_FILE', 'Không đọc được file Excel', 400); }
  const ws = wb.getWorksheet(opts.sheet) ?? (opts.optional ? undefined : wb.worksheets[0]);
  if (!ws && opts.optional) return { rows: [], errors: [] };
  if (!ws) throw new AppError('IMPORT_NO_SHEET', `Không tìm thấy sheet ${opts.sheet}`, 400);
  const dataRows = ws.actualRowCount - (opts.firstDataRow - 1);
  if (dataRows > opts.maxRows) throw new AppError('IMPORT_TOO_MANY_ROWS', `Tệp có ${group(dataRows)} dòng, tối đa ${group(opts.maxRows)}`, 400);

  const colOf = new Map<string, number>();
  ws.getRow(opts.keyRow).eachCell((cell, n) => { const k = String(plainCell(cell.value) ?? '').trim(); if (k && !colOf.has(k)) colOf.set(k, n); });
  if (!colOf.size) throw new AppError('IMPORT_BAD_TEMPLATE', `Không thấy dòng khóa kỹ thuật (dòng ${opts.keyRow}); hãy tải lại mẫu Excel`, 400);
  if (opts.strictKeys && [...colOf.keys()].some((k) => !opts.columns.some((c) => c.key === k))) throw new AppError('IMPORT_BAD_TEMPLATE', 'File không đúng mẫu', 400);
  const missing = opts.columns.filter((c) => c.required && !colOf.has(c.key));
  if (missing.length) throw new AppError('IMPORT_COLUMN_MISSING', `Thiếu cột bắt buộc ở dòng khóa (dòng ${opts.keyRow}): ${missing.map((c) => `${c.label} [${c.key}]`).join(', ')}. Hãy tải lại mẫu Excel`, 400);

  const rows: { row: number; values: Record<string, unknown> }[] = []; const errors: ImportError[] = [];
  ws.eachRow((row, rowNo) => {
    if (rowNo < opts.firstDataRow) return;
    const values: Record<string, unknown> = {}; let bad = false;
    for (const c of opts.columns) {
      const n = colOf.get(c.key);
      if (n === undefined) continue;
      const r = cellValue(c, row.getCell(n));
      if ('err' in r) { errors.push({ row: rowNo, column: c.key, message: r.err }); bad = true; } else if (r.v !== null) values[c.key] = r.v;
    }
    if (bad || Object.keys(values).length) rows.push({ row: rowNo, values });
  });
  return { rows, errors };
}

// Lỗi Zod → tiếng Việt kế toán. Thông báo tùy biến của lược đồ (đã là tiếng Việt) được giữ; thông báo mặc định (tiếng Anh) thay bằng câu theo loại lỗi.
export function zodIssueVi(issue: ZodIssue, label: string): string {
  const custom = /\P{ASCII}/u.test(issue.message) ? issue.message : null;
  if (custom) return `${label}: ${custom}`;
  switch (issue.code) {
    case 'invalid_type': return `${label}: ${issue.received === 'undefined' || issue.received === 'null' ? 'bắt buộc nhập' : 'sai kiểu dữ liệu'}`;
    case 'too_small': return `${label}: ${issue.type === 'string' && issue.minimum === 1 ? 'bắt buộc nhập' : 'quá nhỏ'}`;
    case 'too_big': return `${label}: ${issue.type === 'string' ? `quá dài (tối đa ${issue.maximum} ký tự)` : 'quá lớn'}`;
    case 'invalid_enum_value': return `${label}: không thuộc danh sách (${issue.options.join(', ')})`;
    case 'invalid_string': case 'invalid_literal': return `${label}: sai định dạng`;
    default: return `${label}: không hợp lệ`;
  }
}

// Mẫu nhập: dòng 1 nhãn (cột bắt buộc có (*)), dòng 2 khóa kỹ thuật (ẩn), dòng 3 ví dụ (luôn bị bỏ qua); sheet Huong_dan giữ các dòng hướng dẫn.
export async function buildSheetTemplate(o: { sheet: string; columns: ColumnDef[]; example: (c: ColumnDef) => ExcelJS.CellValue; keyRow: number; help: string[][]; extra?: { sheet: string; columns: ColumnDef[] }[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const { sheet, columns } of [{ sheet: o.sheet, columns: o.columns }, ...(o.extra ?? [])]) {
    const ws = wb.addWorksheet(sheet);
    ws.addRow(columns.map((c) => c.label + (c.required ? ' (*)' : '')));
    ws.addRow(columns.map((c) => c.key)); ws.getRow(o.keyRow).hidden = true;
    ws.addRow(columns.map(o.example));
    ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 22; });
    // Cột chữ định dạng văn bản (@) để Excel giữ số 0 đầu (điện thoại, MST, số tài khoản).
    columns.forEach((c, i) => { if (c.type === 'text' || c.type === 'select') ws.getColumn(i + 1).numFmt = '@'; });
  }
  const hd = wb.addWorksheet('Huong_dan');
  for (const r of o.help) hd.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
