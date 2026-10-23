import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, formatVnNumber, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { assertZipSafe } from '../master/excelSheet.js';
import { MAX_ERRORS, MAX_ROWS, type ImportError } from '../master/importExcel.js';
import { day, num, openingPeriod, txt, type OpeningIssue } from '../ledger/openingBalance.js';
import { isoDate } from '../reporting/routes.js';

type Trx = Transaction<Database>;
const unitsRe = /^\d{1,12}(\.\d{1,12})?$/;

// Thẻ đầu kỳ: nguyên giá (CCDC, chi phí trả trước: giá trị còn lại trên TK 242), hao mòn lũy kế (chỉ TSCĐ), số kỳ còn lại. Loại và tài khoản lấy từ loại tài sản.
export const openingAssetRow = z.object({
  code: z.string().trim().min(1, 'Thiếu mã thẻ').max(30), name: z.string().trim().min(1, 'Thiếu tên thẻ').max(200), categoryCode: z.string().trim().min(1, 'Thiếu mã loại tài sản'),
  useDate: isoDate.nullable().optional(), depreciationStartDate: isoDate.nullable().optional(),
  openingCost: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG), openingAccumulated: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).default('0'),
  openingRemainingUnits: z.string().regex(unitsRe, 'Số tháng còn lại không hợp lệ').nullable().optional(),
});
export type OpeningAssetRow = z.infer<typeof openingAssetRow>;

const lockKey = (tenantId: string, year: number) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opening_balance:${tenantId}:${year}`}, 0))`;
const dkOf = (trx: Trx, year: number) => trx.selectFrom('voucher').select(['id', 'state']).where('voucher_type', '=', 'DK').where('fiscal_year', '=', year)
  .where('source_doc_type', '=', 'opening_balance').where('reversal_of_id', 'is', null).where('state', 'in', ['draft', 'posted']).executeTakeFirst();

/** Thẻ đầu kỳ của năm (kèm mã, loại, tài khoản) cho kiểm tra và dòng DK. */
export const openingCards = (trx: Trx, year: number) => trx.selectFrom('asset').select(['id', 'code', 'kind', 'asset_account_code', 'depreciation_account_code', 'opening_cost', 'opening_accumulated', 'opening_remaining_units', 'life_units'])
  .where('opening_year', '=', year).orderBy('code').execute();
export type OpeningCard = Awaited<ReturnType<typeof openingCards>>[number];

export async function listOpeningAssets(trx: Trx, year: number) {
  const rs = await trx.selectFrom('asset as a').leftJoin('asset_category as c', 'c.id', 'a.category_id')
    .select(['a.id', 'a.code', 'a.name', 'a.kind', 'c.code as category_code', 'a.asset_account_code', 'a.depreciation_account_code', 'a.use_date', 'a.depreciation_start_date', 'a.opening_cost', 'a.opening_accumulated', 'a.opening_remaining_units'])
    .where('a.opening_year', '=', year).orderBy('a.code').execute();
  return rs.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, categoryCode: r.category_code, assetAccountCode: r.asset_account_code, depreciationAccountCode: r.depreciation_account_code,
    useDate: r.use_date, depreciationStartDate: r.depreciation_start_date, openingCost: r.opening_cost, openingAccumulated: r.opening_accumulated, openingRemainingUnits: r.opening_remaining_units === null ? null : D(r.opening_remaining_units).toString() }));
}

