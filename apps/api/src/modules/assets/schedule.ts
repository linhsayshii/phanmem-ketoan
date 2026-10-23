import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, Decimal, ZERO, buildSchedule, futurePeriods, periodUnits, type ActiveWindow, type DepreciationUnit, type PeriodSpan, type Proration, type ScheduleLine } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

// Lịch khấu hao/phân bổ theo phiên bản (quy ước 5 kế hoạch GĐ4). Số tiền luôn đọc từ sổ cái qua fn_asset_values_at; phiên bản chỉ là cách chia phần còn lại theo thời gian.
type Trx = Transaction<Database>;
export interface AssetSchedule { id: number; version: number; effYear: number; effPeriod: number; basisCost: string; basisAcc: string; units: string; reason: string }
type Asset = { code: string; tenant_id: string; kind: string; life_units: number | null; opening_year: number | null; opening_remaining_units: string | null; depreciation_start_date: string | null; decrease_date: string | null };

/** Khoảng hoạt động của thẻ: nơi duy nhất dựng cửa sổ (Task 5 thêm khoảng dừng từ asset_event). Chưa có ngày bắt đầu: không khấu hao. */
export function windowOf(a: { depreciation_start_date: string | null; decrease_date: string | null }): ActiveWindow | null {
  return a.depreciation_start_date ? { start: a.depreciation_start_date, end: a.decrease_date, pauses: [] } : null;
}
export const unitOf = (kind: string, proration: Proration): DepreciationUnit => (kind !== 'fixed' ? 'period' : proration === 'day' ? 'month_day' : 'month_whole');

const key = (y: number, p: number) => y * 100 + p;
const lineOut = (l: { fiscal_year: number; period_no: number; units: string; amount: string; accumulated: string }): ScheduleLine =>
  ({ fiscalYear: l.fiscal_year, periodNo: l.period_no, units: D(l.units).toString(), amount: l.amount, accumulated: l.accumulated });
const scheduleOut = (s: { id: number; version: number; eff_year: number; eff_period: number; basis_cost: string; basis_acc: string; units: string; reason: string }): AssetSchedule =>
  ({ id: s.id, version: s.version, effYear: s.eff_year, effPeriod: s.eff_period, basisCost: s.basis_cost, basisAcc: s.basis_acc, units: D(s.units).toString(), reason: s.reason });
const linesOf = (trx: Trx, ids: number[]) => trx.selectFrom('asset_schedule_line').select(['schedule_id', 'fiscal_year', 'period_no', 'units', 'amount', 'accumulated'])
  .where('schedule_id', 'in', ids).orderBy('fiscal_year').orderBy('period_no').execute();

async function loadAsset(trx: Trx, assetId: number): Promise<Asset> {
  const a = await trx.selectFrom('asset').select(['code', 'tenant_id', 'kind', 'life_units', 'opening_year', 'opening_remaining_units', 'depreciation_start_date', 'decrease_date']).where('id', '=', assetId).executeTakeFirst();
  if (!a) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  return a;
}

/**
 * Phiên bản lịch áp cho kỳ P và dòng của nó (quy ước 5). Phiên bản V (chưa bị thay, eff ≤ P, muộn nhất) dùng được khi
 * (a) nguyên giá tại P.to = V.basis_cost, (b) hao mòn tại P.to trừ các lần chạy kỳ P = V.basis_acc + Σ dòng V trước P
 * (CCDC/CPTT: giá trị trên 242 trừ lần chạy kỳ P + Σ dòng V trước P = V.basis_cost), (c) dòng V của P có units = units(P) tính lại
 * (V không có dòng P thì units(P) = 0 hoặc V đã tiêu thụ hết đơn vị). Sai một điều kiện: phiên bản mới eff = P, mọi phiên bản eff ≥ P bị thay.
 */
