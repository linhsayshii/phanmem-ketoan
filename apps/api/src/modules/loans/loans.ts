import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, formatVnNumber, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { fxRulesFor } from '../cash/fx.js';
import { createVoucher, dateIso, postVoucher, type LineInput } from '../ledger/vouchers.service.js';
import { likePattern } from '../master/crud.js';
import { loanStats, type LoanStat } from './stats.js';

// Khế ước vay = contract kind 'loan' + loan_term (tài khoản, cơ sở ngày) + loan_rate (lãi suất theo hiệu lực) + loan_installment (lịch trả gốc).
// Giải ngân, trả nợ là chứng từ thường (BC/BN hoặc PKT) có contract_id ở dòng; không có bảng số dư riêng: dư nợ lấy từ sổ cái (stats.ts).
type Trx = Transaction<Database>;
const amount = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền không hợp lệ').refine((s) => /^\d+(\.\d+)?$/.test(s) && D(s).gt(0), 'Số tiền phải lớn hơn 0');
const rate = z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, 'Lãi suất không hợp lệ (% năm, tối đa 6 số lẻ)');
const optText = (max: number) => z.string().max(max).nullable().optional();

export const loanInput = z.object({
  code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(255), partyCode: z.string().min(1).nullable().optional(),
  currencyCode: z.string().length(3).default('VND'), value: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).default('0'), // hạn mức, 0 = không giới hạn
  signedDate: dateIso.nullable().optional(), validTo: dateIso.nullable().optional(), status: z.enum(['draft', 'active']).default('active'), note: optText(1000),
  principalAccountCode: z.string().min(1).default('3411'), interestExpenseAccountCode: z.string().min(1).default('635'), interestPayableAccountCode: z.string().min(1).default('335'),
  dayBasis: z.union([z.literal(360), z.literal(365)]).default(365), purpose: optText(500),
  rates: z.array(z.object({ validFrom: dateIso, annualRate: rate })).max(200).default([]),
  installments: z.array(z.object({ dueDate: dateIso, principal: amount, note: optText(255) })).max(600).default([]),
});
export type LoanInput = z.infer<typeof loanInput>;
export const disburseInput = z.object({
  date: dateIso, amount, fxRate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).optional(), description: optText(500),
  bankAccountNo: z.string().min(1).optional(), counterAccountCode: z.string().min(1).optional(), partyCode: z.string().min(1).nullable().optional(),
}).refine((b) => !!b.bankAccountNo !== !!b.counterAccountCode, 'Nhập tài khoản ngân hàng, hoặc tài khoản đối ứng (không nhập cả hai)');
export const repayInput = z.object({
  date: dateIso, principal: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền không hợp lệ').default('0'), interest: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền không hợp lệ').default('0'),
  bankAccountNo: z.string().min(1), fxRate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).optional(), description: optText(500),
}).refine((b) => D(b.principal).gt(0) || D(b.interest).gt(0), 'Nhập số gốc hoặc số lãi trả');

const notFound = () => new AppError('LOAN_NOT_FOUND', 'Không tìm thấy khế ước vay', 404);
const AT_END = '9999-12-31';

export interface LoanDto {
  id: number; code: string; name: string; partyCode: string | null; partyName: string | null; currencyCode: string; value: string; signedDate: string | null; validTo: string | null; status: string; note: string | null;
  principalAccountCode: string; interestExpenseAccountCode: string; interestPayableAccountCode: string; dayBasis: number; purpose: string | null;
  outstanding: string; interestPayable: string; drawn: string;
  rates?: { id: number; validFrom: string; annualRate: string }[]; installments?: { id: number; dueDate: string; principal: string; note: string | null }[];
}
const dto = (c: Record<string, string | number | null>, s?: LoanStat): LoanDto => ({ ...(c as unknown as LoanDto), outstanding: D(s?.outstandingCur ?? 0).toFixed(), interestPayable: D(s?.interestPayable ?? 0).toFixed(), drawn: D(s?.drawnCur ?? 0).toFixed() });
const SELECT_LOAN = sql`SELECT c.id::int AS id, c.code, c.name, p.code AS "partyCode", p.name AS "partyName", c.currency_code AS "currencyCode", c.value::text AS value, c.signed_date::text AS "signedDate",
    c.valid_to::text AS "validTo", c.status, c.note, lt.principal_account_code AS "principalAccountCode", lt.interest_expense_account_code AS "interestExpenseAccountCode",
    lt.interest_payable_account_code AS "interestPayableAccountCode", lt.day_basis AS "dayBasis", lt.purpose
  FROM contract c JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id WHERE c.kind = 'loan'`;

