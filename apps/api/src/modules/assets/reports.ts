import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, ZERO, allocateByRatio } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { assetValues, remainingUnitsOf } from './schedule.js';

// Sổ, thẻ, bảng khấu hao và báo cáo tăng giảm tài sản. Mọi số tiền đọc từ dòng sổ cái có asset_id (cùng quy ước với fn_asset_values_at: chứng từ posted, reversed); không có số tự do.
type Trx = Transaction<Database>;
type Row = Record<string, unknown>;
const POSTED = sql`v.state IN ('posted','reversed')`;
export const DECREASE_REASON: Record<string, string> = { liquidation: 'Thanh lý, nhượng bán', contribution: 'Góp vốn', to_tool: 'Chuyển thành công cụ, dụng cụ', loss: 'Mất, hư hỏng', other: 'Lý do khác', tool: 'Ghi giảm công cụ, dụng cụ' };
const reasonOf = (d: Record<string, unknown>) => { const r = String(d['reason'] ?? ''); return DECREASE_REASON[r] ?? r; };

interface A { id: number; code: string; name: string; kind: string; assetAccount: string; depAccount: string | null; lifeUnits: number | null; isDepreciable: boolean; openingRemaining: string | null; status: string; decreaseDate: string | null;
  useDate: string | null; country: string | null; yearMade: number | null; cardNo: string | null; spec: string | null; uom: string | null; quantity: string; categoryCode: string | null; categoryName: string | null; departmentId: number | null; departmentCode: string | null; departmentName: string | null }
interface Ev { assetId: number; kind: string; date: string; voucherNo: string | null; data: Record<string, unknown> }
interface L { assetId: number; voucherNo: string; date: string; description: string | null; account: string; debit: string; credit: string; sourceType: string | null; sourceId: string | null }

async function assetsOf(trx: Trx, kinds: string[]): Promise<A[]> {
  return (await sql<A>`SELECT a.id::int AS id, a.code, a.name, a.kind, a.asset_account_code AS "assetAccount", a.depreciation_account_code AS "depAccount", a.life_units AS "lifeUnits", a.is_depreciable AS "isDepreciable",
      a.opening_remaining_units::text AS "openingRemaining", a.status, a.decrease_date::text AS "decreaseDate", a.use_date::text AS "useDate", a.country, a.year_made AS "yearMade", a.card_no AS "cardNo", a.spec, a.uom, a.quantity::text AS quantity,
      c.code AS "categoryCode", c.name AS "categoryName", a.department_id::int AS "departmentId", d.code AS "departmentCode", d.name AS "departmentName"
    FROM asset a LEFT JOIN asset_category c ON c.id = a.category_id LEFT JOIN department d ON d.id = a.department_id
    WHERE a.kind = ANY (${kinds}::text[]) ORDER BY c.code NULLS LAST, a.code`.execute(trx)).rows;
}
async function eventsOf(trx: Trx, ids: number[], kinds: string[], to: string): Promise<Ev[]> {
  return (await sql<Ev>`SELECT e.asset_id::int AS "assetId", e.kind, e.event_date::text AS date, v.voucher_no AS "voucherNo", e.data
    FROM asset_event e LEFT JOIN voucher v ON v.id = e.voucher_id
    WHERE e.state = 'active' AND e.asset_id = ANY (${ids}::bigint[]) AND e.kind = ANY (${kinds}::text[]) AND e.event_date <= ${to}::date ORDER BY e.event_date, e.created_at`.execute(trx)).rows;
}
// Dòng nguyên giá (TK tài sản) và hao mòn (TK hao mòn) có mã tài sản đến ngày `to`.
async function linesOf(trx: Trx, tenantId: string, ids: number[], to: string): Promise<L[]> {
  if (!ids.length) return [];
  return (await sql<L>`SELECT l.asset_id::int AS "assetId", v.voucher_no AS "voucherNo", l.posting_date::text AS date, v.description, ac.code AS account, l.debit::text AS debit, l.credit::text AS credit, v.source_doc_type AS "sourceType", v.source_doc_id::text AS "sourceId"
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN account ac ON ac.id = l.account_id AND ac.tenant_id = l.tenant_id JOIN asset s ON s.id = l.asset_id AND s.tenant_id = l.tenant_id
    WHERE l.tenant_id = ${tenantId}::uuid AND l.asset_id = ANY (${ids}::bigint[]) AND l.posting_date <= ${to}::date AND ${POSTED} AND (ac.code = s.asset_account_code OR ac.code = s.depreciation_account_code)
    ORDER BY l.posting_date, v.created_at, l.line_no`.execute(trx)).rows;
}
const group = <T,>(xs: T[], f: (x: T) => number) => { const m = new Map<number, T[]>(); for (const x of xs) { const k = f(x); (m.get(k) ?? m.set(k, []).get(k)!).push(x); } return m; };
const rate = (a: A) => (a.lifeUnits && a.kind === 'fixed' && a.isDepreciable ? D(1200).div(a.lifeUnits).toDecimalPlaces(2).toString() : null);

