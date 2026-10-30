import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Insertable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, type Decimal, formatVnDate, formatVnNumber, parseVnNumber, sum, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { excelDate, MAX_ERRORS, MAX_ROWS, plainCell, type ImportError } from '../master/importExcel.js';
import { assertZipSafe } from '../master/excelSheet.js';
import { isoDate } from '../reporting/routes.js';
import { stockGroups, stockIssues, type StockGroup } from '../inventory/openingStock.js';
import { assetIssues, openingCards, type OpeningCard } from '../assets/openingAssets.js';
import { isSalaryCode, salaryAccountIds } from '../payroll/accounts.js';
import { HEAD_OFFICE } from '../branch/scope.js';
import { notifyRecompute } from './notifyRecompute.js';
import { getVoucher, postVoucher, type VoucherDto } from './vouchers.service.js';

// Tiền VND là đồng nguyên (numeric(20,0) sẽ âm thầm làm tròn '100.5'); nguyên tệ numeric(20,4).
const vnd = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const foreign = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Nguyên tệ không âm, tối đa 4 chữ số thập phân');
export const openingRow = z.object({
  accountCode: z.string().min(1, 'Thiếu số hiệu tài khoản'), partyCode: z.string().nullable().default(null), bankAccountNo: z.string().trim().min(1).max(50).nullable().optional(), currencyCode: z.string().length(3).default('VND'),
  debit: vnd.default('0'), credit: vnd.default('0'), debitCurrency: foreign.default('0'), creditCurrency: foreign.default('0'),
  // Số dư công nợ theo từng hóa đơn: số, ngày chứng từ gốc và hạn thanh toán (chỉ tài khoản phải thu/phải trả).
  docNo: z.string().trim().min(1).max(50).nullable().optional(), docDate: isoDate.nullable().optional(), dueDate: isoDate.nullable().optional(),
  // Khế ước vay của số dư TK 341x (gốc), 335 (lãi phải trả); hợp đồng bán/mua ở TK khác (Task 13c: số dư theo hợp đồng).
  contractCode: z.string().trim().min(1).max(50).nullable().optional(),
  // Vụ việc, công trình (Task 13c): dở dang 154, công nợ... theo vụ việc; số dư 154 có vụ việc không thuộc tồn kho đầu kỳ.
  projectCode: z.string().trim().min(1).max(50).nullable().optional(),
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
  if (r.docDate && r.dueDate && r.dueDate < r.docDate) bad('dueDate', 'Hạn thanh toán trước ngày chứng từ');
});
export type OpeningRow = z.infer<typeof openingRow>;
export interface OpeningIssue {
  code: 'UNBALANCED' | 'ACCOUNT_GROUP' | 'WRONG_SIDE' | 'PARTY_REQUIRED' | 'PARTY_NOT_ALLOWED' | 'CURRENCY_NOT_TRACKED' | 'ACCOUNT_PNL' | 'ACCOUNT_INACTIVE' | 'SUBLEDGER_MODULE_REQUIRED' | 'BANK_ACCOUNT_MISSING' | 'OPENING_STOCK_MISMATCH' | 'ACCOUNT_NOT_FOUND' | 'ASSET_OPENING_MISMATCH' | 'ASSET_OPENING_INVALID';
  message: string; accountCode?: string; partyCode?: string | null;
  warning?: true; // cảnh báo: hiện khi kiểm tra nhưng không chặn ghi sổ
}
type Trx = Transaction<Database>;

