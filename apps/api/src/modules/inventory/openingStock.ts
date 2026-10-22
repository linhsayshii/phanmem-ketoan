import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, formatVnNumber, toBaseQty, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { assertZipSafe } from '../master/excelSheet.js';
import { MAX_ERRORS, MAX_ROWS, type ImportError } from '../master/importExcel.js';
import { day, num, openingPeriod, txt, type OpeningIssue } from '../ledger/openingBalance.js';
import { isoDate } from '../reporting/routes.js';
import { assertSensitive } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
const qtyRe = /^\d{1,16}(\.\d{1,4})?$/;
export const stockRow = z.object({
  warehouseCode: z.string().trim().min(1, 'Thiếu mã kho'), itemCode: z.string().trim().min(1, 'Thiếu mã hàng'), uomCode: z.string().trim().nullable().optional(),
  quantity: z.string().regex(qtyRe, 'Số lượng không hợp lệ').refine((s) => /[1-9]/.test(s), 'Số lượng phải lớn hơn 0'),
  value: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).default('0'), lotNo: z.string().trim().max(50).nullable().optional(), expiryDate: isoDate.nullable().optional(),
});
export type StockRow = z.infer<typeof stockRow>;
type Problem = { index: number; column: string; message: string };
const COST_AUTH = { subledger_kind: 'inventory', code: '156' };

// Tra kho, hàng, ĐVT; quy về ĐVT cơ sở; kiểm lô/hạn dùng và trùng khóa. Trả mọi lỗi theo (chỉ số dòng, cột).
async function resolve(trx: Trx, rows: StockRow[]) {
  const problems: Problem[] = [];
  const whCodes = [...new Set(rows.map((r) => r.warehouseCode))]; const itemCodes = [...new Set(rows.map((r) => r.itemCode))];
  const whs = new Map((whCodes.length ? await trx.selectFrom('warehouse').select(['id', 'code', 'is_active']).where('code', 'in', whCodes).execute() : []).map((w) => [w.code, w]));
  const items = new Map((itemCodes.length ? await trx.selectFrom('item').select(['id', 'code', 'kind', 'tracking', 'is_active', 'base_uom_id']).where('code', 'in', itemCodes).execute() : []).map((i) => [i.code, i]));
  const uoms = items.size ? await trx.selectFrom('item_uom as iu').innerJoin('uom as u', 'u.id', 'iu.uom_id').select(['iu.item_id', 'iu.uom_id', 'u.code', 'iu.factor']).where('iu.item_id', 'in', [...items.values()].map((i) => i.id)).execute() : [];
  const seen = new Map<string, number>();
  const out = rows.map((r, index) => {
    const bad = (column: string, message: string) => { problems.push({ index, column, message }); return null; };
    const wh = whs.get(r.warehouseCode); const item = items.get(r.itemCode);
    if (!wh) return bad('warehouse_code', `Không có kho ${r.warehouseCode}`);
    if (!wh.is_active) return bad('warehouse_code', `Kho ${r.warehouseCode} đã ngừng sử dụng`);
    if (!item) return bad('item_code', `Không có vật tư hàng hóa ${r.itemCode}`);
    if (!item.is_active) return bad('item_code', `Vật tư hàng hóa ${r.itemCode} đã ngừng sử dụng`);
    if (item.kind === 'service') return bad('item_code', `${r.itemCode} là dịch vụ, không có tồn kho`);
    const u = r.uomCode ? uoms.find((x) => x.item_id === item.id && x.code === r.uomCode) : uoms.find((x) => x.item_id === item.id && x.uom_id === item.base_uom_id);
    if (!u) return bad('uom_code', `Hàng ${r.itemCode} không có đơn vị tính ${r.uomCode}`);
    const lot = r.lotNo?.trim() ?? '';
    if (item.tracking !== 'none' && !lot) return bad('lot_no', `Hàng ${r.itemCode} theo dõi theo lô, phải nhập số lô`);
    if (item.tracking === 'lot_expiry' && !r.expiryDate) return bad('expiry_date', `Hàng ${r.itemCode} theo dõi hạn dùng, phải nhập hạn dùng`);
    if (item.tracking === 'none' && (lot || r.expiryDate)) return bad(lot ? 'lot_no' : 'expiry_date', `Hàng ${r.itemCode} không theo dõi lô, hạn dùng`);
    const key = `${wh.id}|${item.id}|${lot}`;
    if (seen.has(key)) return bad('item_code', `Trùng hàng, kho, lô với dòng ${seen.get(key)! + 1}`);
    seen.set(key, index);
    return { item_id: item.id, warehouse_id: wh.id, lot_no: lot, expiry_date: r.expiryDate ?? null, quantity: toBaseQty(r.quantity, String(u.factor)), value: r.value };
  });
  return { rows: out.flatMap((x) => (x ? [x] : [])), problems };
}

