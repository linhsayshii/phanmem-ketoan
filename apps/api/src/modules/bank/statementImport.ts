import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { type Insertable, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

// Nhập sao kê Excel/CSV theo mẫu cột do người dùng khai (không có mẫu chính thức của ngân hàng: docs/dev/tich-hop/ngan-hang.md §5).
type Trx = Transaction<Database>;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;

const col = z.string().regex(/^[A-Z]{1,3}$/, 'Cột theo chữ cái Excel viết hoa (A, B, ..., AA)');
const optCol = col.nullish();
export const formatInput = z.object({
  name: z.string().trim().min(1).max(100), bankCode: z.string().trim().max(20).nullish(), headerRow: z.number().int().min(0).max(1000).default(1), sheetIndex: z.number().int().min(0).max(50).default(0),
  dateCol: col, dateFormat: z.enum(['dd/MM/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'excel']), descriptionCol: col,
  amountInCol: optCol, amountOutCol: optCol, signedAmountCol: optCol, referenceCol: optCol, balanceCol: optCol,
}).refine((f) => f.signedAmountCol || f.amountInCol || f.amountOutCol, { message: 'Khai cột số tiền: Ghi có / Ghi nợ hoặc một cột số tiền có dấu' });

type FormatRow = Selectable<Database['bank_statement_format']>;
const dto = (r: FormatRow) => ({ id: r.id, name: r.name, bankCode: r.bank_code, headerRow: r.header_row, sheetIndex: r.sheet_index, dateCol: r.date_col, dateFormat: r.date_format, descriptionCol: r.description_col,
  amountInCol: r.amount_in_col, amountOutCol: r.amount_out_col, signedAmountCol: r.signed_amount_col, referenceCol: r.reference_col, balanceCol: r.balance_col });
const fnf = () => new AppError('BANK_FORMAT_NOT_FOUND', 'Không tìm thấy mẫu sao kê', 404);

export const listFormats = async (trx: Trx) => (await trx.selectFrom('bank_statement_format').selectAll().orderBy('name').execute()).map(dto);
export async function saveFormat(trx: Trx, tenantId: string, id: number | null, b: z.infer<typeof formatInput>) {
  const v = { name: b.name, bank_code: b.bankCode ?? null, header_row: b.headerRow, sheet_index: b.sheetIndex, date_col: b.dateCol, date_format: b.dateFormat, description_col: b.descriptionCol,
    amount_in_col: b.amountInCol ?? null, amount_out_col: b.amountOutCol ?? null, signed_amount_col: b.signedAmountCol ?? null, reference_col: b.referenceCol ?? null, balance_col: b.balanceCol ?? null };
  if (id === null) return dto(await trx.insertInto('bank_statement_format').values({ tenant_id: tenantId, ...v }).returningAll().executeTakeFirstOrThrow());
  const r = await trx.updateTable('bank_statement_format').set(v).where('id', '=', id).returningAll().executeTakeFirst();
  if (!r) throw fnf();
  return dto(r);
}
export async function deleteFormat(trx: Trx, id: number) {
  const r = await trx.deleteFrom('bank_statement_format').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw fnf();
}

const colNo = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

// Giá trị ô → số / chuỗi / ngày thuần (công thức lấy kết quả, văn bản định dạng lấy chữ).
function plain(v: ExcelJS.CellValue): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
  }
  return null;
}
const text = (v: string | number | Date | null) => (v === null ? '' : v instanceof Date ? '' : String(v).trim());

function parseDate(v: string | number | Date | null, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const mk = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new Error('Ngày không tồn tại');
    return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  };
  if (v instanceof Date) return mk(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (format === 'excel') {
    if (typeof v !== 'number' || !(v >= 1 && v < 2958466)) throw new Error('Ô ngày không phải ngày Excel');
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
    return mk(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const s = text(v);
  const tail = String.raw`(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$`;
  const m = format === 'yyyy-MM-dd' ? new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})` + tail).exec(s)
    : new RegExp(String.raw`^(\d{1,2})${format === 'dd/MM/yyyy' ? '/' : '-'}(\d{1,2})${format === 'dd/MM/yyyy' ? '/' : '-'}(\d{4})` + tail).exec(s);
  if (!m) throw new Error(`Ngày "${s}" không đúng định dạng ${format}`);
  return format === 'yyyy-MM-dd' ? mk(+m[1]!, +m[2]!, +m[3]!) : mk(+m[3]!, +m[2]!, +m[1]!);
}

// Số tiền: số Excel hoặc chuỗi có dấu phân cách nghìn (1,234.5 hoặc 1.234,5). Trống / "-" là 0.
function parseMoney(v: string | number | Date | null) {
  if (v instanceof Date) throw new Error('Ô số tiền là ngày');
  if (typeof v === 'number') return D(String(v));
  let s = text(v).replace(/\s/g, '');
  if (s === '' || s === '-') return D(0);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Số tiền "${s}" không hợp lệ`);
  return D(s);
}
const money4 = (x: ReturnType<typeof D>) => {
  if (x.decimalPlaces() > 4) throw new Error('Số tiền quá 4 chữ số thập phân');
  if (x.abs().toFixed(0).length > 16) throw new Error('Số tiền quá lớn');
  return x.toFixed(4);
};

