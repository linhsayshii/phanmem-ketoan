import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, VND_AMOUNT_MSG, VND_AMOUNT_RE, type PeriodSpan } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { allocationInput, idOf, lockTenant, saveAsset, setAllocations } from './assets.js';
import { assertNoGap, buildLines, refreshRuns, runIdsOf, type Ctx, type RunKind } from './periodRun.js';
import { assetValues, scheduleFor } from './schedule.js';

// Biến động tài sản (quy ước 7, 9 và hợp đồng ghi sổ GĐ4): mỗi nghiệp vụ khóa tư vấn, kiểm kỳ của ngày nghiệp vụ ghi được, ghi asset_event
// (nhật ký kiểm toán qua audit_enable), chứng từ TS (source_doc_type 'asset_event') nếu có tiền, rồi chạy lại các lần chạy hiện có từ kỳ của ngày đó.
type Trx = Transaction<Database>;
type Line = { accountCode: string; debit: string; credit: string; assetCode?: string; partyCode?: string | null; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null; description?: string };
type AllocRow = { expense_account_code: string; department_id: number | null; project_id: number | null; cost_item_id: number | null; ratio: string };
// Giá trị trước/sau lưu trong asset_event.data, đọc lại khi hủy biến động.
type EventData = {
  before?: { use_date?: string | null; depreciation_start_date?: string | null; status?: string; decrease_date?: string | null; quantity?: string; departmentId?: number | null; allocations?: AllocRow[] };
  validFrom?: { year: number; period: number }; scheduleId?: number | null; toolAssetId?: number | null;
};
const RUN_KIND: Record<string, RunKind> = { fixed: 'depreciation', tool: 'tool', prepaid: 'prepaid' };
const vnd = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const units = z.string().regex(/^\d{1,4}(\.\d{1,12})?$/, 'Số đơn vị còn lại không hợp lệ').refine((s) => D(s).gt(0), 'Số đơn vị còn lại phải lớn hơn 0');
const allocLines = allocationInput.shape.lines;

