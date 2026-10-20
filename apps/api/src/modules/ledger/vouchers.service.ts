import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { CASH_PURPOSES, D, HEADER_FIELD_LABELS, sum, SYSTEM_VOUCHER_TYPES, VND_AMOUNT_MSG, VND_AMOUNT_RE, voucherTypeDef, type CashPurpose, type HeaderField, type VoucherTypeDef } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { likePattern } from '../master/crud.js';

export const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Tiền hạch toán là đồng nguyên (numeric(20,0) sẽ âm thầm làm tròn '100.5'); nguyên tệ numeric(20,4); tỷ giá numeric(20,10) và phải dương.
const vndAmount = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const foreignAmount = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/);
const fxRate = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).refine((s) => Number(s) > 0, 'Tỷ giá phải lớn hơn 0');

const optText = (max: number) => z.string().max(max).nullable().optional();
export const lineInput = z.object({
  accountCode: z.string().min(1), debit: vndAmount.default('0'), credit: vndAmount.default('0'), amountCurrency: foreignAmount.optional(), fxRate: fxRate.optional(),
  partyCode: z.string().nullable().optional(), departmentCode: z.string().nullable().optional(), projectCode: z.string().nullable().optional(),
  costItemCode: z.string().nullable().optional(), employeeCode: z.string().nullable().optional(), description: z.string().nullable().optional(),
  dueDate: dateIso.nullable().optional(), extraDims: z.record(z.string()).optional(), bankAccountNo: optText(50),
});
export const voucherInput = z.object({
  voucherType: z.string().min(1), postingDate: dateIso, documentDate: dateIso, description: z.string().nullable().optional(),
  partyCode: z.string().nullable().optional(), currencyCode: z.string().length(3).default('VND'), fxRate: fxRate.optional(), idempotencyKey: z.string().max(100).optional(),
  // Trường tiêu đề của phiếu thu, phiếu chi, giấy báo (mã tài khoản ngân hàng là bank_account.account_no; partyBankAccountNo là số tài khoản của đối tượng chính).
  personName: optText(200), personAddress: optText(200), attachmentsCount: z.number().int().min(0).max(999).nullable().optional(),
  bankAccountNo: optText(50), counterBankAccountNo: optText(50), partyBankAccountNo: optText(50), dueDate: dateIso.nullable().optional(), purpose: optText(50),
  lines: z.array(lineInput).min(1).max(5000, 'Tối đa 5.000 dòng mỗi chứng từ'), // 5.000 × 16 chữ số vẫn vừa numeric(20,0) khi cộng; insertLines chia lô nên không còn bị giới hạn tham số bind
});
export const metaInput = z.object({
  description: z.string().nullable().optional(),
  lines: z.array(lineInput.pick({ departmentCode: true, projectCode: true, costItemCode: true, employeeCode: true, description: true, dueDate: true }).extend({ lineNo: z.number().int() })).optional(),
});
export type VoucherInput = z.infer<typeof voucherInput>;
export type LineInput = z.infer<typeof lineInput>;
export type MetaInput = z.infer<typeof metaInput>;

export interface LineDto extends LineInput { lineNo: number; accountName: string; partyName: string | null }
export interface VoucherDto {
  id: string; voucherType: string; voucherNo: string | null; seqNo: number | null; postingDate: string; documentDate: string; state: string; description: string | null;
  partyCode: string | null; partyName: string | null; personName: string | null; personAddress: string | null; attachmentsCount: number | null;
  bankAccountNo: string | null; counterBankAccountNo: string | null; partyBankAccountNo: string | null; dueDate: string | null; purpose: string | null;
  // Kỳ chứa ngày ghi sổ và chứng từ đã vào chuỗi khóa cứng: giao diện đưa vào decideEdit để biết sửa kiểu gì.
  periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean;
  currencyCode: string; fxRate: string | null; isClosing: boolean; reversalOfId: string | null; reversedById: string | null;
  sourceDocType: string | null; sourceDocId: string | null; version: number; createdBy: string; createdAt: string; postedBy: string | null; postedAt: string | null; totalDebit: string; lines: LineDto[];
}
export interface VoucherListRow {
  id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; description: string | null; partyName: string | null; totalDebit: string;
}

