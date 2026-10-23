import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, Decimal, ZERO, buildSchedule, futurePeriods, periodUnits, type ActiveWindow, type DepreciationUnit, type PeriodSpan, type Proration, type ScheduleLine } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

// Lịch khấu hao/phân bổ theo phiên bản (quy ước 5 kế hoạch GĐ4). Số tiền luôn đọc từ sổ cái qua fn_asset_values_at; phiên bản chỉ là cách chia phần còn lại theo thời gian.
type Trx = Transaction<Database>;
export interface AssetSchedule { id: number; version: number; effYear: number; effPeriod: number; basisCost: string; basisAcc: string; units: string; reason: string }
type Asset = { code: string; tenant_id: string; kind: string; is_depreciable: boolean; life_units: number | null; opening_year: number | null; opening_remaining_units: string | null; depreciation_start_date: string | null; decrease_date: string | null };

/**
 * Khoảng hoạt động của thẻ: nơi duy nhất dựng cửa sổ. Bắt đầu ngày bắt đầu khấu hao, kết thúc ngày ghi giảm, khoảng dừng từ các biến động
 * dừng/tiếp tục còn hiệu lực (theo ngày; dừng mở khoảng, tiếp tục đóng khoảng đang mở). Chưa có ngày bắt đầu: không khấu hao.
 */
export async function windowOf(trx: Trx, assetId: number, a: { depreciation_start_date: string | null; decrease_date: string | null }): Promise<ActiveWindow | null> {
  if (!a.depreciation_start_date) return null;
  const evs = await trx.selectFrom('asset_event').select(['kind', 'event_date']).where('asset_id', '=', assetId).where('state', '=', 'active')
    .where('kind', 'in', ['suspend', 'resume']).orderBy('event_date').orderBy('created_at').execute();
  const pauses: ActiveWindow['pauses'] = [];
  for (const e of evs) {
    const open = pauses.at(-1);
    if (e.kind === 'suspend') pauses.push({ from: e.event_date, to: null });
    else if (open && open.to === null) open.to = e.event_date;
  }
  return { start: a.depreciation_start_date, end: a.decrease_date, pauses };
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
  const a = await trx.selectFrom('asset').select(['code', 'tenant_id', 'kind', 'is_depreciable', 'life_units', 'opening_year', 'opening_remaining_units', 'depreciation_start_date', 'decrease_date']).where('id', '=', assetId).executeTakeFirst();
  if (!a) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  return a;
}

const RUN_KIND: Record<string, string> = { fixed: 'depreciation', tool: 'tool', prepaid: 'prepaid' };
const knownPeriods = async (trx: Trx): Promise<PeriodSpan[]> => (await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to'])
  .where('period_no', '>=', 1).where('period_no', '<=', 12).orderBy('fiscal_year').orderBy('period_no').execute())
  .map((p) => ({ fiscalYear: p.fiscal_year, periodNo: p.period_no, from: p.date_from, to: p.date_to }));

/** Nguyên giá, hao mòn của các tài sản tại ngày (quy ước 1), bỏ chứng từ của các lần chạy đã cho. */
export async function assetValues(trx: Trx, tenantId: string, date: string, excludeRuns: string[], assetIds: number[]): Promise<Map<number, { cost: string; accumulated: string }>> {
  if (!assetIds.length) return new Map();
  const r = await sql<{ asset_id: number; cost: string; accumulated: string }>`SELECT asset_id::int, cost::text, accumulated::text FROM fn_asset_values_at(${tenantId}::uuid, ${date}::date, ${excludeRuns}::uuid[])
    WHERE asset_id = ANY (${assetIds}::bigint[])`.execute(trx);
  return new Map(r.rows.map((x) => [x.asset_id, { cost: x.cost, accumulated: x.accumulated }]));
}

type Cur = { id: number; version: number; eff_year: number; eff_period: number; basis_cost: string; basis_acc: string; units: string; reason: string };
type Plan = { values: { cost: string; accumulated: string }; cur: Cur | undefined; line: ScheduleLine | null }
  & ({ ok: true } | { ok: false; next: { basisCost: string; basisAcc: string; units: string; reason: string; lines: ScheduleLine[] } });

/**
 * Kiểm phiên bản lịch áp cho kỳ P (quy ước 5), không ghi gì. Phiên bản V (chưa bị thay, eff ≤ P, muộn nhất) dùng được khi
 * (a) nguyên giá tại ngày đọc = V.basis_cost, (b) hao mòn tại ngày đọc trừ các lần chạy kỳ P = V.basis_acc + Σ dòng V trước P
 * (CCDC/CPTT: giá trị trên 242 trừ lần chạy kỳ P + Σ dòng V trước P = V.basis_cost), (c) dòng V của P có units = units(P) tính lại
 * (V không có dòng P thì units(P) = 0 hoặc V đã tiêu thụ hết đơn vị). Sai một điều kiện: trả phiên bản mới eff = P (chưa lưu).
 * Ngày đọc sổ cái là P.to khi chạy kỳ; lịch xem trước đọc toàn bộ sổ cái.
 */
