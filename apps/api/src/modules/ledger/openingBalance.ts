import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, formatVnNumber, parseVnNumber, sum } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { MAX_ERRORS, MAX_ROWS, plainCell, type ImportError } from '../master/importExcel.js';
import { notifyRecompute } from './notifyRecompute.js';
import { postVoucher, unpostVoucher, type VoucherDto } from './vouchers.service.js';

// Tiền VND là đồng nguyên (numeric(20,0) sẽ âm thầm làm tròn '100.5'); nguyên tệ numeric(20,4).
const vnd = z.string().regex(/^\d{1,20}$/, 'Số tiền VND phải là số nguyên đồng, không âm');
const foreign = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Nguyên tệ không âm, tối đa 4 chữ số thập phân');
export const openingRow = z.object({
  accountCode: z.string().min(1, 'Thiếu số hiệu tài khoản'), partyCode: z.string().nullable().default(null), currencyCode: z.string().length(3).default('VND'),
  debit: vnd.default('0'), credit: vnd.default('0'), debitCurrency: foreign.default('0'), creditCurrency: foreign.default('0'),
}).superRefine((r, ctx) => {
  // Mỗi số nhập phải vào được chứng từ: số bị bỏ qua âm thầm (sai bên, dòng VND có nguyên tệ) là mất dữ liệu.
  const [d, c, dc, cc] = [r.debit, r.credit, r.debitCurrency, r.creditCurrency].map((x) => D(x).gt(0));
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (d && c) bad('credit', 'Chỉ nhập một bên Nợ hoặc Có');
  if (dc && cc) bad('creditCurrency', 'Chỉ nhập một bên Nợ hoặc Có nguyên tệ');
  if ((dc && c) || (cc && d)) bad(dc ? 'debitCurrency' : 'creditCurrency', 'Nguyên tệ phải cùng bên Nợ/Có với số tiền VND');
  if (r.currencyCode === 'VND' && (dc || cc)) bad(dc ? 'debitCurrency' : 'creditCurrency', 'Dòng VND không có nguyên tệ');
  if (r.currencyCode !== 'VND') {
    if (!d && !c) bad('debit', 'Dòng ngoại tệ phải có số tiền VND quy đổi');
    else if ((d && !dc) || (c && !cc)) bad(d ? 'debitCurrency' : 'creditCurrency', 'Dòng ngoại tệ phải có nguyên tệ cùng bên Nợ/Có với số tiền VND');
  }
});
export type OpeningRow = z.infer<typeof openingRow>;
export interface OpeningIssue {
  code: 'UNBALANCED' | 'ACCOUNT_GROUP' | 'WRONG_SIDE' | 'PARTY_REQUIRED' | 'PARTY_NOT_ALLOWED' | 'CURRENCY_NOT_TRACKED' | 'ACCOUNT_PNL' | 'ACCOUNT_INACTIVE' | 'SUBLEDGER_MODULE_REQUIRED';
  message: string; accountCode?: string; partyCode?: string | null;
}
type Trx = Transaction<Database>;