type Trx = Transaction<Database>;
const LABEL = { account: 'tài khoản', party: 'đối tượng', department: 'bộ phận', project: 'vụ việc', cost_item: 'khoản mục chi phí', employee: 'nhân viên' } as const;
// `accounts` nhớ mã và loại sổ chi tiết của các tài khoản đã tra, để kiểm tra theo loại chứng từ không phải truy vấn lại.
type Lookup = ((table: keyof typeof LABEL, code: string | null | undefined) => Promise<number | string | null>) & { accounts: Map<number, { code: string; kind: string | null }> };

// Kỳ chứa ngày ghi sổ (chứng từ DK: kỳ 0 bắt đầu đúng ngày đó), giống fn_period_of; lấy chế độ kế toán để tra tài khoản và năm tài chính. Tra một lần cho cả chứng từ.
async function periodOf(trx: Trx, postingDate: string, voucherType: string): Promise<{ regime: string; fiscal_year: number }> {
  const q = trx.selectFrom('fiscal_period').select(['regime', 'fiscal_year']);
  const p = await (voucherType === 'DK' ? q.where('period_no', '=', 0).where('date_from', '=', postingDate)
    : q.where('period_no', '>=', 1).where('period_no', '<=', 15).where('date_from', '<=', postingDate).where('date_to', '>=', postingDate)).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${postingDate} không thuộc kỳ kế toán nào đã mở`, 404);
  return p;
}
// Tra mã sang id, nhớ kết quả trong một lần ghi. Tài khoản tra theo mã VÀ chế độ (một công ty có thể giữ nhiều hệ tài khoản, mã trùng giữa các hệ).
function lookupIn(trx: Trx, regime?: string): Lookup {
  const memo = new Map<string, number | string>();
  const accounts: Lookup['accounts'] = new Map();
  return Object.assign(async (table: keyof typeof LABEL, code: string | null | undefined) => {
    if (!code) return null;
    const key = `${table}:${code}`;
    let id = memo.get(key);
    if (id === undefined) {
      let row: { id: number | string } | undefined;
      if (table === 'account') {
        const a = await trx.selectFrom('account').select(['id', 'subledger_kind']).where('code', '=', code).where('regime', '=', regime!).executeTakeFirst();
        if (a) accounts.set(a.id, { code, kind: a.subledger_kind });
        row = a;
      } else row = await trx.selectFrom(table).select('id').where('code', '=', code).executeTakeFirst();
      if (!row) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${LABEL[table]} mã "${code}"`, 404);
      id = row.id; memo.set(key, id);
    }
    return id;
  }, { accounts });
}
async function resolveLine(lookup: Lookup, l: LineInput, currency: string, headerFxRate?: string) {
  const debit = D(l.debit); const credit = D(l.credit);
  if (debit.gt(0) && credit.gt(0)) throw new AppError('LINE_BOTH_SIDES', `Dòng ${l.accountCode}: chỉ được một bên Nợ hoặc Có`, 400);
  if (currency !== 'VND' && l.amountCurrency === undefined) throw new AppError('VALIDATION', `Dòng ${l.accountCode}: chứng từ ngoại tệ ${currency} phải có amountCurrency`, 400);
  return {
    account_id: (await lookup('account', l.accountCode)) as number, currency_code: currency, fx_rate: l.fxRate ?? (currency === 'VND' ? null : headerFxRate ?? null),
    amount_currency: currency === 'VND' ? debit.minus(credit).toString() : l.amountCurrency!,
    debit: debit.toString(), credit: credit.toString(),
    party_id: (await lookup('party', l.partyCode)) as string | null,
    department_id: (await lookup('department', l.departmentCode)) as number | null,
    project_id: (await lookup('project', l.projectCode)) as number | null,
    cost_item_id: (await lookup('cost_item', l.costItemCode)) as number | null,
    employee_id: (await lookup('employee', l.employeeCode)) as number | null,
    extra_dims: JSON.stringify(l.extraDims ?? {}), description: l.description ?? null, due_date: l.dueDate ?? null, bank_account_id: null as number | null,
  };
}
type ResolvedLine = Awaited<ReturnType<typeof resolveLine>>;

