import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, Decimal, periodInterest, type PeriodSpan } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { periodSpan } from '../assets/periodRun.js';
import { fxRulesFor, rateAt } from '../cash/fx.js';
import { lockLoans } from './loans.js';
import { loanStats } from './stats.js';

// Lãi vay kỳ (LV, quy ước 8): mỗi khế ước một cặp dòng Nợ TK chi phí lãi / Có TK lãi phải trả (contract_id), ngày cuối kỳ; lần chạy lưu ở period_run kind 'loan_interest'.
// Chạy lại như khấu hao (assets/periodRun.ts): chứng từ khớp thì giữ, lệch thì đảo cũ ngày cuối kỳ rồi sinh lần chạy và chứng từ mới.
type Trx = Transaction<Database>;
export type Ctx = { tenantId: string; userId: string; canBackdate: boolean };
const KIND = 'loan_interest';

type Basis = { balances: { date: string; balance: string }[]; rates: { validFrom: string; annualRate: string }[] };
type Loan = { id: number; code: string; currency: string; partyCode: string | null; expenseAccount: string; payableAccount: string; dayBasis: 360 | 365 };

// Khế ước (trừ nháp) cùng bậc dư nợ gốc cuối ngày theo loại tiền khế ước (Σ Có − Nợ nguyên tệ dòng TK gốc có contract_id) và lãi suất theo hiệu lực, đến hết `to`.
async function loansWithBasis(trx: Trx, to: string, id?: number): Promise<(Loan & Basis)[]> {
  const loans = (await sql<Loan>`SELECT c.id::int AS id, c.code, c.currency_code AS currency, p.code AS "partyCode", lt.interest_expense_account_code AS "expenseAccount",
      lt.interest_payable_account_code AS "payableAccount", lt.day_basis AS "dayBasis"
    FROM contract c JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
    WHERE c.kind = 'loan' AND c.status <> 'draft' AND (${id ?? null}::bigint IS NULL OR c.id = ${id ?? null}::bigint) ORDER BY c.code`.execute(trx)).rows;
  if (!loans.length) return [];
  const ids = loans.map((l) => l.id);
  const moves = (await sql<{ id: number; date: string; change: string }>`SELECT l.contract_id::int AS id, l.posting_date::text AS date, (-sum(l.amount_currency))::text AS change
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id
    JOIN loan_term lt ON lt.tenant_id = l.tenant_id AND lt.contract_id = l.contract_id AND lt.principal_account_code = a.code
    WHERE l.contract_id = ANY(${ids}::bigint[]) AND l.posting_date <= ${to}::date GROUP BY l.contract_id, l.posting_date ORDER BY l.contract_id, l.posting_date`.execute(trx)).rows;
  const rates = (await sql<{ id: number; validFrom: string; annualRate: string }>`SELECT contract_id::int AS id, valid_from::text AS "validFrom", annual_rate::text AS "annualRate"
    FROM loan_rate WHERE contract_id = ANY(${ids}::bigint[]) ORDER BY valid_from`.execute(trx)).rows;
  return loans.map((l) => {
    let bal = D(0);
    const balances = moves.filter((m) => m.id === l.id).map((m) => ({ date: m.date, balance: (bal = bal.plus(m.change)).toFixed() }));
    return { ...l, dayBasis: Number(l.dayBasis) as 360 | 365, balances, rates: rates.filter((r) => r.id === l.id).map(({ validFrom, annualRate }) => ({ validFrom, annualRate })) };
  });
}

const decimalsOf = (currency: string) => (currency === 'VND' ? 0 : 2) as 0 | 2;
// Lãi kỳ của mọi khế ước (theo loại tiền khế ước). Kỳ 0 và kỳ điều chỉnh không có lãi.
async function computeInterest(trx: Trx, span: PeriodSpan) {
  if (span.periodNo < 1 || span.periodNo > 12) return [];
  return (await loansWithBasis(trx, span.to)).map((l) => ({ ...l, interest: periodInterest({ from: span.from, to: span.to, balances: l.balances, rates: l.rates, dayBasis: l.dayBasis, decimals: decimalsOf(l.currency) }) }));
}