async function plan(trx: Trx, assetId: number, a: Asset, span: PeriodSpan, o: { proration: Proration; runIdsOfPeriod: string[]; valuesAt: string; known: PeriodSpan[]; lifeChange?: string | undefined }): Promise<Plan> {
  const w = await windowOf(trx, assetId, a); const unit = unitOf(a.kind, o.proration);
  const u = w ? periodUnits(span, w, unit) : '0';
  const values = (await assetValues(trx, a.tenant_id, o.valuesAt, o.runIdsOfPeriod, [assetId])).get(assetId)!;
  const fixed = a.kind === 'fixed';
  const cost = D(values.cost); const acc = fixed ? D(values.accumulated) : ZERO;
  const P = key(span.fiscalYear, span.periodNo);

  const cur = await trx.selectFrom('asset_schedule').select(['id', 'version', 'eff_year', 'eff_period', 'basis_cost', 'basis_acc', 'units', 'reason']).where('asset_id', '=', assetId).where('superseded_at', 'is', null)
    .where(sql<boolean>`(eff_year, eff_period) <= (${span.fiscalYear}, ${span.periodNo})`).orderBy('eff_year', 'desc').orderBy('eff_period', 'desc').orderBy('version', 'desc').limit(1).executeTakeFirst();
  let units = ZERO; let reason = 'initial';
  if (o.lifeChange !== undefined) { units = D(o.lifeChange); reason = 'life_change'; } // điều chỉnh thời gian: phiên bản mới eff = P, U = số đơn vị còn lại người dùng nhập
  else if (cur) {
    const lines = await linesOf(trx, [cur.id]);
    const prior = lines.filter((l) => key(l.fiscal_year, l.period_no) < P);
    const amt = prior.reduce((s, l) => s.plus(l.amount), ZERO); const used = prior.reduce((s, l) => s.plus(l.units), ZERO);
    const line = lines.find((l) => key(l.fiscal_year, l.period_no) === P);
    const ledgerOk = fixed ? cost.eq(cur.basis_cost) && acc.eq(D(cur.basis_acc).plus(amt)) : cost.plus(amt).eq(cur.basis_cost);
    const unitsOk = line ? D(line.units).eq(u) : D(u).isZero() || used.gte(cur.units);
    if (ledgerOk && unitsOk) return { values, cur, line: line ? lineOut(line) : null, ok: true };
    reason = ledgerOk ? 'window_change' : 'ledger_change';
    units = Decimal.max(ZERO, D(cur.units).minus(used));
  } else {
    const life = a.opening_remaining_units ?? a.life_units;
    if (life === null) throw new AppError('ASSET_LIFE_MISSING', `Tài sản ${a.code} chưa có thời gian sử dụng (số tháng/số kỳ phân bổ)`, 409);
    // Phiên bản đầu lập ở lần chạy đầu tiên có tài sản: trừ đơn vị các kỳ từ ngày bắt đầu (tài sản nhập đầu kỳ: từ đầu năm nhập) đến trước P,
    // để thời gian sử dụng không trượt khi các kỳ đầu không có số (chưa ghi nguyên giá) nên không cần chạy.
    let elapsed = ZERO;
    if (w) {
      const y0 = a.opening_remaining_units !== null && a.opening_year !== null ? a.opening_year : startYear(o.known, w.start);
      for (const p of y0 <= span.fiscalYear ? futurePeriods(o.known, y0, 1, (span.fiscalYear - y0 + 1) * 12) : []) if (key(p.fiscalYear, p.periodNo) < P) elapsed = elapsed.plus(periodUnits(p, w, unit));
    }
    units = Decimal.max(ZERO, D(life).minus(elapsed));
  }
  const periods = futurePeriods(o.known, span.fiscalYear, span.periodNo, units.ceil().toNumber() + 12); // +12: kỳ đầu/cuối tiêu thụ lẻ đơn vị
  const lines = w ? buildSchedule({ basisValue: Decimal.max(ZERO, cost.minus(acc)).toFixed(0), basisAcc: acc.toFixed(0), units: units.toString(), periods, window: w, unit }) : [];
  return { values, cur, line: lines.find((l) => key(l.fiscalYear, l.periodNo) === P) ?? null, ok: false,
    next: { basisCost: cost.toFixed(0), basisAcc: acc.toFixed(0), units: units.toString(), reason, lines } };
}
const startYear = (known: PeriodSpan[], start: string) => known.find((p) => p.from <= start && start <= p.to)?.fiscalYear ?? Number(start.slice(0, 4));