export async function listLoans(trx: Trx, asOf = AT_END): Promise<LoanDto[]> {
  const rows = (await sql<Record<string, string | number | null>>`${SELECT_LOAN} ORDER BY c.code`.execute(trx)).rows;
  const stats = new Map((await loanStats(trx, asOf)).map((s) => [s.id, s]));
  return rows.map((r) => dto(r, stats.get(r.id as number)));
}
export async function getLoan(trx: Trx, id: number): Promise<LoanDto> {
  const c = (await sql<Record<string, string | number | null>>`${SELECT_LOAN} AND c.id = ${id}::bigint`.execute(trx)).rows[0];
  if (!c) throw notFound();
  const rates = (await sql<{ id: number; validFrom: string; annualRate: string }>`SELECT id::int, valid_from::text AS "validFrom", annual_rate::text AS "annualRate" FROM loan_rate WHERE contract_id = ${id}::bigint ORDER BY valid_from`.execute(trx)).rows;
  const installments = (await sql<{ id: number; dueDate: string; principal: string; note: string | null }>`SELECT id::int, due_date::text AS "dueDate", principal::text AS principal, note FROM loan_installment WHERE contract_id = ${id}::bigint ORDER BY due_date, id`.execute(trx)).rows;
  return { ...dto(c, (await loanStats(trx, AT_END, id))[0]), rates, installments };
}

export async function lockLoans(trx: Trx, tenantId: string) { await sql`SELECT pg_advisory_xact_lock(hashtext('loan_run'), hashtext(${tenantId}))`.execute(trx); }
async function latestRegime(trx: Trx): Promise<string> {
  const r = await trx.selectFrom('fiscal_period').select('regime').orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new AppError('PERIOD_NOT_FOUND', 'Công ty chưa có năm tài chính nào', 404);
  return r.regime;
}
async function assertAccount(trx: Trx, regime: string, code: string, prefix: string | string[], what: string) {
  const prefixes = [prefix].flat();
  const a = await trx.selectFrom('account').select(['is_group', 'is_active']).where('regime', '=', regime).where('code', '=', code).executeTakeFirst();
  const bad = (m: string) => new AppError('LOAN_ACCOUNT_INVALID', m, 400);
  if (!a) throw bad(`Không có tài khoản ${what} "${code}" trong hệ thống tài khoản`);
  if (!prefixes.some((x) => code.startsWith(x))) throw bad(`Tài khoản ${what} phải thuộc nhóm ${prefixes.join(', ')}, không phải ${code}`);
  if (a.is_group) throw bad(`Tài khoản ${what} ${code} là tài khoản tổng hợp, chọn tài khoản chi tiết`);
}
const hasLedger = async (trx: Trx, id: number) => !!(await trx.selectFrom('voucher_line').select('id').where('contract_id', '=', id).limit(1).executeTakeFirst())
  || !!(await trx.selectFrom('opening_balance').select('id').where('contract_id', '=', id).limit(1).executeTakeFirst());