// Thay toàn bộ thẻ đầu kỳ của năm. Chỉ khi chứng từ DK chưa ghi sổ (dòng chứng từ DK nháp bị xóa hết cùng thẻ cũ, ghi sổ số dư đầu kỳ dựng lại); thẻ đã có dòng sổ cái ngoài DK thì không xóa được.
export async function replaceOpeningAssets(trx: Trx, tenantId: string, year: number, rows: OpeningAssetRow[]): Promise<number> {
  const { date_from: dkDate } = await openingPeriod(trx, year);
  if (await trx.selectFrom('fiscal_period').select('id').where('fiscal_year', '<', year).executeTakeFirst())
    throw new AppError('OPENING_PRIOR_YEAR_EXISTS', `Đã có năm tài chính trước năm ${year}: thẻ tài sản đầu kỳ chỉ nhập cho năm đầu tiên, các năm sau tự kết chuyển`, 409);
  await lockKey(tenantId, year).execute(trx);
  const dk = await dkOf(trx, year);
  if (dk?.state === 'posted') throw new AppError('OPENING_POSTED', 'Số dư đầu kỳ đã ghi sổ: bỏ ghi sổ trước khi sửa thẻ tài sản đầu kỳ', 409);
  const codes = rows.map((r) => r.code);
  const dup = codes.find((c, i) => codes.indexOf(c) !== i); if (dup) throw new AppError('DUPLICATE', `Mã thẻ ${dup} bị trùng`, 409);
  const cats = new Map((await trx.selectFrom('asset_category').selectAll().execute()).map((c) => [c.code, c]));
  const values = rows.map((r) => {
    const c = cats.get(r.categoryCode); if (!c) throw new AppError('LOOKUP_NOT_FOUND', `Không có loại tài sản mã "${r.categoryCode}"`, 404);
    return { tenant_id: tenantId, code: r.code, name: r.name, kind: c.kind, category_id: c.id, asset_account_code: c.asset_account_code, depreciation_account_code: c.depreciation_account_code,
      use_date: r.useDate ?? null, depreciation_start_date: r.depreciationStartDate ?? dkDate, life_units: c.default_life_units, opening_year: year, opening_cost: r.openingCost,
      opening_accumulated: c.kind === 'fixed' ? r.openingAccumulated : '0', opening_remaining_units: r.openingRemainingUnits ?? null };
  });
  const old = (await trx.selectFrom('asset').select(['id', 'code']).where('opening_year', '=', year).execute());
  if (old.length) {
    const ids = old.map((o) => o.id);
    const dkId = dk?.id ?? null;
    const inUse = await trx.selectFrom('voucher_line').select('asset_id').where('asset_id', 'in', ids).$if(dkId !== null, (q) => q.where('voucher_id', '<>', dkId!)).limit(1).executeTakeFirst()
      ?? await trx.selectFrom('voucher_item_line').select('asset_id').where('asset_id', 'in', ids).limit(1).executeTakeFirst()
      ?? await trx.selectFrom('asset_event').select('asset_id').where('asset_id', 'in', ids).limit(1).executeTakeFirst();
    if (inUse) throw new AppError('ASSET_IN_USE', `Thẻ ${old.find((o) => o.id === inUse.asset_id)!.code} đã có bút toán hoặc biến động trên sổ cái, không thay được thẻ đầu kỳ`, 409);
    if (dkId) await trx.deleteFrom('voucher_line').where('voucher_id', '=', dkId).where('posting_date', '=', dkDate).execute(); // cả chứng từ nháp (xóa một phần dòng làm lệch Nợ/Có); ghi sổ lại sẽ dựng lại toàn bộ dòng
    await trx.deleteFrom('asset').where('id', 'in', ids).execute();
  }
  if (values.length) await trx.insertInto('asset').values(values).execute();
  return values.length;
}

const account = (code: string, what: string, card: string, bal: string) => `Tài khoản ${code}: ${what} ${card} khác số dư tài khoản ${bal}`;
/**
 * Thẻ đầu kỳ so với số dư tài khoản ở opening_balance. TSCĐ: Σ nguyên giá = số dư TK tài sản, Σ hao mòn = số dư TK 214x.
 * 242: Σ giá trị còn lại của thẻ không vượt số dư 242 (phần còn lại không thuộc thẻ giữ một dòng không gắn tài sản).
 */