async function readSheet(file: Buffer, filename: string, sheetIndex: number): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(filename)) {
      // map nhận nguyên chuỗi: ExcelJS mặc định tự đoán ngày/số, làm lệch ngày dd/MM và số 0 đầu.
      return await wb.csv.read(Readable.from([file.toString('utf8').replace(/^\uFEFF/, '')]), { map: (v: unknown) => v, parserOptions: { delimiter: ',' } } as never);
    }
    if (/\.xlsx$/i.test(filename)) {
      await wb.xlsx.load(file as never);
      const ws = wb.worksheets[sheetIndex];
      if (!ws) throw new AppError('IMPORT_SHEET_MISSING', `Tệp không có trang tính số ${sheetIndex + 1}`, 400);
      return ws;
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('IMPORT_FILE_INVALID', 'Không đọc được tệp sao kê (hỏng hoặc sai định dạng)', 400);
  }
  throw new AppError('IMPORT_FILE_TYPE', 'Chỉ nhận tệp .xlsx hoặc .csv', 400);
}

export interface ImportResult { inserted: number; skipped: number; errors: { row: number; message: string }[] }

export async function importStatement(trx: Trx, tenantId: string, a: { bankAccountId: number; formatId: number; file: Buffer; filename: string }): Promise<ImportResult> {
  const acc = await trx.selectFrom('bank_account').select(['id', 'account_no']).where('id', '=', a.bankAccountId).executeTakeFirst();
  if (!acc) throw new AppError('BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng', 404);
  const f = await trx.selectFrom('bank_statement_format').selectAll().where('id', '=', a.formatId).executeTakeFirst();
  if (!f) throw fnf();
  const ws = await readSheet(a.file, a.filename, f.sheet_index);
  if (ws.rowCount - f.header_row > MAX_IMPORT_ROWS) throw new AppError('IMPORT_TOO_MANY_ROWS', `Tệp có hơn ${MAX_IMPORT_ROWS} dòng, hãy tách nhỏ`, 413);
  const c = (n: string | null) => (n ? colNo(n) : 0);
  const idx = { date: c(f.date_col), desc: c(f.description_col), in: c(f.amount_in_col), out: c(f.amount_out_col), signed: c(f.signed_amount_col), ref: c(f.reference_col), bal: c(f.balance_col) };

  const errors: ImportResult['errors'] = [];
  const seen = new Map<string, number>();
  const rows: Insertable<Database['bank_transaction']>[] = [];
  for (let r = f.header_row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (n: number) => (n ? plain(row.getCell(n).value) : null);
    const cells = [idx.date, idx.desc, idx.in, idx.out, idx.signed].map(get);
    if (cells.every((v) => text(v) === '' && !(v instanceof Date))) continue; // dòng trống
    try {
      const valueDate = parseDate(get(idx.date), f.date_format);
      let inV = D(0); let outV = D(0);
      if (idx.signed) { const s = parseMoney(get(idx.signed)); if (s.gt(0)) inV = s; else outV = s.neg(); }
      if (idx.in) inV = parseMoney(get(idx.in));
      if (idx.out) outV = parseMoney(get(idx.out));
      if (inV.lt(0) || outV.lt(0)) throw new Error('Số tiền âm trong cột Ghi có / Ghi nợ');
      if (inV.gt(0) === outV.gt(0)) throw new Error(inV.gt(0) ? 'Dòng có cả số tiền vào và ra' : 'Dòng không có số tiền');
      const bal = idx.bal && text(get(idx.bal)) !== '' ? money4(parseMoney(get(idx.bal))) : null;
      const description = text(get(idx.desc)) || null; const reference = text(get(idx.ref)) || null;
      const key = [acc.account_no, valueDate, inV.gt(0) ? `+${money4(inV)}` : `-${money4(outV)}`, reference ?? '', description ?? ''].join('|');
      const n = seen.get(key) ?? 0; seen.set(key, n + 1); // cùng nội dung lặp trong tệp vẫn là các giao dịch riêng
      rows.push({ tenant_id: tenantId, bank_account_id: acc.id, source: 'import', external_id: `imp:${createHash('sha256').update(`${key}|${n}`).digest('hex')}`, txn_time: null, value_date: valueDate,
        amount_in: money4(inV), amount_out: money4(outV), balance_after: bal, description, reference });
    } catch (e) {
      errors.push({ row: r, message: e instanceof Error ? e.message : String(e) });
    }
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    inserted += (await trx.insertInto('bank_transaction').values(chunk).onConflict((oc) => oc.columns(['tenant_id', 'source', 'external_id']).doNothing()).returning('id').execute()).length;
  }
  return { inserted, skipped: rows.length - inserted, errors };
}