// ---- Sổ tài sản cố định (S21-DN / S09-DNN) và Sổ theo dõi TSCĐ, CCDC tại nơi sử dụng (S22-DN / S10-DNN) ----
interface Held { a: A; inc: L; decs: Ev[]; cost: string; grossQty: string }
// Tài sản có ghi tăng đến `to` và chưa ghi giảm hết trước `from`.
async function heldAssets(trx: Trx, tenantId: string, kinds: string[], from: string, to: string): Promise<Held[]> {
  const as = await assetsOf(trx, kinds); const ids = as.map((a) => a.id);
  const lines = group(await linesOf(trx, tenantId, ids, to), (l) => l.assetId); const decs = group(await eventsOf(trx, ids, ['decrease'], to), (e) => e.assetId);
  const vals = await assetValues(trx, tenantId, to, [], ids); const out: Held[] = [];
  for (const a of as) {
    const ls = lines.get(a.id) ?? []; const inc = ls.find((l) => l.account === a.assetAccount && !D(l.debit).isZero()); if (!inc) continue;
    const ds = decs.get(a.id) ?? [];
    if (a.status === 'decreased' && a.decreaseDate && a.decreaseDate < from) continue;
    if (a.kind === 'fixed' && ds.length && ds[0]!.date < from) continue;
    const gross = ls.filter((l) => l.account === a.assetAccount).reduce((t, l) => t.plus(l.debit), ZERO);
    // Công cụ, dụng cụ ghi giảm từng phần: số lượng ban đầu là số lượng trước lần giảm đầu tiên.
    const grossQty = ds.length && a.kind === 'tool' ? String((ds[0]!.data['before'] as Row | undefined)?.['quantity'] ?? a.quantity) : a.quantity;
    out.push({ a, inc, decs: ds, grossQty: D(grossQty).toString(), cost: a.kind === 'fixed' ? (ds.length ? String(ds[0]!.data['cost'] ?? gross) : (vals.get(a.id)?.cost ?? '0')) : gross.toFixed(0) });
  }
  return out;
}

export async function assetRegister(trx: Trx, tenantId: string, q: { from: string; to: string }) {
  const held = await heldAssets(trx, tenantId, ['fixed'], q.from, q.to);
  const groups = new Map<string, { categoryCode: string; categoryName: string; rows: Row[]; totalCost: string; totalAnnual: string }>();
  for (const h of held) {
    const a = h.a; const key = a.categoryCode ?? '';
    const g = groups.get(key) ?? groups.set(key, { categoryCode: key, categoryName: a.categoryName ?? '(Chưa phân loại)', rows: [], totalCost: '0', totalAnnual: '0' }).get(key)!;
    const r = rate(a); const annual = r ? D(h.cost).times(12).div(a.lifeUnits!).toDecimalPlaces(0).toString() : '0'; const dec = h.decs[0]; // mức năm = nguyên giá × 12 / số tháng (khớp lịch khấu hao); chỉ tỷ lệ in ra mới làm tròn 2 chữ số lẻ
    g.rows.push({ stt: g.rows.length + 1, assetId: a.id, assetCode: a.code, incVoucherNo: h.inc.voucherNo, incDate: h.inc.date, name: [a.name, a.spec].filter(Boolean).join(', '), country: a.country, useDate: a.useDate, cardNo: a.cardNo ?? a.code,
      cost: h.cost, ratePct: r, annualDepreciation: annual,
      accumulatedAtDecrease: dec ? String(dec.data['accumulated'] ?? '0') : null, decVoucherNo: dec?.voucherNo ?? null, decDate: dec?.date ?? null, decReason: dec ? reasonOf(dec.data) : null });
    g.totalCost = D(g.totalCost).plus(h.cost).toString(); g.totalAnnual = D(g.totalAnnual).plus(annual).toString();
  }
  return { from: q.from, to: q.to, groups: [...groups.values()] };
}