export function assetIssues(cards: OpeningCard[], book: { accountCode: string; debit: string; credit: string }[]): OpeningIssue[] {
  const issues: OpeningIssue[] = [];
  const net = (code: string, side: 'debit' | 'credit') => book.filter((b) => b.accountCode === code).reduce((s, b) => s.plus(side === 'debit' ? D(b.debit).minus(b.credit) : D(b.credit).minus(b.debit)), D(0));
  const sums = new Map<string, { side: 'debit' | 'credit'; fixed: boolean; value: ReturnType<typeof D> }>();
  const add = (code: string, side: 'debit' | 'credit', fixed: boolean, v: string) => sums.set(code, { side, fixed, value: (sums.get(code)?.value ?? D(0)).plus(v) });
  for (const c of cards) {
    const cost = D(c.opening_cost ?? 0); const acc = D(c.opening_accumulated ?? 0);
    if (c.kind === 'fixed') {
      if (acc.gt(cost)) issues.push({ code: 'ASSET_OPENING_INVALID', accountCode: c.asset_account_code, message: `Thẻ ${c.code}: hao mòn lũy kế ${formatVnNumber(acc.toString())} lớn hơn nguyên giá ${formatVnNumber(cost.toString())}` });
      if (c.opening_remaining_units === null) issues.push({ code: 'ASSET_OPENING_INVALID', accountCode: c.asset_account_code, message: `Thẻ ${c.code}: thiếu số tháng còn lại` });
      add(c.asset_account_code, 'debit', true, cost.toString()); add(c.depreciation_account_code!, 'credit', true, acc.toString());
    } else {
      if (c.opening_remaining_units === null && c.life_units === null) issues.push({ code: 'ASSET_OPENING_INVALID', accountCode: c.asset_account_code, message: `Thẻ ${c.code}: thiếu số kỳ phân bổ còn lại` });
      add(c.asset_account_code, 'debit', false, cost.toString());
    }
  }
  for (const [code, s] of [...sums].sort(([a], [b]) => a.localeCompare(b))) {
    const bal = net(code, s.side);
    const bad = s.fixed ? !s.value.eq(bal) : s.value.gt(bal);
    if (bad) issues.push({ code: 'ASSET_OPENING_MISMATCH', accountCode: code, message: account(code, s.fixed ? 'tổng trên thẻ' : 'tổng giá trị còn lại trên thẻ', formatVnNumber(s.value.toString()), formatVnNumber(bal.toString())) });
  }
  return issues;
}

// ===== Excel =====
const COLS = [['code', 'Mã thẻ (*)'], ['name', 'Tên thẻ (*)'], ['categoryCode', 'Mã loại tài sản (*)'], ['useDate', 'Ngày bắt đầu sử dụng'], ['depreciationStartDate', 'Ngày bắt đầu khấu hao/phân bổ'],
  ['openingCost', 'Nguyên giá (*)'], ['openingAccumulated', 'Hao mòn lũy kế'], ['openingRemainingUnits', 'Số tháng còn lại (*)']] as const;
const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const normHeader = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const label = (k: string) => COLS.find((c) => c[0] === k)![1].replace(/ \(\*\)$/, '');

