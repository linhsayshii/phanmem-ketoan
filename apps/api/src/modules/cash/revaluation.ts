import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import type { FxRules } from '@kt/coa-data';
import { D, formatVnDate, toVnd, ZERO } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { isoDate } from '../reporting/routes.js';
import { fxLock, fxRulesFor, fxRunSourceId, rateAt } from './fx.js';

type Trx = Transaction<Database>;
type Ctx = { tenantId: string; userId: string; canBackdate: boolean };
// rates: tỷ giá nhập tay theo loại tiền, dùng cho cả tài sản và nợ phải trả; loại tiền không nhập thì lấy tỷ giá theo ngày của loại cấu hình.
export const revaluationInput = z.object({ date: isoDate, rates: z.record(z.string().regex(/^[A-Z]{3}$/, 'Mã loại tiền gồm 3 chữ in hoa'), S.fxRate).optional() });
type Input = z.infer<typeof revaluationInput>;

// Một khoản mục tiền tệ có gốc ngoại tệ còn số dư nguyên tệ tại ngày: nhóm tiền (tài khoản, tài khoản ngân hàng, loại tiền) hoặc khoản công nợ gốc (dư VND gồm cả khoản con).
export interface RevaluationLine {
  kind: string | null; accountCode: string; bankAccountNo: string | null; partyCode: string | null; openItemId: number | null; docNo: string | null; currency: string;
  balanceCurrency: string; balance: string; rateType: string; rate: string; revalued: string; difference: string;
}
type Line = S.SystemVoucherInput['lines'][number];
interface CashRow { kind: string; accountCode: string; bankAccountNo: string | null; currency: string; balance: string; cur: string }
interface ItemRow { openItemId: number; kind: string | null; accountCode: string; partyCode: string; docNo: string | null; currency: string; dueDate: string | null; balance: string; cur: string }