// Bộ phận tại ngày d: bộ phận cũ của lần điều chuyển (đã sắp theo ngày) đầu tiên từ ngày d trở đi (đã sau d thì tài sản còn ở bộ phận cũ); không còn lần nào thì bộ phận hiện tại.
export function departmentAt(transfers: { date: string; data: Record<string, unknown> }[], date: string, current: number | null, after = false): number | null {
  const t = transfers.find((x) => (after ? x.date > date : x.date >= date));
  return t ? ((t.data['before'] as { departmentId?: number | null } | undefined)?.departmentId ?? null) : current;
}

export async function assetsByLocation(trx: Trx, tenantId: string, q: { from: string; to: string; departmentId?: number | undefined }) {
  const held = await heldAssets(trx, tenantId, ['fixed', 'tool'], q.from, q.to);
  const trs = group(await eventsOf(trx, held.map((h) => h.a.id), ['transfer'], '9999-12-31'), (e) => e.assetId);
  const depts = new Map((await sql<{ id: number; code: string; name: string }>`SELECT id::int AS id, code, name FROM department`.execute(trx)).rows.map((d) => [d.id, d]));
  const groups = new Map<string, { departmentCode: string; departmentName: string; rows: Row[]; totalIncrease: string; totalDecrease: string }>();
  const add = (deptId: number | null, row: Row, inc: unknown, dec: unknown) => {
    if (q.departmentId !== undefined && deptId !== q.departmentId) return;
    const d = deptId === null ? undefined : depts.get(deptId); const key = d?.code ?? '';
    const g = groups.get(key) ?? groups.set(key, { departmentCode: key, departmentName: d?.name ?? '(Chưa gán bộ phận)', rows: [], totalIncrease: '0', totalDecrease: '0' }).get(key)!;
    g.rows.push(row);
    if (inc !== undefined) g.totalIncrease = D(g.totalIncrease).plus(String(inc)).toString();
    if (dec !== undefined) g.totalDecrease = D(g.totalDecrease).plus(String(dec)).toString();
  };
  for (const h of held) {
    const a = h.a; const ts = trs.get(a.id) ?? [];
    const beforeOf = (t: Ev) => ((t.data['before'] as Row | undefined)?.['departmentId'] as number | null | undefined) ?? null;
    const deptFrom = (d: string, after = false) => departmentAt(ts, d, a.departmentId, after);
    const qty0 = a.kind === 'fixed' ? '1' : h.grossQty; const unit = D(qty0).isZero() ? '0' : D(h.cost).div(qty0).toDecimalPlaces(0).toString();
    const base = { assetCode: a.code, name: a.name, uom: a.uom };
    const primary = deptFrom(q.from); const decs = h.decs.filter((e) => e.date >= q.from);
    const first = decs[0] && deptFrom(decs[0].date, true) === primary ? decs[0] : undefined; // lần giảm đầu cùng bộ phận ghi chung dòng với dòng tăng
    add(primary, { ...base, incVoucherNo: h.inc.voucherNo, incDate: h.inc.date, incQty: qty0, unitPrice: unit, incAmount: h.cost, ...(first ? decRow(a, first) : {}) }, h.cost, first ? decRow(a, first).decAmount : undefined);
    for (const e of decs) if (e !== first) add(deptFrom(e.date, true), { ...base, ...decRow(a, e) }, undefined, decRow(a, e).decAmount);
    // Điều chuyển trong kỳ: giảm ở bộ phận cũ, tăng ở bộ phận mới (không chứng từ).
    ts.forEach((t, i) => {
      if (t.date < q.from || t.date > q.to) return;
      add(beforeOf(t), { ...base, decDate: t.date, decReason: 'Điều chuyển', decQty: qty0, decAmount: h.cost }, undefined, h.cost);
      add(ts[i + 1] ? beforeOf(ts[i + 1]!) : a.departmentId, { ...base, incDate: t.date, incQty: qty0, unitPrice: unit, incAmount: h.cost }, h.cost, undefined);
    });
  }
  return { from: q.from, to: q.to, groups: [...groups.values()] };
}
const decRow = (a: A, e: Ev) => ({ decVoucherNo: e.voucherNo, decDate: e.date, decReason: reasonOf(e.data), decQty: a.kind === 'fixed' ? '1' : String(e.data['quantity'] ?? a.quantity), decAmount: String(a.kind === 'fixed' ? (e.data['cost'] ?? '0') : (e.data['value'] ?? '0')) });