export async function getVoucher(trx: Trx, id: string): Promise<VoucherDto> {
  const v = await trx.selectFrom('voucher as v').leftJoin('party as p', 'p.id', 'v.party_id')
    .leftJoin('bank_account as ba', 'ba.id', 'v.bank_account_id').leftJoin('bank_account as cba', 'cba.id', 'v.counter_bank_account_id').leftJoin('party_bank_account as pba', 'pba.id', 'v.party_bank_account_id')
    .leftJoin('fiscal_period as fp', (j) => j.onRef('fp.tenant_id', '=', 'v.tenant_id').onRef('fp.fiscal_year', '=', 'v.fiscal_year').onRef('fp.period_no', '=', 'v.period_no'))
    .selectAll('v').select(['p.code as party_code', 'p.name as party_name', 'ba.account_no as bank_account_no', 'cba.account_no as counter_bank_account_no', 'pba.account_no as party_bank_account_no', 'fp.status as period_status'])
    .where('v.id', '=', id).executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  const lines = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id')
    .leftJoin('party as p', 'p.id', 'l.party_id').leftJoin('department as d', 'd.id', 'l.department_id').leftJoin('project as pr', 'pr.id', 'l.project_id')
    .leftJoin('cost_item as ci', 'ci.id', 'l.cost_item_id').leftJoin('employee as e', 'e.id', 'l.employee_id').leftJoin('bank_account as lb', 'lb.id', 'l.bank_account_id')
    .select(['l.line_no', 'a.code as account_code', 'a.name as account_name', 'l.debit', 'l.credit', 'l.amount_currency', 'l.fx_rate', 'p.code as party_code', 'p.name as party_name',
      'd.code as department_code', 'pr.code as project_code', 'ci.code as cost_item_code', 'e.code as employee_code', 'l.description', 'l.due_date', 'l.extra_dims', 'lb.account_no as bank_account_no'])
    .where('l.voucher_id', '=', id).where('l.posting_date', '=', v.posting_date).orderBy('l.line_no').execute(); // posting_date: chỉ quét partition của tháng chứng từ
  return {
    id: v.id, voucherType: v.voucher_type, voucherNo: v.voucher_no, seqNo: v.seq_no, postingDate: v.posting_date, documentDate: v.document_date, state: v.state, description: v.description,
    partyCode: v.party_code, partyName: v.party_name, personName: v.person_name, personAddress: v.person_address, attachmentsCount: v.attachments_count,
    bankAccountNo: v.bank_account_no, counterBankAccountNo: v.counter_bank_account_no, partyBankAccountNo: v.party_bank_account_no, dueDate: v.due_date, purpose: v.purpose,
    periodStatus: (v.period_status ?? 'open') as VoucherDto['periodStatus'], hashed: v.row_hash !== null, currencyCode: v.currency_code, fxRate: v.fx_rate, isClosing: v.is_closing, reversalOfId: v.reversal_of_id, reversedById: v.reversed_by_id,
    sourceDocType: v.source_doc_type, sourceDocId: v.source_doc_id, version: v.version, createdBy: v.created_by, createdAt: v.created_at, postedBy: v.posted_by, postedAt: v.posted_at,
    totalDebit: sum(lines.map((l) => l.debit)).toString(),
    lines: lines.map((l) => ({ lineNo: l.line_no, accountCode: l.account_code, accountName: l.account_name, debit: l.debit, credit: l.credit, amountCurrency: l.amount_currency, fxRate: l.fx_rate ?? undefined,
      partyCode: l.party_code, partyName: l.party_name, departmentCode: l.department_code, projectCode: l.project_code, costItemCode: l.cost_item_code, employeeCode: l.employee_code,
      description: l.description, dueDate: l.due_date, extraDims: l.extra_dims as Record<string, string>, bankAccountNo: l.bank_account_no })),
  };
}