export async function openingAssetTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu');
  ws.addRow(COLS.map((c) => c[1])); ws.addRow(COLS.map((c) => snake(c[0]))); ws.getRow(2).hidden = true; ws.addRow(['VI_DU', '', '', '', '', 0, 0, 0]);
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 24; });
  for (const i of [1, 2, 3]) ws.getColumn(i).numFmt = '@'; for (const i of [4, 5]) ws.getColumn(i).numFmt = 'dd/mm/yyyy';
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow(['Mỗi dòng một thẻ tài sản cố định, công cụ dụng cụ hoặc chi phí trả trước đang dùng đầu kỳ. Mã loại tài sản lấy từ danh mục Loại tài sản (quyết định loại tài sản và tài khoản).']);
  hd.addRow(['Tài sản cố định: Nguyên giá, Hao mòn lũy kế (không lớn hơn nguyên giá), Số tháng còn lại. Công cụ dụng cụ, chi phí trả trước: Nguyên giá là giá trị còn lại đầu kỳ, Hao mòn lũy kế để trống, Số tháng còn lại là số kỳ phân bổ còn lại.']);
  hd.addRow(['Ngày bắt đầu khấu hao/phân bổ để trống là ngày đầu năm. Dòng 3 là ví dụ (VI_DU): bị bỏ qua. Tổng thẻ theo tài khoản phải khớp số dư tài khoản ở Số dư đầu kỳ.']);
  hd.addRow(['Nhập Excel thay thế toàn bộ thẻ đầu kỳ của năm; sau đó cần Ghi sổ số dư đầu kỳ để cập nhật chứng từ DK.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseOpeningAssetWorkbook(trx: Trx, year: number, buffer: Buffer): Promise<{ rows: OpeningAssetRow[]; errors: ImportError[]; total: number }> {
  await assertZipSafe(buffer);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw new AppError('IMPORT_BAD_FILE', 'Không đọc được file Excel', 400); }
  const ws = wb.getWorksheet('Du_lieu') ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', 'Không tìm thấy sheet Du_lieu', 400);
  if (ws.rowCount > MAX_ROWS + 3) throw new AppError('IMPORT_TOO_LARGE', 'File vượt quá 20.000 dòng', 400);
  if (!COLS.every((c, i) => normHeader(txt(ws.getRow(1).getCell(i + 1))) === normHeader(c[1])))
    throw new AppError('IMPORT_BAD_HEADER', `Tiêu đề cột ở dòng 1 không đúng mẫu. Cần: ${COLS.map((c) => c[1]).join(', ')}. Hãy tải lại mẫu Excel.`, 400);
  await openingPeriod(trx, year);
  const cats = new Set((await trx.selectFrom('asset_category').select('code').execute()).map((c) => c.code));
  const rows: OpeningAssetRow[] = []; const errors: ImportError[] = []; const seen = new Map<string, number>(); let total = 0;
  ws.eachRow((row, i) => {
    if (i <= 2 || (i === 3 && txt(row.getCell(1)) === 'VI_DU')) return;
    if (COLS.every((_, k) => txt(row.getCell(k + 1)) === '')) return;
    total++;
    const fail = (key: string, message: string) => { errors.push({ row: i, column: label(key), message }); };
    const cost = num(row.getCell(6)); const acc = num(row.getCell(7)); const units = num(row.getCell(8)); const d1 = day(row.getCell(4)); const d2 = day(row.getCell(5));
    if (cost === null) return fail('openingCost', 'Số không hợp lệ'); if (acc === null) return fail('openingAccumulated', 'Số không hợp lệ');
    if (units === null) return fail('openingRemainingUnits', 'Số không hợp lệ');
    if (d1 === undefined) return fail('useDate', 'Ngày không hợp lệ'); if (d2 === undefined) return fail('depreciationStartDate', 'Ngày không hợp lệ');
    if (txt(row.getCell(8)) === '') return fail('openingRemainingUnits', 'Thiếu số tháng còn lại');
    const parsed = openingAssetRow.safeParse({ code: txt(row.getCell(1)), name: txt(row.getCell(2)), categoryCode: txt(row.getCell(3)), useDate: d1, depreciationStartDate: d2, openingCost: cost, openingAccumulated: acc, openingRemainingUnits: units });
    if (!parsed.success) { for (const is of parsed.error.issues) fail(String(is.path[0]), is.message); return; }
    const r = parsed.data;
    if (!cats.has(r.categoryCode)) return fail('categoryCode', `Không có loại tài sản ${r.categoryCode}`);
    if (seen.has(r.code)) return fail('code', `Trùng với dòng ${seen.get(r.code)}`);
    seen.set(r.code, i); rows.push(r);
  });
  return { rows, errors, total };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const yearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
  app.get('/api/opening-assets/template', { preHandler: app.requirePermission('opening_balance.view') }, async (_req, reply) =>
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_tai_san_dau_ky.xlsx"').send(await openingAssetTemplate()));
  app.get('/api/opening-assets/:year', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, (trx) => listOpeningAssets(trx, req.params.year)));
  app.put('/api/opening-assets/:year', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, body: z.object({ rows: z.array(openingAssetRow) }) } }, async (req) =>
    ({ count: await app.withTenant(req, (trx) => replaceOpeningAssets(trx, req.auth!.tenantId!, req.params.year, req.body.rows)) }));
  app.post('/api/opening-assets/:year/import', { preHandler: app.requirePermission('opening_balance.update'),
    schema: { params: yearParam, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    return app.withTenant(req, async (trx) => {
      const { rows, errors, total } = await parseOpeningAssetWorkbook(trx, req.params.year, buf);
      if (!total) throw new AppError('IMPORT_EMPTY', 'Tệp không có thẻ tài sản nào', 400);
      const report = (inserted: number) => ({ total, inserted, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length });
      if (req.query.mode === 'validate' || errors.length) return report(0);
      return report(await replaceOpeningAssets(trx, req.auth!.tenantId!, req.params.year, rows));
    });
  });
};
export default routes;