// ---- Thẻ TSCĐ (S23-DN / S11-DNN) ----
export async function assetCard(trx: Trx, tenantId: string, id: number, to: string) {
  const a = (await assetsOf(trx, ['fixed'])).find((x) => x.id === id);
  if (!a) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản cố định', 404);
  const ls = await linesOf(trx, tenantId, [id], to); const evs = await eventsOf(trx, [id], ['decrease', 'suspend', 'resume'], to);
  const costLines = ls.filter((l) => l.account === a.assetAccount).map((l) => ({ voucherNo: l.voucherNo, date: l.date, description: l.description, amount: D(l.debit).minus(l.credit).toString() }));
  const byYear = new Map<string, string>();
  for (const l of ls.filter((x) => x.account === a.depAccount)) { const y = l.date.slice(0, 4); byYear.set(y, D(byYear.get(y) ?? '0').plus(l.credit).minus(l.debit).toString()); }
  let cum = ZERO; const wear = [...byYear.entries()].sort().map(([year, value]) => { cum = cum.plus(value); return { year: Number(year), value, accumulated: cum.toString() }; });
  const dec = evs.find((e) => e.kind === 'decrease'); const open = [...evs].reverse().find((e) => e.kind === 'suspend' || e.kind === 'resume');
  const stop = open?.kind === 'suspend' ? open : null;
  return { asset: { id: a.id, code: a.code, name: a.name, spec: a.spec, cardNo: a.cardNo, country: a.country, yearMade: a.yearMade, departmentCode: a.departmentCode, departmentName: a.departmentName, useDate: a.useDate, categoryName: a.categoryName },
    costLines, wear, accessories: [] as Row[], suspended: stop ? { date: stop.date, reason: String(stop.data['reason'] ?? '') } : null,
    decrease: dec ? { voucherNo: dec.voucherNo, date: dec.date, reason: reasonOf(dec.data) } : null, to };
}