const firstProblem = (p: Problem) => new AppError('OPENING_STOCK_INVALID', `Dòng ${p.index + 1}: ${p.message}`, 400);

// Thay toàn bộ tồn đầu kỳ của năm; trả số dòng đã ghi.
export async function replaceOpeningStock(trx: Trx, tenantId: string, year: number, rows: StockRow[]): Promise<number> {
  await openingPeriod(trx, year);
  const { rows: values, problems } = await resolve(trx, rows);
  if (problems.length) throw firstProblem(problems[0]!);
  await trx.deleteFrom('opening_stock').where('fiscal_year', '=', year).execute();
  for (let i = 0; i < values.length; i += 1000) await trx.insertInto('opening_stock').values(values.slice(i, i + 1000).map((v) => ({ ...v, tenant_id: tenantId, fiscal_year: year }))).execute();
  return values.length;
}

export async function listOpeningStock(trx: Trx, year: number, withValue: boolean) {
  const rs = await trx.selectFrom('opening_stock as s').innerJoin('item as i', 'i.id', 's.item_id').innerJoin('warehouse as w', 'w.id', 's.warehouse_id').innerJoin('uom as u', 'u.id', 'i.base_uom_id')
    .select(['s.id', 'w.code as wh', 'w.name as whName', 'i.code as item', 'i.name as itemName', 'u.code as uom', 's.quantity', 's.value', 's.lot_no', 's.expiry_date'])
    .where('s.fiscal_year', '=', year).orderBy('w.code').orderBy('i.code').orderBy('s.lot_no').execute();
  return rs.map((r) => ({ id: r.id, warehouseCode: r.wh, warehouseName: r.whName, itemCode: r.item, itemName: r.itemName, uomCode: r.uom, quantity: r.quantity, value: withValue ? r.value : null, lotNo: r.lot_no, expiryDate: r.expiry_date }));
}

// Hàng–kho–lô kèm tài khoản kho (kho, rồi hàng, rồi 156) theo mã.
export async function stockGroups(trx: Trx, year: number) {
  const rs = await trx.selectFrom('opening_stock as s').innerJoin('item as i', 'i.id', 's.item_id').innerJoin('warehouse as w', 'w.id', 's.warehouse_id')
    .leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').leftJoin('account as ia', 'ia.id', 'i.inventory_account_id')
    .select(['s.item_id', 's.warehouse_id', 's.lot_no', 's.expiry_date', 's.quantity', 's.value', 'i.base_uom_id', 'i.code as itemCode', 'w.code as whCode', sql<string>`coalesce(wa.code, ia.code, '156')`.as('accountCode')])
    .where('s.fiscal_year', '=', year).orderBy('w.code').orderBy('i.code').orderBy('s.lot_no').execute();
  return rs;
}
export type StockGroup = Awaited<ReturnType<typeof stockGroups>>[number];

// Số dư từng tài khoản kho ở opening_balance phải bằng Σ giá trị tồn đầu kỳ của tài khoản đó (tài khoản kho theo kho, rồi hàng).
export function stockIssues(book: { accountCode: string; subledger_kind: string | null; debit: string; credit: string }[], groups: StockGroup[]): OpeningIssue[] {
  const stock = new Map<string, ReturnType<typeof D>>(); const bal = new Map<string, ReturnType<typeof D>>();
  for (const g of groups) stock.set(g.accountCode, (stock.get(g.accountCode) ?? D(0)).plus(g.value));
  for (const b of book) if (b.subledger_kind === 'inventory' || stock.has(b.accountCode)) bal.set(b.accountCode, (bal.get(b.accountCode) ?? D(0)).plus(b.debit).minus(b.credit));
  return [...new Set([...stock.keys(), ...bal.keys()])].sort().flatMap((code) => {
    const s = stock.get(code) ?? D(0); const b = bal.get(code) ?? D(0);
    return s.equals(b) ? [] : [{ code: 'OPENING_STOCK_MISMATCH' as const, accountCode: code,
      message: `Tài khoản ${code}: số dư đầu kỳ ${formatVnNumber(b.toString())} khác tổng tồn kho đầu kỳ ${formatVnNumber(s.toString())} (chênh lệch ${formatVnNumber(b.minus(s).toString())})` }];
  });
}

// ===== Excel =====
const COLS = [['warehouseCode', 'Mã kho (*)'], ['itemCode', 'Mã hàng (*)'], ['uomCode', 'ĐVT'], ['quantity', 'Số lượng (*)'], ['value', 'Giá trị'], ['lotNo', 'Số lô'], ['expiryDate', 'Hạn dùng']] as const;
const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const normHeader = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

