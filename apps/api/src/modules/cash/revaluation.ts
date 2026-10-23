import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import type { FxRules } from '@kt/coa-data';
import { D, formatVnDate, sensitiveDenial, toVnd, ZERO } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { isoDate } from '../reporting/routes.js';
import { fxLock, fxRulesFor, fxRunSourceId, RATE_TYPE_LABEL, rateAt } from './fx.js';

type Trx = Transaction<Database>;
// sensitive: cờ dữ liệu nhạy cảm của người gọi; thiếu cờ của tài khoản thì thông báo lỗi, cảnh báo không nêu số chứng từ.
type Ctx = { tenantId: string; userId: string; canBackdate: boolean; sensitive: Set<string> };
// rates: tỷ giá nhập tay theo loại tiền, dùng cho cả tài sản và nợ phải trả; loại tiền không nhập thì lấy tỷ giá theo ngày của loại cấu hình.
export const revaluationInput = z.object({ date: isoDate, rates: z.record(z.string().regex(/^[A-Z]{3}$/, 'Mã loại tiền gồm 3 chữ in hoa'), S.fxRate).optional() });
type Input = z.infer<typeof revaluationInput>;

// Một khoản mục tiền tệ có gốc ngoại tệ còn số dư nguyên tệ tại ngày: nhóm tiền (tài khoản, tài khoản ngân hàng, loại tiền) hoặc khoản công nợ gốc (dư VND gồm cả khoản con).
export interface RevaluationLine {
  kind: string | null; accountCode: string; bankAccountNo: string | null; partyCode: string | null; openItemId: number | null; docNo: string | null; currency: string;
  balanceCurrency: string; balance: string; rateType: string; rate: string; revalued: string; difference: string; contractCode?: string | null;
}
type Line = S.SystemVoucherInput['lines'][number];
interface CashRow { kind: string; accountCode: string; bankAccountNo: string | null; currency: string; balance: string; cur: string }
interface LoanRow { accountCode: string; contractCode: string; partyCode: string | null; currency: string; balance: string; cur: string }
interface ItemRow { openItemId: number; kind: string | null; accountCode: string; partyCode: string; docNo: string | null; currency: string; dueDate: string | null; balance: string; cur: string;
  partyCur: string; settledAfter: boolean }

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

  const settings = await getSettings(trx, ctx.tenantId);
  // Tỷ giá xuất quỹ đích danh không có XQ: nhóm tiền hết nguyên tệ còn dư VND cũng kết chuyển ở đây (đánh giá lại về 0).
  const specific = settings.fx_outflow_method === 'specific';
  const cash = (await sql<CashRow>`
    SELECT a.subledger_kind AS kind, a.code AS "accountCode", ba.account_no AS "bankAccountNo", l.currency_code AS currency, sum(l.debit - l.credit)::text AS balance, sum(l.amount_currency)::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${date}::date AND a.regime = ${p.regime} AND a.subledger_kind IN ('cash', 'bank') AND l.currency_code <> 'VND'
      AND v.id <> ALL(${prev}::uuid[])
    GROUP BY a.subledger_kind, a.code, l.bank_account_id, ba.account_no, l.currency_code HAVING sum(l.amount_currency) <> 0 OR (${specific}::boolean AND sum(l.debit - l.credit) <> 0)
    ORDER BY a.code, ba.account_no NULLS FIRST, l.currency_code`.execute(trx)).rows;
  // Khế ước vay ngoại tệ: TK gốc vay và lãi phải trả (không theo dõi công nợ) theo từng khế ước, dòng có contract_id.
  const loans = (await sql<LoanRow>`
    SELECT a.code AS "accountCode", c.code AS "contractCode", pa.code AS "partyCode", l.currency_code AS currency, sum(l.debit - l.credit)::text AS balance, sum(l.amount_currency)::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id JOIN contract c ON c.id = l.contract_id AND c.kind = 'loan'
    JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id AND a.code IN (lt.principal_account_code, lt.interest_payable_account_code) LEFT JOIN party pa ON pa.id = c.party_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${date}::date AND a.regime = ${p.regime} AND a.subledger_kind IS NULL AND l.currency_code <> 'VND' AND v.id <> ALL(${prev}::uuid[])
    GROUP BY a.code, c.code, pa.code, l.currency_code HAVING sum(l.amount_currency) <> 0 ORDER BY a.code, c.code, l.currency_code`.execute(trx)).rows;
  // Khoản công nợ gốc còn dư nguyên tệ; dư VND của nhóm = dư khoản gốc + dư các khoản con (đánh giá lại các kỳ trước).
  // Khoản gốc đã đảo sau ngày vẫn đánh giá lại (còn dư tại ngày): khoản con sinh ra được đóng ngay sau khi ghi DG (closeReversedRoots).
  // settledAfter: đã đối trừ (không phải đảo) ngày sau ngày đánh giá lại. partyCur: dư nguyên tệ thuần của đối tượng trên tài khoản, loại tiền.
  const items = (await sql<ItemRow>`
    WITH r AS (SELECT * FROM fn_open_items_at(${ctx.tenantId}::uuid, ${date}::date)),
    ch AS (SELECT o.parent_id, sum(r.residual) AS vnd FROM r JOIN open_item o ON o.id = r.item_id WHERE o.parent_id IS NOT NULL AND o.voucher_id <> ALL(${prev}::uuid[]) GROUP BY o.parent_id),
    b AS (
      SELECT o.id, o.account_id, o.party_id, o.currency_code, o.doc_no, o.doc_date, o.due_date, a.subledger_kind, a.code, pa.code AS party_code,
             r.residual + coalesce(ch.vnd, 0) AS balance, r.residual_currency AS cur,
             EXISTS (SELECT 1 FROM settlement s WHERE s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) AND s.kind <> 'reversal'
               AND s.settle_date > ${date}::date AND s.amount_currency <> 0) AS settled_after
      FROM r JOIN open_item o ON o.id = r.item_id JOIN account a ON a.id = o.account_id JOIN party pa ON pa.id = o.party_id LEFT JOIN ch ON ch.parent_id = o.id
      WHERE o.parent_id IS NULL AND o.currency_code <> 'VND' AND a.regime = ${p.regime} AND r.residual_currency <> 0)
    SELECT id::int AS "openItemId", subledger_kind AS kind, code AS "accountCode", party_code AS "partyCode", doc_no AS "docNo", currency_code AS currency, due_date AS "dueDate",
           balance::text, cur::text, settled_after AS "settledAfter", sum(cur) OVER (PARTITION BY account_id, party_id, currency_code)::text AS "partyCur"
    FROM b ORDER BY code, party_code, doc_date, id`.execute(trx)).rows;

  let rules: FxRules | undefined;
  const ruleSet = async () => (rules ??= await fxRulesFor(trx, p.regime));
  const ratesUsed = new Map<string, { currency: string; rateType: string; rate: string; rateDate: string | null }>();
  // Tài sản (tiền, đối tượng dư Nợ thuần) theo loại tỷ giá tài sản, nợ phải trả (đối tượng dư Có thuần) theo loại tỷ giá nợ phải trả: cài đặt công ty, không có thì theo chế độ.
  const rateFor = async (currency: string, asset: boolean) => {
    const given = input.rates?.[currency];
    const rateType = given ? 'input' : asset ? settings.fx_reval_rate_asset ?? (await ruleSet()).assetRate : settings.fx_reval_rate_liability ?? (await ruleSet()).liabilityRate;
    const key = `${currency}|${rateType}`;
    let used = ratesUsed.get(key);
    if (!used) {
      const r = given ? { rate: given, rateDate: null } : await rateAt(trx, ctx.tenantId, { currency, date, type: rateType as Exclude<typeof rateType, 'input'> });
      ratesUsed.set(key, used = { currency, rateType, rate: r.rate, rateDate: r.rateDate });
    }
    return { rateType, rate: used.rate };
  };
  const rows: (RevaluationLine & { dueDate: string | null })[] = [];
  const add = async (r: Omit<RevaluationLine, 'balanceCurrency' | 'rateType' | 'rate' | 'revalued' | 'difference'> & { cur: string; balance: string; dueDate: string | null }, asset: boolean) => {
    const { cur, ...rest } = r;
    const { rateType, rate } = await rateFor(r.currency, asset);
    const revalued = toVnd(cur, rate);
    rows.push({ ...rest, balanceCurrency: cur, rateType, rate, revalued, difference: D(revalued).minus(r.balance).toFixed(0) });
  };
  for (const g of cash) await add({ ...g, partyCode: null, openItemId: null, docNo: null, dueDate: null }, true);
  for (const g of loans) await add({ ...g, kind: null, bankAccountNo: null, openItemId: null, docNo: null, dueDate: null }, D(g.cur).gt(0));
  const vn = formatVnDate(date);
  // Số chứng từ chỉ nêu khi người gọi có cờ xem mọi tài khoản liên quan.
  const docList = (xs: { kind: string | null; accountCode: string; docNo: string | null }[]) =>
    xs.some((x) => sensitiveDenial(ctx, { subledger_kind: x.kind, code: x.accountCode })) ? null : [...new Set(xs.map((x) => x.docNo ?? '(không số)'))].join(', ');
  const warnings: string[] = [];
  const after = new Set<number>(); // khoản gốc đã đối trừ sau ngày đánh giá lại
  for (const { partyCur, settledAfter, ...o } of items) {
    if (settledAfter) after.add(o.openItemId);
    // Khoản ứng trước (người mua trả trước: phải thu dư Có; trả trước người bán: phải trả dư Nợ) không phải khoản mục tiền tệ: bỏ cả đối tượng.
    // Còn lại mọi khoản của đối tượng theo một loại tỷ giá, theo dấu dư thuần (tài sản / nợ phải trả).
    const pc = D(partyCur);
    if ((o.kind === 'receivable' && pc.lt(0)) || (o.kind === 'payable' && pc.gt(0))) continue;
    await add({ ...o, bankAccountNo: null }, pc.isZero() ? o.kind !== 'payable' : pc.gt(0));
  }

  // Chênh dương (tài sản tăng, nợ phải trả giảm) là lãi, chênh âm là lỗ. Dòng trên khoản mục: nguyên tệ 0, không tỷ giá; dòng công nợ là khoản con của khoản gốc (reval_of).
  const diffs = rows.filter((r) => r.difference !== '0');
  const gain = diffs.reduce((s, r) => (D(r.difference).gt(0) ? s.plus(r.difference) : s), ZERO);
  const loss = diffs.reduce((s, r) => (D(r.difference).lt(0) ? s.minus(r.difference) : s), ZERO);
  const main: Line[] = []; const transfer: Line[] = [];
  if (diffs.length) {
    const fx = await ruleSet();
    for (const r of diffs) {
      const d = D(r.difference); const amount = d.abs().toFixed(0);
      const what = r.openItemId ? `${r.docNo ?? ''} – ${r.partyCode}` : `${r.accountCode}${r.bankAccountNo ? ` – ${r.bankAccountNo}` : ''}${r.contractCode ? ` – ${r.contractCode}` : ''}`;
      main.push({ accountCode: r.accountCode, currencyCode: r.currency, amountCurrency: '0', debit: d.gt(0) ? amount : '0', credit: d.gt(0) ? '0' : amount, partyCode: r.partyCode,
        bankAccountNo: r.bankAccountNo, dueDate: r.dueDate, contractCode: r.contractCode ?? null, ...(r.openItemId && { extraDims: { reval_of: String(r.openItemId) } }), description: `Đánh giá lại ${what} ${r.currency} theo tỷ giá ${D(r.rate).toString()}` });
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
  const keyOf = (x: { code: string; bankNo?: string | null | undefined; party?: string | null | undefined; currency: string; debit: string; credit: string; revalOf?: string | null | undefined; contract?: string | null | undefined }) =>
    [x.code, x.bankNo ?? '', x.party ?? '', x.currency, x.debit, x.credit, x.revalOf ?? '', x.contract ?? ''].join('|');
  const active = prev.length ? (await sql<{ code: string; bankNo: string | null; party: string | null; currency: string; debit: string; credit: string; revalOf: string | null; contract: string | null }>`
    SELECT a.code, ba.account_no AS "bankNo", pa.code AS party, l.currency_code AS currency, l.debit::text AS debit, l.credit::text AS credit, l.extra_dims->>'reval_of' AS "revalOf", k.code AS contract
    FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN bank_account ba ON ba.id = l.bank_account_id LEFT JOIN party pa ON pa.id = l.party_id LEFT JOIN contract k ON k.id = l.contract_id
    WHERE l.voucher_id = ANY(${prev}::uuid[])`.execute(trx)).rows : [];
  const unchanged = active.map(keyOf).sort().join('\n') === [...main, ...transfer].map((l) => keyOf({ code: l.accountCode, bankNo: l.bankAccountNo, party: l.partyCode, currency: l.currencyCode ?? 'VND',
    debit: l.debit, credit: l.credit, revalOf: l.extraDims?.reval_of, contract: l.contractCode })).sort().join('\n');
  if (!unchanged) {
    // Chạy lại phải đảo DG cũ: khoản con đã được đối trừ (thu, trả sau đánh giá lại) thì người dùng hủy đối trừ trước, không tự hủy.
    // Khoản con đóng do đảo khoản gốc (đối trừ 'reversal') không tính: DG cũ vẫn đảo được, bản đảo của khoản con được đóng lại cùng khoản con mới.
    if (prev.length) {
      const settled = (await sql<{ kind: string | null; accountCode: string; docNo: string | null }>`SELECT DISTINCT a.subledger_kind AS kind, a.code AS "accountCode", po.doc_no AS "docNo"
        FROM open_item o JOIN open_item po ON po.id = o.parent_id JOIN account a ON a.id = po.account_id
        WHERE o.voucher_id = ANY(${prev}::uuid[]) AND EXISTS (SELECT 1 FROM settlement s WHERE s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) AND s.kind <> 'reversal')
        ORDER BY 3`.execute(trx)).rows;
      const docs = docList(settled);
      if (settled.length) throw new AppError('FX_REVALUATION_SETTLED', docs ? `Khoản điều chỉnh đánh giá lại ngày ${vn} của chứng từ ${docs} đã được đối trừ: hãy hủy đối trừ các chứng từ đó trước rồi chạy lại đánh giá lại`
        : `Khoản điều chỉnh đánh giá lại ngày ${vn} đã được đối trừ: hãy hủy đối trừ các khoản đó trước rồi chạy lại đánh giá lại`, 409);
    }
    // Khoản gốc có chênh lệch đã đối trừ ngày sau ngày đánh giá lại (lập trước lần chạy): khoản con sinh sau sẽ không đối trừ được cùng khoản gốc (lãi lỗ khống, dư kẹt).
    const hit = rows.filter((r) => r.openItemId && after.has(r.openItemId) && r.difference !== '0');
    if (hit.length) {
      const docs = docList(hit);
      throw new AppError('FX_REVALUATION_SETTLED_AFTER', `${docs ? `Khoản công nợ của chứng từ ${docs}` : 'Có khoản công nợ'} đã được đối trừ sau ngày ${vn}: hủy đối trừ các chứng từ sau ngày ${vn}, chạy đánh giá lại, rồi đối trừ lại`, 409);
    }
  }
  const totals = { gain: gain.toFixed(0), loss: loss.toFixed(0), net: gain.minus(loss).toFixed(0) };
  const rates = [...ratesUsed.values()];
  // Tỷ giá lấy theo ngày gần nhất đến ngày đánh giá lại: ngày tỷ giá trước đó thì cảnh báo, không chặn.
  for (const r of rates) if (r.rateDate && r.rateDate < date)
    warnings.push(`Tỷ giá ${RATE_TYPE_LABEL[r.rateType as keyof typeof RATE_TYPE_LABEL]} của ${r.currency} lấy ngày ${formatVnDate(r.rateDate)}, trước ngày đánh giá lại ${vn}`);
  return { p, prev, rows, main, transfer, unchanged, totals, rates, warnings };
}

// Xem trước: các khoản mục, tỷ giá, chênh lệch dự kiến; không ghi gì.
export async function previewRevaluation(trx: Trx, ctx: Ctx, input: Input) {
  const c = await compute(trx, ctx, input);
  return { dryRun: true, date: input.date, fiscalYear: c.p.fiscal_year, periodNo: c.p.period_no, unchanged: c.unchanged, totals: c.totals, rates: c.rates, warnings: c.warnings,
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
    params: JSON.stringify({ rates: c.rates, totals: c.totals, unchanged: c.unchanged, warnings: c.warnings, ...(c.unchanged ? { note: 'không đổi' } : {}) }), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
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
  if (!c.unchanged) await closeReversedRoots(trx, ctx.tenantId);
  // Đánh giá lại các ngày sau tính trên số dư (khoản con) cũ: chạy lại theo thứ tự ngày.
  const staleRevaluations = c.unchanged ? [] : (await trx.selectFrom('fx_run').select('run_date').distinct().where('kind', '=', 'revaluation').where('run_date', '>', date)
    .orderBy('run_date').execute()).map((r) => r.run_date);
  return { runId: run.id, date, voucherIds, reversedVoucherIds: reversed, unchanged: c.unchanged, staleRevaluations, totals: c.totals, rates: c.rates, warnings: c.warnings };
}

// Khoản gốc đã đóng bằng đảo chứng từ mà còn khoản con dư ≠ 0 (khoản con của DG vừa ghi, hoặc bản đảo của khoản con cũ đã đóng khi đảo khoản gốc):
// đóng như lúc đảo, trong nhóm và ngày của dòng đối trừ 'reversal' của khoản gốc; phần chênh thành chứng từ CL ngày greatest(ngày đảo, ngày DG).
async function closeReversedRoots(trx: Trx, tenantId: string) {
  const roots = (await sql<{ id: number; g: string; d: string }>`SELECT DISTINCT ON (o.id) o.id::int AS id, s.group_id::text AS g, s.settle_date::text AS d
    FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) AND s.kind = 'reversal'
    WHERE o.tenant_id = ${tenantId}::uuid AND o.parent_id IS NULL
      AND EXISTS (SELECT 1 FROM open_item c CROSS JOIN LATERAL fn_open_item_residual(c.id) x WHERE c.tenant_id = o.tenant_id AND c.parent_id = o.id AND x.vnd <> 0)
    ORDER BY o.id, s.settle_date`.execute(trx)).rows;
  for (const r of roots) await sql`SELECT fn_open_items_close_reval_children(${r.id}::bigint, ${r.g}::uuid, ${r.d}::date)`.execute(trx);
}