// ---- Khấu hao, phân bổ theo kỳ ----
export async function periodOf(trx: Trx, fiscalYear: number, periodNo: number) {
  const p = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to', 'regime']).where('fiscal_year', '=', fiscalYear).where('period_no', '=', periodNo).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${periodNo}/${fiscalYear}`, 404);
  const prev = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_to']).where('period_no', '>=', 1).where('period_no', '<=', 12)
    .where(sql<boolean>`(fiscal_year, period_no) < (${fiscalYear}, ${periodNo})`).orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').limit(1).executeTakeFirst();
  return { from: p.date_from, to: p.date_to, regime: p.regime, prev: prev ? { fiscalYear: prev.fiscal_year, periodNo: prev.period_no, to: prev.date_to } : null };
}
// Số tiền mỗi tài sản của chứng từ chạy kỳ: Có TK hao mòn (khấu hao) hoặc Có TK 242 (phân bổ); gồm cả chứng từ đảo nên chạy lại vẫn đúng.
async function runAmounts(trx: Trx, kind: string, fy: number, pn: number): Promise<Map<number, string>> {
  const r = await sql<{ id: number; amt: string }>`SELECT l.asset_id::int AS id, sum(l.credit - l.debit)::text AS amt
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN period_run r ON r.id = v.source_doc_id AND r.tenant_id = v.tenant_id
    JOIN account ac ON ac.id = l.account_id AND ac.tenant_id = l.tenant_id JOIN asset s ON s.id = l.asset_id AND s.tenant_id = l.tenant_id
    WHERE v.source_doc_type = 'asset_run' AND r.kind = ${kind} AND r.fiscal_year = ${fy} AND r.period_no = ${pn} AND ${POSTED} AND l.asset_id IS NOT NULL
      AND ac.code = CASE WHEN ${kind} = 'depreciation' THEN s.depreciation_account_code ELSE s.asset_account_code END
    GROUP BY l.asset_id`.execute(trx);
  return new Map(r.rows.map((x) => [x.id, x.amt]));
}
// Số khấu hao TSCĐ của kỳ: chứng từ KH cộng khấu hao tháng ghi giảm (chế độ ngày) nằm trong chứng từ TS của ghi giảm còn hiệu lực có ngày trong kỳ (quy ước 7).
async function depreciationAmounts(trx: Trx, fy: number, pn: number): Promise<Map<number, string>> {
  const m = await runAmounts(trx, 'depreciation', fy, pn);
  const r = await sql<{ id: number; amt: string }>`SELECT e.asset_id::int AS id, sum((e.data->>'partialDepreciation')::numeric)::text AS amt
    FROM asset_event e JOIN fiscal_period p ON p.tenant_id = e.tenant_id AND p.fiscal_year = ${fy} AND p.period_no = ${pn} AND e.event_date BETWEEN p.date_from AND p.date_to
    WHERE e.kind = 'decrease' AND e.state = 'active' AND coalesce((e.data->>'partialDepreciation')::numeric, 0) <> 0 GROUP BY e.asset_id`.execute(trx);
  for (const x of r.rows) m.set(x.id, D(m.get(x.id) ?? '0').plus(x.amt).toString());
  return m;
}
interface Part { assetId: number; account: string; departmentCode: string | null; departmentName: string | null; amount: string }
// Chia số tiền từng tài sản theo phân bổ chi phí hiệu lực ở kỳ (cùng hàm allocateByRatio với chứng từ KH/PB nên khớp từng đồng).
async function distribute(trx: Trx, amounts: Map<number, string>, fy: number, pn: number): Promise<Part[]> {
  const ids = [...amounts.keys()].filter((i) => !D(amounts.get(i)!).isZero()); if (!ids.length) return [];
  const al = (await sql<{ assetId: number; year: number; period: number; account: string; ratio: string; dc: string | null; dn: string | null }>`SELECT x.asset_id::int AS "assetId", x.valid_from_year AS year, x.valid_from_period AS period,
      x.expense_account_code AS account, x.ratio::text AS ratio, d.code AS dc, d.name AS dn FROM asset_allocation x LEFT JOIN department d ON d.id = x.department_id
    WHERE x.asset_id = ANY (${ids}::bigint[]) AND (x.valid_from_year, x.valid_from_period) <= (${fy}, ${pn}) ORDER BY x.id`.execute(trx)).rows;
  const out: Part[] = [];
  for (const id of ids) {
    const mine = al.filter((x) => x.assetId === id); const top = Math.max(...mine.map((x) => x.year * 100 + x.period)); const cur = mine.filter((x) => x.year * 100 + x.period === top);
    if (!cur.length) { out.push({ assetId: id, account: '(chưa phân bổ)', departmentCode: null, departmentName: null, amount: amounts.get(id)! }); continue; }
    allocateByRatio(amounts.get(id)!, cur.map((x) => x.ratio)).forEach((p, i) => out.push({ assetId: id, account: cur[i]!.account, departmentCode: cur[i]!.dc, departmentName: cur[i]!.dn, amount: p }));
  }
  return out;
}
const sumBy = (ps: Part[], key: (p: Part) => string) => { const m = new Map<string, string>(); for (const p of ps) m.set(key(p), D(m.get(key(p)) ?? '0').plus(p.amount).toString()); return m; };
const obj = (m: Map<string, string>) => Object.fromEntries([...m.entries()].sort(([x], [y]) => x.localeCompare(y)));