// Kỳ 0 của năm: ngày ghi sổ chứng từ DK và chế độ kế toán. Mã tài khoản chỉ có nghĩa trong một chế độ (một công ty có thể giữ nhiều hệ tài khoản).
export async function openingPeriod(trx: Trx, year: number) {
  const p = await trx.selectFrom('fiscal_period').select(['date_from', 'regime']).where('fiscal_year', '=', year).where('period_no', '=', 0).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Chưa có năm tài chính ${year}`, 404);
  return p;
}

const openingRows = (trx: Trx, year: number, regime: string) =>
  trx.selectFrom('opening_balance as o').innerJoin('account as a', 'a.id', 'o.account_id').leftJoin('party as p', 'p.id', 'o.party_id')
    .leftJoin('contract as ct', 'ct.id', 'o.contract_id').leftJoin('project as pj', 'pj.id', 'o.project_id').leftJoin('bank_account as ba', 'ba.id', 'o.bank_account_id').leftJoin('bank as bk', 'bk.id', 'ba.bank_id')
    .select(['o.id', 'o.account_id', 'o.party_id', 'o.bank_account_id', 'o.currency_code', 'o.debit', 'o.credit', 'o.debit_currency', 'o.credit_currency', 'o.doc_no', 'o.doc_date', 'o.due_date', 'o.contract_id', 'ct.code as contractCode', 'ct.kind as contractKind', 'o.project_id', 'pj.code as projectCode',
      'a.code as accountCode', 'a.name as accountName', 'a.is_group', 'a.is_active', 'a.normal_balance', 'a.subledger_kind', 'a.track_currency', 'a.root_type', 'p.code as partyCode', 'p.name as partyName', 'ba.account_no as bankAccountNo', 'bk.name as bankName'])
    .where('o.fiscal_year', '=', year).where('a.regime', '=', regime).orderBy('a.code').orderBy('p.code').orderBy('ba.account_no').orderBy('o.doc_date').orderBy('o.doc_no').orderBy('o.id').execute();
type DbRow = Awaited<ReturnType<typeof openingRows>>[number];

export async function listOpening(trx: Trx, year: number): Promise<(OpeningRow & { id: number; accountName: string; partyName: string | null; bankName: string | null })[]> {
  const { regime } = await openingPeriod(trx, year);
  return (await openingRows(trx, year, regime)).map((r) => ({ id: r.id, accountCode: r.accountCode, accountName: r.accountName, partyCode: r.partyCode, partyName: r.partyName, bankAccountNo: r.bankAccountNo, bankName: r.bankName,
    currencyCode: r.currency_code, debit: r.debit, credit: r.credit, debitCurrency: r.debit_currency, creditCurrency: r.credit_currency, docNo: r.doc_no, docDate: r.doc_date, dueDate: r.due_date, contractCode: r.contractCode, projectCode: r.projectCode }));
}

// 1000 dòng × 15 cột < 65535 tham số bind của PostgreSQL.
const chunks = <T>(xs: T[], n = 1000): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const isZeroRow = (r: OpeningRow) => [r.debit, r.credit, r.debitCurrency, r.creditCurrency].every((x) => D(x).isZero());
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
const notFound = (what: string, code: string) => new AppError('LOOKUP_NOT_FOUND', `Không có ${what} ${code}`, 404);

// Tài khoản ngân hàng của dòng phải có thật, dòng phải thuộc tài khoản tiền gửi (subledger_kind = 'bank') và cùng tài khoản sổ cái với tài khoản ngân hàng (như chứng từ).
function bankProblem(r: OpeningRow, account: { subledger_kind: string | null }, bank: { gl_account_code: string } | undefined): AppError | null {
  if (!r.bankAccountNo) return null;
  if (!bank) return new AppError('BANK_ACCOUNT_NOT_FOUND', `Không có tài khoản ngân hàng số "${r.bankAccountNo}"`, 404);
  if (account.subledger_kind !== 'bank') return new AppError('BANK_ACCOUNT_NOT_ALLOWED', `Tài khoản ${r.accountCode} không phải tài khoản tiền gửi ngân hàng, không gán được tài khoản ngân hàng ${r.bankAccountNo}`, 400);
  if (bank.gl_account_code !== r.accountCode) return new AppError('BANK_ACCOUNT_GL_MISMATCH', `Tài khoản ngân hàng ${r.bankAccountNo} thuộc TK ${bank.gl_account_code}, không thuộc TK ${r.accountCode}`, 400);
  return null;
}
// Số, ngày chứng từ và hạn thanh toán chỉ có nghĩa với số dư công nợ (theo từng hóa đơn); ngày chứng từ không sau ngày của chứng từ số dư (DK).
const isArap = (account: { subledger_kind: string | null }) => account.subledger_kind === 'receivable' || account.subledger_kind === 'payable';
const DOC_FIELDS = [['docNo', 'doc_no'], ['docDate', 'doc_date'], ['dueDate', 'due_date']] as const;
function docProblem(r: OpeningRow, account: { subledger_kind: string | null }, dkDate: string): { column: string; error: AppError } | null {
  const given = DOC_FIELDS.find(([k]) => r[k]);
  if (given && !isArap(account)) return { column: given[1], error: new AppError('OPENING_DOC_NOT_ALLOWED', `Tài khoản ${r.accountCode} không theo dõi công nợ: không nhập số chứng từ, ngày chứng từ, hạn thanh toán`, 400) };
  if (r.docDate && r.docDate > dkDate) return { column: 'doc_date', error: new AppError('OPENING_DOC_DATE_AFTER', `Ngày chứng từ ${formatVnDate(r.docDate)} sau ngày số dư đầu kỳ ${formatVnDate(dkDate)}`, 400) };
  return null;
}
// Số dư TK vay (341x) và lãi phải trả (335) chỉ gắn khế ước vay, khế ước vay chỉ gắn hai TK đó; hợp đồng bán/mua gắn TK khác (131, 331, 154...).
function contractProblem(r: OpeningRow, contract: { kind: string } | null): AppError | null {
  if (!r.contractCode || !contract) return null;
  const loanAcc = r.accountCode.startsWith('341') || r.accountCode.startsWith('335');
  if (contract.kind === 'loan' && !loanAcc) return new AppError('OPENING_CONTRACT_NOT_ALLOWED', `Tài khoản ${r.accountCode} không theo dõi theo khế ước vay (chỉ 341x, 335)`, 400);
  if (contract.kind !== 'loan' && loanAcc) return new AppError('OPENING_CONTRACT_NOT_ALLOWED', `${r.contractCode} không phải khế ước vay`, 400);
  return null;
}
const banksOf = async (trx: Trx, nos: string[]) =>
  new Map((nos.length ? await trx.selectFrom('bank_account').select(['id', 'account_no', 'gl_account_code']).where('account_no', 'in', nos).execute() : []).map((b) => [b.account_no, b]));

// Thay toàn bộ số dư của năm. Dòng toàn số 0 bị bỏ qua; trả số dòng đã ghi.
export async function replaceOpening(trx: Trx, tenantId: string, year: number, rows: OpeningRow[]): Promise<number> {
  const { regime, date_from: dkDate } = await openingPeriod(trx, year);
  const live = rows.filter((r) => !isZeroRow(r));
  const accCodes = uniq(live.map((r) => r.accountCode)); const partyCodes = uniq(live.map((r) => r.partyCode)); const curCodes = uniq(live.map((r) => r.currencyCode));
  const accounts = new Map((accCodes.length ? await trx.selectFrom('account').select(['id', 'code', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', accCodes).execute() : []).map((a) => [a.code, a]));
  const parties = new Map((partyCodes.length ? await trx.selectFrom('party').select(['id', 'code']).where('code', 'in', partyCodes).execute() : []).map((p) => [p.code, p.id]));
  const currencies = new Set((curCodes.length ? await trx.selectFrom('currency').select('code').where('code', 'in', curCodes).execute() : []).map((c) => c.code));
  const banks = await banksOf(trx, uniq(live.map((r) => r.bankAccountNo ?? null)));
  const contractCodes = uniq(live.map((r) => r.contractCode ?? null));
  const contracts = new Map((contractCodes.length ? await trx.selectFrom('contract').select(['id', 'code', 'kind']).where('code', 'in', contractCodes).execute() : []).map((c) => [c.code, c]));
  const projectCodes = uniq(live.map((r) => r.projectCode ?? null));
  const projects = new Map((projectCodes.length ? await trx.selectFrom('project').select(['id', 'code']).where('code', 'in', projectCodes).execute() : []).map((p) => [p.code, p.id]));
  const values = live.map((r) => {
    const account = accounts.get(r.accountCode); if (!account) throw notFound('tài khoản', r.accountCode);
    const party_id = r.partyCode ? parties.get(r.partyCode) : null; if (party_id === undefined) throw notFound('đối tượng', r.partyCode!);
    if (!currencies.has(r.currencyCode)) throw notFound('loại tiền', r.currencyCode);
    const bank = r.bankAccountNo ? banks.get(r.bankAccountNo) : undefined; const bad = bankProblem(r, account, bank); if (bad) throw bad;
    const doc = docProblem(r, account, dkDate); if (doc) throw doc.error;
    const contract = r.contractCode ? contracts.get(r.contractCode) : null; if (contract === undefined) throw notFound('hợp đồng, khế ước', r.contractCode!);
    const project_id = r.projectCode ? projects.get(r.projectCode) : null; if (project_id === undefined) throw notFound('vụ việc', r.projectCode!);
    const cbad = contractProblem(r, contract ?? null); if (cbad) throw cbad;
    return { tenant_id: tenantId, fiscal_year: year, account_id: account.id, party_id, bank_account_id: bank?.id ?? null, currency_code: r.currencyCode, debit: r.debit, credit: r.credit, debit_currency: r.debitCurrency, credit_currency: r.creditCurrency,
      doc_no: r.docNo ?? null, doc_date: r.docDate ?? null, due_date: r.dueDate ?? null, contract_id: contract?.id ?? null, project_id };
  });
  await trx.deleteFrom('opening_balance').where('fiscal_year', '=', year).execute();
  for (const c of chunks(values)) await trx.insertInto('opening_balance').values(c).execute();
  return values.length;
}

// Tài khoản nguyên giá, hao mòn có thẻ đầu kỳ thì số dư được tách theo thẻ ở phân hệ tài sản (assetIssues), không còn bị khóa.
const cardAccounts = (cards: OpeningCard[]) => new Set(cards.flatMap((c) => [c.asset_account_code, ...(c.depreciation_account_code ? [c.depreciation_account_code] : [])]));
// Số dư TK kho (154) gắn vụ việc là dở dang theo vụ việc, ghi thẳng dòng sổ cái có vụ việc; không đối chiếu với tồn kho đầu kỳ.
const stockBook = (rows: DbRow[]) => rows.filter((r) => r.project_id === null);
function issuesOf(rows: DbRow[], covered: Set<string>): OpeningIssue[] {
  const issues: OpeningIssue[] = [];
  for (const r of rows) {
    const at = { accountCode: r.accountCode, partyCode: r.partyCode }; const code = r.accountCode;
    if (r.is_group) issues.push({ code: 'ACCOUNT_GROUP', message: `Tài khoản ${code} là tài khoản tổng hợp`, ...at });
    if (!r.is_active) issues.push({ code: 'ACCOUNT_INACTIVE', message: `Tài khoản ${code} đã ngừng sử dụng`, ...at });
    if (r.subledger_kind === 'fixed_asset' && !covered.has(code))
      issues.push({ code: 'SUBLEDGER_MODULE_REQUIRED', message: `Tài khoản ${code} theo dõi chi tiết tài sản cố định; số dư nhập ở phân hệ tài sản`, ...at });
    if (['income', 'expense'].includes(r.root_type)) issues.push({ code: 'ACCOUNT_PNL', message: `Tài khoản ${code} loại 5–9 không có số dư đầu kỳ`, ...at });
    if (r.normal_balance === 'debit' && D(r.credit).gt(0)) issues.push({ code: 'WRONG_SIDE', message: `Tài khoản ${code} chỉ có số dư Nợ`, ...at });
    if (r.normal_balance === 'credit' && D(r.debit).gt(0)) issues.push({ code: 'WRONG_SIDE', message: `Tài khoản ${code} chỉ có số dư Có`, ...at });
    const party = ['receivable', 'payable'].includes(r.subledger_kind ?? '');
    if (party && !r.partyCode) issues.push({ code: 'PARTY_REQUIRED', message: `Tài khoản ${code} phải nhập chi tiết theo đối tượng`, ...at });
    if (!party && r.partyCode) issues.push({ code: 'PARTY_NOT_ALLOWED', message: `Tài khoản ${code} không theo dõi đối tượng`, ...at });
    if (r.currency_code !== 'VND' && !r.track_currency) issues.push({ code: 'CURRENCY_NOT_TRACKED', message: `Tài khoản ${code} không theo dõi ngoại tệ`, ...at });
    if (r.subledger_kind === 'bank' && !r.bankAccountNo)
      issues.push({ code: 'BANK_ACCOUNT_MISSING', warning: true, message: `Tài khoản ${code} chưa gán tài khoản ngân hàng: sổ tiền gửi theo tài khoản ngân hàng sẽ thiếu số dư đầu`, ...at });
  }
  const d = sum(rows.map((r) => r.debit)); const c = sum(rows.map((r) => r.credit));
  if (!d.equals(c)) issues.push({ code: 'UNBALANCED', message: `Tổng dư Nợ ${formatVnNumber(d.toString())} khác tổng dư Có ${formatVnNumber(c.toString())}` });
  return issues;
}

// Tài khoản kho của dòng tồn (theo kho, hàng, hoặc 156) tra theo mã trong chế độ của năm: phải có, còn dùng và không phải tài khoản tổng hợp.
async function stockAccountIssues(trx: Trx, regime: string, groups: StockGroup[]): Promise<OpeningIssue[]> {
  const codes = [...new Set(groups.map((g) => g.accountCode))].sort(); if (!codes.length) return [];
  const found = new Map((await trx.selectFrom('account').select(['code', 'is_active', 'is_group']).where('regime', '=', regime).where('code', 'in', codes).execute()).map((a) => [a.code, a]));
  return codes.flatMap((code): OpeningIssue[] => { const a = found.get(code);
    if (!a) return [{ code: 'ACCOUNT_NOT_FOUND', accountCode: code, message: `Tài khoản kho ${code} không có trong hệ thống tài khoản ${regime} của năm này` }];
    return [...(a.is_group ? [{ code: 'ACCOUNT_GROUP' as const, accountCode: code, message: `Tài khoản ${code} là tài khoản tổng hợp` }] : []), ...(a.is_active ? [] : [{ code: 'ACCOUNT_INACTIVE' as const, accountCode: code, message: `Tài khoản ${code} đã ngừng sử dụng` }])]; });
}

export async function checkOpening(trx: Trx, year: number): Promise<OpeningIssue[]> {
  const { regime } = await openingPeriod(trx, year);
  const rows = await openingRows(trx, year, regime);
  const groups = await stockGroups(trx, year); const cards = await openingCards(trx, year);
  return [...issuesOf(rows, cardAccounts(cards)), ...stockIssues(stockBook(rows), groups), ...await stockAccountIssues(trx, regime, groups), ...assetIssues(cards, rows)];
}

// Chỉ ghi sổ số dư mới bỏ ghi sổ được chứng từ DK của chính nó: cờ app.opening_repost (xem unpost_voucher, 0015) chỉ bật quanh đúng lệnh này rồi đặt lại.
async function unpostOpeningVoucher(trx: Trx, id: string) {
  await sql`SELECT set_config('app.opening_repost', 'on', true)`.execute(trx);
  await sql`SELECT unpost_voucher(${id}::uuid)`.execute(trx);
  await sql`SELECT set_config('app.opening_repost', 'off', true)`.execute(trx);
}

// Tạo hoặc ghi lại chứng từ DK của năm: chứng từ cũ được bỏ ghi sổ rồi thay dòng, giữ nguyên số chứng từ.
// opts.branchId: chi nhánh của chứng từ DK (null = trụ sở chính); bỏ trống thì DK mới theo chi nhánh làm việc của người ghi sổ (mặc định cột), DK cũ giữ chi nhánh.
// Cả năm chỉ một DK nên toàn bộ số dư (tài khoản, công nợ, tồn kho, thẻ tài sản) thuộc một chi nhánh (QĐ 1808–1812).
export async function postOpening(trx: Trx, ctx: { tenantId: string; userId: string }, year: number, opts: { branchId?: number | null | undefined } = {}): Promise<VoucherDto> {
  const p0 = await openingPeriod(trx, year);
  // Số dư đầu kỳ chỉ nhập cho năm đầu tiên; các năm sau kết chuyển theo số dư, nhập thêm sẽ cộng đôi.
  if (await trx.selectFrom('fiscal_period').select('id').where('fiscal_year', '<', year).executeTakeFirst())
    throw new AppError('OPENING_PRIOR_YEAR_EXISTS', `Đã có năm tài chính trước năm ${year}: số dư đầu kỳ chỉ nhập cho năm đầu tiên, các năm sau tự kết chuyển`, 409);
  // Hai lần ghi sổ đồng thời đều thấy chưa có chứng từ và cùng tạo mới → hai DK, số dư cộng đôi.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opening_balance:${ctx.tenantId}:${year}`}, 0))`.execute(trx);
  const rows = await openingRows(trx, year, p0.regime);
  if (!rows.length) throw new AppError('OPENING_EMPTY', 'Chưa nhập số dư đầu kỳ nào', 409);
  const groups = await stockGroups(trx, year); const cards = await openingCards(trx, year);
  const issues = [...issuesOf(rows, cardAccounts(cards)), ...stockIssues(stockBook(rows), groups), ...await stockAccountIssues(trx, p0.regime, groups), ...assetIssues(cards, rows)].filter((i) => !i.warning);
  if (issues.length) throw new AppError('OPENING_INVALID', 'Số dư đầu kỳ chưa hợp lệ', 409, issues);
  // DK lập tay cùng năm không bị chiếm (bỏ ghi sổ + xóa dòng) và cũng không có DK thứ hai (số dư cộng đôi); chứng từ đã đảo hoặc hủy thì không tính.
  const dks = await trx.selectFrom('voucher').select(['id', 'state', 'source_doc_type', 'voucher_no', sql<number | null>`branch_id`.as('branch_id')]).where('voucher_type', '=', 'DK').where('fiscal_year', '=', year).where('reversal_of_id', 'is', null)
    .where('state', 'in', ['draft', 'posted']).execute();
  if (dks.some((v) => v.source_doc_type !== 'opening_balance')) throw new AppError('OPENING_DK_FOREIGN', 'Năm này đã có chứng từ DK lập tay; hủy hoặc đảo chứng từ đó trước', 409);
  const old = dks[0];
  let id: string;
  if (old) {
    id = old.id;
    const move = opts.branchId !== undefined && opts.branchId !== old.branch_id;
    // Đánh số theo chi nhánh: số của DK mang mã chi nhánh cũ, đổi chi nhánh sẽ lệch mã trong số. Xét cả số cấp lúc còn bật rồi tắt sau: số chứa mã chi nhánh cũ (mã trụ sở khi chưa có chi nhánh).
    if (move && old.voucher_no) {
      const setting = await trx.selectFrom('voucher_numbering_setting').select(['per_branch', 'hq_code']).executeTakeFirst();
      const oldCode = old.branch_id === null ? (setting?.hq_code ?? 'TSC')
        : (await trx.selectFrom('department').select('code').where('id', '=', old.branch_id).executeTakeFirst())?.code ?? '';
      if (setting?.per_branch || (oldCode && old.voucher_no.includes(oldCode)))
        throw new AppError('OPENING_BRANCH_NUMBERED', `Chứng từ số dư ${old.voucher_no} đã có số theo chi nhánh cũ: không đổi chi nhánh được`, 409);
    }
    if (old.state === 'posted') await unpostOpeningVoucher(trx, id);
    if (move) await sql`UPDATE voucher SET branch_id = ${opts.branchId ?? null} WHERE id = ${id}::uuid`.execute(trx);
    await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).where('posting_date', '=', p0.date_from).execute();
    await trx.deleteFrom('voucher_item_line').where('voucher_id', '=', id).execute();
  } else {
    id = (await trx.insertInto('voucher').values({ tenant_id: ctx.tenantId, voucher_type: 'DK', posting_date: p0.date_from, document_date: p0.date_from, description: `Số dư đầu kỳ năm ${year}`,
      currency_code: 'VND', source_doc_type: 'opening_balance', source_doc_id: sql<string>`md5(${`${ctx.tenantId}:opening:${year}`})::uuid`, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow()).id;
    // Cột branch_id (0240) không có trong kiểu Kysely: đặt sau khi tạo, chứng từ còn nháp (trg_voucher_branch kiểm chi nhánh có thật).
    if (opts.branchId !== undefined) await sql`UPDATE voucher SET branch_id = ${opts.branchId} WHERE id = ${id}::uuid`.execute(trx);
  }
  // Tài khoản kho: dòng sổ cái lấy từ tồn đầu kỳ (theo hàng–kho); số dư từng tài khoản đã được kiểm bằng tổng tồn.
  const stockCodes = new Set([...groups.map((g) => g.accountCode), ...stockBook(rows).filter((r) => r.subledger_kind === 'inventory').map((r) => r.accountCode)]);
  // Tài khoản có thẻ tài sản đầu kỳ: mỗi thẻ một dòng gắn asset_id (Nợ nguyên giá/giá trị còn lại, Có hao mòn), phần còn lại của số dư (chỉ 242) giữ một dòng không gắn tài sản.
  const cardLines = new Map<string, { assetId: number; code: string; debit: string; credit: string }[]>();
  for (const c of cards) {
    const put = (acc: string, debit: string, credit: string) => { if (D(debit).gt(0) || D(credit).gt(0)) cardLines.set(acc, [...(cardLines.get(acc) ?? []), { assetId: c.id, code: c.code, debit, credit }]); };
    put(c.asset_account_code, c.opening_cost ?? '0', '0'); if (c.depreciation_account_code) put(c.depreciation_account_code, '0', c.opening_accumulated ?? '0');
  }
  const base = (r: DbRow) => ({ tenant_id: ctx.tenantId, voucher_id: id, line_no: 0, account_id: r.account_id, posting_date: p0.date_from, currency_code: r.currency_code, due_date: r.due_date });
  const rowLines = (r: DbRow): Insertable<Database['voucher_line']>[] => {
    const cl = cardLines.get(r.accountCode); if (!cl) return [plainLine(r)];
    cardLines.delete(r.accountCode); // nhiều dòng cùng tài khoản: thẻ chỉ tách ở dòng đầu
    const out: Insertable<Database['voucher_line']>[] = cl.map((x) => ({ ...base(r), debit: x.debit, credit: x.credit, amount_currency: '0', party_id: null, bank_account_id: null, description: `Số dư đầu kỳ thẻ ${x.code}`, extra_dims: '{}', asset_id: x.assetId }));
    const debit = D(r.debit).minus(sum(cl.map((x) => x.debit))); const credit = D(r.credit).minus(sum(cl.map((x) => x.credit)));
    if (debit.gt(0) || credit.gt(0)) out.push({ ...plainLine(r), debit: debit.toString(), credit: credit.toString() });
    return out;
  };
  const plainLine = (r: DbRow): Insertable<Database['voucher_line']> => ({
    tenant_id: ctx.tenantId, voucher_id: id, line_no: 0, account_id: r.account_id, posting_date: p0.date_from, currency_code: r.currency_code, debit: r.debit, credit: r.credit,
    // có dấu: + Nợ, − Có (dòng VND được trigger đặt lại bằng Nợ − Có)
    amount_currency: D(r.debit_currency).minus(r.credit_currency).toString(), party_id: r.party_id, bank_account_id: r.bank_account_id,
    // số dư công nợ theo hóa đơn: fn_open_items_create lấy số/ngày chứng từ gốc từ extra_dims, hạn từ due_date của dòng
    description: r.doc_no ? `Số dư ${r.doc_no}` : 'Số dư đầu kỳ', due_date: r.due_date, contract_id: r.contract_id, project_id: r.project_id,
    extra_dims: JSON.stringify({ ...(r.doc_no ? { opening_doc_no: r.doc_no } : {}), ...(r.doc_date ? { opening_doc_date: r.doc_date } : {}) }) });
  const lines: Insertable<Database['voucher_line']>[] = rows.filter((r) => !stockCodes.has(r.accountCode) || r.project_id !== null).flatMap(rowLines);
  // Dòng kho: sổ cái gộp theo (tài khoản, hàng, kho), bỏ nhóm 0 đồng; dòng hàng chiều nhập (mỗi lô một dòng) để post_voucher sinh phát sinh kho và lớp giá ngày đầu năm.
  const sAcc = new Map((stockCodes.size ? await trx.selectFrom('account').select(['id', 'code']).where('regime', '=', p0.regime).where('code', 'in', [...stockCodes]).execute() : []).map((x) => [x.code, x.id]));
  const byKey = new Map<string, { g: StockGroup; value: Decimal }>();
  for (const g of groups) {
    if (!sAcc.has(g.accountCode)) throw notFound('tài khoản', g.accountCode);
    const k = `${g.accountCode}|${g.item_id}|${g.warehouse_id}`; byKey.set(k, { g, value: (byKey.get(k)?.value ?? D(0)).plus(g.value) });
  }
  for (const { g, value } of byKey.values()) if (!value.isZero())
    lines.push({ tenant_id: ctx.tenantId, voucher_id: id, line_no: 0, account_id: sAcc.get(g.accountCode)!, posting_date: p0.date_from, currency_code: 'VND', debit: value.toFixed(0), credit: '0', amount_currency: '0',
      party_id: null, bank_account_id: null, description: 'Tồn kho đầu kỳ', due_date: null, extra_dims: '{}', item_id: g.item_id, warehouse_id: g.warehouse_id });
  lines.forEach((l, i) => { l.line_no = i + 1; });
  for (const c of chunks(lines)) await trx.insertInto('voucher_line').values(c).execute();
  const itemLines = groups.map((g, i) => ({ tenant_id: ctx.tenantId, voucher_id: id, line_no: i + 1, item_id: g.item_id, uom_id: g.base_uom_id, quantity: g.quantity, uom_factor: '1', base_quantity: g.quantity, amount_currency: g.value, amount: g.value,
    account_id: sAcc.get(g.accountCode)!, debit_account_id: sAcc.get(g.accountCode)!, warehouse_id: g.warehouse_id, direction: 'in', lot_no: g.lot_no || null, expiry_date: g.expiry_date }));
  for (const c of chunks(itemLines)) await trx.insertInto('voucher_item_line').values(c).execute();
  return postVoucher(trx, id);
}

// Bỏ ghi sổ chứng từ DK của năm từ màn hình Số dư đầu kỳ: chứng từ về nháp, số dư nhập vẫn giữ để sửa rồi ghi sổ lại.
export async function unpostOpening(trx: Trx, tenantId: string, year: number): Promise<VoucherDto> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opening_balance:${tenantId}:${year}`}, 0))`.execute(trx);
  const dk = await trx.selectFrom('voucher').select('id').where('voucher_type', '=', 'DK').where('fiscal_year', '=', year).where('source_doc_type', '=', 'opening_balance')
    .where('reversal_of_id', 'is', null).where('state', '=', 'posted').executeTakeFirst();
  if (!dk) throw new AppError('OPENING_NOT_POSTED', `Năm ${year} chưa có chứng từ số dư đầu kỳ đã ghi sổ`, 409);
  // Khoản công nợ đầu kỳ của DK đã đối trừ thì unpost_voucher từ chối 409 OPEN_ITEM_SETTLED (ghi sổ lại số dư bỏ ghi sổ DK cũ bằng cùng hàm nên cũng bị chặn).
  await unpostOpeningVoucher(trx, dk.id);
  return getVoucher(trx, dk.id);
}

// ===== Excel =====
const COLS = [['accountCode', 'Số hiệu TK (*)'], ['partyCode', 'Mã đối tượng'], ['bankAccountNo', 'Tài khoản ngân hàng'], ['docNo', 'Số chứng từ'], ['docDate', 'Ngày chứng từ'], ['dueDate', 'Hạn thanh toán'],
  ['currencyCode', 'Loại tiền (*)'], ['debit', 'Dư Nợ'], ['credit', 'Dư Có'], ['debitCurrency', 'Dư Nợ nguyên tệ'], ['creditCurrency', 'Dư Có nguyên tệ'], ['contractCode', 'Khế ước vay']] as const;
type ColKey = (typeof COLS)[number][0];
// Ba bố cục nhận được: mẫu hiện hành; mẫu trước (chưa có cột chứng từ của số dư công nợ theo hóa đơn); mẫu cũ (chưa có cả cột Tài khoản ngân hàng).
const NEW_KEYS: ColKey[] = COLS.map((c) => c[0]);
const NOCONTRACT_KEYS = NEW_KEYS.filter((k) => k !== 'contractCode');
const BANK_KEYS = NOCONTRACT_KEYS.filter((k) => !['docNo', 'docDate', 'dueDate'].includes(k)); const OLD_KEYS = BANK_KEYS.filter((k) => k !== 'bankAccountNo');
const normHeader = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

export async function openingTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu');
  ws.addRow(COLS.map((c) => c[1])); ws.addRow(COLS.map((c) => snake(c[0]))); ws.getRow(2).hidden = true; ws.addRow(['VI_DU', '', '', '', '', '', 'VND', 0, 0, 0, 0, '']);
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 22; });
  for (const i of [1, 2, 3, 4, 7, 12]) ws.getColumn(i).numFmt = '@'; // cột chữ định dạng văn bản để Excel giữ số 0 đầu của mã
  for (const i of [5, 6]) ws.getColumn(i).numFmt = 'dd/mm/yyyy';
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow(['Mỗi dòng một tài khoản chi tiết (và một đối tượng với tài khoản công nợ, một tài khoản ngân hàng với tài khoản tiền gửi ngân hàng: nhập số tài khoản đã khai trong danh mục Tài khoản ngân hàng). Chỉ nhập một bên Nợ hoặc Có. Tổng dư Nợ phải bằng tổng dư Có.']);
  hd.addRow(['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ (VI_DU): bị bỏ qua, có thể xóa hoặc để nguyên; nhập dữ liệu ngay bên dưới.']);
  hd.addRow(['Số dư công nợ (131, 331...) nhập theo từng hóa đơn: mỗi hóa đơn một dòng với Số chứng từ, Ngày chứng từ, Hạn thanh toán (ngày dạng dd/mm/yyyy). Các cột này để trống ở tài khoản khác.']);
  hd.addRow(['Số dư vay (TK 341x) và lãi phải trả (335) nhập theo khế ước vay: ghi mã khế ước ở cột Khế ước vay (khai khế ước ở màn hình Khế ước vay trước).']);
  hd.addRow(['Số tiền VND là số nguyên đồng; dư nguyên tệ nhập ở cột nguyên tệ (tối đa 4 số lẻ) cùng bên Nợ/Có với số VND. Số nhập dạng 1.500.000 hoặc 1.500.000,25.']);
  hd.addRow(['Nhập Excel thay thế toàn bộ số dư đầu kỳ đã nhập của năm; sau đó cần Ghi sổ số dư đầu kỳ để cập nhật chứng từ DK.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Ô số → chuỗi thập phân (String giữ nguyên 1000.25, không qua dấu chấm nghìn); ô chữ chỉ nhận định dạng Việt Nam chặt (1.500.000 hoặc 1.500.000,25); ô trống là 0; ô khác là lỗi (null).
export function num(cell: ExcelJS.Cell): string | null {
  const v = plainCell(cell.value);
  if (v === null || v === undefined) return '0';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim() === '' ? '0' : parseVnNumber(v);
  return null;
}
export const txt = (cell: ExcelJS.Cell) => { const v = plainCell(cell.value); return v === null || v === undefined ? '' : String(v).trim(); };
// Ô ngày: trống là null, sai là undefined (lỗi).
export const day = (cell: ExcelJS.Cell): string | null | undefined => { const v = plainCell(cell.value); return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? null : excelDate(v) ?? undefined; };

export async function parseOpeningWorkbook(trx: Trx, year: number, buffer: Buffer): Promise<{ rows: OpeningRow[]; errors: ImportError[] }> {
  await assertZipSafe(buffer);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw new AppError('IMPORT_BAD_FILE', 'Không đọc được file Excel', 400); }
  const ws = wb.getWorksheet('Du_lieu') ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', 'Không tìm thấy sheet Du_lieu', 400);
  if (ws.rowCount > MAX_ROWS + 3) throw new AppError('IMPORT_TOO_LARGE', 'File vượt quá 20.000 dòng', 400);
  // Bố cục cột nhận biết bằng tiêu đề dòng 1, phải khớp đúng một trong ba mẫu (mẫu trước, mẫu cũ thì các cột sau dịch sang trái); tiêu đề lạ thì từ chối, không đoán, kẻo đọc lệch cột Nợ/Có.
  const headerIs = (keys: ColKey[]) => keys.every((k, i) => normHeader(txt(ws.getRow(1).getCell(i + 1))) === normHeader(COLS.find((c) => c[0] === k)![1]));
  const cols = [NEW_KEYS, NOCONTRACT_KEYS, BANK_KEYS, OLD_KEYS].find(headerIs);
  if (!cols) throw new AppError('IMPORT_BAD_HEADER', `Tiêu đề cột ở dòng 1 không đúng mẫu. Cần: ${COLS.map((c) => c[1]).join(', ')} (hoặc mẫu trước chưa có ba cột Số chứng từ, Ngày chứng từ, Hạn thanh toán; mẫu cũ chưa có cả cột Tài khoản ngân hàng). Hãy tải lại mẫu Excel.`, 400);
  const { regime, date_from: dkDate } = await openingPeriod(trx, year);
  const accounts = new Map((await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).execute()).map((a) => [a.code, a]));
  const banks = new Map((await trx.selectFrom('bank_account').select(['account_no', 'gl_account_code']).execute()).map((b) => [b.account_no, b]));
  const parties = new Set((await trx.selectFrom('party').select('code').execute()).map((p) => p.code));
  const contracts = new Map((await trx.selectFrom('contract').select(['code', 'kind']).execute()).map((c) => [c.code, c]));
  const currencies = new Set((await trx.selectFrom('currency').select('code').execute()).map((c) => c.code));
  const rows: OpeningRow[] = []; const errors: ImportError[] = []; const seen = new Map<string, number>();
  const cell = (row: ExcelJS.Row, key: ColKey) => row.getCell(cols.indexOf(key) + 1);
  ws.eachRow((row, i) => {
    if (i <= 2 || (i === 3 && txt(row.getCell(1)) === 'VI_DU')) return; // dòng 1 nhãn, dòng 2 khóa kỹ thuật (ẩn), dòng 3 ví dụ nếu còn
    if (cols.every((_, k) => txt(row.getCell(k + 1)) === '')) return;
    const amounts = ['debit', 'credit', 'debitCurrency', 'creditCurrency'] as const;
    const n = amounts.map((k) => num(cell(row, k)));
    const badNum = n.flatMap((v, k) => (v === null ? [amounts[k]!] : []));
    if (badNum.length) { for (const k of badNum) errors.push({ row: i, column: snake(k), message: 'Số không hợp lệ' }); return; }
    const has = (k: ColKey) => cols.includes(k);
    const dates = (['docDate', 'dueDate'] as const).map((k) => (has(k) ? day(cell(row, k)) : null));
    const badDate = dates.flatMap((v, k) => (v === undefined ? [k ? 'due_date' : 'doc_date'] : []));
    if (badDate.length) { for (const column of badDate) errors.push({ row: i, column, message: 'Ngày không hợp lệ' }); return; }
    const parsed = openingRow.safeParse({ accountCode: txt(cell(row, 'accountCode')), partyCode: txt(cell(row, 'partyCode')) || null, bankAccountNo: has('bankAccountNo') ? txt(cell(row, 'bankAccountNo')) || null : null,
      docNo: has('docNo') ? txt(cell(row, 'docNo')) || null : null, docDate: dates[0], dueDate: dates[1], contractCode: has('contractCode') ? txt(cell(row, 'contractCode')) || null : null,
      currencyCode: (txt(cell(row, 'currencyCode')) || 'VND').toUpperCase(), debit: n[0], credit: n[1], debitCurrency: n[2], creditCurrency: n[3] });
    if (!parsed.success) { for (const is of parsed.error.issues) errors.push({ row: i, column: snake(String(is.path[0])), message: is.message }); return; }
    const r = parsed.data;
    const fail = (column: string, message: string) => { errors.push({ row: i, column, message }); };
    const account = accounts.get(r.accountCode);
    if (!account) return fail('account_code', `Không có tài khoản ${r.accountCode} (hệ ${regime})`);
    if (r.partyCode && !parties.has(r.partyCode)) return fail('party_code', `Không có đối tượng ${r.partyCode}`);
    const bad = bankProblem(r, account, banks.get(r.bankAccountNo ?? ''));
    if (bad) return fail('bank_account_no', bad.message);
    const doc = docProblem(r, account, dkDate);
    if (doc) return fail(doc.column, doc.error.message);
    if (r.contractCode && !contracts.has(r.contractCode)) return fail('contract_code', `Không có khế ước ${r.contractCode}`);
    const cbad = contractProblem(r, r.contractCode ? contracts.get(r.contractCode) ?? null : null);
    if (cbad) return fail('contract_code', cbad.message);
    if (!currencies.has(r.currencyCode)) return fail('currency_code', `Không có loại tiền ${r.currencyCode}`);
    const key = `${r.accountCode}|${r.partyCode ?? ''}|${r.bankAccountNo ?? ''}|${r.currencyCode}|${r.docNo ?? ''}|${r.contractCode ?? ''}`;
    if (seen.has(key)) return fail('account_code', `Trùng với dòng ${seen.get(key)}`);
    seen.set(key, i); rows.push(r);
  });
  return { rows, errors };
}

// Số dư tài khoản kho là giá trị tồn kho: người thiếu view_cost không xem hay sửa được khi năm đó có số dư kho (hoặc dòng đang nhập thuộc tài khoản kho).
async function guardInventory(trx: Trx, auth: { sensitive: Set<string> }, year: number, codes: string[] = []) {
  if (auth.sensitive.has('view_cost')) return;
  const { regime } = await openingPeriod(trx, year);
  const book = await trx.selectFrom('opening_balance as o').innerJoin('account as a', 'a.id', 'o.account_id').select('o.id').where('o.fiscal_year', '=', year).where('a.subledger_kind', '=', 'inventory').limit(1).executeTakeFirst();
  const stock = book ?? await trx.selectFrom('opening_stock').select('id').where('fiscal_year', '=', year).limit(1).executeTakeFirst();
  const incoming = stock || !codes.length ? stock : await trx.selectFrom('account').select('id').where('regime', '=', regime).where('subledger_kind', '=', 'inventory').where('code', 'in', codes).limit(1).executeTakeFirst();
  if (incoming) throw new AppError('FORBIDDEN', 'Cần cờ xem giá vốn (view_cost) để xem hoặc sửa số dư tài khoản kho và tồn kho đầu kỳ', 403);
}

// Số dư đầu kỳ của tài khoản lương (334 theo nhân viên, BHXH, BHYT, BHTN, KPCĐ, TNCN theo ánh xạ payrollAccounts) là số lương: thiếu view_salary không xem hay sửa được khi năm đó có số dư loại này
// (hoặc dòng đang nhập thuộc tài khoản lương). Không che từng dòng vì lưu số dư thay cả bộ dòng: bản che sẽ ghi đè số lương bằng 0.
async function guardSalary(trx: Trx, auth: { sensitive: Set<string> }, year: number, codes: string[] = []) {
  if (auth.sensitive.has('view_salary')) return;
  const { regime } = await openingPeriod(trx, year);
  const ids = await salaryAccountIds(trx);
  const book = ids.length ? await trx.selectFrom('opening_balance').select('id').where('fiscal_year', '=', year).where('account_id', 'in', ids).limit(1).executeTakeFirst() : undefined;
  if (book || codes.some((c) => isSalaryCode(regime, c))) throw new AppError('SALARY_FORBIDDEN', 'Cần cờ xem lương (view_salary) để xem hoặc sửa số dư tài khoản lương, bảo hiểm và thuế TNCN', 403);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const yearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
  app.get('/api/opening-balance/template.xlsx', { preHandler: app.requirePermission('opening_balance.view') }, async (_req, reply) =>
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_so_du_dau_ky.xlsx"').send(await openingTemplate()));
  app.get('/api/opening-balance/:year', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, async (trx) => { await guardInventory(trx, req.auth!, req.params.year); await guardSalary(trx, req.auth!, req.params.year); return listOpening(trx, req.params.year); }));
  app.put('/api/opening-balance/:year', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, body: z.object({ rows: z.array(openingRow) }) } }, async (req) =>
    ({ count: await app.withTenant(req, async (trx) => { await guardInventory(trx, req.auth!, req.params.year, req.body.rows.map((r) => r.accountCode)); await guardSalary(trx, req.auth!, req.params.year, req.body.rows.map((r) => r.accountCode)); return replaceOpening(trx, req.auth!.tenantId!, req.params.year, req.body.rows); }) }));
  // Trả cả cảnh báo (phần tử có warning: true, không chặn ghi sổ): mảng không còn phần tử lỗi mới là hợp lệ.
  app.get('/api/opening-balance/:year/check', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, async (trx) => { await guardInventory(trx, req.auth!, req.params.year); await guardSalary(trx, req.auth!, req.params.year); return checkOpening(trx, req.params.year); }));
  // Chi nhánh của chứng từ DK hiện có (null: chưa có DK).
  app.get('/api/opening-balance/:year/branch', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const dk = await trx.selectFrom('voucher').select(sql<number | null>`branch_id`.as('branch_id')).where('voucher_type', '=', 'DK').where('fiscal_year', '=', req.params.year).where('source_doc_type', '=', 'opening_balance')
        .where('reversal_of_id', 'is', null).where('state', 'in', ['draft', 'posted']).executeTakeFirst();
      return { branch: dk ? (dk.branch_id ?? 'HO') : null };
    }));
  // branch: chi nhánh của chứng từ DK ('HO' = trụ sở chính); bỏ trống như cũ. Ngoài phạm vi chi nhánh của người dùng là 403 (RLS trên voucher cũng chặn).
  app.post('/api/opening-balance/:year/post', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, body: z.object({ branch: z.union([z.literal('HO'), z.number().int().positive()]).optional() }).nullish() } }, async (req) => {
    const want = req.body?.branch; const branchId = want === undefined ? undefined : want === 'HO' ? null : want;
    const scope = req.auth!.branchScope ?? null;
    if (want !== undefined && scope !== null && !scope.includes(branchId ?? HEAD_OFFICE)) throw new AppError('BRANCH_FORBIDDEN', 'Chi nhánh ngoài phạm vi được phân quyền', 403);
    const dto = await app.withTenant(req, async (trx) => { await guardInventory(trx, req.auth!, req.params.year); await guardSalary(trx, req.auth!, req.params.year); return postOpening(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.params.year, { branchId }); });
    notifyRecompute(app, req.auth!.tenantId!);
    return dto;
  });
  // Cần cả quyền sửa số dư đầu kỳ lẫn quyền bỏ ghi sổ chứng từ.
  app.post('/api/opening-balance/:year/unpost', { preHandler: [app.requirePermission('opening_balance.update'), app.requirePermission('voucher.unpost')], schema: { params: yearParam } }, async (req) => {
    const dto = await app.withTenant(req, async (trx) => { await guardInventory(trx, req.auth!, req.params.year); await guardSalary(trx, req.auth!, req.params.year); return unpostOpening(trx, req.auth!.tenantId!, req.params.year); });
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
      await guardInventory(trx, req.auth!, req.params.year, rows.map((r) => r.accountCode));
      await guardSalary(trx, req.auth!, req.params.year, rows.map((r) => r.accountCode));
      return report(await replaceOpening(trx, req.auth!.tenantId!, req.params.year, rows));
    });
  });
};
export default routes;