// Quy ước 6: kỳ liền trước có lãi khác 0 mà chưa có lần chạy hiệu lực → 409.
async function assertNoGap(trx: Trx, span: PeriodSpan) {
  const prev = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no']).where('period_no', '>=', 1).where('period_no', '<=', 12)
    .where(sql<boolean>`(fiscal_year, period_no) < (${span.fiscalYear}, ${span.periodNo})`).orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').limit(1).executeTakeFirst();
  if (!prev) return;
  if (await trx.selectFrom('period_run').select('id').where('kind', '=', KIND).where('fiscal_year', '=', prev.fiscal_year).where('period_no', '=', prev.period_no).where('status', '=', 'active').executeTakeFirst()) return;
  const hit = (await computeInterest(trx, (await periodSpan(trx, prev.fiscal_year, prev.period_no)).span)).find((x) => !D(x.interest).isZero());
  if (hit) throw new AppError('PERIOD_RUN_GAP', `Kỳ ${prev.period_no}/${prev.fiscal_year} chưa tính lãi vay mà có lãi phát sinh (khế ước ${hit.code}): chạy kỳ đó trước`, 409);
}

type VLine = S.LineInput & { currencyCode: string };
const lineKey = (l: { accountCode: string; debit: string; credit: string; currencyCode: string; amountCurrency?: string | null | undefined; partyCode?: string | null | undefined; contractCode?: string | null | undefined }) =>
  [l.accountCode, D(l.debit).toFixed(0), D(l.credit).toFixed(0), l.currencyCode, l.currencyCode === 'VND' ? '' : D(l.amountCurrency ?? 0).toFixed(4), l.partyCode ?? '', l.contractCode ?? ''].join('|');

export async function runLoanInterest(trx: Trx, ctx: Ctx, input: { fiscalYear: number; periodNo: number }) {
  await lockLoans(trx, ctx.tenantId);
  const { fiscalYear: fy, periodNo: pn } = input;
  const { span, status } = await periodSpan(trx, fy, pn);
  await assertNoGap(trx, span);
  const items = (await computeInterest(trx, span)).filter((x) => !D(x.interest).isZero());

  // Khế ước ngoại tệ: quy VND theo tỷ giá ngày cuối kỳ, loại tỷ giá nợ phải trả (cài đặt công ty, không có thì theo chế độ) như đánh giá lại.
  let rateType: Awaited<ReturnType<typeof getSettings>>['fx_rate_type'] | undefined;
  const lines: VLine[] = []; const result = [];
  for (const x of items) {
    let fxRate: string | undefined; let vnd = x.interest;
    if (x.currency !== 'VND') {
      if (!rateType) {
        const regime = (await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', fy).where('period_no', '=', pn).executeTakeFirstOrThrow()).regime;
        rateType = (await getSettings(trx, ctx.tenantId)).fx_reval_rate_liability ?? (await fxRulesFor(trx, regime)).liabilityRate;
      }
      fxRate = (await rateAt(trx, ctx.tenantId, { currency: x.currency, date: span.to, type: rateType })).rate;
      vnd = D(x.interest).times(fxRate).toDecimalPlaces(0).toFixed(0);
    }
    const description = `Lãi vay khế ước ${x.code} kỳ ${pn}/${fy}`;
    lines.push({ accountCode: x.expenseAccount, debit: vnd, credit: '0', currencyCode: 'VND', description },
      { accountCode: x.payableAccount, debit: '0', credit: vnd, currencyCode: x.currency, ...(fxRate && { amountCurrency: D(x.interest).neg().toFixed(2), fxRate }), partyCode: x.partyCode, contractCode: x.code, description });
    result.push({ loanCode: x.code, interest: x.interest, interestVnd: vnd });
  }
  const resultJson = JSON.stringify({ lines: result });

  const active = await trx.selectFrom('period_run as r').leftJoin('voucher as v', 'v.id', 'r.voucher_id').select(['r.id', 'r.voucher_id', 'v.state'])
    .where('r.kind', '=', KIND).where('r.fiscal_year', '=', fy).where('r.period_no', '=', pn).where('r.status', '=', 'active').executeTakeFirst();
  if (active) {
    let same = !active.voucher_id && !lines.length;
    if (active.voucher_id && active.state === 'posted') {
      const cur = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('party as p', 'p.id', 'l.party_id').leftJoin('contract as c', 'c.id', 'l.contract_id')
        .select(['a.code as accountCode', 'l.debit', 'l.credit', 'l.currency_code as currencyCode', 'l.amount_currency as amountCurrency', 'p.code as partyCode', 'c.code as contractCode'])
        .where('l.voucher_id', '=', active.voucher_id).where('l.posting_date', '=', span.to).execute();
      same = cur.map(lineKey).sort().join(';') === lines.map(lineKey).sort().join(';');
    }
    if (same) {
      await trx.updateTable('period_run').set({ checked_at: sql`now()`, result: resultJson }).where('id', '=', active.id).execute();
      return { runId: active.id, voucherId: active.voucher_id, reversedVoucherIds: [] as string[], unchanged: true, lines: result };
    }
  }
  if (status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${pn}/${fy} đã khóa cứng: không tính lãi vay`, 409);
  if (status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${pn}/${fy} đã khóa sổ, cần quyền ghi lùi ngày để tính lãi vay`, 409);
  const reversed: string[] = [];
  if (active) {
    if (active.voucher_id && active.state === 'posted') { await S.reverseVoucher(trx, active.voucher_id, { postingDate: span.to }); reversed.push(active.voucher_id); }
    await trx.updateTable('period_run').set({ status: 'superseded' }).where('id', '=', active.id).execute();
  }
  const run = await trx.insertInto('period_run').values({ tenant_id: ctx.tenantId, kind: KIND, fiscal_year: fy, period_no: pn, created_by: ctx.userId, result: resultJson }).returning('id').executeTakeFirstOrThrow();
  let voucherId: string | null = null;
  if (lines.length) {
    const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'LV', postingDate: span.to, documentDate: span.to, description: `Lãi vay kỳ ${pn}/${fy}`, currencyCode: 'VND', lines }, { type: KIND, id: run.id });
    await S.postVoucher(trx, v.id);
    voucherId = v.id;
    await trx.updateTable('period_run').set({ voucher_id: v.id }).where('id', '=', run.id).execute();
  }
  return { runId: run.id, voucherId, reversedVoucherIds: reversed, unchanged: false, lines: result };
}