async function insertLines(trx: Trx, tenantId: string, voucherId: string, postingDate: string, lines: ResolvedLine[]) {
  const rows = lines.map((r, i) => ({ tenant_id: tenantId, voucher_id: voucherId, line_no: i + 1, posting_date: postingDate, ...r }));
  for (let i = 0; i < rows.length; i += 1000) await trx.insertInto('voucher_line').values(rows.slice(i, i + 1000)).execute(); // chia lô: một câu lệnh 5.000 dòng vượt 65.535 tham số bind
}

const HEADER_VALUE: Record<HeaderField, (i: VoucherInput) => unknown> = {
  party: (i) => i.partyCode, personName: (i) => i.personName, personAddress: (i) => i.personAddress, attachmentsCount: (i) => i.attachmentsCount, bankAccount: (i) => i.bankAccountNo,
  counterBankAccount: (i) => i.counterBankAccountNo, partyBankAccount: (i) => i.partyBankAccountNo, dueDate: (i) => i.dueDate, purpose: (i) => i.purpose, currency: (i) => i.currencyCode,
};
const MONEY_LABEL = { cash: 'tiền mặt', bank: 'tiền gửi ngân hàng' } as const;

// Quy tắc theo loại chứng từ (VOUCHER_TYPES): trường bắt buộc, mục đích, dòng tiền đúng chiều, đối tượng ở dòng đối ứng. Loại không có trong VOUCHER_TYPES (loại tự thêm) không bị kiểm.
function assertTypeRules(def: VoucherTypeDef, input: VoucherInput, lines: ResolvedLine[], accounts: Lookup['accounts'], regime: string): void {
  for (const f of def.required) {
    const v = HEADER_VALUE[f](input);
    if (v === null || v === undefined || v === '') throw new AppError('VOUCHER_FIELD_REQUIRED', `${def.name}: thiếu ${HEADER_FIELD_LABELS[f]}`, 400);
  }
  const purpose = input.purpose ? CASH_PURPOSES.find((p) => p.code === input.purpose && (p.types as string[]).includes(def.code)) : undefined;
  if (input.purpose && !purpose) throw new AppError('VOUCHER_PURPOSE_INVALID', `Mục đích "${input.purpose}" không dùng cho ${def.name}`, 400);
  const kindOf = (l: ResolvedLine) => accounts.get(l.account_id)?.kind;
  if (def.cashSide && def.moneyKind) {
    const side = def.cashSide === 'in' ? 'debit' : 'credit';
    if (!lines.some((l) => D(l[side]).gt(0) && kindOf(l) === def.moneyKind))
      throw new AppError('VOUCHER_CASH_LINE_REQUIRED', `${def.name} phải có dòng ${side === 'debit' ? 'Nợ' : 'Có'} tài khoản ${MONEY_LABEL[def.moneyKind]}`, 400);
  }
  if (def.header.includes('counterBankAccount')) { // chuyển tiền nội bộ: dòng Nợ trên tài khoản ngân hàng là tài khoản nhận
    if (!input.counterBankAccountNo && lines.some((l) => D(l.debit).gt(0) && kindOf(l) === 'bank')) throw new AppError('VOUCHER_FIELD_REQUIRED', `${def.name}: thiếu ${HEADER_FIELD_LABELS.counterBankAccount}`, 400);
    if (input.bankAccountNo && input.bankAccountNo === input.counterBankAccountNo) throw new AppError('BANK_TRANSFER_SAME_ACCOUNT', `${def.name}: tài khoản chuyển đi và tài khoản nhận phải khác nhau`, 400);
  }
  if (purpose?.partyRequired) { // chỉ dòng trên tài khoản đối ứng của mục đích (ví dụ 131); dòng thuế, chênh lệch tỷ giá... không bắt buộc đối tượng
    const counter = purpose.counterAccounts[regime as keyof CashPurpose['counterAccounts']] ?? []; // TT58 không có mục đích: không dòng nào bị đòi
    const bad = lines.find((l) => (D(l.debit).gt(0) || D(l.credit).gt(0)) && counter.includes(accounts.get(l.account_id)!.code) && l.party_id === null);
    if (bad) throw new AppError('LINE_PARTY_REQUIRED', `Mục đích "${purpose.label}": dòng tài khoản ${accounts.get(bad.account_id)!.code} phải có đối tượng`, 400);
  }
}