export async function saveLoan(trx: Trx, tenantId: string, id: number | null, b: LoanInput): Promise<LoanDto> {
  await lockLoans(trx, tenantId);
  const regime = await latestRegime(trx);
  await assertAccount(trx, regime, b.principalAccountCode, '341', 'gốc vay');
  await assertAccount(trx, regime, b.interestExpenseAccountCode, ['635', '241', '627'], 'chi phí lãi vay');
  await assertAccount(trx, regime, b.interestPayableAccountCode, '335', 'lãi vay phải trả');
  if (b.validTo && b.signedDate && b.validTo < b.signedDate) throw new AppError('VALIDATION', 'Ngày đáo hạn trước ngày ký', 400);
  if (new Set(b.rates.map((r) => r.validFrom)).size !== b.rates.length) throw new AppError('VALIDATION', 'Mỗi ngày hiệu lực chỉ có một lãi suất', 400);
  const cur = await trx.selectFrom('currency').select('code').where('code', '=', b.currencyCode).executeTakeFirst();
  if (!cur) throw new AppError('LOOKUP_NOT_FOUND', `Không có loại tiền ${b.currencyCode}`, 404);
  if (b.currencyCode !== 'VND') {
    const tc = await trx.selectFrom('account').select('track_currency').where('regime', '=', regime).where('code', '=', b.principalAccountCode).executeTakeFirst();
    if (!tc?.track_currency) throw new AppError('LOAN_CURRENCY_NOT_TRACKED', `Tài khoản ${b.principalAccountCode} chưa bật "theo dõi ngoại tệ": bật theo dõi ngoại tệ cho tài khoản trước khi lập khế ước vay bằng ${b.currencyCode}`, 400);
  }
  const party = b.partyCode ? (await trx.selectFrom('party').select('id').where('code', '=', b.partyCode).executeTakeFirst())?.id : null;
  if (party === undefined) throw new AppError('LOOKUP_NOT_FOUND', `Không có đối tượng ${b.partyCode}`, 404);
  let cid = id;
  if (id === null) {
    cid = (await sql<{ id: number }>`INSERT INTO contract(tenant_id, code, name, party_id, kind, signed_date, valid_to, value, currency_code, status, note)
      VALUES (${tenantId}::uuid, ${b.code}, ${b.name}, ${party}::uuid, 'loan', ${b.signedDate ?? null}::date, ${b.validTo ?? null}::date, ${b.value}::numeric, ${b.currencyCode}, ${b.status}, ${b.note ?? null}) RETURNING id::int`.execute(trx)).rows[0]!.id;
    await sql`INSERT INTO loan_term(tenant_id, contract_id, principal_account_code, interest_expense_account_code, interest_payable_account_code, day_basis, purpose)
      VALUES (${tenantId}::uuid, ${cid}::bigint, ${b.principalAccountCode}, ${b.interestExpenseAccountCode}, ${b.interestPayableAccountCode}, ${b.dayBasis}, ${b.purpose ?? null})`.execute(trx);
  } else {
    const old = (await sql<{ status: string; currency: string; principal: string }>`SELECT c.status, c.currency_code AS currency, lt.principal_account_code AS principal FROM contract c JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id
      WHERE c.id = ${id}::bigint AND c.kind = 'loan' FOR UPDATE OF c`.execute(trx)).rows[0];
    if (!old) throw notFound();
    if ((old.currency !== b.currencyCode || old.principal !== b.principalAccountCode) && await hasLedger(trx, id))
      throw new AppError('LOAN_IN_USE', 'Khế ước đã có bút toán: không đổi loại tiền hoặc tài khoản gốc vay', 409);
    await sql`UPDATE contract SET code = ${b.code}, name = ${b.name}, party_id = ${party}::uuid, signed_date = ${b.signedDate ?? null}::date, valid_to = ${b.validTo ?? null}::date, value = ${b.value}::numeric,
      currency_code = ${b.currencyCode}, status = ${old.status === 'terminated' ? 'terminated' : b.status}, note = ${b.note ?? null} WHERE id = ${id}::bigint`.execute(trx);
    await sql`UPDATE loan_term SET principal_account_code = ${b.principalAccountCode}, interest_expense_account_code = ${b.interestExpenseAccountCode}, interest_payable_account_code = ${b.interestPayableAccountCode},
      day_basis = ${b.dayBasis}, purpose = ${b.purpose ?? null} WHERE contract_id = ${id}::bigint`.execute(trx);
    await sql`DELETE FROM loan_rate WHERE contract_id = ${id}::bigint`.execute(trx);
    await sql`DELETE FROM loan_installment WHERE contract_id = ${id}::bigint`.execute(trx);
  }
  for (const r of b.rates) await sql`INSERT INTO loan_rate(tenant_id, contract_id, valid_from, annual_rate) VALUES (${tenantId}::uuid, ${cid}::bigint, ${r.validFrom}::date, ${r.annualRate}::numeric)`.execute(trx);
  for (const i of b.installments) await sql`INSERT INTO loan_installment(tenant_id, contract_id, due_date, principal, note) VALUES (${tenantId}::uuid, ${cid}::bigint, ${i.dueDate}::date, ${i.principal}::numeric, ${i.note ?? null})`.execute(trx);
  return getLoan(trx, cid!);
}