// Kỳ 0 của năm: ngày ghi sổ chứng từ DK và chế độ kế toán. Mã tài khoản chỉ có nghĩa trong một chế độ (một công ty có thể giữ nhiều hệ tài khoản).
async function openingPeriod(trx: Trx, year: number) {
  const p = await trx.selectFrom('fiscal_period').select(['date_from', 'regime']).where('fiscal_year', '=', year).where('period_no', '=', 0).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Chưa có năm tài chính ${year}`, 404);
  return p;
}

const openingRows = (trx: Trx, year: number, regime: string) =>
  trx.selectFrom('opening_balance as o').innerJoin('account as a', 'a.id', 'o.account_id').leftJoin('party as p', 'p.id', 'o.party_id')
    .select(['o.id', 'o.account_id', 'o.party_id', 'o.currency_code', 'o.debit', 'o.credit', 'o.debit_currency', 'o.credit_currency',
      'a.code as accountCode', 'a.name as accountName', 'a.is_group', 'a.is_active', 'a.normal_balance', 'a.subledger_kind', 'a.track_currency', 'a.root_type', 'p.code as partyCode', 'p.name as partyName'])
    .where('o.fiscal_year', '=', year).where('a.regime', '=', regime).orderBy('a.code').orderBy('p.code').orderBy('o.id').execute();
type DbRow = Awaited<ReturnType<typeof openingRows>>[number];

export async function listOpening(trx: Trx, year: number): Promise<(OpeningRow & { id: number; accountName: string; partyName: string | null })[]> {
  const { regime } = await openingPeriod(trx, year);
  return (await openingRows(trx, year, regime)).map((r) => ({ id: r.id, accountCode: r.accountCode, accountName: r.accountName, partyCode: r.partyCode, partyName: r.partyName,
    currencyCode: r.currency_code, debit: r.debit, credit: r.credit, debitCurrency: r.debit_currency, creditCurrency: r.credit_currency }));
}

// 1000 dòng × 12 cột < 65535 tham số bind của PostgreSQL.
const chunks = <T>(xs: T[], n = 1000): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const isZeroRow = (r: OpeningRow) => [r.debit, r.credit, r.debitCurrency, r.creditCurrency].every((x) => D(x).isZero());
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
const notFound = (what: string, code: string) => new AppError('LOOKUP_NOT_FOUND', `Không có ${what} ${code}`, 404);

// Thay toàn bộ số dư của năm. Dòng toàn số 0 bị bỏ qua; trả số dòng đã ghi.
export async function replaceOpening(trx: Trx, tenantId: string, year: number, rows: OpeningRow[]): Promise<number> {
  const { regime } = await openingPeriod(trx, year);
  const live = rows.filter((r) => !isZeroRow(r));
  const accCodes = uniq(live.map((r) => r.accountCode)); const partyCodes = uniq(live.map((r) => r.partyCode)); const curCodes = uniq(live.map((r) => r.currencyCode));
  const accounts = new Map((accCodes.length ? await trx.selectFrom('account').select(['id', 'code']).where('regime', '=', regime).where('code', 'in', accCodes).execute() : []).map((a) => [a.code, a.id]));
  const parties = new Map((partyCodes.length ? await trx.selectFrom('party').select(['id', 'code']).where('code', 'in', partyCodes).execute() : []).map((p) => [p.code, p.id]));
  const currencies = new Set((curCodes.length ? await trx.selectFrom('currency').select('code').where('code', 'in', curCodes).execute() : []).map((c) => c.code));
  const values = live.map((r) => {
    const account_id = accounts.get(r.accountCode); if (account_id === undefined) throw notFound('tài khoản', r.accountCode);
    const party_id = r.partyCode ? parties.get(r.partyCode) : null; if (party_id === undefined) throw notFound('đối tượng', r.partyCode!);
    if (!currencies.has(r.currencyCode)) throw notFound('loại tiền', r.currencyCode);
    return { tenant_id: tenantId, fiscal_year: year, account_id, party_id, currency_code: r.currencyCode, debit: r.debit, credit: r.credit, debit_currency: r.debitCurrency, credit_currency: r.creditCurrency };
  });
  await trx.deleteFrom('opening_balance').where('fiscal_year', '=', year).execute();
  for (const c of chunks(values)) await trx.insertInto('opening_balance').values(c).execute();
  return values.length;
}

function issuesOf(rows: DbRow[]): OpeningIssue[] {
  const issues: OpeningIssue[] = [];
  for (const r of rows) {
    const at = { accountCode: r.accountCode, partyCode: r.partyCode }; const code = r.accountCode;
    if (r.is_group) issues.push({ code: 'ACCOUNT_GROUP', message: `Tài khoản ${code} là tài khoản tổng hợp`, ...at });
    if (!r.is_active) issues.push({ code: 'ACCOUNT_INACTIVE', message: `Tài khoản ${code} đã ngừng sử dụng`, ...at });
    if (['inventory', 'fixed_asset'].includes(r.subledger_kind ?? ''))
      issues.push({ code: 'SUBLEDGER_MODULE_REQUIRED', message: `Tài khoản ${code} theo dõi chi tiết vật tư/tài sản; số dư nhập ở phân hệ kho/tài sản (giai đoạn 2)`, ...at });
    if (['income', 'expense'].includes(r.root_type)) issues.push({ code: 'ACCOUNT_PNL', message: `Tài khoản ${code} loại 5–9 không có số dư đầu kỳ`, ...at });
    if (r.normal_balance === 'debit' && D(r.credit).gt(0)) issues.push({ code: 'WRONG_SIDE', message: `Tài khoản ${code} chỉ có số dư Nợ`, ...at });
    if (r.normal_balance === 'credit' && D(r.debit).gt(0)) issues.push({ code: 'WRONG_SIDE', message: `Tài khoản ${code} chỉ có số dư Có`, ...at });
    const party = ['receivable', 'payable'].includes(r.subledger_kind ?? '');
    if (party && !r.partyCode) issues.push({ code: 'PARTY_REQUIRED', message: `Tài khoản ${code} phải nhập chi tiết theo đối tượng`, ...at });
    if (!party && r.partyCode) issues.push({ code: 'PARTY_NOT_ALLOWED', message: `Tài khoản ${code} không theo dõi đối tượng`, ...at });
    if (r.currency_code !== 'VND' && !r.track_currency) issues.push({ code: 'CURRENCY_NOT_TRACKED', message: `Tài khoản ${code} không theo dõi ngoại tệ`, ...at });
  }
  const d = sum(rows.map((r) => r.debit)); const c = sum(rows.map((r) => r.credit));
  if (!d.equals(c)) issues.push({ code: 'UNBALANCED', message: `Tổng dư Nợ ${formatVnNumber(d.toString())} khác tổng dư Có ${formatVnNumber(c.toString())}` });
  return issues;
}

export async function checkOpening(trx: Trx, year: number): Promise<OpeningIssue[]> {
  const { regime } = await openingPeriod(trx, year);
  return issuesOf(await openingRows(trx, year, regime));
}

// Tạo hoặc ghi lại chứng từ DK của năm: chứng từ cũ được bỏ ghi sổ rồi thay dòng, giữ nguyên số chứng từ.
export async function postOpening(trx: Trx, ctx: { tenantId: string; userId: string }, year: number): Promise<VoucherDto> {
  const p0 = await openingPeriod(trx, year);
  // Số dư đầu kỳ chỉ nhập cho năm đầu tiên; các năm sau kết chuyển theo số dư, nhập thêm sẽ cộng đôi.
  if (await trx.selectFrom('fiscal_period').select('id').where('fiscal_year', '<', year).executeTakeFirst())
    throw new AppError('OPENING_PRIOR_YEAR_EXISTS', `Đã có năm tài chính trước năm ${year}: số dư đầu kỳ chỉ nhập cho năm đầu tiên, các năm sau tự kết chuyển`, 409);
  // Hai lần ghi sổ đồng thời đều thấy chưa có chứng từ và cùng tạo mới → hai DK, số dư cộng đôi.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opening_balance:${ctx.tenantId}:${year}`}, 0))`.execute(trx);
  const rows = await openingRows(trx, year, p0.regime);
  if (!rows.length) throw new AppError('OPENING_EMPTY', 'Chưa nhập số dư đầu kỳ nào', 409);
  const issues = issuesOf(rows);
  if (issues.length) throw new AppError('OPENING_INVALID', 'Số dư đầu kỳ chưa hợp lệ', 409, issues);
  // DK lập tay cùng năm không bị chiếm (bỏ ghi sổ + xóa dòng) và cũng không có DK thứ hai (số dư cộng đôi); chứng từ đã đảo hoặc hủy thì không tính.
  const dks = await trx.selectFrom('voucher').select(['id', 'state', 'source_doc_type']).where('voucher_type', '=', 'DK').where('fiscal_year', '=', year).where('reversal_of_id', 'is', null)
    .where('state', 'in', ['draft', 'posted']).execute();
  if (dks.some((v) => v.source_doc_type !== 'opening_balance')) throw new AppError('OPENING_DK_FOREIGN', 'Năm này đã có chứng từ DK lập tay; hủy hoặc đảo chứng từ đó trước', 409);
  const old = dks[0];
  let id: string;
  if (old) {
    id = old.id;
    if (old.state === 'posted') await unpostVoucher(trx, id);
    await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).where('posting_date', '=', p0.date_from).execute();
  } else {
    id = (await trx.insertInto('voucher').values({ tenant_id: ctx.tenantId, voucher_type: 'DK', posting_date: p0.date_from, document_date: p0.date_from, description: `Số dư đầu kỳ năm ${year}`,
      currency_code: 'VND', source_doc_type: 'opening_balance', source_doc_id: sql<string>`md5(${`${ctx.tenantId}:opening:${year}`})::uuid`, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow()).id;
  }
  const lines = rows.map((r, i) => ({
    tenant_id: ctx.tenantId, voucher_id: id, line_no: i + 1, account_id: r.account_id, posting_date: p0.date_from, currency_code: r.currency_code, debit: r.debit, credit: r.credit,
    // có dấu: + Nợ, − Có (dòng VND được trigger đặt lại bằng Nợ − Có)
    amount_currency: D(r.debit_currency).minus(r.credit_currency).toString(), party_id: r.party_id, description: 'Số dư đầu kỳ' }));
  for (const c of chunks(lines)) await trx.insertInto('voucher_line').values(c).execute();
  return postVoucher(trx, id);
}

// ===== Excel =====
const COLS = [['accountCode', 'Số hiệu TK (*)'], ['partyCode', 'Mã đối tượng'], ['currencyCode', 'Loại tiền (*)'], ['debit', 'Dư Nợ'], ['credit', 'Dư Có'],
  ['debitCurrency', 'Dư Nợ nguyên tệ'], ['creditCurrency', 'Dư Có nguyên tệ']] as const;
const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

export async function openingTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu');
  ws.addRow(COLS.map((c) => c[1])); ws.addRow(COLS.map((c) => snake(c[0]))); ws.getRow(2).hidden = true; ws.addRow(['VI_DU', '', 'VND', 0, 0, 0, 0]);
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 22; });
  for (const i of [1, 2, 3]) ws.getColumn(i).numFmt = '@'; // cột chữ định dạng văn bản để Excel giữ số 0 đầu của mã
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow(['Mỗi dòng một tài khoản chi tiết (và một đối tượng với tài khoản công nợ). Chỉ nhập một bên Nợ hoặc Có. Tổng dư Nợ phải bằng tổng dư Có.']);
  hd.addRow(['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ (VI_DU): bị bỏ qua, có thể xóa hoặc để nguyên; nhập dữ liệu ngay bên dưới.']);
  hd.addRow(['Số tiền VND là số nguyên đồng; dư nguyên tệ nhập ở cột nguyên tệ (tối đa 4 số lẻ) cùng bên Nợ/Có với số VND. Số nhập dạng 1.500.000 hoặc 1.500.000,25.']);
  hd.addRow(['Nhập Excel thay thế toàn bộ số dư đầu kỳ đã nhập của năm; sau đó cần Ghi sổ số dư đầu kỳ để cập nhật chứng từ DK.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Ô số → chuỗi thập phân (String giữ nguyên 1000.25, không qua dấu chấm nghìn); ô chữ chỉ nhận định dạng Việt Nam chặt (1.500.000 hoặc 1.500.000,25); ô trống là 0; ô khác là lỗi (null).
function num(cell: ExcelJS.Cell): string | null {
  const v = plainCell(cell.value);
  if (v === null || v === undefined) return '0';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim() === '' ? '0' : parseVnNumber(v);
  return null;
}
const txt = (cell: ExcelJS.Cell) => { const v = plainCell(cell.value); return v === null || v === undefined ? '' : String(v).trim(); };

export async function parseOpeningWorkbook(trx: Trx, year: number, buffer: Buffer): Promise<{ rows: OpeningRow[]; errors: ImportError[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw new AppError('IMPORT_BAD_FILE', 'Không đọc được file Excel', 400); }
  const ws = wb.getWorksheet('Du_lieu') ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', 'Không tìm thấy sheet Du_lieu', 400);
  if (ws.rowCount > MAX_ROWS + 3) throw new AppError('IMPORT_TOO_LARGE', 'File vượt quá 20.000 dòng', 400);
  const { regime } = await openingPeriod(trx, year);
  const accounts = new Set((await trx.selectFrom('account').select('code').where('regime', '=', regime).execute()).map((a) => a.code));
  const parties = new Set((await trx.selectFrom('party').select('code').execute()).map((p) => p.code));
  const currencies = new Set((await trx.selectFrom('currency').select('code').execute()).map((c) => c.code));
  const rows: OpeningRow[] = []; const errors: ImportError[] = []; const seen = new Map<string, number>();
  ws.eachRow((row, i) => {
    if (i <= 2 || (i === 3 && txt(row.getCell(1)) === 'VI_DU')) return; // dòng 1 nhãn, dòng 2 khóa kỹ thuật (ẩn), dòng 3 ví dụ nếu còn
    if (COLS.every((_, k) => txt(row.getCell(k + 1)) === '')) return;
    const n = [4, 5, 6, 7].map((c) => num(row.getCell(c)));
    const badNum = n.flatMap((v, k) => (v === null ? [COLS[k + 3]![0]] : []));
    if (badNum.length) { for (const k of badNum) errors.push({ row: i, column: snake(k), message: 'Số không hợp lệ' }); return; }
    const parsed = openingRow.safeParse({ accountCode: txt(row.getCell(1)), partyCode: txt(row.getCell(2)) || null, currencyCode: (txt(row.getCell(3)) || 'VND').toUpperCase(),
      debit: n[0], credit: n[1], debitCurrency: n[2], creditCurrency: n[3] });
    if (!parsed.success) { for (const is of parsed.error.issues) errors.push({ row: i, column: snake(String(is.path[0])), message: is.message }); return; }
    const r = parsed.data;
    const fail = (column: string, message: string) => { errors.push({ row: i, column, message }); };
    if (!accounts.has(r.accountCode)) return fail('account_code', `Không có tài khoản ${r.accountCode} (hệ ${regime})`);
    if (r.partyCode && !parties.has(r.partyCode)) return fail('party_code', `Không có đối tượng ${r.partyCode}`);
    if (!currencies.has(r.currencyCode)) return fail('currency_code', `Không có loại tiền ${r.currencyCode}`);
    const key = `${r.accountCode}|${r.partyCode ?? ''}|${r.currencyCode}`;
    if (seen.has(key)) return fail('account_code', `Trùng với dòng ${seen.get(key)}`);
    seen.set(key, i); rows.push(r);
  });
  return { rows, errors };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const yearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
  app.get('/api/opening-balance/template.xlsx', { preHandler: app.requirePermission('opening_balance.view') }, async (_req, reply) =>
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_so_du_dau_ky.xlsx"').send(await openingTemplate()));
  app.get('/api/opening-balance/:year', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, (trx) => listOpening(trx, req.params.year)));
  app.put('/api/opening-balance/:year', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, body: z.object({ rows: z.array(openingRow) }) } }, async (req) =>
    ({ count: await app.withTenant(req, (trx) => replaceOpening(trx, req.auth!.tenantId!, req.params.year, req.body.rows)) }));
  app.get('/api/opening-balance/:year/check', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, (trx) => checkOpening(trx, req.params.year)));
  app.post('/api/opening-balance/:year/post', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam } }, async (req) => {
    const dto = await app.withTenant(req, (trx) => postOpening(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.params.year));
    notifyRecompute(app, req.auth!.tenantId!);
    return dto;
  });
  app.post('/api/opening-balance/:year/import', { preHandler: app.requirePermission('opening_balance.update'),
    schema: { params: yearParam, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    return app.withTenant(req, async (trx) => {
      const { rows, errors } = await parseOpeningWorkbook(trx, req.params.year, buf);
      if (rows.every(isZeroRow) && !errors.length) throw new AppError('IMPORT_EMPTY', 'Tệp không có dòng số dư nào (dòng toàn số 0 không tính)', 400); // nhập tệp trống sẽ xóa sạch số dư đã lưu
      const total = rows.length + new Set(errors.map((e) => e.row)).size;
      const report = (inserted: number) => ({ total, inserted, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length });
      if (req.query.mode === 'validate' || errors.length) return report(0);
      return report(await replaceOpening(trx, req.auth!.tenantId!, req.params.year, rows));
    });
  });
};
export default routes;