// Tính đánh giá lại tại ngày (dùng cho xem trước và chạy thật). DG đang hiệu lực của các lần chạy trước cùng ngày được loại khỏi số dư, vì chạy lại sẽ đảo chúng cùng ngày.
async function compute(trx: Trx, ctx: Ctx, input: Input) {
  const { date } = input;
  const p = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'status', 'regime']).where('period_no', '>=', 1).where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${formatVnDate(date)} không thuộc kỳ kế toán nào`, 404);
  const label = `${p.period_no}/${p.fiscal_year}`;
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${label} đã khóa cứng: không đánh giá lại ngoại tệ`, 409);
  // Biến phiên ghi lùi do người gọi đặt (app.withOverride); ở đây chỉ báo lỗi sớm, rõ kỳ.
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${label} đã khóa sổ, cần quyền ghi lùi ngày`, 409);

  // DG còn hiệu lực của các lần chạy trước cùng ngày, theo thứ tự đã sinh.
  const prev = (await sql<{ id: string }>`SELECT v.id FROM fx_run r CROSS JOIN LATERAL unnest(r.voucher_ids) WITH ORDINALITY AS u(id, ord) JOIN voucher v ON v.id = u.id
    WHERE r.kind = 'revaluation' AND r.run_date = ${date}::date AND v.state = 'posted' ORDER BY r.id, u.ord`.execute(trx)).rows.map((r) => r.id);

  const cash = (await sql<CashRow>`
    SELECT a.subledger_kind AS kind, a.code AS "accountCode", ba.account_no AS "bankAccountNo", l.currency_code AS currency, sum(l.debit - l.credit)::text AS balance, sum(l.amount_currency)::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${date}::date AND a.regime = ${p.regime} AND a.subledger_kind IN ('cash', 'bank') AND l.currency_code <> 'VND'
      AND v.id <> ALL(${prev}::uuid[])
    GROUP BY a.subledger_kind, a.code, l.bank_account_id, ba.account_no, l.currency_code HAVING sum(l.amount_currency) <> 0
    ORDER BY a.code, ba.account_no NULLS FIRST, l.currency_code`.execute(trx)).rows;
  // Khoản công nợ gốc còn dư nguyên tệ; dư VND của nhóm = dư khoản gốc + dư các khoản con (đánh giá lại các kỳ trước).
  const items = (await sql<ItemRow>`
    WITH r AS (SELECT * FROM fn_open_items_at(${ctx.tenantId}::uuid, ${date}::date)),
    ch AS (SELECT o.parent_id, sum(r.residual) AS vnd FROM r JOIN open_item o ON o.id = r.item_id WHERE o.parent_id IS NOT NULL AND o.voucher_id <> ALL(${prev}::uuid[]) GROUP BY o.parent_id)
    SELECT o.id::int AS "openItemId", a.subledger_kind AS kind, a.code AS "accountCode", pa.code AS "partyCode", o.doc_no AS "docNo", o.currency_code AS currency, o.due_date AS "dueDate",
           (r.residual + coalesce(ch.vnd, 0))::text AS balance, r.residual_currency::text AS cur
    FROM r JOIN open_item o ON o.id = r.item_id JOIN account a ON a.id = o.account_id JOIN party pa ON pa.id = o.party_id LEFT JOIN ch ON ch.parent_id = o.id
    WHERE o.parent_id IS NULL AND o.currency_code <> 'VND' AND a.regime = ${p.regime} AND r.residual_currency <> 0
    ORDER BY a.code, pa.code, o.doc_date, o.id`.execute(trx)).rows;

  const settings = await getSettings(trx, ctx.tenantId);
  let rules: FxRules | undefined;
  const ruleSet = async () => (rules ??= await fxRulesFor(trx, p.regime));
  const ratesUsed = new Map<string, string>();
  // Tài sản (tiền, khoản dư Nợ) theo loại tỷ giá tài sản, nợ phải trả (khoản dư Có) theo loại tỷ giá nợ phải trả: cài đặt công ty, không có thì theo chế độ.
  const rateFor = async (currency: string, asset: boolean) => {
    const given = input.rates?.[currency];
    const rateType = given ? 'input' : asset ? settings.fx_reval_rate_asset ?? (await ruleSet()).assetRate : settings.fx_reval_rate_liability ?? (await ruleSet()).liabilityRate;
    const key = `${currency}|${rateType}`;
    let rate = ratesUsed.get(key);
    if (rate === undefined) ratesUsed.set(key, rate = given ?? (await rateAt(trx, ctx.tenantId, { currency, date, type: rateType as Exclude<typeof rateType, 'input'> })).rate);
    return { rateType, rate };
  };
  const rows: (RevaluationLine & { dueDate: string | null })[] = [];
  const add = async (r: Omit<RevaluationLine, 'balanceCurrency' | 'rateType' | 'rate' | 'revalued' | 'difference'> & { cur: string; balance: string; dueDate: string | null }, asset: boolean) => {
    const { cur, ...rest } = r;
    const { rateType, rate } = await rateFor(r.currency, asset);
    const revalued = toVnd(cur, rate);
    rows.push({ ...rest, balanceCurrency: cur, rateType, rate, revalued, difference: D(revalued).minus(r.balance).toFixed(0) });
  };
  for (const g of cash) await add({ ...g, partyCode: null, openItemId: null, docNo: null, dueDate: null }, true);
  for (const o of items) await add({ ...o, bankAccountNo: null }, D(o.cur).gt(0));

  // Chênh dương (tài sản tăng, nợ phải trả giảm) là lãi, chênh âm là lỗ. Dòng trên khoản mục: nguyên tệ 0, không tỷ giá; dòng công nợ là khoản con của khoản gốc (reval_of).
  const diffs = rows.filter((r) => r.difference !== '0');
  const gain = diffs.reduce((s, r) => (D(r.difference).gt(0) ? s.plus(r.difference) : s), ZERO);
  const loss = diffs.reduce((s, r) => (D(r.difference).lt(0) ? s.minus(r.difference) : s), ZERO);
  const main: Line[] = []; const transfer: Line[] = [];
  if (diffs.length) {
    const fx = await ruleSet();
    for (const r of diffs) {
      const d = D(r.difference); const amount = d.abs().toFixed(0);
      const what = r.openItemId ? `${r.docNo ?? ''} – ${r.partyCode}` : `${r.accountCode}${r.bankAccountNo ? ` – ${r.bankAccountNo}` : ''}`;
      main.push({ accountCode: r.accountCode, currencyCode: r.currency, amountCurrency: '0', debit: d.gt(0) ? amount : '0', credit: d.gt(0) ? '0' : amount, partyCode: r.partyCode,
        bankAccountNo: r.bankAccountNo, dueDate: r.dueDate, ...(r.openItemId && { extraDims: { reval_of: String(r.openItemId) } }), description: `Đánh giá lại ${what} ${r.currency} theo tỷ giá ${D(r.rate).toString()}` });
    }
    // Đối ứng: TK đánh giá lại (413, bên Có lãi, bên Nợ lỗ) rồi kết chuyển số ròng sang 515/635; chế độ không dùng 413 (TT99) thì ghi thẳng 515/635.
    const vnd = (accountCode: string, debit: string, credit: string, description: string): Line => ({ accountCode, currencyCode: 'VND', debit, credit, description });
    if (gain.gt(0)) main.push(vnd(fx.revalAccount ?? fx.gainAccount, '0', gain.toFixed(0), 'Lãi tỷ giá do đánh giá lại khoản mục tiền tệ có gốc ngoại tệ'));
    if (loss.gt(0)) main.push(vnd(fx.revalAccount ?? fx.lossAccount, loss.toFixed(0), '0', 'Lỗ tỷ giá do đánh giá lại khoản mục tiền tệ có gốc ngoại tệ'));
    const net = gain.minus(loss); const amount = net.abs().toFixed(0);
    if (fx.revalAccount && fx.transferToPnl && !net.isZero()) {
      const desc = `Kết chuyển ${net.gt(0) ? 'lãi' : 'lỗ'} tỷ giá do đánh giá lại`;
      transfer.push(...(net.gt(0) ? [vnd(fx.revalAccount, amount, '0', desc), vnd(fx.gainAccount, '0', amount, desc)] : [vnd(fx.lossAccount, amount, '0', desc), vnd(fx.revalAccount, '0', amount, desc)]));
    }
  }

  // Kết quả trùng hệt DG đang hiệu lực (cùng dòng, cùng số, cùng khoản gốc) thì không đảo, không sinh.
  const keyOf = (x: { code: string; bankNo?: string | null | undefined; party?: string | null | undefined; currency: string; debit: string; credit: string; revalOf?: string | null | undefined }) =>
    [x.code, x.bankNo ?? '', x.party ?? '', x.currency, x.debit, x.credit, x.revalOf ?? ''].join('|');
  const active = prev.length ? (await sql<{ code: string; bankNo: string | null; party: string | null; currency: string; debit: string; credit: string; revalOf: string | null }>`
    SELECT a.code, ba.account_no AS "bankNo", pa.code AS party, l.currency_code AS currency, l.debit::text AS debit, l.credit::text AS credit, l.extra_dims->>'reval_of' AS "revalOf"
    FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id LEFT JOIN party pa ON pa.id = l.party_id
    WHERE l.voucher_id = ANY(${prev}::uuid[])`.execute(trx)).rows : [];
  const unchanged = active.map(keyOf).sort().join('\n') === [...main, ...transfer].map((l) => keyOf({ code: l.accountCode, bankNo: l.bankAccountNo, party: l.partyCode, currency: l.currencyCode ?? 'VND',
    debit: l.debit, credit: l.credit, revalOf: l.extraDims?.reval_of })).sort().join('\n');
  // Chạy lại phải đảo DG cũ: khoản con đã được đối trừ (thu, trả sau đánh giá lại) thì người dùng hủy đối trừ trước, không tự hủy.
  if (!unchanged && prev.length) {
    const docs = (await sql<{ doc: string | null }>`SELECT DISTINCT po.doc_no AS doc FROM open_item o JOIN open_item po ON po.id = o.parent_id
      WHERE o.voucher_id = ANY(${prev}::uuid[]) AND EXISTS (SELECT 1 FROM settlement s WHERE s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) AND s.kind <> 'reversal')
      ORDER BY 1`.execute(trx)).rows.map((r) => r.doc ?? '(không số)');
    if (docs.length) throw new AppError('FX_REVALUATION_SETTLED', `Khoản điều chỉnh đánh giá lại ngày ${formatVnDate(date)} của chứng từ ${docs.join(', ')} đã được đối trừ: hãy hủy đối trừ các chứng từ đó trước rồi chạy lại đánh giá lại`, 409);
  }
  const totals = { gain: gain.toFixed(0), loss: loss.toFixed(0), net: gain.minus(loss).toFixed(0) };
  return { p, prev, rows, main, transfer, unchanged, totals, ratesUsed: Object.fromEntries(ratesUsed) };
}

// Xem trước: các khoản mục, tỷ giá, chênh lệch dự kiến; không ghi gì.
export async function previewRevaluation(trx: Trx, ctx: Ctx, input: Input) {
  const c = await compute(trx, ctx, input);
  return { dryRun: true, date: input.date, fiscalYear: c.p.fiscal_year, periodNo: c.p.period_no, unchanged: c.unchanged, totals: c.totals,
    lines: c.rows.map(({ dueDate: _, ...l }) => l) satisfies RevaluationLine[] };
}

// Đánh giá lại số dư ngoại tệ tại ngày: chứng từ DG (khoản mục / TK đánh giá lại hoặc 515, 635) và, nếu chế độ kết chuyển, DG thứ hai kết chuyển số ròng của TK đánh giá lại sang 515/635.
// Chạy lại cùng ngày đảo DG cũ cùng ngày (kỳ khóa sổ cần quyền ghi lùi) rồi sinh mới; kết quả không đổi thì không chạm sổ. Không tự đảo DG đầu kỳ sau.
export async function runRevaluation(trx: Trx, ctx: Ctx, input: Input) {
  await fxLock(trx, ctx.tenantId);
  const c = await compute(trx, ctx, input);
  const { date } = input;
  const reversed = c.unchanged ? [] : c.prev;
  for (const id of reversed) await S.reverseVoucher(trx, id, { postingDate: date });
  const run = await trx.insertInto('fx_run').values({ tenant_id: ctx.tenantId, kind: 'revaluation', fiscal_year: c.p.fiscal_year, period_no: c.p.period_no, run_date: date, reversed_voucher_ids: reversed,
    params: JSON.stringify({ rates: c.ratesUsed, totals: c.totals, unchanged: c.unchanged, ...(c.unchanged ? { note: 'không đổi' } : {}) }), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
  const voucherIds: string[] = [];
  if (!c.unchanged && c.main.length) {
    const source = { type: 'fx_revaluation', id: await fxRunSourceId(trx, ctx.tenantId, run.id) };
    const vn = formatVnDate(date);
    for (const [lines, description] of [[c.main, `Đánh giá lại số dư ngoại tệ ngày ${vn}`], [c.transfer, `Kết chuyển chênh lệch tỷ giá đánh giá lại ngày ${vn}`]] as const) {
      if (!lines.length) continue;
      const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'DG', postingDate: date, documentDate: date, description, currencyCode: 'VND', lines: [...lines] }, source);
      await S.postVoucher(trx, v.id);
      voucherIds.push(v.id);
    }
    await trx.updateTable('fx_run').set({ voucher_ids: voucherIds }).where('id', '=', run.id).execute();
  }
  // Đánh giá lại các ngày sau tính trên số dư (khoản con) cũ: chạy lại theo thứ tự ngày.
  const staleRevaluations = c.unchanged ? [] : (await trx.selectFrom('fx_run').select('run_date').distinct().where('kind', '=', 'revaluation').where('run_date', '>', date)
    .orderBy('run_date').execute()).map((r) => r.run_date);
  return { runId: run.id, date, voucherIds, reversedVoucherIds: reversed, unchanged: c.unchanged, staleRevaluations, totals: c.totals };
}
