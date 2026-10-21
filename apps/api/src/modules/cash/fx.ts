import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { loadFxRules } from '@kt/coa-data';
import { avgRate, D, formatVnDate, proportionalVnd, todayVn, ZERO, type Decimal, type Regime } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings, type Settings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { cashBalanceAt } from './books.js';

type Trx = Transaction<Database>;
type RateType = Settings['fx_rate_type'];
const RATE_TYPE_LABEL: Record<RateType, string> = { transfer_avg: 'mua bán chuyển khoản trung bình', buy: 'mua', sell: 'bán' };

// Tỷ giá theo ngày: tỷ giá có ngày lớn nhất không sau `date`; không nêu loại thì theo loại tỷ giá ghi sổ trong cài đặt.
export async function rateAt(trx: Trx, tenantId: string, p: { currency: string; date: string; type?: RateType | undefined }) {
  const type = p.type ?? (await getSettings(trx, tenantId)).fx_rate_type;
  const r = await trx.selectFrom('exchange_rate').select(['rate_date', 'rate']).where('currency_code', '=', p.currency).where('rate_type', '=', type)
    .where('rate_date', '<=', p.date).orderBy('rate_date', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new AppError('FX_RATE_MISSING', `Chưa có tỷ giá ${RATE_TYPE_LABEL[type]} của ${p.currency} đến ngày ${formatVnDate(p.date)}`, 409);
  return { currency: p.currency, type, rateDate: r.rate_date, rate: r.rate };
}

// Tỷ giá xuất quỹ bình quân di động tại cuối ngày `date` = số dư VND / số dư nguyên tệ của (tài khoản, tài khoản ngân hàng, loại tiền), dòng đã ghi sổ.
// Nguyên tệ bằng 0 thì không có tỷ giá; số dư âm (chi quá số có) cho tỷ giá không dương: cũng trả null, không điền sẵn.
export async function outflowRate(trx: Trx, p: { accountCode: string; bankAccountNo?: string | undefined; currency: string; date: string }) {
  const b = await cashBalanceAt(trx, { accountCode: p.accountCode, bankAccountNo: p.bankAccountNo, currency: p.currency, asOf: p.date });
  const rate = avgRate(b.balance, b.balanceCurrency);
  return { rate: rate !== null && D(rate).gt(0) ? rate : null, balance: b.balance, balanceCurrency: b.balanceCurrency };
}

// source_doc_id của chứng từ sinh từ một lần chạy (uuid suy từ công ty và mã lần chạy, như kiểm kê quỹ); đánh giá lại ngoại tệ dùng chung.
export async function fxRunSourceId(trx: Trx, tenantId: string, runId: number): Promise<string> {
  return (await sql<{ id: string }>`SELECT md5(${`${tenantId}:fx_run:${runId}`})::uuid::text AS id`.execute(trx)).rows[0]!.id;
}

export const adjustInput = z.object({ fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(15) });
interface TraversalRow { accountId: number; accountCode: string; bankAccountId: number | null; bankAccountNo: string | null; currency: string; inPeriod: boolean; isOut: boolean; debit: string; credit: string; cur: string }
interface Group { accountCode: string; bankAccountNo: string | null; currency: string; vnd: Decimal; cur: Decimal; diff: Decimal }

// Tính lại tỷ giá xuất quỹ bình quân di động của kỳ: duyệt dòng đã ghi sổ của từng (tài khoản tiền, tài khoản ngân hàng, loại tiền ngoại tệ) đến hết kỳ,
// theo (ngày, Nợ trước Có, lúc ghi sổ, dòng). Dòng Có trong kỳ có nguyên tệ là lần xuất: giá trị đúng = nguyên tệ × bình quân tại lúc xuất; dòng Có kỳ trước
// và dòng chỉ VND (nguyên tệ 0: điều chỉnh, đánh giá lại) giữ số đã ghi. Tổng lệch (đã ghi − đúng) khác 0 thì sinh một chứng từ XQ ngày cuối kỳ, mỗi nhóm một cặp dòng
// với 515/635. Chạy lại cùng kỳ đảo XQ của các lần trước rồi sinh mới.
export async function runOutflowAdjust(trx: Trx, ctx: { tenantId: string; userId: string; canBackdate: boolean }, input: z.infer<typeof adjustInput>) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('fx_outflow'), hashtext(${ctx.tenantId}::text))`.execute(trx);
  if ((await getSettings(trx, ctx.tenantId)).fx_outflow_method !== 'moving_average')
    throw new AppError('FX_OUTFLOW_METHOD_SPECIFIC', 'Công ty dùng tỷ giá xuất quỹ đích danh (cài đặt): không tính lại theo bình quân di động', 409);
  const { fiscalYear: fy, periodNo: pn } = input;
  const p = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to', 'status', 'regime']).where('fiscal_year', '=', fy).where('period_no', '=', pn).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${pn}/${fy}`, 404);
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${pn}/${fy} đã khóa cứng: không tính lại tỷ giá xuất quỹ`, 409);
  if (p.status === 'soft_locked') {
    if (!ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${pn}/${fy} đã khóa sổ, cần quyền ghi lùi ngày`, 409);
    await sql`SELECT set_config('app.override_soft_lock', 'on', true)`.execute(trx);
  }

  // Đảo XQ còn hiệu lực của các lần chạy trước: kỳ mở đảo ngày cuối kỳ; kỳ khóa sổ đảo ngày hôm nay (không trước ngày chứng từ gốc).
  const today = todayVn();
  const reverseDate = p.status === 'open' || today < p.date_to ? p.date_to : today;
  const prev = (await sql<{ id: string }>`SELECT v.id FROM fx_run r CROSS JOIN LATERAL unnest(r.voucher_ids) AS u(id) JOIN voucher v ON v.id = u.id
    WHERE r.kind = 'outflow' AND r.fiscal_year = ${fy} AND r.period_no = ${pn} AND v.state = 'posted' ORDER BY r.id, v.id`.execute(trx)).rows.map((r) => r.id);
  for (const id of prev) await S.reverseVoucher(trx, id, { postingDate: reverseDate });

  const rows = (await sql<TraversalRow>`
    SELECT l.account_id AS "accountId", a.code AS "accountCode", l.bank_account_id AS "bankAccountId", ba.account_no AS "bankAccountNo", l.currency_code AS currency,
           (v.fiscal_year = ${fy} AND v.period_no = ${pn}) AS "inPeriod", (l.credit > 0 OR (l.debit = 0 AND l.amount_currency < 0)) AS "isOut",
           l.debit::text AS debit, l.credit::text AS credit, l.amount_currency::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id
    LEFT JOIN voucher o ON o.id = v.reversal_of_id LEFT JOIN voucher r ON r.id = v.reversed_by_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${p.date_to}::date AND a.regime = ${p.regime} AND a.subledger_kind IN ('cash', 'bank') AND l.currency_code <> 'VND'
      -- XQ của chính kỳ này và bản đảo của chúng (bản đảo có thể nằm ở kỳ sau khi kỳ này đã khóa sổ)
      AND NOT coalesce(v.source_doc_type = 'fx_outflow' AND coalesce(o.fiscal_year, v.fiscal_year) = ${fy} AND coalesce(o.period_no, v.period_no) = ${pn}, false)
      -- chứng từ trong kỳ đã bị đảo trước hết kỳ: gốc và bản đảo triệt tiêu, không phải lần xuất quỹ
      AND NOT coalesce(o.posting_date >= ${p.date_from}::date, false)
      AND NOT coalesce(r.posting_date <= ${p.date_to}::date AND v.posting_date >= ${p.date_from}::date, false)
    ORDER BY l.account_id, l.bank_account_id NULLS FIRST, l.currency_code, l.posting_date, "isOut", v.posted_at, v.id, l.line_no`.execute(trx)).rows;

  // shortcut: duyệt từng dòng cả lịch sử của nhóm; dữ liệu lớn thì cộng gộp các dòng trước kỳ (đều giữ số đã ghi) thành số dư đầu kỳ rồi chỉ duyệt dòng trong kỳ.
  const groups = new Map<string, Group>();
  for (const l of rows) {
    const key = `${l.accountId}|${l.bankAccountId ?? ''}|${l.currency}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { accountCode: l.accountCode, bankAccountNo: l.bankAccountNo, currency: l.currency, vnd: ZERO, cur: ZERO, diff: ZERO });
    if (!l.isOut) { g.vnd = g.vnd.plus(l.debit); g.cur = g.cur.plus(l.cur); continue; }
    const part = D(l.cur).neg();
    // không còn số dư dương (chi quá số có) thì không có bình quân: giữ số đã ghi
    const right = l.inPeriod && part.gt(0) && g.cur.gt(0) && g.vnd.gt(0) ? D(proportionalVnd(g.vnd.toFixed(0), g.cur.toFixed(4), part.toFixed(4))) : D(l.credit);
    g.diff = g.diff.plus(l.credit).minus(right); g.vnd = g.vnd.minus(right); g.cur = g.cur.plus(l.cur);
  }

  const adjust = [...groups.values()].filter((g) => !g.diff.isZero());
  const rules = adjust.length ? loadFxRules(p.regime as Regime) : undefined; // chỉ cần khi có điều chỉnh
  const summary = adjust.map((g) => ({ accountCode: g.accountCode, bankAccountNo: g.bankAccountNo, currency: g.currency, difference: g.diff.toFixed(0) }));
  // Lệch dương: đã ghi Có tiền nhiều hơn giá trị đúng, ghi Nợ lại tiền / Có lãi tỷ giá; lệch âm: Nợ lỗ tỷ giá / Có tiền.
  const lines = adjust.flatMap((g) => {
    const amount = g.diff.abs().toFixed(0); const gain = g.diff.gt(0);
    const description = `Điều chỉnh tỷ giá xuất quỹ ${g.accountCode}${g.bankAccountNo ? ` – ${g.bankAccountNo}` : ''} ${g.currency}`;
    return [
      { accountCode: g.accountCode, currencyCode: g.currency, amountCurrency: '0', debit: gain ? amount : '0', credit: gain ? '0' : amount, bankAccountNo: g.bankAccountNo, description },
      { accountCode: gain ? rules!.gainAccount : rules!.lossAccount, currencyCode: 'VND', debit: gain ? '0' : amount, credit: gain ? amount : '0', description },
    ];
  });

  const run = await trx.insertInto('fx_run').values({ tenant_id: ctx.tenantId, kind: 'outflow', fiscal_year: fy, period_no: pn, run_date: p.date_to, reversed_voucher_ids: prev,
    params: JSON.stringify({ groups: summary }), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
  const voucherIds: string[] = [];
  if (lines.length) {
    const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'XQ', postingDate: p.date_to, documentDate: p.date_to, description: `Điều chỉnh tỷ giá xuất quỹ kỳ ${pn}/${fy}`, currencyCode: 'VND', lines },
      { type: 'fx_outflow', id: await fxRunSourceId(trx, ctx.tenantId, run.id) });
    await S.postVoucher(trx, v.id);
    voucherIds.push(v.id);
    await trx.updateTable('fx_run').set({ voucher_ids: voucherIds }).where('id', '=', run.id).execute();
  }
  return { runId: run.id, voucherIds, reversedVoucherIds: prev, groups: summary };
}