// Bảng tính và phân bổ khấu hao TSCĐ (06-TSCĐ): I kỳ trước, II tăng, III giảm, IV kỳ này (= I + II - III). Tăng/giảm tính theo từng (tài sản, TK chi phí, bộ phận): chênh lệch dương là tăng, âm là giảm.
export async function depreciationSheet(trx: Trx, tenantId: string, q: { fiscalYear: number; periodNo: number }) {
  const span = await periodOf(trx, q.fiscalYear, q.periodNo);
  const curAmt = await depreciationAmounts(trx, q.fiscalYear, q.periodNo);
  const prevAmt = span.prev ? await depreciationAmounts(trx, span.prev.fiscalYear, span.prev.periodNo) : new Map<number, string>();
  const cur = await distribute(trx, curAmt, q.fiscalYear, q.periodNo); const prev = span.prev ? await distribute(trx, prevAmt, span.prev.fiscalYear, span.prev.periodNo) : [];
  const ids = [...new Set([...curAmt.keys(), ...prevAmt.keys()])];
  const as = (await assetsOf(trx, ['fixed'])).filter((a) => ids.includes(a.id) || (a.decreaseDate && a.decreaseDate >= span.from && a.decreaseDate <= span.to));
  const costNow = await assetValues(trx, tenantId, span.to, [], as.map((a) => a.id)); const costPrev = span.prev ? await assetValues(trx, tenantId, span.prev.to, [], as.map((a) => a.id)) : new Map();
  const pos = (id: number, m: Map<number, string>) => D(m.get(id) ?? '0').gt(0);
  const decIn = (id: number) => { const d = as.find((a) => a.id === id)?.decreaseDate; return !!d && d >= span.from && d <= span.to; };
  // Chênh lệch theo (tài sản, TK, bộ phận).
  const k = (p: Part) => `${p.assetId}|${p.account}|${p.departmentCode ?? ''}`;
  const delta = new Map<string, Part>();
  for (const p of cur) delta.set(k(p), { ...p });
  for (const p of prev) { const x = delta.get(k(p)); if (x) x.amount = D(x.amount).minus(p.amount).toString(); else delta.set(k(p), { ...p, amount: D(p.amount).neg().toString() }); }
  const inc = [...delta.values()].filter((p) => D(p.amount).gt(0)); const dec = [...delta.values()].filter((p) => D(p.amount).lt(0)).map((p) => ({ ...p, amount: D(p.amount).neg().toString() }));
  const costOf = (m: Map<number, { cost: string }>, f: (id: number) => boolean) => as.filter((a) => f(a.id)).reduce((t, a) => t.plus(m.get(a.id)?.cost ?? '0'), ZERO).toString();
  const mk = (label: string, key: string, parts: Part[], cost: string) => ({ key, label, cost, depreciation: parts.reduce((t, p) => t.plus(p.amount), ZERO).toString(), byAccount: obj(sumBy(parts, (p) => p.account)), byDepartment: obj(sumBy(parts, (p) => p.departmentCode ?? '')) });
  const rows = [mk('I. Số khấu hao trích tháng trước', 'prev', prev, costOf(costPrev, (id) => pos(id, prevAmt))),
    mk('II. Số KH TSCĐ tăng trong tháng', 'increase', inc, costOf(costNow, (id) => pos(id, curAmt) && !pos(id, prevAmt))),
    mk('III. Số KH TSCĐ giảm trong tháng', 'decrease', dec, costOf(costPrev, (id) => pos(id, prevAmt) && (!pos(id, curAmt) || decIn(id)))),
    mk('IV. Số KH trích tháng này (I + II - III)', 'current', cur, costOf(costNow, (id) => pos(id, curAmt)))];
  const name = new Map(cur.filter((p) => p.departmentCode).map((p) => [p.departmentCode!, p.departmentName!]));
  const detail = (parts: Part[]) => parts.map((p) => ({ assetCode: as.find((a) => a.id === p.assetId)?.code ?? '', account: p.account, departmentCode: p.departmentCode, amount: p.amount }));
  const decreasedInPeriod = as.filter((a) => a.decreaseDate && a.decreaseDate >= span.from && a.decreaseDate <= span.to).map((a) => a.code);
  return { fiscalYear: q.fiscalYear, periodNo: q.periodNo, from: span.from, to: span.to, regime: span.regime, accounts: Object.keys(obj(sumBy([...prev, ...cur], (p) => p.account))),
    departments: [...new Set([...prev, ...cur].map((p) => p.departmentCode).filter((x): x is string => !!x))].sort().map((c) => ({ code: c, name: name.get(c) ?? prev.find((p) => p.departmentCode === c)?.departmentName ?? c })),
    rows, increases: detail(inc), decreases: detail(dec), decreasedInPeriod, total: rows[3]!.depreciation };
}