export async function openingStockTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu');
  ws.addRow(COLS.map((c) => c[1])); ws.addRow(COLS.map((c) => snake(c[0]))); ws.getRow(2).hidden = true; ws.addRow(['VI_DU', '', '', 0, 0, '', '']);
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 20; });
  for (const i of [1, 2, 3, 6]) ws.getColumn(i).numFmt = '@'; ws.getColumn(7).numFmt = 'dd/mm/yyyy';
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow(['Mỗi dòng một hàng tại một kho (và một số lô với hàng theo dõi lô). Số lượng tính theo cột ĐVT (để trống là ĐVT cơ sở); Giá trị là tổng tiền VND của dòng.']);
  hd.addRow(['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ (VI_DU): bị bỏ qua. Hàng theo dõi hạn dùng phải có Hạn dùng (dd/mm/yyyy).']);
  hd.addRow(['Nhập Excel thay thế toàn bộ tồn kho đầu kỳ đã nhập của năm; sau đó cần Ghi sổ số dư đầu kỳ để cập nhật chứng từ DK.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseOpeningStockWorkbook(trx: Trx, year: number, buffer: Buffer): Promise<{ rows: StockRow[]; errors: ImportError[]; total: number }> {
  await assertZipSafe(buffer);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw new AppError('IMPORT_BAD_FILE', 'Không đọc được file Excel', 400); }
  const ws = wb.getWorksheet('Du_lieu') ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', 'Không tìm thấy sheet Du_lieu', 400);
  if (ws.rowCount > MAX_ROWS + 3) throw new AppError('IMPORT_TOO_LARGE', 'File vượt quá 20.000 dòng', 400);
  if (!COLS.every((c, i) => normHeader(txt(ws.getRow(1).getCell(i + 1))) === normHeader(c[1])))
    throw new AppError('IMPORT_BAD_HEADER', `Tiêu đề cột ở dòng 1 không đúng mẫu. Cần: ${COLS.map((c) => c[1]).join(', ')}. Hãy tải lại mẫu Excel.`, 400);
  await openingPeriod(trx, year);
  const rows: StockRow[] = []; const sheetRow: number[] = []; const errors: ImportError[] = []; let total = 0;
  ws.eachRow((row, i) => {
    if (i <= 2 || (i === 3 && txt(row.getCell(1)) === 'VI_DU')) return;
    if (COLS.every((_, k) => txt(row.getCell(k + 1)) === '')) return;
    total++;
    const q = num(row.getCell(4)); const v = num(row.getCell(5)); const ex = day(row.getCell(7));
    if (q === null) { errors.push({ row: i, column: 'quantity', message: 'Số không hợp lệ' }); return; }
    if (v === null) { errors.push({ row: i, column: 'value', message: 'Số không hợp lệ' }); return; }
    if (ex === undefined) { errors.push({ row: i, column: 'expiry_date', message: 'Ngày không hợp lệ' }); return; }
    const parsed = stockRow.safeParse({ warehouseCode: txt(row.getCell(1)), itemCode: txt(row.getCell(2)), uomCode: txt(row.getCell(3)) || null, quantity: q, value: v, lotNo: txt(row.getCell(6)) || null, expiryDate: ex });
    if (!parsed.success) { for (const is of parsed.error.issues) errors.push({ row: i, column: snake(String(is.path[0])), message: is.message }); return; }
    rows.push(parsed.data); sheetRow.push(i);
  });
  const { problems } = await resolve(trx, rows);
  for (const p of problems) errors.push({ row: sheetRow[p.index]!, column: p.column, message: p.message });
  errors.sort((a, b) => a.row - b.row);
  return { rows, errors, total };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const yearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
  const seeCost = (req: { auth: { sensitive: Set<string> } | null }) => req.auth!.sensitive.has('view_cost');
  app.get('/api/opening-stock/template.xlsx', { preHandler: app.requirePermission('opening_balance.view') }, async (_req, reply) =>
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_ton_kho_dau_ky.xlsx"').send(await openingStockTemplate()));
  // Số lượng xem được; giá trị tồn kho cần view_cost (null khi thiếu).
  app.get('/api/opening-stock/:year', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, (trx) => listOpeningStock(trx, req.params.year, seeCost(req))));
  app.put('/api/opening-stock/:year', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, body: z.object({ rows: z.array(stockRow) }) } }, async (req) => {
    assertSensitive(req.auth!, COST_AUTH);
    return { count: await app.withTenant(req, (trx) => replaceOpeningStock(trx, req.auth!.tenantId!, req.params.year, req.body.rows)) };
  });
  app.post('/api/opening-stock/:year/import', { preHandler: app.requirePermission('opening_balance.update'),
    schema: { params: yearParam, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    assertSensitive(req.auth!, COST_AUTH);
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    return app.withTenant(req, async (trx) => {
      const { rows, errors, total } = await parseOpeningStockWorkbook(trx, req.params.year, buf);
      if (!total) throw new AppError('IMPORT_EMPTY', 'Tệp không có dòng tồn kho nào', 400);
      const report = (inserted: number) => ({ total, inserted, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length });
      if (req.query.mode === 'validate' || errors.length) return report(0);
      return report(await replaceOpeningStock(trx, req.auth!.tenantId!, req.params.year, rows));
    });
  });
};
export default routes;