type BankRef = { id: number; gl: string };
// Tra tài khoản ngân hàng của công ty theo số tài khoản, nhớ kết quả trong một lần ghi.
function bankLookup(trx: Trx) {
  const memo = new Map<string, BankRef>();
  return async (no: string | null | undefined): Promise<BankRef | null> => {
    if (!no) return null;
    let b = memo.get(no);
    if (!b) {
      const r = await trx.selectFrom('bank_account').select(['id', 'gl_account_code']).where('account_no', '=', no).executeTakeFirst();
      if (!r) throw new AppError('BANK_ACCOUNT_NOT_FOUND', `Không có tài khoản ngân hàng số "${no}"`, 404);
      b = { id: r.id, gl: r.gl_account_code }; memo.set(no, b);
    }
    return b;
  };
}
// Tài khoản ngân hàng của đối tượng phải thuộc đúng đối tượng chính của chứng từ.
async function partyBankId(trx: Trx, partyId: string | null, no: string | null | undefined): Promise<string | null> {
  if (!no) return null;
  const r = partyId ? await trx.selectFrom('party_bank_account').select('id').where('party_id', '=', partyId).where('account_no', '=', no).executeTakeFirst() : undefined;
  if (!r) throw new AppError('PARTY_BANK_ACCOUNT_NOT_FOUND', `Đối tượng của chứng từ không có tài khoản ngân hàng số "${no}"`, 404);
  return r.id;
}

// Tra cứu, kiểm quy tắc theo loại và gán tài khoản ngân hàng cho dòng; dùng chung cho tạo mới và sửa nháp.
async function prepareVoucher(trx: Trx, lookup: Lookup, input: VoucherInput, regime: string) {
  const bank = bankLookup(trx);
  const partyId = (await lookup('party', input.partyCode)) as string | null;
  const headerBank = await bank(input.bankAccountNo); const counterBank = await bank(input.counterBankAccountNo);
  const header = {
    party_id: partyId, person_name: input.personName || null, person_address: input.personAddress || null, attachments_count: input.attachmentsCount ?? null,
    bank_account_id: headerBank?.id ?? null, counter_bank_account_id: counterBank?.id ?? null, party_bank_account_id: await partyBankId(trx, partyId, input.partyBankAccountNo),
    due_date: input.dueDate ?? null, purpose: input.purpose || null,
  };
  const lines: ResolvedLine[] = [];
  for (const l of input.lines) lines.push(await resolveLine(lookup, l, input.currencyCode, input.fxRate));
  const def = voucherTypeDef(input.voucherType);
  if (def) assertTypeRules(def, input, lines, lookup.accounts, regime);
  // Dòng riêng ghi tài khoản ngân hàng thì dùng; dòng trên tài khoản ngân hàng không ghi thì lấy của tiêu đề. Chuyển tiền nội bộ: dòng Có là tài khoản chuyển đi (bankAccountNo), dòng Nợ là tài khoản nhận (counterBankAccountNo).
  const transfer = def?.header.includes('counterBankAccount') ?? false;
  for (const [i, r] of lines.entries()) {
    const acc = lookup.accounts.get(r.account_id)!; const own = input.lines[i]!.bankAccountNo;
    const ref = own ? await bank(own) : acc.kind === 'bank' ? (transfer && D(r.debit).gt(0) ? counterBank : headerBank) : null;
    if (ref && ref.gl !== acc.code) throw new AppError('BANK_ACCOUNT_GL_MISMATCH', `Dòng ${i + 1}: tài khoản ${acc.code} khác tài khoản kế toán ${ref.gl} của tài khoản ngân hàng`, 400);
    r.bank_account_id = ref?.id ?? null;
  }
  return { header, lines };
}