// Bảng phân bổ công cụ, dụng cụ và chi phí trả trước theo TK chi phí (phần CCDC/CPTT của 07-VT).
export async function allocationSheet(trx: Trx, q: { fiscalYear: number; periodNo: number }) {
  const span = await periodOf(trx, q.fiscalYear, q.periodNo);
  const tool = await distribute(trx, await runAmounts(trx, 'tool', q.fiscalYear, q.periodNo), q.fiscalYear, q.periodNo);
  const prepaid = await distribute(trx, await runAmounts(trx, 'prepaid', q.fiscalYear, q.periodNo), q.fiscalYear, q.periodNo);
  const accs = [...new Set([...tool, ...prepaid].map((p) => p.account))].sort();
  const names = new Map((await trx.selectFrom('account').select(['code', 'name']).where('regime', '=', span.regime).where('code', 'in', accs.length ? accs : ['']).execute()).map((x) => [x.code, x.name]));
  const sum = (ps: Part[], f: (p: Part) => boolean) => ps.filter(f).reduce((t, p) => t.plus(p.amount), ZERO);
  const rows: Row[] = [];
  for (const a of accs) {
    const t = sum(tool, (p) => p.account === a); const c = sum(prepaid, (p) => p.account === a);
    rows.push({ accountCode: a, departmentCode: null, label: `TK ${a}${names.get(a) ? ` – ${names.get(a)}` : ''}`, tool: t.toString(), prepaid: c.toString(), total: t.plus(c).toString(), isBold: true });
    for (const d of [...new Set([...tool, ...prepaid].filter((p) => p.account === a && p.departmentCode).map((p) => p.departmentCode!))].sort()) {
      const dt = sum(tool, (p) => p.account === a && p.departmentCode === d); const dc = sum(prepaid, (p) => p.account === a && p.departmentCode === d);
      rows.push({ accountCode: a, departmentCode: d, label: `    - Bộ phận ${d}`, tool: dt.toString(), prepaid: dc.toString(), total: dt.plus(dc).toString() });
    }
  }
  const t = sum(tool, () => true); const c = sum(prepaid, () => true);
  return { fiscalYear: q.fiscalYear, periodNo: q.periodNo, from: span.from, to: span.to, regime: span.regime, rows, totals: { tool: t.toString(), prepaid: c.toString(), total: t.plus(c).toString() } };
}

// ---- Báo cáo tăng giảm tài sản theo loại (quản trị) ----
// Tăng/giảm trong kỳ: bỏ cặp chứng từ gốc và bút toán đảo cùng nằm trong [from, to] (chạy lại KH/PB, hủy biến động, đảo): cặp đó không là phát sinh thật, tổng ròng bằng 0.
export async function movementReport(trx: Trx, tenantId: string, q: { kind: string; from: string; to: string }) {
  const inRange = sql`l.posting_date >= ${q.from}::date AND NOT ((o.id IS NOT NULL AND o.posting_date >= ${q.from}::date) OR (rv.id IS NOT NULL AND rv.posting_date <= ${q.to}::date))`;
  const r = await sql<Record<string, string | null>>`SELECT coalesce(c.code, '') AS "categoryCode", coalesce(c.name, '(Chưa phân loại)') AS "categoryName",
      sum(l.debit - l.credit) FILTER (WHERE ac.code = s.asset_account_code AND l.posting_date < ${q.from}::date)::text AS "openCost",
      sum(l.debit) FILTER (WHERE ac.code = s.asset_account_code AND ${inRange})::text AS "incCost",
      sum(l.credit) FILTER (WHERE ac.code = s.asset_account_code AND ${inRange})::text AS "decCost",
      sum(l.credit - l.debit) FILTER (WHERE ac.code = s.depreciation_account_code AND l.posting_date < ${q.from}::date)::text AS "openAcc",
      sum(l.credit) FILTER (WHERE ac.code = s.depreciation_account_code AND ${inRange})::text AS "incAcc",
      sum(l.debit) FILTER (WHERE ac.code = s.depreciation_account_code AND ${inRange})::text AS "decAcc"
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN account ac ON ac.id = l.account_id AND ac.tenant_id = l.tenant_id
    LEFT JOIN voucher o ON o.id = v.reversal_of_id AND o.tenant_id = v.tenant_id LEFT JOIN voucher rv ON rv.id = v.reversed_by_id AND rv.tenant_id = v.tenant_id
    JOIN asset s ON s.id = l.asset_id AND s.tenant_id = l.tenant_id LEFT JOIN asset_category c ON c.id = s.category_id
    WHERE l.tenant_id = ${tenantId}::uuid AND s.kind = ${q.kind} AND l.posting_date <= ${q.to}::date AND ${POSTED} AND (ac.code = s.asset_account_code OR ac.code = s.depreciation_account_code)
    GROUP BY c.code, c.name ORDER BY c.code NULLS LAST`.execute(trx);
  const rows = r.rows.map((x) => {
    const n = (k: string) => D(x[k] ?? '0');
    const cost = { opening: n('openCost'), inc: n('incCost'), dec: n('decCost') }; const acc = { opening: n('openAcc'), inc: n('incAcc'), dec: n('decAcc') };
    const closeCost = cost.opening.plus(cost.inc).minus(cost.dec); const closeAcc = acc.opening.plus(acc.inc).minus(acc.dec);
    return { categoryCode: x['categoryCode'], categoryName: x['categoryName'], openingCost: cost.opening.toString(), increaseCost: cost.inc.toString(), decreaseCost: cost.dec.toString(), closingCost: closeCost.toString(),
      openingAccumulated: acc.opening.toString(), increaseAccumulated: acc.inc.toString(), decreaseAccumulated: acc.dec.toString(), closingAccumulated: closeAcc.toString(),
      openingNet: cost.opening.minus(acc.opening).toString(), closingNet: closeCost.minus(closeAcc).toString() };
  }).filter((x) => Object.entries(x).some(([k, v]) => k !== 'categoryCode' && k !== 'categoryName' && !D(v as string).isZero()));
  const keys = ['openingCost', 'increaseCost', 'decreaseCost', 'closingCost', 'openingAccumulated', 'increaseAccumulated', 'decreaseAccumulated', 'closingAccumulated', 'openingNet', 'closingNet'] as const;
  const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((t, x) => t.plus(x[k]), ZERO).toString()]));
  return { kind: q.kind, from: q.from, to: q.to, rows, totals };
}