export const increaseInput = z.object({
  date: dateIso, reason: z.enum(['construction', 'contribution', 'finance_lease', 'donation', 'other', 'purchase', 'stock']),
  counterAccountCode: z.string().min(1), amount: vnd.refine((s) => D(s).gt(0), 'Số tiền phải lớn hơn 0'), partyCode: z.string().nullable().optional(), description: z.string().max(500).nullable().optional(),
});
export const decreaseInput = z.object({
  date: dateIso, reason: z.enum(['liquidation', 'contribution', 'to_tool', 'loss', 'other']), counterAccountCode: z.string().min(1).optional(),
  toolCard: z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(200), periods: z.number().int().min(1).max(1200), allocations: allocLines, depreciationStartDate: dateIso.optional() }).optional(),
});
export const revalueInput = z.object({ date: dateIso, newCost: vnd, newAccumulated: vnd, remainingUnits: units.optional(), counterAccountCode: z.string().min(1).default('412') });
export const toolDecreaseInput = z.object({ date: dateIso, quantity: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số lượng không hợp lệ').refine((s) => D(s).gt(0), 'Số lượng ghi giảm phải lớn hơn 0').optional(), counterAccountCode: z.string().min(1), reason: z.string().max(500).nullable().optional() });
export const toolAdjustInput = z.object({ date: dateIso, delta: z.string().regex(/^-?\d{1,16}$/, VND_AMOUNT_MSG).refine((s) => !D(s).isZero(), 'Số tiền điều chỉnh phải khác 0'), counterAccountCode: z.string().min(1), partyCode: z.string().nullable().optional() });
export const transferInput = z.object({ date: dateIso, departmentCode: z.string().nullable(), allocations: allocLines });
export const suspendInput = z.object({ date: dateIso, reason: z.string().trim().min(1).max(500) });
export const resumeInput = z.object({ date: dateIso });
export const lifeInput = z.object({ date: dateIso, remainingUnits: units });

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const label = (s: PeriodSpan) => `Kỳ ${s.periodNo}/${s.fiscalYear}`;

async function periodAt(trx: Trx, ctx: Ctx, date: string): Promise<PeriodSpan> {
  const p = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to', 'status']).where('period_no', '>=', 1).where('period_no', '<=', 12)
    .where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ kế toán chứa ngày ${date}`, 404);
  const span = { fiscalYear: p.fiscal_year, periodNo: p.period_no, from: p.date_from, to: p.date_to };
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `${label(span)} đã khóa cứng: không ghi được nghiệp vụ tài sản ngày ${date}`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `${label(span)} đã khóa sổ, cần quyền ghi lùi ngày để ghi nghiệp vụ tài sản ngày ${date}`, 409);
  return span;
}
// Khóa (quy ước 9), thẻ (khóa dòng), kỳ của ngày nghiệp vụ ghi được.
async function begin(trx: Trx, ctx: Ctx, id: number, date: string, needActive = true) {
  await lockTenant(trx, ctx.tenantId);
  const a = await trx.selectFrom('asset').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!a) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  if (needActive && a.status === 'decreased') throw new AppError('ASSET_DECREASED', `Tài sản ${a.code} đã ghi giảm ngày ${a.decrease_date}`, 409);
  return { a, span: await periodAt(trx, ctx, date) };
}
async function tsVoucher(trx: Trx, ctx: Ctx, eventId: string, date: string, description: string, lines: Line[]): Promise<string | null> {
  const ls = lines.filter((l) => !D(l.debit).isZero() || !D(l.credit).isZero());
  if (!ls.length) return null;
  const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'TS', postingDate: date, documentDate: date, description, currencyCode: 'VND', lines: ls }, { type: 'asset_event', id: eventId });
  await S.postVoucher(trx, v.id);
  return v.id;
}
async function record(trx: Trx, ctx: Ctx, e: { id?: string; assetId: number; kind: string; date: string; voucherId?: string | null; data: object }): Promise<string> {
  const r = await trx.insertInto('asset_event').values({ ...(e.id ? { id: e.id } : {}), tenant_id: ctx.tenantId, asset_id: e.assetId, kind: e.kind, event_date: e.date, voucher_id: e.voucherId ?? null, data: JSON.stringify(e.data), created_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow();
  return r.id;
}
const refresh = (trx: Trx, ctx: Ctx, kind: string, span: PeriodSpan) => refreshRuns(trx, ctx, RUN_KIND[kind]!, span.fiscalYear, span.periodNo);
// Nợ/Có theo dấu: dương ghi bên `side`, âm ghi bên kia.
const signed = (accountCode: string, amount: ReturnType<typeof D>, side: 'debit' | 'credit', more: Partial<Line> = {}): Line => {
  const pos = amount.isNegative() ? (side === 'debit' ? 'credit' : 'debit') : side;
  return { accountCode, debit: pos === 'debit' ? amount.abs().toFixed(0) : '0', credit: pos === 'credit' ? amount.abs().toFixed(0) : '0', ...more };
};

/** Ghi tăng khác (XDCB, góp vốn, thuê tài chính, biếu tặng, khác): TS Nợ TK tài sản (A) / Có TK đối ứng; điền ngày sử dụng, ngày bắt đầu nếu trống. */
export async function increaseAsset(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof increaseInput>) {
  if (b.reason === 'purchase') throw new AppError('VALIDATION', 'Ghi tăng do mua sắm: lập chứng từ mua (hóa đơn mua, phiếu chi, giấy báo Nợ, phiếu kế toán) có mã tài sản trên dòng tài khoản tài sản', 400);
  if (b.reason === 'stock') throw new AppError('VALIDATION', 'Ghi tăng từ kho: lập Phiếu xuất kho có mã tài sản trên dòng hàng', 400);
  const { a, span } = await begin(trx, ctx, id, b.date);
  const before = { use_date: a.use_date, depreciation_start_date: a.depreciation_start_date };
  await trx.updateTable('asset').set({ use_date: a.use_date ?? b.date, depreciation_start_date: a.depreciation_start_date ?? b.date }).where('id', '=', id).execute();
  const eventId = randomUUID();
  const voucherId = await tsVoucher(trx, ctx, eventId, b.date, b.description ?? `Ghi tăng tài sản ${a.code}`, [
    { accountCode: a.asset_account_code, debit: b.amount, credit: '0', assetCode: a.code },
    { accountCode: b.counterAccountCode, debit: '0', credit: b.amount, partyCode: b.partyCode ?? null },
  ]);
  await record(trx, ctx, { id: eventId, assetId: id, kind: 'increase', date: b.date, voucherId, data: { reason: b.reason, amount: b.amount, counterAccountCode: b.counterAccountCode, partyCode: b.partyCode ?? null, before } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId };
}

/**
 * Ghi giảm ngày d trong kỳ P (quy ước 7): đánh dấu ghi giảm (tài sản ra khỏi lần chạy P và sau), chứng từ TS gồm [chế độ ngày: khấu hao từ P.from đến d − 1
 * theo phiên bản của P, Nợ chi phí theo phân bổ / Có 214x], Nợ 214x toàn bộ hao mòn, Nợ đối ứng (811; chuyển CCDC: 242 thẻ CCDC mới) giá trị còn lại, Có TK tài sản nguyên giá.
 * Giá trị tại d bỏ chứng từ các lần chạy kỳ P (sẽ chạy lại không còn tài sản). CCDC/CPTT: Nợ đối ứng / Có 242 toàn bộ giá trị còn lại.
 */
export async function decreaseAsset(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof decreaseInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  const fixed = a.kind === 'fixed';
  if (b.reason === 'to_tool' && (!fixed || !b.toolCard)) throw new AppError('VALIDATION', fixed ? 'Chuyển thành công cụ dụng cụ cần thông tin thẻ công cụ dụng cụ mới' : 'Chỉ tài sản cố định chuyển thành công cụ dụng cụ', 400);
  if (b.toolCard?.depreciationStartDate && b.toolCard.depreciationStartDate <= span.to)
    throw new AppError('VALIDATION', `Ngày bắt đầu phân bổ công cụ dụng cụ phải sau kỳ ghi giảm (sau ngày ${span.to})`, 400);
  const proration = (await getSettings(trx, ctx.tenantId)).fa_proration;
  const kind = RUN_KIND[a.kind]!;
  // Kỳ trước chưa chạy mà có số: lần chạy sau đó sẽ còn khấu hao tài sản đã xóa sổ (hao mòn khác 0 sau ghi giảm) → chạy kỳ đó trước.
  await assertNoGap(trx, kind, span, proration);
  await trx.updateTable('asset').set({ status: 'decreased', decrease_date: b.date }).where('id', '=', id).execute();

  let partial = '0';
  const runIds = await runIdsOf(trx, kind, span.fiscalYear, span.periodNo);
  if (fixed && a.is_depreciable && proration === 'day' && a.depreciation_start_date !== null && a.depreciation_start_date < b.date)
    partial = (await scheduleFor(trx, id, span, { proration, runIdsOfPeriod: runIds })).line?.amount ?? '0';
  const partialLines = D(partial).isZero() ? [] : await buildLines(trx, 'depreciation', span, [{ ...a, amount: partial }]);
  const v = (await assetValues(trx, ctx.tenantId, b.date, runIds, [id])).get(id)!;
  const cost = D(v.cost); const acc = fixed ? D(v.accumulated).plus(partial) : D(0);
  const nbv = cost.minus(acc);

  let tool: { id: number; code: string } | null = null;
  if (b.reason === 'to_tool') {
    const c = b.toolCard!;
    const start = c.depreciationStartDate ?? nextDay(span.to);
    const t = await saveAsset(trx, ctx.tenantId, null, { code: c.code, name: c.name, kind: 'tool', assetAccountCode: '242', departmentCode: null, useDate: b.date, depreciationStartDate: start, lifeUnits: c.periods, quantity: a.quantity });
    const next = span.periodNo === 12 ? { y: span.fiscalYear + 1, p: 1 } : { y: span.fiscalYear, p: span.periodNo + 1 };
    await setAllocations(trx, ctx.tenantId, t.id, { validFromYear: next.y, validFromPeriod: next.p, lines: c.allocations });
    tool = { id: t.id, code: t.code };
  }
  const counter = tool ? '242' : (b.counterAccountCode ?? '811');
  const eventId = randomUUID();
  const voucherId = await tsVoucher(trx, ctx, eventId, b.date, `Ghi giảm tài sản ${a.code}`, [
    ...partialLines,
    ...(fixed ? [signed(a.depreciation_account_code!, acc, 'debit', { assetCode: a.code })] : []),
    signed(counter, nbv, 'debit', tool ? { assetCode: tool.code } : {}),
    signed(a.asset_account_code, cost, 'credit', { assetCode: a.code }),
  ]);
  await record(trx, ctx, { id: eventId, assetId: id, kind: 'decrease', date: b.date, voucherId,
    data: { reason: b.reason, counterAccountCode: counter, partialDepreciation: partial, cost: cost.toFixed(0), accumulated: acc.toFixed(0), nbv: nbv.toFixed(0), toolAssetId: tool?.id ?? null, before: { status: a.status, decrease_date: a.decrease_date } } });
  await refresh(trx, ctx, a.kind, span);
  if (tool) await refreshRuns(trx, ctx, 'tool', span.fiscalYear, span.periodNo);
  return { eventId, voucherId, partialDepreciation: partial };
}

/**
 * Ghi giảm CCDC/CPTT một phần hoặc toàn bộ: giá trị ghi giảm = round_half_up(giá trị còn lại × số lượng giảm / số lượng thẻ), giá trị còn lại bỏ lần phân bổ kỳ P (chạy lại sau);
 * Nợ đối ứng / Có 242. Giảm hết số lượng → thẻ 'decreased'; giảm một phần → số lượng thẻ giảm, kỳ sau phân bổ phần còn lại trên số kỳ còn lại (phiên bản lịch mới).
 */
export async function decreaseTool(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof toolDecreaseInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  if (a.kind === 'fixed') throw new AppError('VALIDATION', 'Tài sản cố định ghi giảm bằng nghiệp vụ ghi giảm tài sản', 400);
  if (a.kind === 'prepaid' && b.quantity !== undefined) throw new AppError('VALIDATION', 'Chi phí trả trước không có số lượng, không ghi giảm một phần', 400);
  const q = b.quantity !== undefined ? D(b.quantity) : D(a.quantity);
  if (q.gt(a.quantity)) throw new AppError('ASSET_QUANTITY', `Số lượng ghi giảm ${q.toString()} lớn hơn số lượng còn lại ${D(a.quantity).toString()}`, 400);
  await assertNoGap(trx, RUN_KIND[a.kind]!, span, (await getSettings(trx, ctx.tenantId)).fa_proration);
  const nbv = D((await assetValues(trx, ctx.tenantId, b.date, await runIdsOf(trx, RUN_KIND[a.kind]!, span.fiscalYear, span.periodNo), [id])).get(id)!.cost);
  const all = q.eq(a.quantity);
  const value = all ? nbv : nbv.times(q).div(a.quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const left = D(a.quantity).minus(q).toString();
  await trx.updateTable('asset').set(all ? { status: 'decreased', decrease_date: b.date } : { quantity: left }).where('id', '=', id).execute();
  const eventId = randomUUID();
  const voucherId = await tsVoucher(trx, ctx, eventId, b.date, b.reason ?? `Ghi giảm ${a.code}`, [
    signed(b.counterAccountCode, value, 'debit'), signed(a.asset_account_code, value, 'credit', { assetCode: a.code })]);
  await record(trx, ctx, { id: eventId, assetId: id, kind: 'decrease', date: b.date, voucherId,
    data: { reason: 'tool', counterAccountCode: b.counterAccountCode, quantity: q.toString(), value: value.toFixed(0), nbv: nbv.toFixed(0), before: { status: a.status, decrease_date: a.decrease_date, quantity: a.quantity } } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId, value: value.toFixed(0) };
}

/** Điều chỉnh giá trị CCDC/CPTT (delta > 0 tăng: Nợ 242 / Có đối ứng; delta < 0 giảm); giá trị còn lại không được âm (không thấp hơn đã phân bổ). */
export async function adjustToolValue(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof toolAdjustInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  if (a.kind === 'fixed') throw new AppError('VALIDATION', 'Tài sản cố định điều chỉnh bằng nghiệp vụ đánh giá lại', 400);
  await assertNoGap(trx, RUN_KIND[a.kind]!, span, (await getSettings(trx, ctx.tenantId)).fa_proration);
  const nbv = D((await assetValues(trx, ctx.tenantId, b.date, await runIdsOf(trx, RUN_KIND[a.kind]!, span.fiscalYear, span.periodNo), [id])).get(id)!.cost);
  if (D(b.delta).gt(0)) { // lịch đã phân bổ hết số kỳ: phần tăng thêm không còn kỳ nào để chia (động cơ cho U = 0) → từ chối
    const cur = await trx.selectFrom('asset_schedule').select(['id', 'units']).where('asset_id', '=', id).where('superseded_at', 'is', null)
      .where(sql<boolean>`(eff_year, eff_period) <= (${span.fiscalYear}, ${span.periodNo})`).orderBy('eff_year', 'desc').orderBy('eff_period', 'desc').orderBy('version', 'desc').limit(1).executeTakeFirst();
    const used = cur ? (await trx.selectFrom('asset_schedule_line').select('units').where('schedule_id', '=', cur.id).where(sql<boolean>`(fiscal_year, period_no) < (${span.fiscalYear}, ${span.periodNo})`).execute()).reduce((x, l) => x.plus(l.units), D(0)) : D(0);
    if (cur && used.gte(cur.units)) throw new AppError('ASSET_SCHEDULE_ENDED', `${a.code} đã phân bổ hết số kỳ: tăng giá trị cần điều chỉnh thời gian sử dụng trước`, 400);
  }
  if (nbv.plus(b.delta).isNegative()) throw new AppError('VALIDATION', `Giảm giá trị ${D(b.delta).abs().toFixed(0)} làm giá trị thấp hơn số đã phân bổ (giá trị còn lại ${nbv.toFixed(0)})`, 400);
  const eventId = randomUUID();
  const voucherId = await tsVoucher(trx, ctx, eventId, b.date, `Điều chỉnh giá trị ${a.code}`, [
    signed(a.asset_account_code, D(b.delta), 'debit', { assetCode: a.code }), signed(b.counterAccountCode, D(b.delta), 'credit', { partyCode: b.partyCode ?? null })]);
  await record(trx, ctx, { id: eventId, assetId: id, kind: 'value_adjust', date: b.date, voucherId, data: { delta: b.delta, counterAccountCode: b.counterAccountCode, nbv: nbv.toFixed(0) } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId };
}

// Phiên bản lịch mới life_change eff = kỳ P với số đơn vị còn lại đã nhập (hủy biến động: thay mọi phiên bản eff ≥ P, động cơ dựng lại từ phiên bản trước).
async function lifeVersion(trx: Trx, ctx: Ctx, id: number, kind: string, span: PeriodSpan, remainingUnits: string) {
  const proration = (await getSettings(trx, ctx.tenantId)).fa_proration;
  return (await scheduleFor(trx, id, span, { proration, runIdsOfPeriod: await runIdsOf(trx, RUN_KIND[kind]!, span.fiscalYear, span.periodNo), lifeChange: remainingUnits })).schedule.id;
}

/** Đánh giá lại TSCĐ: chênh lệch nguyên giá và hao mòn so với sổ cái tại ngày đánh giá; đối ứng (412 mặc định) phần ròng; có số đơn vị còn lại thì điều chỉnh thời gian từ kỳ đó. */
export async function revalueAsset(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof revalueInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  if (a.kind !== 'fixed') throw new AppError('VALIDATION', 'Đánh giá lại chỉ áp dụng cho tài sản cố định', 400);
  if (D(b.newAccumulated).gt(b.newCost)) throw new AppError('VALIDATION', 'Hao mòn sau đánh giá lại không được lớn hơn nguyên giá sau đánh giá lại', 400);
  // Giá trị trước khấu hao kỳ P (bỏ lần chạy KH kỳ P, sẽ chạy lại): cùng chênh lệch dù KH kỳ P đã chạy hay chưa, kể cả ngày đánh giá là P.to.
  const v = (await assetValues(trx, ctx.tenantId, b.date, await runIdsOf(trx, 'depreciation', span.fiscalYear, span.periodNo), [id])).get(id)!;
  const dCost = D(b.newCost).minus(v.cost); const dAcc = D(b.newAccumulated).minus(v.accumulated);
  if (dCost.isZero() && dAcc.isZero() && !b.remainingUnits) throw new AppError('VALIDATION', 'Giá trị đánh giá lại bằng giá trị trên sổ, không có chênh lệch', 400);
  const eventId = randomUUID();
  const voucherId = await tsVoucher(trx, ctx, eventId, b.date, `Đánh giá lại tài sản ${a.code}`, [
    signed(a.asset_account_code, dCost, 'debit', { assetCode: a.code }),
    signed(a.depreciation_account_code!, dAcc, 'credit', { assetCode: a.code }),
    signed(b.counterAccountCode, dCost.minus(dAcc), 'credit'),
  ]);
  const scheduleId = b.remainingUnits ? await lifeVersion(trx, ctx, id, a.kind, span, b.remainingUnits) : null;
  await record(trx, ctx, { id: eventId, assetId: id, kind: 'revaluation', date: b.date, voucherId,
    data: { before: { cost: v.cost, accumulated: v.accumulated }, after: { cost: b.newCost, accumulated: b.newAccumulated }, counterAccountCode: b.counterAccountCode, remainingUnits: b.remainingUnits ?? null, scheduleId } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId };
}

/** Điều chuyển bộ phận: bộ phận của thẻ đổi, phân bổ chi phí mới hiệu lực từ kỳ của ngày điều chuyển; không chứng từ. */
export async function transferAsset(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof transferInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  const prev = await trx.selectFrom('asset_allocation').select(['expense_account_code', 'department_id', 'project_id', 'cost_item_id', 'ratio'])
    .where('asset_id', '=', id).where('valid_from_year', '=', span.fiscalYear).where('valid_from_period', '=', span.periodNo).orderBy('id').execute();
  await trx.updateTable('asset').set({ department_id: await idOf(trx, 'department', b.departmentCode, 'bộ phận') }).where('id', '=', id).execute();
  await setAllocations(trx, ctx.tenantId, id, { validFromYear: span.fiscalYear, validFromPeriod: span.periodNo, lines: b.allocations });
  const eventId = await record(trx, ctx, { assetId: id, kind: 'transfer', date: b.date,
    data: { before: { departmentId: a.department_id, allocations: prev }, after: { departmentCode: b.departmentCode, allocations: b.allocations }, validFrom: { year: span.fiscalYear, period: span.periodNo } } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId: null };
}

const lastPause = (trx: Trx, id: number) => trx.selectFrom('asset_event').select(['kind', 'event_date']).where('asset_id', '=', id).where('state', '=', 'active')
  .where('kind', 'in', ['suspend', 'resume']).orderBy('event_date', 'desc').orderBy('created_at', 'desc').limit(1).executeTakeFirst();

/** Dừng khấu hao từ ngày (ngày đó không khấu hao). */
export async function suspendAsset(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof suspendInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  const last = await lastPause(trx, id);
  if (last?.kind === 'suspend') throw new AppError('ASSET_SUSPENDED', `Tài sản ${a.code} đang dừng khấu hao từ ngày ${last.event_date}`, 409);
  if (last && b.date < last.event_date) throw new AppError('ASSET_PAUSE_ORDER', `Ngày dừng khấu hao phải sau ngày tiếp tục gần nhất ${last.event_date}`, 400);
  const eventId = await record(trx, ctx, { assetId: id, kind: 'suspend', date: b.date, data: { reason: b.reason } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId: null };
}
/** Tiếp tục khấu hao từ ngày (sau ngày dừng). */
export async function resumeAsset(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof resumeInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  const last = await lastPause(trx, id);
  if (last?.kind !== 'suspend') throw new AppError('ASSET_NOT_SUSPENDED', `Tài sản ${a.code} không đang dừng khấu hao`, 409);
  if (b.date <= last.event_date) throw new AppError('ASSET_PAUSE_ORDER', `Ngày tiếp tục khấu hao phải sau ngày dừng ${last.event_date}`, 400);
  const eventId = await record(trx, ctx, { assetId: id, kind: 'resume', date: b.date, data: { suspendedFrom: last.event_date } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId: null };
}

/** Điều chỉnh thời gian sử dụng: phiên bản lịch mới life_change từ kỳ của ngày, số đơn vị còn lại tính từ đầu kỳ đó. */
export async function changeLife(trx: Trx, ctx: Ctx, id: number, b: z.infer<typeof lifeInput>) {
  const { a, span } = await begin(trx, ctx, id, b.date);
  const scheduleId = await lifeVersion(trx, ctx, id, a.kind, span, b.remainingUnits);
  const eventId = await record(trx, ctx, { assetId: id, kind: 'life_change', date: b.date, data: { remainingUnits: b.remainingUnits, scheduleId } });
  await refresh(trx, ctx, a.kind, span);
  return { eventId, voucherId: null };
}

/** Hủy biến động: đảo chứng từ cùng ngày, khôi phục thẻ, chạy lại từ kỳ của ngày biến động. Còn biến động hiệu lực muộn hơn của cùng tài sản → 409. */
export async function cancelEvent(trx: Trx, ctx: Ctx, eventId: string) {
  await lockTenant(trx, ctx.tenantId);
  const e = await trx.selectFrom('asset_event').selectAll().where('id', '=', eventId).forUpdate().executeTakeFirst();
  if (!e) throw new AppError('ASSET_EVENT_NOT_FOUND', 'Không tìm thấy biến động tài sản', 404);
  if (e.state === 'cancelled') throw new AppError('ASSET_EVENT_CANCELLED', 'Biến động đã hủy', 409);
  const later = await trx.selectFrom('asset_event').select(['kind', 'event_date']).where('asset_id', '=', e.asset_id).where('state', '=', 'active').where('id', '<>', e.id)
    .where(sql<boolean>`(event_date > ${e.event_date}::date OR created_at > (SELECT x.created_at FROM asset_event x WHERE x.id = ${e.id}::uuid))`).orderBy('event_date', 'desc').limit(1).executeTakeFirst();
  if (later) throw new AppError('ASSET_EVENT_ORDER', `Tài sản còn biến động muộn hơn (ngày ${later.event_date}): hủy biến động đó trước`, 409);
  const { a, span } = await begin(trx, ctx, e.asset_id, e.event_date, false);
  const d = e.data as EventData;
  if (e.kind === 'decrease' && d.toolAssetId) { // thẻ CCDC sinh ra còn biến động hoặc đã phân bổ thì không hủy được (đảo 242 sẽ làm âm giá trị)
    const used = await trx.selectFrom('asset_event').select('id').where('asset_id', '=', d.toolAssetId).where('state', '=', 'active').limit(1).executeTakeFirst()
      ?? await trx.selectFrom('voucher_line as l').innerJoin('voucher as v', 'v.id', 'l.voucher_id').select('l.id').where('l.asset_id', '=', d.toolAssetId).where('l.posting_date', '>=', e.event_date).where('v.voucher_type', '=', 'PB').where('v.state', '=', 'posted').where('l.credit', '>', '0').limit(1).executeTakeFirst();
    if (used) throw new AppError('ASSET_EVENT_ORDER', 'Thẻ công cụ dụng cụ sinh ra từ ghi giảm này đã có biến động hoặc phân bổ: xử lý trước', 409);
  }
  if (e.voucher_id) await S.reverseVoucher(trx, e.voucher_id, { postingDate: e.event_date, description: `Hủy biến động tài sản ${a.code}` });
  if (e.kind === 'increase') {
    await trx.updateTable('asset').set({ use_date: d.before!.use_date ?? null, depreciation_start_date: d.before!.depreciation_start_date ?? null }).where('id', '=', a.id).execute();
  } else if (e.kind === 'decrease') {
    await trx.updateTable('asset').set({ status: d.before!.status ?? 'active', decrease_date: d.before!.decrease_date ?? null, ...(d.before!.quantity ? { quantity: d.before!.quantity } : {}) }).where('id', '=', a.id).execute();
  } else if (e.kind === 'transfer') {
    await trx.updateTable('asset').set({ department_id: d.before!.departmentId ?? null }).where('id', '=', a.id).execute();
    const vf = d.validFrom!; const rows = d.before!.allocations ?? [];
    await trx.deleteFrom('asset_allocation').where('asset_id', '=', a.id).where('valid_from_year', '=', vf.year).where('valid_from_period', '=', vf.period).execute();
    if (rows.length) await trx.insertInto('asset_allocation').values(rows.map((r) => ({ ...r, tenant_id: ctx.tenantId, asset_id: a.id, valid_from_year: vf.year, valid_from_period: vf.period }))).execute();
  }
  if (e.kind === 'life_change' || (e.kind === 'revaluation' && d.scheduleId)) // bỏ phiên bản điều chỉnh và các phiên bản dựng trên nó; lần chạy lại dựng từ phiên bản trước
    await trx.updateTable('asset_schedule').set({ superseded_at: sql`now()` }).where('asset_id', '=', a.id).where('superseded_at', 'is', null)
      .where(sql<boolean>`(eff_year, eff_period) >= (${span.fiscalYear}, ${span.periodNo})`).execute();
  await trx.updateTable('asset_event').set({ state: 'cancelled' }).where('id', '=', e.id).execute();
  await refresh(trx, ctx, a.kind, span);
  if (e.kind === 'decrease' && d.toolAssetId) await refreshRuns(trx, ctx, 'tool', span.fiscalYear, span.periodNo);
  return { eventId: e.id, state: 'cancelled' };
}

export async function listEvents(trx: Trx, assetId: number) {
  if (!(await trx.selectFrom('asset').select('id').where('id', '=', assetId).executeTakeFirst())) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  return (await trx.selectFrom('asset_event as e').leftJoin('voucher as v', 'v.id', 'e.voucher_id')
    .select(['e.id', 'e.kind', 'e.event_date', 'e.voucher_id', 'v.voucher_no', 'e.state', 'e.data', 'e.created_at']).where('e.asset_id', '=', assetId)
    .orderBy('e.event_date').orderBy('e.created_at').execute())
    .map((r) => ({ id: r.id, kind: r.kind, eventDate: r.event_date, voucherId: r.voucher_id, voucherNo: r.voucher_no, state: r.state, data: r.data, createdAt: r.created_at }));
}