// Chứng từ DK chỉ do màn hình Số dư đầu kỳ tạo (source_doc_type = 'opening_balance'); lập tay thì số dư bị cộng đôi hoặc bị ghi đè khi ghi sổ số dư.
// Chứng từ KC chỉ do màn hình Kết chuyển sinh (source_doc_type = 'closing_step'); PB lập tay vẫn được.
const SYSTEM_TYPE_MSG: Record<string, string> = {
  DK: 'Chứng từ số dư đầu kỳ chỉ lập qua màn hình Số dư đầu kỳ',
  KC: 'Chứng từ kết chuyển do hệ thống sinh ở màn hình Kết chuyển, không lập tay',
};
// Loại do hệ thống sinh (SYSTEM_VOUCHER_TYPES) không lập tay; hóa đơn, giảm giá, trả lại lập ở /api/invoices.
const assertNotSystemType = (voucherType: string) => {
  const def = voucherTypeDef(voucherType);
  if (SYSTEM_VOUCHER_TYPES.includes(voucherType) || def?.manual === false) throw new AppError('VOUCHER_TYPE_SYSTEM', SYSTEM_TYPE_MSG[voucherType] ?? `${def?.name ?? voucherType} do hệ thống sinh, không lập tay`, 409);
  if (def?.hasItems) throw new AppError('VOUCHER_TYPE_USE_INVOICE', `${def.name} lập ở màn hình Hóa đơn, không lập qua chứng từ chung`, 409);
};

// Chứng từ đã sinh ra từ màn hình Kết chuyển/Số dư đầu kỳ chỉ đổi qua màn hình đó (chạy lại đảo cũ, ghi sổ số dư): không sửa dòng, bỏ ghi sổ, hủy hay xóa tay. Khớp danh sách source_doc_type trong unpost_voucher/discard_voucher (0025); thêm loại mới thì sửa cả hai nơi.
const SYSTEM_MSG: Record<string, string> = {
  closing_step: 'Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển',
  opening_balance: 'Chứng từ số dư đầu kỳ chỉ sửa ở màn hình Số dư đầu kỳ',
  settlement_fx: 'Chứng từ chênh lệch tỷ giá do đối trừ chứng từ sinh ra; thao tác ở chức năng đối trừ chứng từ',
  fx_revaluation: 'Chứng từ đánh giá lại ngoại tệ do hệ thống sinh; thao tác ở chức năng đánh giá lại ngoại tệ',
  fx_outflow: 'Chứng từ điều chỉnh tỷ giá xuất quỹ do hệ thống sinh; thao tác ở chức năng đã sinh ra chứng từ',
  vat_offset: 'Chứng từ khấu trừ thuế GTGT do hệ thống sinh; thao tác ở chức năng khấu trừ thuế GTGT',
  amortization: 'Chứng từ phân bổ do hệ thống sinh; thao tác ở chức năng phân bổ',
};
const failIfSystem = (sourceDocType: string | null) => {
  const msg = sourceDocType ? SYSTEM_MSG[sourceDocType] : undefined;
  if (msg) throw new AppError('VOUCHER_SYSTEM_GENERATED', msg, 409);
};
async function assertNotSystemGenerated(trx: Trx, id: string) {
  failIfSystem((await trx.selectFrom('voucher').select('source_doc_type').where('id', '=', id).executeTakeFirst())?.source_doc_type ?? null);
}

export async function createVoucher(trx: Trx, ctx: { tenantId: string; userId: string }, input: VoucherInput): Promise<VoucherDto> {
  assertNotSystemType(input.voucherType); // cả nhân bản (duplicateVoucher gọi hàm này)
  if (input.idempotencyKey) {
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) return getVoucher(trx, existing.id);
  }
  const { regime } = await periodOf(trx, input.postingDate, input.voucherType);
  const { header, lines } = await prepareVoucher(trx, lookupIn(trx, regime), input, regime);
  const v = await trx.insertInto('voucher').values({
    tenant_id: ctx.tenantId, voucher_type: input.voucherType, posting_date: input.postingDate, document_date: input.documentDate, description: input.description ?? null,
    ...header, currency_code: input.currencyCode, fx_rate: input.fxRate ?? null, idempotency_key: input.idempotencyKey ?? null, created_by: ctx.userId,
  }).onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing()).returning('id').executeTakeFirst();
  if (!v) { // thua cuộc đua idempotency: chờ giao dịch thắng commit rồi trả chứng từ của nó
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey!).executeTakeFirstOrThrow();
    return getVoucher(trx, existing.id);
  }
  await insertLines(trx, ctx.tenantId, v.id, input.postingDate, lines);
  return getVoucher(trx, v.id);
}