/** Phiên bản lịch áp cho kỳ P và dòng của nó; lệch thì lưu phiên bản mới eff = P và thay mọi phiên bản eff ≥ P. `values`: số sổ cái đã dùng (dấu vân tay của lần chạy). */
export async function scheduleFor(trx: Trx, assetId: number, span: PeriodSpan, opts: { proration: Proration; runIdsOfPeriod: string[]; lifeChange?: string }): Promise<{ schedule: AssetSchedule; line: ScheduleLine | null; created: boolean; values: { cost: string; accumulated: string } }> {
  const a = await loadAsset(trx, assetId);
  const r = await plan(trx, assetId, a, span, { ...opts, valuesAt: span.to, known: await knownPeriods(trx) });
  if (r.ok) return { schedule: scheduleOut(r.cur!), line: r.line, created: false, values: r.values };
  await trx.updateTable('asset_schedule').set({ superseded_at: sql`now()` }).where('asset_id', '=', assetId).where('superseded_at', 'is', null)
    .where(sql<boolean>`(eff_year, eff_period) >= (${span.fiscalYear}, ${span.periodNo})`).execute();
  const last = await trx.selectFrom('asset_schedule').select((eb) => eb.fn.max('version').as('v')).where('asset_id', '=', assetId).executeTakeFirst();
  const n = r.next;
  const s = await trx.insertInto('asset_schedule').values({ tenant_id: a.tenant_id, asset_id: assetId, version: (last?.v ?? 0) + 1, eff_year: span.fiscalYear, eff_period: span.periodNo,
    basis_cost: n.basisCost, basis_acc: n.basisAcc, units: n.units, reason: n.reason }).returning(['id', 'version', 'eff_year', 'eff_period', 'basis_cost', 'basis_acc', 'units', 'reason']).executeTakeFirstOrThrow();
  if (n.lines.length) await trx.insertInto('asset_schedule_line').values(n.lines.map((l) => ({ tenant_id: a.tenant_id, schedule_id: s.id, fiscal_year: l.fiscalYear, period_no: l.periodNo, units: l.units, amount: l.amount, accumulated: l.accumulated }))).execute();
  return { schedule: scheduleOut(s), line: r.line, created: true, values: r.values };
}

/**
 * Lịch hiện hành cho màn hình (chỉ đọc, không lưu): các phiên bản chưa bị thay cho các kỳ đã chạy, từ kỳ chưa chạy kế tiếp P* (sau lần chạy hiệu lực muộn nhất
 * của loại, không trước kỳ bắt đầu) là lịch sẽ áp nếu chạy với toàn bộ sổ cái hiện có: phiên bản hiện hành nếu còn khớp, nếu không thì phiên bản mới tính trong bộ nhớ.
 */
export async function previewSchedule(trx: Trx, assetId: number, proration: Proration): Promise<ScheduleLine[]> {
  const a = await loadAsset(trx, assetId);
  const w = await windowOf(trx, assetId, a);
  if (!w || !a.is_depreciable) return [];
  const known = await knownPeriods(trx);
  const y0 = startYear(known, w.start);
  const startP = futurePeriods(known, y0, 1, 24).find((p) => p.to >= w.start)!;
  const last = await trx.selectFrom('period_run').select(['fiscal_year', 'period_no']).where('kind', '=', RUN_KIND[a.kind]!).where('status', '=', 'active')
    .where('period_no', '>=', 1).where('period_no', '<=', 12).orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').limit(1).executeTakeFirst();
  const afterLast = last ? futurePeriods(known, last.fiscal_year, last.period_no, 2)[1]! : startP;
  const next = key(afterLast.fiscalYear, afterLast.periodNo) > key(startP.fiscalYear, startP.periodNo) ? afterLast : startP;
  const N = key(next.fiscalYear, next.periodNo);

  const vs = await trx.selectFrom('asset_schedule').select(['id', 'eff_year', 'eff_period']).where('asset_id', '=', assetId).where('superseded_at', 'is', null).orderBy('eff_year').orderBy('eff_period').execute();
  const lines = vs.length ? await linesOf(trx, vs.map((v) => v.id)) : [];
  const composed = lines.filter((l) => {
    const i = vs.findIndex((v) => v.id === l.schedule_id); const nv = vs[i + 1];
    const k = key(l.fiscal_year, l.period_no);
    return k >= key(vs[i]!.eff_year, vs[i]!.eff_period) && (!nv || k < key(nv.eff_year, nv.eff_period));
  }).map(lineOut);
  if (!vs.length && a.life_units === null && a.opening_remaining_units === null) return []; // chưa có thời gian sử dụng: chưa dựng được lịch
  const r = await plan(trx, assetId, a, next, { proration, runIdsOfPeriod: [], valuesAt: '9999-12-31', known });
  if (r.ok) return composed;
  return [...composed.filter((l) => key(l.fiscalYear, l.periodNo) < N), ...r.next.lines];
}
