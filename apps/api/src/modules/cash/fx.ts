import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import type { FxRules } from '@kt/coa-data';
import { avgRate, D, formatVnDate, proportionalVnd, ZERO, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings, type Settings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { cashBalanceAt } from './books.js';

type Trx = Transaction<Database>;
type RateType = Settings['fx_rate_type'];
export const RATE_TYPE_LABEL: Record<RateType, string> = { transfer_avg: 'mua bán chuyển khoản trung bình', buy: 'mua', sell: 'bán' };

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

// Tính lại tỷ giá xuất quỹ và đánh giá lại ngoại tệ của một công ty chạy nối tiếp nhau (cùng một khóa): đánh giá lại đọc số dư tiền sau XQ, XQ bỏ qua DG trong kỳ.
export const fxLock = (trx: Trx, tenantId: string) => sql`SELECT pg_advisory_xact_lock(hashtext('fx'), hashtext(${tenantId}::text))`.execute(trx);

// Tài khoản lãi/lỗ tỷ giá của chế độ, đọc bảng fx_rule (đồng bộ từ fx-rules.json khi migrate) như hàm SQL đối trừ: một nguồn lúc chạy.
// Chế độ chưa có quy tắc thì 409. Chênh lệch tỷ giá đối trừ, xuất quỹ và đánh giá lại dùng chung.
export async function fxRulesFor(db: Kysely<Database>, regime: string): Promise<FxRules> {
  const r = await db.selectFrom('fx_rule').select('rules').where('regime', '=', regime).executeTakeFirst();
  if (!r) throw new AppError('FX_RULES_MISSING', `Chưa khai báo tài khoản lãi, lỗ chênh lệch tỷ giá cho chế độ kế toán ${regime}`, 409);
  return r.rules as FxRules;
}

export const adjustInput = z.object({ fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(15) });
interface TraversalRow { accountId: number; accountCode: string; bankAccountId: number | null; bankAccountNo: string | null; currency: string; inPeriod: boolean; isOut: boolean; debit: string; credit: string; cur: string }
interface Group { accountCode: string; bankAccountNo: string | null; currency: string; vnd: Decimal; cur: Decimal; diff: Decimal }

// Tính lại tỷ giá xuất quỹ bình quân di động của kỳ: duyệt dòng đã ghi sổ của từng (tài khoản tiền, tài khoản ngân hàng, loại tiền ngoại tệ) đến hết kỳ,
// theo (ngày, Nợ trước Có, lúc ghi sổ, dòng). Dòng Có trong kỳ có nguyên tệ là lần xuất: giá trị đúng = nguyên tệ × bình quân tại lúc xuất; dòng Có kỳ trước
// và dòng chỉ VND (nguyên tệ 0: điều chỉnh, đánh giá lại) giữ số đã ghi. Tổng lệch (đã ghi − đúng) khác 0 thì sinh một chứng từ XQ ngày cuối kỳ, mỗi nhóm một cặp dòng
// với 515/635. Chạy lại cùng kỳ đảo XQ của các lần trước (cùng ngày cuối kỳ) rồi sinh mới; kết quả không đổi thì không chạm sổ.
export async function runOutflowAdjust(trx: Trx, ctx: { tenantId: string; userId: string; canBackdate: boolean }, input: z.infer<typeof adjustInput>) {
  await fxLock(trx, ctx.tenantId);
  if ((await getSettings(trx, ctx.tenantId)).fx_outflow_method !== 'moving_average')
    throw new AppError('FX_OUTFLOW_METHOD_SPECIFIC', 'Công ty dùng tỷ giá xuất quỹ đích danh (cài đặt): không tính lại theo bình quân di động', 409);
  const { fiscalYear: fy, periodNo: pn } = input;
  const p = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to', 'status', 'regime']).where('fiscal_year', '=', fy).where('period_no', '=', pn).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${pn}/${fy}`, 404);
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${pn}/${fy} đã khóa cứng: không tính lại tỷ giá xuất quỹ`, 409);
  // Biến phiên ghi lùi do người gọi đặt (app.withOverride); ở đây chỉ báo lỗi sớm, rõ kỳ.
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${pn}/${fy} đã khóa sổ, cần quyền ghi lùi ngày`, 409);

  // XQ còn hiệu lực của các lần chạy trước cùng kỳ.
  const prev = (await sql<{ id: string }>`SELECT v.id FROM fx_run r CROSS JOIN LATERAL unnest(r.voucher_ids) AS u(id) JOIN voucher v ON v.id = u.id
    WHERE r.kind = 'outflow' AND r.fiscal_year = ${fy} AND r.period_no = ${pn} AND v.state = 'posted' ORDER BY r.id, v.id`.execute(trx)).rows.map((r) => r.id);

  const rows = (await sql<TraversalRow>`
    SELECT l.account_id AS "accountId", a.code AS "accountCode", l.bank_account_id AS "bankAccountId", ba.account_no AS "bankAccountNo", l.currency_code AS currency,
           (v.fiscal_year = ${fy} AND v.period_no = ${pn} AND (v.reversal_of_id IS NULL OR o.posting_date >= ${p.date_from}::date)) AS "inPeriod", (l.credit > 0 OR (l.debit = 0 AND l.amount_currency < 0)) AS "isOut",
           l.debit::text AS debit, l.credit::text AS credit, l.amount_currency::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id
    LEFT JOIN voucher o ON o.id = v.reversal_of_id LEFT JOIN voucher r ON r.id = v.reversed_by_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${p.date_to}::date AND a.regime = ${p.regime} AND a.subledger_kind IN ('cash', 'bank') AND l.currency_code <> 'VND'
      -- XQ của chính kỳ này và bản đảo của chúng (bản đảo có thể nằm ở kỳ sau khi kỳ này đã khóa sổ)
      AND NOT coalesce(v.source_doc_type = 'fx_outflow' AND coalesce(o.fiscal_year, v.fiscal_year) = ${fy} AND coalesce(o.period_no, v.period_no) = ${pn}, false)
      -- chứng từ gốc trong kỳ đã bị đảo trước hết kỳ: gốc và bản đảo triệt tiêu, không phải lần xuất quỹ. Chỉ ghép cặp với chứng từ gốc:
      -- đảo của một bản đảo là lần thu/chi thật, vẫn duyệt. Bản đảo của chứng từ kỳ trước giữ số đã ghi ("inPeriod" sai).
      AND NOT coalesce(o.reversal_of_id IS NULL AND o.posting_date >= ${p.date_from}::date, false)
      AND NOT coalesce(v.reversal_of_id IS NULL AND r.posting_date <= ${p.date_to}::date AND v.posting_date >= ${p.date_from}::date, false)
      -- đánh giá lại (DG, gốc và bản đảo) ghi trong kỳ: chạy sau XQ trên số dư đã điều chỉnh; DG cuối kỳ đứng trước phiếu chi cùng ngày (Nợ trước Có) sẽ làm lệch bình quân
      AND NOT coalesce(v.source_doc_type = 'fx_revaluation' AND v.posting_date BETWEEN ${p.date_from}::date AND ${p.date_to}::date, false)
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
  const rules = adjust.length ? await fxRulesFor(trx, p.regime) : undefined; // chỉ cần khi có điều chỉnh
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

  // Kết quả trùng hệt XQ đang hiệu lực (cùng nhóm, cùng số) thì không đảo, không sinh: chạy lại không đổi không chạm sổ của kỳ (kể cả kỳ đã khóa sổ).
  const keyOf = (x: { code: string; bankNo?: string | null | undefined; currency: string; debit: string; credit: string }) => `${x.code}|${x.bankNo ?? ''}|${x.currency}|${x.debit}|${x.credit}`;
  const active = prev.length ? (await sql<{ code: string; bankNo: string | null; currency: string; debit: string; credit: string }>`
    SELECT a.code, ba.account_no AS "bankNo", l.currency_code AS currency, l.debit::text AS debit, l.credit::text AS credit
    FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id WHERE l.voucher_id = ANY(${prev}::uuid[])`.execute(trx)).rows : [];
  const unchanged = active.map(keyOf).sort().join('\n') === lines.map((l) => keyOf({ code: l.accountCode, bankNo: l.bankAccountNo, currency: l.currencyCode, debit: l.debit, credit: l.credit })).sort().join('\n');
  const reversed = unchanged ? [] : prev;
  // Đảo ngày cuối kỳ, cùng kỳ với XQ mới; kỳ khóa sổ đã bật quyền ghi lùi ở trên.
  for (const id of reversed) await S.reverseVoucher(trx, id, { postingDate: p.date_to });

  const run = await trx.insertInto('fx_run').values({ tenant_id: ctx.tenantId, kind: 'outflow', fiscal_year: fy, period_no: pn, run_date: p.date_to, reversed_voucher_ids: reversed,
    params: JSON.stringify({ groups: summary, unchanged, ...(unchanged ? { note: 'không đổi' } : {}) }), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
  const voucherIds: string[] = [];
  if (lines.length && !unchanged) {
    const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'XQ', postingDate: p.date_to, documentDate: p.date_to, description: `Điều chỉnh tỷ giá xuất quỹ kỳ ${pn}/${fy}`, currencyCode: 'VND', lines },
      { type: 'fx_outflow', id: await fxRunSourceId(trx, ctx.tenantId, run.id) });
    await S.postVoucher(trx, v.id);
    voucherIds.push(v.id);
    await trx.updateTable('fx_run').set({ voucher_ids: voucherIds }).where('id', '=', run.id).execute();
  }
  // Kỳ sau cùng năm đã chạy: bình quân đầu kỳ của chúng có thể đã đổi, cần chạy lại theo thứ tự kỳ.
  const stalePeriods = (await trx.selectFrom('fx_run').select('period_no').distinct().where('kind', '=', 'outflow').where('fiscal_year', '=', fy).where('period_no', '>', pn)
    .orderBy('period_no').execute()).map((r) => r.period_no);
  // Đánh giá lại từ đầu kỳ trở đi tính trên số dư tiền trước lần điều chỉnh này: chạy lại đánh giá lại các ngày đó.
  const staleRevaluations = unchanged ? [] : (await trx.selectFrom('fx_run').select('run_date').distinct().where('kind', '=', 'revaluation').where('run_date', '>=', p.date_from)
    .orderBy('run_date').execute()).map((r) => r.run_date);
  return { runId: run.id, voucherIds, reversedVoucherIds: reversed, unchanged, stalePeriods, staleRevaluations, groups: summary };
}