async function lockAndCheckVersion(trx: Trx, id: string, version: number) {
  const v = await trx.selectFrom('voucher').select(['id', 'version', 'state', 'tenant_id', 'voucher_no', 'voucher_type', 'fiscal_year', 'source_doc_type']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  if (v.version !== version) throw new AppError('VERSION_CONFLICT', 'Chứng từ đã được người khác sửa, hãy tải lại', 409);
  return v;
}

export async function updateDraft(trx: Trx, id: string, version: number, input: VoucherInput): Promise<VoucherDto> {
  assertNotSystemType(input.voucherType);
  const v = await lockAndCheckVersion(trx, id, version);
  failIfSystem(v.source_doc_type);
  if (v.state !== 'draft') throw new AppError('VOUCHER_POSTED_EDIT', 'Chứng từ đã ghi sổ: chỉ sửa được diễn giải/chiều phân tích, hoặc Bỏ ghi sổ trước', 409);
  const period = await periodOf(trx, input.postingDate, input.voucherType);
  // Số đã cấp gắn với loại chứng từ và năm tài chính (bộ đếm theo năm): đổi một trong hai sẽ cấp số trùng hoặc lệch.
  if (v.voucher_no !== null && (input.voucherType !== v.voucher_type || period.fiscal_year !== v.fiscal_year))
    throw new AppError('VOUCHER_NUMBER_LOCKED', 'Chứng từ đã có số: không đổi loại chứng từ hoặc năm tài chính; hãy Hủy và lập mới', 409);
  const { header, lines } = await prepareVoucher(trx, lookupIn(trx, period.regime), input, period.regime);
  await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute();
  await trx.updateTable('voucher').set({ voucher_type: input.voucherType, posting_date: input.postingDate, document_date: input.documentDate, description: input.description ?? null,
    ...header, currency_code: input.currencyCode, fx_rate: input.fxRate ?? null }).where('id', '=', id).execute();
  await insertLines(trx, v.tenant_id, id, input.postingDate, lines);
  return getVoucher(trx, id);
}

export async function updatePostedMeta(trx: Trx, id: string, version: number, input: MetaInput): Promise<VoucherDto> {
  const v = await lockAndCheckVersion(trx, id, version);
  if (v.state === 'draft') throw new AppError('VALIDATION', 'Chứng từ nháp phải gửi đầy đủ nội dung', 400);
  if (input.description === undefined && !input.lines?.length) return getVoucher(trx, id);
  if (input.lines?.length) failIfSystem(v.source_doc_type); // diễn giải ở đầu chứng từ vẫn sửa được; dòng thì không
  const lookup = lookupIn(trx);
  for (const l of input.lines ?? []) {
    const set: Record<string, unknown> = {};
    if (l.description !== undefined) set['description'] = l.description;
    if (l.dueDate !== undefined) set['due_date'] = l.dueDate;
    if (l.departmentCode !== undefined) set['department_id'] = await lookup('department', l.departmentCode);
    if (l.projectCode !== undefined) set['project_id'] = await lookup('project', l.projectCode);
    if (l.costItemCode !== undefined) set['cost_item_id'] = await lookup('cost_item', l.costItemCode);
    if (l.employeeCode !== undefined) set['employee_id'] = await lookup('employee', l.employeeCode);
    if (!Object.keys(set).length) continue;
    const r = await trx.updateTable('voucher_line').set(set as never).where('voucher_id', '=', id).where('line_no', '=', l.lineNo).executeTakeFirst();
    if (!r.numUpdatedRows) throw new AppError('LINE_NOT_FOUND', `Chứng từ không có dòng ${l.lineNo}`, 404);
  }
  // Một lần UPDATE cuối để trigger tăng version đúng một nấc (kể cả khi chỉ đổi chiều phân tích của dòng).
  await trx.updateTable('voucher').set({ description: input.description !== undefined ? input.description : sql<string | null>`description` }).where('id', '=', id).execute();
  return getVoucher(trx, id);
}

export const postVoucher = async (trx: Trx, id: string) => { await sql`SELECT post_voucher(${id}::uuid)`.execute(trx); return getVoucher(trx, id); };
export const unpostVoucher = async (trx: Trx, id: string) => { await assertNotSystemGenerated(trx, id); await sql`SELECT unpost_voucher(${id}::uuid)`.execute(trx); return getVoucher(trx, id); };
export const discardVoucher = async (trx: Trx, id: string) => { await assertNotSystemGenerated(trx, id); await sql`SELECT discard_voucher(${id}::uuid)`.execute(trx); return getVoucher(trx, id); };
export async function reverseVoucher(trx: Trx, id: string, input: { postingDate: string; description?: string | undefined }): Promise<VoucherDto> {
  const r = await sql<{ id: string }>`SELECT reverse_voucher(${id}::uuid, ${input.postingDate}::date, ${input.description ?? null}) AS id`.execute(trx);
  return getVoucher(trx, r.rows[0]!.id);
}
export async function duplicateVoucher(trx: Trx, ctx: { tenantId: string; userId: string }, id: string, postingDate: string): Promise<VoucherDto> {
  const src = await getVoucher(trx, id);
  return createVoucher(trx, ctx, { voucherType: src.voucherType, postingDate, documentDate: postingDate, description: src.description, partyCode: src.partyCode, currencyCode: src.currencyCode,
    fxRate: src.fxRate ?? undefined, personName: src.personName, personAddress: src.personAddress, attachmentsCount: src.attachmentsCount, bankAccountNo: src.bankAccountNo,
    counterBankAccountNo: src.counterBankAccountNo, partyBankAccountNo: src.partyBankAccountNo, dueDate: src.dueDate, purpose: src.purpose,
    lines: src.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit, amountCurrency: l.amountCurrency, fxRate: l.fxRate, partyCode: l.partyCode,
      departmentCode: l.departmentCode, projectCode: l.projectCode, costItemCode: l.costItemCode, employeeCode: l.employeeCode, description: l.description, dueDate: l.dueDate, extraDims: l.extraDims, bankAccountNo: l.bankAccountNo })) });
}
export async function deleteDraft(trx: Trx, id: string): Promise<void> {
  await assertNotSystemGenerated(trx, id);
  await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute(); // chứng từ đã ghi sổ: trigger dòng chặn (LINE_IMMUTABLE); nháp đã có số: trigger chứng từ chặn
  if (!(await trx.deleteFrom('voucher').where('id', '=', id).returning('id').executeTakeFirst())) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
}
export async function listVouchers(trx: Trx, f: { type?: string | undefined; from?: string | undefined; to?: string | undefined; state?: string | undefined; q?: string | undefined; page: number; size: number }): Promise<{ rows: VoucherListRow[]; total: number }> {
  let q = trx.selectFrom('voucher as v').leftJoin('party as p', 'p.id', 'v.party_id');
  const types = f.type?.split(',').map((t) => t.trim()).filter(Boolean) ?? []; // type nhận danh sách mã cách nhau dấu phẩy
  if (types.length) q = q.where('v.voucher_type', 'in', types);
  if (f.from) q = q.where('v.posting_date', '>=', f.from);
  if (f.to) q = q.where('v.posting_date', '<=', f.to);
  if (f.state) q = q.where('v.state', '=', f.state);
  if (f.q) { const like = likePattern(f.q); q = q.where((eb) => eb.or([eb('v.voucher_no', 'ilike', like), eb('v.description', 'ilike', like), eb('p.name', 'ilike', like)])); }
  const total = Number((await q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
  const rows = await q.select(['v.id', 'v.voucher_type as voucherType', 'v.voucher_no as voucherNo', 'v.posting_date as postingDate', 'v.state', 'v.description', 'p.name as partyName',
      sql<string>`(SELECT coalesce(sum(debit),0) FROM voucher_line l WHERE l.voucher_id = v.id AND l.posting_date = v.posting_date)`.as('totalDebit')])
    .orderBy('v.posting_date', 'desc').orderBy('v.seq_no', 'desc').orderBy('v.created_at', 'desc').limit(f.size).offset((f.page - 1) * f.size).execute();
  return { rows, total };
}