/**
 * Lãi dự tính theo tháng dương lịch trong [from, to] của một khế ước (màn hình): dư nợ theo sổ cái, cộng các kỳ trả gốc còn lại của lịch
 * (số đã trả trừ vào kỳ sớm nhất trước, như B01) trừ dần vào ngày đến hạn sau lần ghi sổ gốc cuối cùng. Kỳ quá hạn chưa trả giữ nguyên dư nợ.
 */
export async function interestPreview(trx: Trx, id: number, from: string, to: string) {
  const [l] = await loansWithBasis(trx, to, id);
  if (!l) throw new AppError('LOAN_NOT_FOUND', 'Không tìm thấy khế ước vay', 404);
  const stat = (await loanStats(trx, '9999-12-31', id))[0]!;
  const last = l.balances.at(-1);
  let bal = D(last?.balance ?? 0); let repaid = D(stat.repaidCur);
  const inst = (await sql<{ dueDate: string; principal: string }>`SELECT due_date::text AS "dueDate", principal::text AS principal FROM loan_installment WHERE contract_id = ${id}::bigint ORDER BY due_date, id`.execute(trx)).rows;
  const balances = [...l.balances];
  for (const i of inst) {
    const paid = Decimal.min(repaid, i.principal); repaid = repaid.minus(paid);
    const left = D(i.principal).minus(paid);
    if (left.gt(0) && i.dueDate > (last?.date ?? '') && i.dueDate <= to) balances.push({ date: i.dueDate, balance: (bal = Decimal.max(0, bal.minus(left))).toFixed() });
  }
  const months = [];
  for (let m = from.slice(0, 7); `${m}-01` <= to;) {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const a = `${m}-01` < from ? from : `${m}-01`; const b = end > to ? to : end;
    months.push({ from: a, to: b, interest: periodInterest({ from: a, to: b, balances, rates: l.rates, dayBasis: l.dayBasis, decimals: decimalsOf(l.currency) }) });
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  }
  return { currencyCode: l.currency, months, total: months.reduce((s, x) => s.plus(x.interest), D(0)).toFixed(decimalsOf(l.currency)) };
}