// ---- Sổ theo dõi công cụ dụng cụ / chi phí trả trước ----
export async function toolRegister(trx: Trx, tenantId: string, q: { kind: 'tool' | 'prepaid'; from: string; to: string }) {
  const as = await assetsOf(trx, [q.kind]); const ids = as.map((a) => a.id);
  const lines = group(await linesOf(trx, tenantId, ids, q.to), (l) => l.assetId); const vals = await assetValues(trx, tenantId, q.to, [], ids);
  const decIds = new Set(ids.length ? (await sql<{ id: string }>`SELECT id::text AS id FROM asset_event WHERE kind = 'decrease' AND asset_id = ANY (${ids}::bigint[])`.execute(trx)).rows.map((r) => r.id) : []);
  const base = as.map((a) => {
    const ls = (lines.get(a.id) ?? []).filter((l) => l.account === a.assetAccount);
    // Chia theo nguồn, mỗi cột là số ròng gồm cả bút toán đảo: ban đầu − phân bổ − ghi giảm = còn lại (= Σ dòng 242 có asset_id).
    const kindOf = (l: L) => (l.sourceType === 'asset_run' ? 'run' : l.sourceType === 'asset_event' && decIds.has(l.sourceId ?? '') ? 'dec' : 'init');
    const net = (f: (l: L) => boolean, sign: 1 | -1) => ls.filter(f).reduce((t, l) => t.plus(D(l.debit).minus(l.credit).times(sign)), ZERO);
    const initial = net((l) => kindOf(l) === 'init', 1); const allocated = net((l) => kindOf(l) === 'run', -1);
    const period = net((l) => kindOf(l) === 'run' && l.date >= q.from, -1); const decreased = net((l) => kindOf(l) === 'dec', -1);
    return { a, first: ls.find((l) => !D(l.debit).isZero()), initial, allocated, period, decreased, cost: vals.get(a.id)?.cost ?? '0' };
  }).filter((x) => x.first);
  const remaining = await remainingUnitsOf(trx, base.map((x) => ({ id: x.a.id, isDepreciable: x.a.isDepreciable, lifeUnits: x.a.lifeUnits, openingRemainingUnits: x.a.openingRemaining, status: x.a.status, cost: x.cost })));
  const rows = base.map((x) => ({ assetCode: x.a.code, name: x.a.name, departmentCode: x.a.departmentCode, startDate: x.first!.date, voucherNo: x.first!.voucherNo, lifeUnits: x.a.lifeUnits, initial: x.initial.toString(), allocatedPeriod: x.period.toString(),
    allocatedTotal: x.allocated.toString(), decreased: x.decreased.toString(), remaining: x.cost, remainingUnits: remaining.get(x.a.id) ?? '0' }));
  const sum = (k: 'initial' | 'allocatedPeriod' | 'allocatedTotal' | 'decreased' | 'remaining') => rows.reduce((t, r) => t.plus(r[k]), ZERO).toString();
  return { kind: q.kind, from: q.from, to: q.to, rows, totals: { initial: sum('initial'), allocatedPeriod: sum('allocatedPeriod'), allocatedTotal: sum('allocatedTotal'), decreased: sum('decreased'), remaining: sum('remaining') } };
}