export async function deleteLoan(trx: Trx, tenantId: string, id: number): Promise<void> {
  await lockLoans(trx, tenantId);
  if (!(await sql`SELECT 1 FROM contract WHERE id = ${id}::bigint AND kind = 'loan'`.execute(trx)).rows.length) throw notFound();
  if (await hasLedger(trx, id)) throw new AppError('LOAN_IN_USE', 'Khế ước đã có bút toán hoặc số dư đầu kỳ: không xóa được', 409);
  await sql`DELETE FROM contract WHERE id = ${id}::bigint`.execute(trx);
}

// Khế ước còn hoạt động, đã khóa dòng để kiểm hạn mức và dư nợ tuần tự.
async function activeLoan(trx: Trx, tenantId: string, id: number) {
  await lockLoans(trx, tenantId);
  const c = (await sql<{ code: string; status: string; currency: string; value: string; partyCode: string | null }>`SELECT c.code, c.status, c.currency_code AS currency, c.value::text AS value, p.code AS "partyCode"
    FROM contract c LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id WHERE c.id = ${id}::bigint AND c.kind = 'loan' FOR UPDATE OF c`.execute(trx)).rows[0];
  if (!c) throw notFound();
  if (c.status === 'terminated') throw new AppError('LOAN_TERMINATED', `Khế ước ${c.code} đã tất toán`, 409);
  const stat = (await loanStats(trx, AT_END, id))[0]!;
  return { c, stat };
}
// Tiền một dòng theo loại tiền khế ước: VND giữ số nguyên; ngoại tệ cần tỷ giá, tiền VND quy đổi làm tròn đồng.
function money(currency: string, amt: string, fxRate: string | undefined): Pick<LineInput, 'debit' | 'credit' | 'amountCurrency' | 'fxRate'> & { vnd: string } {
  if (currency === 'VND') {
    if (!VND_AMOUNT_RE.test(amt)) throw new AppError('VALIDATION', VND_AMOUNT_MSG, 400);
    return { vnd: amt, debit: '0', credit: '0' };
  }
  if (!fxRate) throw new AppError('VALIDATION', `Khế ước bằng ${currency}: nhập tỷ giá`, 400);
  return { vnd: D(amt).times(fxRate).toDecimalPlaces(0).toString(), debit: '0', credit: '0', amountCurrency: amt, fxRate };
}
async function bankGl(trx: Trx, no: string): Promise<string> {
  const b = await trx.selectFrom('bank_account').select('gl_account_code').where('account_no', '=', no).executeTakeFirst();
  if (!b) throw new AppError('BANK_ACCOUNT_NOT_FOUND', `Không có tài khoản ngân hàng số "${no}"`, 404);
  return b.gl_account_code;
}

type Ctx = { tenantId: string; userId: string };
export async function disburse(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof disburseInput>) {
  const { c, stat } = await activeLoan(trx, ctx.tenantId, id);
  if (c.status === 'draft') throw new AppError('LOAN_DRAFT', `Khế ước ${c.code} còn ở trạng thái nháp: chuyển sang đang hiệu lực trước khi giải ngân`, 409);
  const limit = D(c.value);
  if (limit.gt(0) && D(stat.drawnCur).plus(b.amount).gt(limit))
    throw new AppError('LOAN_LIMIT', `Giải ngân ${formatVnNumber(b.amount)} cộng đã rút ${formatVnNumber(stat.drawnCur)} vượt hạn mức ${formatVnNumber(c.value)} của khế ước ${c.code}`, 409);
  const m = money(c.currency, b.amount, b.fxRate); const fx = { ...(m.amountCurrency ? { amountCurrency: m.amountCurrency, fxRate: m.fxRate } : {}) };
  const lender = c.partyCode;
  const bank = b.bankAccountNo ? await bankGl(trx, b.bankAccountNo) : null;
  const v = await createVoucher(trx, ctx, {
    voucherType: bank ? 'BC' : 'PKT', postingDate: b.date, documentDate: b.date, description: b.description ?? `Giải ngân khế ước vay ${c.code}`, partyCode: lender, currencyCode: c.currency,
    ...(c.currency !== 'VND' && { fxRate: b.fxRate }), ...(b.bankAccountNo && { bankAccountNo: b.bankAccountNo }),
    lines: [
      { accountCode: bank ?? b.counterAccountCode!, debit: m.vnd, credit: '0', ...fx, ...(bank ? { bankAccountNo: b.bankAccountNo! } : { partyCode: b.partyCode ?? null }) },
      { accountCode: stat.principalAccount, debit: '0', credit: m.vnd, ...(m.amountCurrency ? { amountCurrency: `-${m.amountCurrency}`, fxRate: m.fxRate } : {}), partyCode: lender, contractCode: c.code },
    ],
  });
  return postVoucher(trx, v.id);
}