export async function scheduleFor(trx: Trx, assetId: number, span: PeriodSpan, opts: { proration: Proration; runIdsOfPeriod: string[] }): Promise<{ schedule: AssetSchedule; line: ScheduleLine | null; created: boolean }> {
  const a = await loadAsset(trx, assetId);
  const w = windowOf(a); const unit = unitOf(a.kind, opts.proration);
  const u = w ? periodUnits(span, w, unit) : '0';
  const val = (await sql<{ cost: string; accumulated: string }>`SELECT cost::text, accumulated::text FROM fn_asset_values_at(${a.tenant_id}::uuid, ${span.to}::date, ${opts.runIdsOfPeriod}::uuid[]) WHERE asset_id = ${assetId}`.execute(trx)).rows[0]!;
  const fixed = a.kind === 'fixed';
  const cost = D(val.cost); const acc = fixed ? D(val.accumulated) : ZERO;
  const P = key(span.fiscalYear, span.periodNo);

  const cur = await trx.selectFrom('asset_schedule').select(['id', 'version', 'eff_year', 'eff_period', 'basis_cost', 'basis_acc', 'units', 'reason']).where('asset_id', '=', assetId).where('superseded_at', 'is', null)
    .where(sql<boolean>`(eff_year, eff_period) <= (${span.fiscalYear}, ${span.periodNo})`).orderBy('eff_year', 'desc').orderBy('eff_period', 'desc').orderBy('version', 'desc').limit(1).executeTakeFirst();
  let units = ZERO; let reason = 'initial';
  if (cur) {
    const lines = await linesOf(trx, [cur.id]);
    const prior = lines.filter((l) => key(l.fiscal_year, l.period_no) < P);
    const amt = prior.reduce((s, l) => s.plus(l.amount), ZERO); const used = prior.reduce((s, l) => s.plus(l.units), ZERO);
    const line = lines.find((l) => key(l.fiscal_year, l.period_no) === P);
    const ledgerOk = fixed ? cost.eq(cur.basis_cost) && acc.eq(D(cur.basis_acc).plus(amt)) : cost.plus(amt).eq(cur.basis_cost);
    const unitsOk = line ? D(line.units).eq(u) : D(u).isZero() || used.gte(cur.units);
    if (ledgerOk && unitsOk) return { schedule: scheduleOut(cur), line: line ? lineOut(line) : null, created: false };
    reason = ledgerOk ? 'window_change' : 'ledger_change';
    units = Decimal.max(ZERO, D(cur.units).minus(used));
  }
  const known = (await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to']).where('period_no', '>=', 1).where('period_no', '<=', 12).execute())
    .map((p) => ({ fiscalYear: p.fiscal_year, periodNo: p.period_no, from: p.date_from, to: p.date_to }));
  if (!cur) {
    const life = a.opening_remaining_units ?? a.life_units;
    if (life === null) throw new AppError('ASSET_LIFE_MISSING', `Tài sản ${a.code} chưa có thời gian sử dụng (số tháng/số kỳ phân bổ)`, 409);
    // Phiên bản đầu lập ở lần chạy đầu tiên có tài sản: trừ đơn vị các kỳ từ ngày bắt đầu (tài sản nhập đầu kỳ: từ đầu năm nhập) đến trước P,
    // để thời gian sử dụng không trượt khi các kỳ đầu không có số (chưa ghi nguyên giá) nên không cần chạy.
    let elapsed = ZERO;
    if (w) {
      const y0 = a.opening_remaining_units !== null && a.opening_year !== null ? a.opening_year
        : known.find((p) => p.from <= w.start && w.start <= p.to)?.fiscalYear ?? Number(w.start.slice(0, 4));
      for (const p of y0 <= span.fiscalYear ? futurePeriods(known, y0, 1, (span.fiscalYear - y0 + 1) * 12) : []) if (key(p.fiscalYear, p.periodNo) < P) elapsed = elapsed.plus(periodUnits(p, w, unit));
    }
    units = Decimal.max(ZERO, D(life).minus(elapsed));
  }

  await trx.updateTable('asset_schedule').set({ superseded_at: sql`now()` }).where('asset_id', '=', assetId).where('superseded_at', 'is', null)
    .where(sql<boolean>`(eff_year, eff_period) >= (${span.fiscalYear}, ${span.periodNo})`).execute();
  const last = await trx.selectFrom('asset_schedule').select((eb) => eb.fn.max('version').as('v')).where('asset_id', '=', assetId).executeTakeFirst();
  const periods = futurePeriods(known, span.fiscalYear, span.periodNo, units.ceil().toNumber() + 12); // +12: kỳ đầu/cuối tiêu thụ lẻ đơn vị
  const lines = w ? buildSchedule({ basisValue: Decimal.max(ZERO, cost.minus(acc)).toFixed(0), basisAcc: acc.toFixed(0), units: units.toString(), periods, window: w, unit }) : [];
  const s = await trx.insertInto('asset_schedule').values({ tenant_id: a.tenant_id, asset_id: assetId, version: (last?.v ?? 0) + 1, eff_year: span.fiscalYear, eff_period: span.periodNo,
    basis_cost: cost.toFixed(0), basis_acc: acc.toFixed(0), units: units.toString(), reason }).returning(['id', 'version', 'eff_year', 'eff_period', 'basis_cost', 'basis_acc', 'units', 'reason']).executeTakeFirstOrThrow();
  if (lines.length) await trx.insertInto('asset_schedule_line').values(lines.map((l) => ({ tenant_id: a.tenant_id, schedule_id: s.id, fiscal_year: l.fiscalYear, period_no: l.periodNo, units: l.units, amount: l.amount, accumulated: l.accumulated }))).execute();
  return { schedule: scheduleOut(s), line: lines.find((l) => key(l.fiscalYear, l.periodNo) === P) ?? null, created: true };
}

/** Lịch hiện hành cho màn hình: mỗi phiên bản chưa bị thay cho các kỳ từ eff của nó đến trước eff của phiên bản kế tiếp. Chưa chạy kỳ nào: rỗng. */
export async function previewSchedule(trx: Trx, assetId: number): Promise<ScheduleLine[]> {
  await loadAsset(trx, assetId);
  const vs = await trx.selectFrom('asset_schedule').select(['id', 'eff_year', 'eff_period']).where('asset_id', '=', assetId).where('superseded_at', 'is', null).orderBy('eff_year').orderBy('eff_period').execute();
  if (!vs.length) return [];
  const lines = await linesOf(trx, vs.map((v) => v.id));
  return lines.filter((l) => {
    const i = vs.findIndex((v) => v.id === l.schedule_id); const next = vs[i + 1];
    const k = key(l.fiscal_year, l.period_no);
    return k >= key(vs[i]!.eff_year, vs[i]!.eff_period) && (!next || k < key(next.eff_year, next.eff_period));
  }).map(lineOut);
}