// Dư Có (VND, nguyên tệ) của khế ước trên một tài khoản đến hết ngày: tỷ giá ghi sổ bình quân của khoản vay (gốc, lãi phải trả).
async function bookBalance(trx: Trx, id: number, account: string, date: string) {
  return (await sql<{ vnd: string; cur: string }>`SELECT coalesce(sum(l.credit - l.debit), 0)::text AS vnd, coalesce(-sum(l.amount_currency), 0)::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id
    WHERE l.contract_id = ${id}::bigint AND a.code = ${account} AND l.posting_date <= ${date}::date`.execute(trx)).rows[0]!;
}

// Trả nợ: Nợ TK gốc, TK lãi phải trả (khế ước) / Có tiền gửi. Khế ước ngoại tệ: bên Nợ theo tỷ giá ghi sổ bình quân của khế ước trên từng tài khoản (trả hết thì đúng số dư VND),
// bên Có tiền theo tỷ giá thanh toán nhập vào; chênh lệch vào lãi (Có) / lỗ (Nợ) tỷ giá của chế độ (fx_rule).
export async function repay(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof repayInput>) {
  const { c, stat } = await activeLoan(trx, ctx.tenantId, id);
  // Trả gốc không được vượt dư nợ nhỏ nhất từ ngày trả trở đi: dư nợ tại ngày trả và số dư chạy sau mỗi bút toán gốc về sau (trả lùi ngày không làm dư nợ các ngày sau âm,
  // trả trước ngày giải ngân không làm dư nợ ngày trả âm), vì chạy lãi vay không tính được trên dư nợ âm.
  const at = (await loanStats(trx, b.date, id))[0]!;
  const later = (await sql<{ low: string | null }>`SELECT min(bal)::text AS low FROM (
      SELECT d, sum(net) OVER (ORDER BY d) AS bal FROM (
        SELECT l.posting_date AS d, sum(-l.amount_currency) AS net
        FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id
        WHERE l.contract_id = ${id}::bigint AND a.code = ${stat.principalAccount} GROUP BY l.posting_date) g) w
    WHERE d > ${b.date}::date`.execute(trx)).rows[0]!.low;
  const room = later !== null && D(later).lt(at.outstandingCur) ? D(later) : D(at.outstandingCur);
  if (D(b.principal).gt(room)) {
    const vnd = c.currency === 'VND' || !room.eq(at.outstandingCur) ? '' : ` (${formatVnNumber(at.outstandingVnd)} đồng)`;
    throw new AppError('LOAN_OVERPAY', `Trả gốc ${formatVnNumber(b.principal)} ${c.currency} vượt dư nợ gốc tối đa trả được ${formatVnNumber(room.toString())} ${c.currency}${vnd} của khế ước ${c.code} tại ngày ${b.date} (tính cả các khoản gốc ghi sổ sau ngày này)`, 409);
  }
  const gl = await bankGl(trx, b.bankAccountNo);
  const lender = c.partyCode;
  const part = (amt: string) => money(c.currency, amt, b.fxRate);
  const lines: (LineInput & { currencyCode?: string })[] = []; let total = D(0); let book = D(0); let totalCur = D(0);
  for (const [acc, amt] of [[stat.principalAccount, b.principal], [stat.interestPayableAccount, b.interest]] as const) {
    if (D(amt).isZero()) continue;
    const m = part(amt); total = total.plus(m.vnd); totalCur = totalCur.plus(amt);
    let vnd = m.vnd; let fxRate = m.fxRate;
    if (m.amountCurrency) {
      const bb = await bookBalance(trx, id, acc, b.date);
      if (D(bb.cur).gt(0) && D(bb.vnd).gt(0)) {
        vnd = D(amt).eq(bb.cur) ? D(bb.vnd).toFixed(0) : D(amt).times(bb.vnd).div(bb.cur).toDecimalPlaces(0).toFixed(0);
        fxRate = D(vnd).div(amt).toDecimalPlaces(10).toString();
      }
    }
    book = book.plus(vnd);
    lines.push({ accountCode: acc, debit: vnd, credit: '0', ...(m.amountCurrency ? { amountCurrency: m.amountCurrency, fxRate } : {}), partyCode: lender, contractCode: c.code });
  }
  lines.push({ accountCode: gl, debit: '0', credit: total.toString(), ...(c.currency !== 'VND' ? { amountCurrency: totalCur.neg().toString(), fxRate: b.fxRate! } : {}), bankAccountNo: b.bankAccountNo });
  const diff = total.minus(book);
  if (!diff.isZero()) {
    const p = await trx.selectFrom('fiscal_period').select('regime').where('date_from', '<=', b.date).where('date_to', '>=', b.date).limit(1).executeTakeFirst();
    if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ kế toán chứa ngày ${b.date}`, 404);
    const rules = await fxRulesFor(trx, p.regime);
    lines.push({ accountCode: diff.gt(0) ? rules.lossAccount : rules.gainAccount, debit: diff.gt(0) ? diff.toFixed(0) : '0', credit: diff.gt(0) ? '0' : diff.neg().toFixed(0), currencyCode: 'VND',
      description: `Chênh lệch tỷ giá trả nợ khế ước vay ${c.code}` });
  }
  const v = await createVoucher(trx, ctx, {
    voucherType: 'BN', postingDate: b.date, documentDate: b.date, description: b.description ?? `Trả nợ khế ước vay ${c.code}`, partyCode: lender, currencyCode: c.currency,
    ...(c.currency !== 'VND' && { fxRate: b.fxRate }), bankAccountNo: b.bankAccountNo, lines,
  });
  return postVoucher(trx, v.id);
}

// Tất toán: dư nợ gốc và lãi phải trả (theo khế ước) đều bằng 0 mới đóng khế ước.
export async function settleLoan(trx: Trx, tenantId: string, id: number): Promise<LoanDto> {
  const { c, stat } = await activeLoan(trx, tenantId, id);
  if (!D(stat.outstandingVnd).isZero() || !D(stat.outstandingCur).isZero() || !D(stat.interestPayable).isZero())
    throw new AppError('LOAN_OUTSTANDING', `Khế ước ${c.code} còn dư nợ gốc ${formatVnNumber(stat.outstandingVnd)}, lãi phải trả ${formatVnNumber(stat.interestPayable)}: chưa tất toán được`, 409);
  await sql`UPDATE contract SET status = 'terminated' WHERE id = ${id}::bigint`.execute(trx);
  return getLoan(trx, id);
}

// Tra cứu F4 ô Khế ước trên dòng chứng từ.
export async function lookupContracts(trx: Trx, q: string, kind: string | undefined, size: number) {
  const like = likePattern(q);
  return (await sql<{ id: number; code: string; name: string; kind: string; partyCode: string | null; currencyCode: string; status: string }>`
    SELECT c.id::int, c.code, c.name, c.kind, p.code AS "partyCode", c.currency_code AS "currencyCode", c.status FROM contract c LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
    WHERE (c.code ILIKE ${like} ESCAPE '\\' OR c.name ILIKE ${like} ESCAPE '\\') AND (${kind ?? null}::text IS NULL OR c.kind = ${kind ?? null}) ORDER BY c.code LIMIT ${size}`.execute(trx)).rows;
}
