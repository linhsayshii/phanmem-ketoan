import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { computeCosting, D, Decimal, formatVnDate, splitByRatio, ZERO, type CostMethod, type CostMove, type CostOpening, type CostResult } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';

type Trx = Transaction<Database>;
const METHODS = ['avg_period', 'avg_moving', 'fifo', 'specific'] as const;
export const costingInput = z.object({
  periodFrom: S.dateIso, periodTo: S.dateIso, warehouseCode: z.string().min(1).optional(), itemCode: z.string().min(1).optional(), method: z.enum(METHODS).optional(),
});
export type CostingInput = z.infer<typeof costingInput>;
export type CostingError = { moveId: string; code: CostResult['errors'][number]['code'] | 'COSTING_RECEIPT_PRICE_MISSING'; detail: string };
export interface CostingSummary { items: number; moves: number; delta: string; errors: CostingError[] }
type Ctx = { tenantId: string; userId: string; canBackdate: boolean };

// Một phát sinh kho kèm dòng hàng, chứng từ và giá gán hiện hành.
interface Mv {
  id: number; item_id: number; warehouse_id: number; posting_date: string; direction: 'in' | 'out'; quantity: string; lot_no: string | null;
  transfer_id: string | null; reversal_of: number | null; stock_kind: string | null; party_code: string | null; unit_price: string | null; fixed_cost: boolean; unit_cost: string | null;
  debit_code: string | null; credit_code: string | null; debit_kind: string | null; credit_kind: string | null; item_code: string; wh_code: string; dest_code: string | null; wh_method: string | null;
  base: string; // số dòng hàng đã ghi sổ cái lúc ghi phiếu (giá tạm tính của dòng xuất, tiền dòng nhập)
  adj_open: string | null; // phần điều chỉnh giá nhập chưa ghi nhận ở GV nào (voucher_id null)
  receipt: string | null; // giá trị lớp nhập đã lưu, cộng các lớp điều chỉnh giá nhập
  cur_amount: string | null; cur_unit_cost: string | null; cur_run: string | null; carry_date: string | null;
  asset_code: string | null; voucher_id: string; voucher_type: string; cost_ratio: string | null; // LR: nhóm giá trị là chứng từ
  lr_rev_out: boolean; // chiều xuất đảo của chiều nhập LR: chênh giá đã ghi ở chiều nhập đảo của linh kiện, không ghi lần hai
}
const MOVE_SELECT = sql`m.id, m.item_id, m.warehouse_id, m.posting_date, m.direction, m.quantity, m.lot_no, m.transfer_id, m.reversal_of, v.stock_kind, pa.code AS party_code,
  l.unit_price, l.fixed_cost, l.unit_cost, da.code AS debit_code, ca.code AS credit_code, da.subledger_kind AS debit_kind, ca.subledger_kind AS credit_kind,
  i.code AS item_code, w.code AS wh_code, dw.code AS dest_code, w.costing_method AS wh_method, ast.code AS asset_code,
  (CASE WHEN l.unit_cost IS NOT NULL THEN round(coalesce(l.base_quantity, l.quantity * l.uom_factor) * l.unit_cost) ELSE l.amount END)::text AS base,
  (SELECT sum(c.value) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind IN ('receipt', 'adjustment'))::text AS receipt,
  (SELECT sum(c.value) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind = 'adjustment' AND c.voucher_id IS NULL)::text AS adj_open,
  a.amount AS cur_amount, a.unit_cost AS cur_unit_cost, a.run_id AS cur_run, coalesce(gv.posting_date, cr.period_to)::text AS carry_date,
  m.voucher_id, v.voucher_type, l.cost_ratio::text AS cost_ratio,
  (m.direction = 'out' AND m.reversal_of IS NOT NULL AND EXISTS (SELECT 1 FROM stock_move om JOIN voucher ov ON ov.id = om.voucher_id WHERE om.id = m.reversal_of AND om.direction = 'in' AND ov.voucher_type = 'LR')) AS lr_rev_out`;
const MOVE_JOINS = sql`JOIN voucher v ON v.id = m.voucher_id JOIN voucher_item_line l ON l.tenant_id = m.tenant_id AND l.id = m.item_line_id
  LEFT JOIN account da ON da.id = l.debit_account_id LEFT JOIN account ca ON ca.id = l.credit_account_id LEFT JOIN party pa ON pa.id = v.party_id
  JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id LEFT JOIN warehouse dw ON dw.id = l.dest_warehouse_id LEFT JOIN asset ast ON ast.id = l.asset_id
  LEFT JOIN stock_cost_assignment a ON a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current
  LEFT JOIN costing_run cr ON cr.id = a.run_id LEFT JOIN voucher gv ON gv.id = a.voucher_id`;
// Thứ tự tính giá trong ngày: thứ tự trong ngày của chứng từ, chứng từ đảo sau chứng từ gốc, nhập trước xuất, số chứng từ, dòng.
const MOVE_ORDER = sql`ORDER BY m.posting_date, v.day_order, (m.reversal_of IS NOT NULL), m.direction = 'out', v.seq_no, l.line_no, m.id`;

const isLrIn = (m: Mv) => m.direction === 'in' && m.voucher_type === 'LR' && m.reversal_of === null;
const pairKey = (m: { item_id: number; warehouse_id: number }) => `${m.item_id}:${m.warehouse_id}`;
type Edge = { si: number; sw: number; di: number; dw: number }; // phụ thuộc giá: cặp nguồn (si, sw) → cặp đích (di, dw)
const uc = (amount: Decimal, qty: string) => amount.div(qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

// Tính giá vốn của kỳ [periodFrom, periodTo] cho các cặp hàng–kho có phát sinh trong kỳ (lọc theo kho, hàng), cộng các kho nhận chuyển kho từ chúng.
// Mỗi cặp: tồn đầu kỳ dựng lại từ toàn bộ phát sinh trước kỳ với số đã ghi sổ cái (giá gán hiện hành hoặc giá tạm tính), rồi động cơ giá vốn tính phát sinh trong kỳ
// theo phương pháp của kho. Chênh (giá gán − giá tạm tính) ghi bằng chứng từ GV ngày cuối kỳ; chạy lại đảo GV cũ của các lần chạy có gán bị thay, sinh GV mới;
// kết quả không đổi thì không chạm sổ.
export async function runCosting(trx: Trx, ctx: Ctx, input: CostingInput) {
  const { periodFrom: from, periodTo: to } = input;
  if (from > to) throw new AppError('VALIDATION', 'Từ ngày phải trước hoặc bằng đến ngày', 400);
  await sql`SELECT pg_advisory_xact_lock(hashtext('costing'), hashtext(${ctx.tenantId}::text))`.execute(trx);

  const periods = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to', 'status', 'locked_modules'])
    .where('period_no', '>=', 1).where('period_no', '<=', 15).orderBy('date_from').execute();
  const periodAt = (d: string) => periods.find((p) => p.date_from <= d && p.date_to >= d);
  if (!periodAt(from) || !periodAt(to)) throw new AppError('PERIOD_NOT_FOUND', `Khoảng ${formatVnDate(from)} – ${formatVnDate(to)} không nằm trong kỳ kế toán đã mở`, 404);
  for (const p of periods.filter((x) => x.date_from <= to && x.date_to >= from)) {
    if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa cứng: không tính lại giá vốn`, 409);
    if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa sổ, cần quyền ghi lùi ngày`, 409);
    if (p.locked_modules.includes('inventory')) throw new AppError('PERIOD_MODULE_LOCKED', `Phần hành kho đã khóa ở kỳ ${p.period_no}/${p.fiscal_year}`, 409);
  }
  const writable = (p: (typeof periods)[number]) => (p.status === 'open' || (p.status === 'soft_locked' && ctx.canBackdate)) && !p.locked_modules.includes('inventory');
  // Ngày ghi chứng từ GV (và bản đảo): ngày đó nếu kỳ ghi được, không thì ngày đầu của kỳ mở gần nhất sau đó.
  const gvDate = (d: string) => {
    const p = periodAt(d);
    if (p && writable(p)) return d;
    const next = periods.find((x) => x.date_from > d && writable(x));
    if (!next) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ mở sau ngày ${formatVnDate(d)} để ghi chứng từ giá vốn`, 404);
    return next.date_from;
  };

  const item = input.itemCode ? await trx.selectFrom('item').select('id').where('code', '=', input.itemCode).executeTakeFirst() : undefined;
  if (input.itemCode && !item) throw new AppError('ITEM_NOT_FOUND', `Không có vật tư hàng hóa mã "${input.itemCode}"`, 404);
  const wh = input.warehouseCode ? await trx.selectFrom('warehouse').select('id').where('code', '=', input.warehouseCode).executeTakeFirst() : undefined;
  if (input.warehouseCode && !wh) throw new AppError('WAREHOUSE_NOT_FOUND', `Không có kho mã "${input.warehouseCode}"`, 404);

  // Phạm vi: cặp có phát sinh trong kỳ theo bộ lọc (direct), cộng (lặp) cặp kho nhận của chuyển kho trong kỳ: giá nhập kho nhận là giá gán của kho đi.
  const closure = async () => {
    let q = trx.selectFrom('stock_move').select(['item_id', 'warehouse_id']).distinct().where('posting_date', '>=', from).where('posting_date', '<=', to);
    if (item) q = q.where('item_id', '=', item.id);
    if (wh) q = q.where('warehouse_id', '=', wh.id);
    const scope = new Map((await q.execute()).map((p) => [pairKey(p), p]));
    const direct = new Set(scope.keys());
    const edges: Edge[] = (await sql<{ item_id: number; src: number; dst: number }>`SELECT DISTINCT o.item_id, o.warehouse_id AS src, i.warehouse_id AS dst
      FROM stock_move o JOIN stock_move i ON i.tenant_id = o.tenant_id AND i.transfer_id = o.transfer_id AND i.direction = 'in'
      WHERE o.direction = 'out' AND o.transfer_id IS NOT NULL AND o.posting_date BETWEEN ${from}::date AND ${to}::date`.execute(trx)).rows
      .map((e) => ({ si: e.item_id, sw: e.src, di: e.item_id, dw: e.dst }));
    // Lắp ráp, tháo dỡ (LR): giá chiều nhập phụ thuộc giá gán chiều xuất cùng chứng từ; chiều nhập chia theo cả nhóm, nên kéo mọi cặp của chứng từ vào phạm vi, theo hai chiều.
    // Phạm vi LR: chứng từ LR có phát sinh của cặp trong phạm vi nằm trong [từ ngày, đến ngày], cộng chứng từ gốc của LR đảo trong kỳ. LR cũ hơn giữ giá nhập đã lưu, không kéo cả lịch sử.
    const lrSeen = new Set<string>(); const lrV = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      const ps = [...scope.values()];
      const lr = ps.length ? (await sql<{ si: number; sw: number; di: number; dw: number; vid: string }>`SELECT DISTINCT o.item_id AS si, o.warehouse_id AS sw, i.item_id AS di, i.warehouse_id AS dw, o.voucher_id AS vid
        FROM stock_move o JOIN voucher v ON v.id = o.voucher_id AND v.voucher_type = 'LR'
        JOIN stock_move i ON i.tenant_id = o.tenant_id AND i.voucher_id = o.voucher_id AND i.direction = 'in' AND i.reversal_of IS NULL
        WHERE o.direction = 'out' AND o.reversal_of IS NULL AND o.voucher_id IN (
          SELECT m.voucher_id FROM stock_move m
            JOIN unnest(${ps.map((p) => p.item_id)}::bigint[], ${ps.map((p) => p.warehouse_id)}::bigint[]) p(i, w) ON m.item_id = p.i AND m.warehouse_id = p.w
            WHERE m.reversal_of IS NULL AND m.posting_date BETWEEN ${from}::date AND ${to}::date
          UNION SELECT om.voucher_id FROM stock_move m
            JOIN unnest(${ps.map((p) => p.item_id)}::bigint[], ${ps.map((p) => p.warehouse_id)}::bigint[]) p(i, w) ON m.item_id = p.i AND m.warehouse_id = p.w
            JOIN stock_move om ON om.id = m.reversal_of
            WHERE m.posting_date BETWEEN ${from}::date AND ${to}::date)`.execute(trx)).rows : [];
      for (const e of lr) {
        lrV.add(e.vid);
        const k = `${e.si}:${e.sw}>${e.di}:${e.dw}`;
        if (!lrSeen.has(k)) { lrSeen.add(k); edges.push({ si: e.si, sw: e.sw, di: e.di, dw: e.dw }); }
        for (const p of [{ item_id: e.si, warehouse_id: e.sw }, { item_id: e.di, warehouse_id: e.dw }]) if (!scope.has(pairKey(p))) { scope.set(pairKey(p), p); grew = true; }
      }
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges) {
        const dst = { item_id: e.di, warehouse_id: e.dw };
        if (scope.has(`${e.si}:${e.sw}`) && !scope.has(pairKey(dst))) { scope.set(pairKey(dst), dst); grew = true; }
      }
    }
    return { scope, direct, edges, lrV };
  };
  // Khóa mọi cặp theo thứ tự băm tăng (như ghi sổ phiếu kho) để không bế tắc với ghi sổ đồng thời; đọc lại phạm vi sau khi khóa,
  // phạm vi lớn thêm (chuyển kho vừa ghi sổ) thì khóa thêm rồi đọc lại.
  const locked = new Set<string>();
  let c: Awaited<ReturnType<typeof closure>>;
  for (;;) {
    c = await closure();
    const all = [...c.scope.values()];
    if (all.every((p) => locked.has(pairKey(p)))) break;
    await sql`SELECT fn_stock_lock_keys(${ctx.tenantId}::uuid, (SELECT array_agg(ARRAY[i, w] ORDER BY hashtextextended(${ctx.tenantId}::text || ':' || i || ':' || w, 0))
      FROM unnest(${all.map((p) => p.item_id)}::bigint[], ${all.map((p) => p.warehouse_id)}::bigint[]) t(i, w)))`.execute(trx);
    for (const p of all) locked.add(pairKey(p));
  }
  const { direct, edges, lrV } = c;
  const pairs = [...c.scope.values()];
  const itemIds = pairs.map((p) => p.item_id); const whIds = pairs.map((p) => p.warehouse_id);

  // Mọi phát sinh của các cặp trong phạm vi (sau kỳ: chỉ để ghi lớp còn lại, giữ số đã ghi), cộng chiều xuất (ngoài phạm vi) của chuyển kho đến các cặp đó.
  const rows = pairs.length ? (await sql<Mv>`WITH p AS (SELECT * FROM unnest(${itemIds}::bigint[], ${whIds}::bigint[]) AS p(item_id, warehouse_id)),
    mv AS (SELECT m.* FROM stock_move m JOIN p USING (item_id, warehouse_id)),
    ext AS (SELECT DISTINCT o.* FROM stock_move o JOIN mv i ON i.transfer_id = o.transfer_id AND i.direction = 'in' AND o.direction = 'out'
      WHERE NOT EXISTS (SELECT 1 FROM p WHERE p.item_id = o.item_id AND p.warehouse_id = o.warehouse_id))
    SELECT ${MOVE_SELECT} FROM (SELECT * FROM mv UNION ALL SELECT * FROM ext) m ${MOVE_JOINS} ${MOVE_ORDER}`.execute(trx)).rows : [];
  const byId = new Map(rows.map((m) => [m.id, m]));
  const xferOut = new Map(rows.filter((m) => m.transfer_id && m.direction === 'out').map((m) => [m.transfer_id!, m]));
  const byPair = new Map<string, Mv[]>(pairs.map((p) => [pairKey(p), []]));
  for (const m of rows) byPair.get(pairKey(m))?.push(m);
  const inScope = (m: Mv) => byPair.has(pairKey(m)) && m.posting_date >= from && m.posting_date <= to;

  const settings = await getSettings(trx, ctx.tenantId);
  // Phương pháp chọn khi chạy chỉ áp cho cặp theo bộ lọc; kho nhận chuyển kho kéo vào giữ phương pháp của kho.
  const methodOf = (m: Mv): CostMethod => (direct.has(pairKey(m)) && input.method) || (m.wh_method as CostMethod | null) || settings.costing_method;

  // Giá đích: chiều xuất trong phạm vi lấy từ động cơ; ngoài phạm vi là số đã ghi sổ cái (giá gán hiện hành, không có thì giá tạm tính).
  const target = new Map<number, Decimal>(); const unitCost = new Map<number, string>();
  const booked = (m: Mv) => D(m.cur_amount ?? m.base);
  const amountOut = (o: Mv) => (inScope(o) && target.get(o.id)) || booked(o);
  // Giá trị chiều nhập: chuyển kho = giá chiều xuất cùng chuyển; nhập đảo phiếu xuất = giá chiều xuất gốc (kỳ trước: số đã ghi); còn lại = lớp nhập đã lưu.
  // LR: giá trị chiều nhập = Σ giá chiều xuất + chi phí nhập tay (Σ tiền nhập − Σ tiền xuất lúc lập phiếu), chia theo tỷ lệ đã lưu, dòng cuối nhận phần dư.
  // Chỉ nhóm LR trong phạm vi (lrV) tính lại; LR cũ hơn kỳ, hoặc sau kỳ, giữ giá trị nhập đã lưu.
  const lrGroup = new Map<string, { outs: Mv[]; ins: Mv[] }>();
  for (const m of rows) if (m.voucher_type === 'LR' && m.reversal_of === null && lrV.has(m.voucher_id)) {
    const g = lrGroup.get(m.voucher_id) ?? { outs: [], ins: [] }; lrGroup.set(m.voucher_id, g); (m.direction === 'out' ? g.outs : g.ins).push(m);
  }
  const lrValues = (g: { outs: Mv[]; ins: Mv[] }): Decimal[] => {
    const extra = g.ins.reduce((t, x) => t.plus(x.base), ZERO).minus(g.outs.reduce((t, x) => t.plus(x.base), ZERO));
    return splitByRatio(g.outs.reduce((t, x) => t.plus(amountOut(x)), ZERO).plus(extra), g.ins.map((x) => x.cost_ratio ?? '0')).map((x) => D(x));
  };
  const lrValue = (m: Mv): Decimal => {
    const g = lrGroup.get(m.voucher_id);
    return g && inScope(m) ? lrValues(g)[g.ins.indexOf(m)]! : D(m.receipt ?? m.base);
  };
  const valueIn = (m: Mv): Decimal => {
    if (isLrIn(m)) return lrValue(m);
    if (m.transfer_id) { const o = xferOut.get(m.transfer_id); if (!o) throw new Error(`Chuyển kho ${m.transfer_id} thiếu chiều xuất`); return amountOut(o); }
    if (m.reversal_of !== null) { // nhập đảo chiều xuất: giá chiều xuất gốc theo tỷ lệ số lượng nhập (trả lại một phần hàng bán)
      if (!inScope(m)) return booked(m);
      const o = byId.get(m.reversal_of)!; const v = amountOut(o);
      // lần trả cuối (cộng dồn đủ số lượng xuất) nhận phần còn lại để tổng các lần trả bằng đúng giá trị xuất
      const sibs = rows.filter((x) => x.reversal_of === o.id && x.direction === 'in'); const before = sibs.slice(0, sibs.indexOf(m));
      if (before.reduce((t, x) => t.plus(x.quantity), D(0)).plus(m.quantity).eq(o.quantity)) return v.minus(before.reduce((t, x) => t.plus(valueIn(x)), D(0)));
      return D(m.quantity).eq(o.quantity) ? v : v.times(m.quantity).div(o.quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    }
    // điều chỉnh chưa ghi nhận chỉ vào giá trị của phát sinh đến cuối kỳ (sẽ ghi ở GV lần tính này); sau kỳ chưa ghi sổ cái nên chưa tính
    return D(m.receipt ?? m.base).minus(m.posting_date > to ? (m.adj_open ?? 0) : 0);
  };
  const toEngine = (list: Mv[], fixAll: boolean): CostMove[] => list.map((m, i) => {
    const base = { id: String(m.id), seq: i, date: m.posting_date, qty: D(m.quantity).toString(), ...(m.lot_no !== null && { lot: m.lot_no }) };
    // nhập đảo phiếu xuất cùng cặp, cùng kỳ: động cơ lấy đúng giá gán của chiều xuất (bình quân cuối kỳ loại cả hai khỏi giá bình quân), không tính lặp
    const o = m.direction === 'in' && !fixAll && m.reversal_of !== null && !m.transfer_id && inScope(m) ? byId.get(m.reversal_of) : undefined;
    if (o && pairKey(o) === pairKey(m) && inScope(o) && list.indexOf(o) >= 0 && list.indexOf(o) < i) return { ...base, direction: 'in', value: null, valueFrom: String(o.id) };
    if (m.direction === 'in') return { ...base, direction: 'in', value: valueIn(m).toFixed(0) };
    // xuất đảo phiếu nhập: lấy đúng giá trị đã nhập
    if (fixAll || !inScope(m) || m.reversal_of !== null) return { ...base, direction: 'out', value: null, fixedAmount: (m.reversal_of !== null && inScope(m) ? valueIn(byId.get(m.reversal_of)!) : amountOut(m)).toFixed(0) };
    return { ...base, direction: 'out', value: null, ...(m.fixed_cost && m.unit_cost !== null && { fixedUnitCost: m.unit_cost }) };
  });
  // Tồn đầu kỳ: động cơ chạy lại phát sinh trước kỳ, mọi chiều xuất giữ số đã ghi sổ cái.
  const openingOf = (method: CostMethod, hist: Mv[]): CostOpening => {
    if (!hist.length) return { qty: '0', value: '0' };
    const r = computeCosting(method, { qty: '0', value: '0' }, toEngine(hist, true), from);
    if (method === 'avg_period' || method === 'avg_moving') return { qty: r.endQty, value: r.endValue };
    const ls = r.layers.filter((l) => !D(l.remainingQty).isZero() || !D(l.remainingValue).isZero());
    if (method === 'fifo') // lớp thiếu chuyển kỳ phải đứng một mình: gộp cả nhóm
      return { qty: r.endQty, value: r.endValue, lots: ls.some((l) => D(l.remainingQty).lt(0)) ? [{ lot: 'gop', qty: r.endQty, value: r.endValue }] : ls.map((l) => ({ lot: l.moveId, qty: l.remainingQty, value: l.remainingValue })) };
    const lots = new Map<string, { lot: string; qty: Decimal; value: Decimal }>();
    for (const l of ls) {
      const lot = byId.get(Number(l.moveId))?.lot_no ?? '';
      const g = lots.get(lot) ?? { lot, qty: ZERO, value: ZERO };
      lots.set(lot, { lot, qty: g.qty.plus(l.remainingQty), value: g.value.plus(l.remainingValue) });
    }
    return { qty: r.endQty, value: r.endValue, lots: [...lots.values()].map((l) => ({ lot: l.lot, qty: l.qty.toString(), value: l.value.toFixed(0) })) };
  };

  // Thứ tự cặp: kho đi trước kho đến (chuyển kho trong kỳ); vòng thì tính lặp đến khi không số tiền nào đổi, quá 200 lượt thì báo lỗi.
  const order: string[] = []; const indeg = new Map([...byPair.keys()].map((k) => [k, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const a = `${e.si}:${e.sw}`; const b = `${e.di}:${e.dw}`;
    if (!indeg.has(a) || !indeg.has(b)) continue;
    out.set(a, [...(out.get(a) ?? []), b]); indeg.set(b, indeg.get(b)! + 1);
  }
  const ready = [...indeg].filter(([, d]) => d === 0).map(([k]) => k).sort();
  while (ready.length) { const k = ready.shift()!; order.push(k); for (const b of out.get(k) ?? []) { indeg.set(b, indeg.get(b)! - 1); if (indeg.get(b) === 0) ready.push(b); } }
  order.push(...[...indeg.keys()].filter((k) => !order.includes(k)).sort());

  const openings = new Map<string, CostOpening>();
  let results = new Map<string, CostResult>();
  for (let pass = 1; ; pass++) {
    let changed = false; results = new Map();
    for (const k of order) {
      const list = byPair.get(k)!.filter((m) => m.posting_date <= to); if (!list.length) continue;
      const method = methodOf(list[0]!);
      const hist = list.filter((m) => m.posting_date < from); const cur = list.filter((m) => m.posting_date >= from);
      if (!openings.has(k)) openings.set(k, openingOf(method, hist));
      const r = computeCosting(method, openings.get(k)!, toEngine(cur, false), to);
      results.set(k, r);
      for (const a of r.assignments) {
        const id = Number(a.moveId); const amt = D(a.amount);
        if (!target.get(id)?.eq(amt)) { target.set(id, amt); changed = true; }
        unitCost.set(id, a.unitCost);
      }
    }
    if (!changed) break;
    if (pass >= 200) throw new AppError('COSTING_TRANSFER_CYCLE', 'Chuyển kho qua lại giữa các kho trong kỳ: giá vốn không hội tụ sau 200 lượt tính', 409);
  }

  // Lỗi của động cơ (tồn âm, thiếu lô) và nhập thành phẩm chưa có giá. Thiếu lô (giá đích danh) hủy cả lần chạy.
  const errors: CostingError[] = [];
  for (const [k, r] of results) for (const e of r.errors) {
    const m = byId.get(Number(e.moveId)) ?? byPair.get(k)![0]!;
    errors.push({ moveId: e.moveId, code: e.code, detail: `Hàng ${m.item_code} kho ${m.wh_code}: ${e.detail}` });
  }
  for (const m of rows) if (inScope(m) && m.direction === 'in' && m.stock_kind === 'finished' && !m.transfer_id && m.reversal_of === null && D(m.unit_price ?? 0).isZero() && D(m.receipt ?? 0).isZero())
    errors.push({ moveId: String(m.id), code: 'COSTING_RECEIPT_PRICE_MISSING', detail: `Hàng ${m.item_code} kho ${m.wh_code}: nhập thành phẩm ngày ${formatVnDate(m.posting_date)} chưa có giá nhập` });
  const lotMissing = errors.filter((e) => e.code === 'COSTING_LOT_MISSING');
  if (lotMissing.length) throw new AppError('COSTING_LOT_MISSING', `Giá đích danh cần số lô: ${lotMissing.slice(0, 5).map((e) => e.detail).join('; ')}`, 409, { errors: lotMissing });

  // Phát sinh có giá gán của lần chạy: chiều xuất, nhập đảo phiếu xuất (giá = giá xuất gốc).
  const assigned = rows.filter((m) => inScope(m) && (m.direction === 'out' || (m.reversal_of !== null && !m.transfer_id)));
  for (const m of assigned) if (m.direction === 'in') { const v = valueIn(m); target.set(m.id, v); unitCost.set(m.id, uc(v, m.quantity)); }
  const assignedIds = new Set(assigned.map((m) => m.id));

  // Lần chạy trước có chứng từ GV phải đảo: giữ gán hiện hành của phát sinh trong phạm vi, hoặc cùng kỳ và cùng cặp (phát sinh đã bỏ ghi sổ vẫn còn chênh trong GV).
  const keys = [...byPair.keys()];
  const curRuns = [...new Set(assigned.flatMap((m) => (m.cur_run ? [m.cur_run] : [])))];
  const prevRuns = (await sql<{ id: string }>`SELECT r.id FROM costing_run r WHERE r.status = 'done' AND (r.id = ANY(${curRuns}::uuid[])
    OR (r.period_from <= ${to}::date AND r.period_to >= ${from}::date AND (r.summary -> 'pairs') ?| ${keys}::text[]))`.execute(trx)).rows.map((r) => r.id);
  const prevGv = prevRuns.length ? (await sql<{ id: string; posting_date: string }>`SELECT v.id, v.posting_date FROM costing_run r CROSS JOIN LATERAL unnest(r.voucher_ids) u(id)
    JOIN voucher v ON v.id = u.id WHERE r.id = ANY(${prevRuns}::uuid[]) AND v.state = 'posted' ORDER BY v.posting_date, v.id`.execute(trx)).rows : [];
  // Gán hiện hành của các lần chạy đó ngoài phạm vi, có chênh: chuyển sang lần chạy mới, giữ nguyên giá, ghi vào GV cùng ngày GV cũ.
  const carried = prevRuns.length ? (await sql<Mv>`SELECT ${MOVE_SELECT} FROM stock_move m ${MOVE_JOINS}
    WHERE a.run_id = ANY(${prevRuns}::uuid[]) AND NOT (m.id = ANY(${[...assignedIds]}::bigint[])) ${MOVE_ORDER}`.execute(trx)).rows.filter((m) => !D(m.cur_amount!).eq(m.base)) : [];

  // Dòng GV: mỗi phát sinh chênh = giá gán − giá tạm tính, Nợ TK nợ / Có TK có của dòng hàng (chênh âm thì ngược lại); cộng ròng theo (ngày, TK, hàng, kho, đối tượng công nợ).
  const net = new Map<string, { date: string; account: string; item: string; wh: string; party: string | null; asset: string | null; amount: Decimal }>();
  const deltaMoves = new Map<string, number[]>();
  // LR: chênh giá của chiều xuất (hoặc nhập đảo của chiều xuất gốc) ghi bên TK kho của chính hàng đó; bên TK kho nhập ghi riêng theo từng hàng nhập của nhóm (flushLr), để số dư từng hàng khớp lớp giá.
  const lrAcc = new Map<string, { orig: string; date: string; sign: 1 | -1; d: Decimal }>();
  const lrLegOf = (m: Mv): { orig: string; sign: 1 | -1 } | null => {
    if (m.voucher_type !== 'LR' || m.transfer_id) return null;
    if (m.direction === 'out' && m.reversal_of === null) return { orig: m.voucher_id, sign: 1 };
    const o = m.direction === 'in' && m.reversal_of !== null ? byId.get(m.reversal_of) : undefined;
    return o ? { orig: o.voucher_id, sign: -1 } : null;
  };
  const addDelta = (m: Mv, date: string, d: Decimal) => {
    if (d.isZero() || m.lr_rev_out) return;
    if (!m.debit_code || !m.credit_code) throw new AppError('COSTING_ACCOUNT_MISSING', `Hàng ${m.item_code} kho ${m.wh_code}: dòng phiếu chưa có tài khoản Nợ/Có`, 409);
    deltaMoves.set(date, [...(deltaMoves.get(date) ?? []), m.id]);
    const lr = lrLegOf(m);
    if (lr) { const k = `${lr.orig}|${date}|${lr.sign}`; const g = lrAcc.get(k); lrAcc.set(k, { ...lr, date, d: (g?.d ?? ZERO).plus(d) }); }
    const sides = [[m.debit_code, m.debit_kind, m.dest_code ?? m.wh_code, 1], [m.credit_code, m.credit_kind, m.wh_code, -1]] as const;
    for (const [account, kind, whCode, sign] of lr ? [sides[lr.sign === 1 ? 1 : 0]] : sides) {
      const party = kind === 'receivable' || kind === 'payable' ? m.party_code : null;
      const asset = sign === (m.reversal_of === null ? 1 : -1) ? m.asset_code : null; // thẻ tài sản ở dòng Nợ của phiếu gốc (phiếu đảo: dòng Có); chênh giá vốn ghi cùng thẻ
      const k = [date, account, m.item_code, whCode, party ?? '', asset ?? ''].join('|');
      const g = net.get(k) ?? { date, account, item: m.item_code, wh: whCode, party, asset, amount: ZERO };
      net.set(k, { ...g, amount: g.amount.plus(d.times(sign)) });
    }
  };
  const runDate = gvDate(to);
  for (const m of assigned) addDelta(m, runDate, target.get(m.id)!.minus(m.base));
  for (const m of carried) addDelta(m, gvDate(m.carry_date!), D(m.cur_amount!).minus(m.base));
  // Lớp điều chỉnh giá nhập (chênh giá nhập thành phẩm, chênh giá mua, chi phí mua hàng) trên chiều nhập: chưa ghi nhận của cặp trong phạm vi, ngày ≤ cuối kỳ → ngày GV của lần chạy;
  // đã ghi nhận ở GV bị đảo → ghi lại cùng ngày GV đó. Nợ TK kho / Có TK đối ứng của dòng nhập. Giá trị lớp đã nằm trong giá trị nhập (receipt) nên động cơ tính xuất theo giá mới.
  const gvOldDate = new Map(prevGv.map((g) => [g.id, g.posting_date]));
  const adjLayers = (await sql<Mv & { layer_id: number; layer_value: string; layer_gv: string | null }>`SELECT ${MOVE_SELECT}, c.id AS layer_id, c.value::text AS layer_value, c.voucher_id AS layer_gv
    FROM stock_cost_layer c JOIN stock_move m ON m.tenant_id = c.tenant_id AND m.id = c.move_id ${MOVE_JOINS}
    WHERE c.kind = 'adjustment' AND (c.voucher_id = ANY(${prevGv.map((g) => g.id)}::uuid[])
      OR (c.voucher_id IS NULL AND c.posting_date <= ${to}::date AND (c.item_id || ':' || c.warehouse_id) = ANY(${keys}::text[])))`.execute(trx)).rows;
  const deltaLayers = new Map<string, number[]>(); let newlyBooked = ZERO;
  for (const a of adjLayers) {
    const date = a.layer_gv ? gvDate(gvOldDate.get(a.layer_gv)!) : runDate;
    if (!D(a.layer_value).isZero() && !a.layer_gv) newlyBooked = newlyBooked.plus(a.layer_value);
    if (!D(a.layer_value).isZero()) deltaLayers.set(date, [...(deltaLayers.get(date) ?? []), a.layer_id]);
    addDelta(a, date, D(a.layer_value));
  }
  // Bên TK kho nhập của LR: mỗi hàng nhập nhận (giá trị mới − giá tạm tính) khi các chiều xuất của nhóm ghi đủ trong lần này (tổng khớp), nếu không thì chia chênh theo tỷ lệ.
  const outsideLr = [...new Set([...lrAcc.values()].map((x) => x.orig).filter((id) => !lrGroup.has(id)))];
  const loaded = new Map<string, { item: string; wh: string; account: string; ratio: string | null; diff: string | null }[]>();
  // diff = giá trị lớp giá đã lưu − giá tạm tính của chân nhập: chính xác theo từng hàng, dùng thay cho chia theo tỷ lệ.
  if (outsideLr.length) for (const r of (await sql<{ vid: string; item: string; wh: string; account: string; ratio: string | null; diff: string | null }>`SELECT m.voucher_id AS vid, i.code AS item, w.code AS wh, da.code AS account, l.cost_ratio::text AS ratio,
      ((SELECT sum(c.value) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind IN ('receipt', 'adjustment'))
        - (CASE WHEN l.unit_cost IS NOT NULL THEN round(coalesce(l.base_quantity, l.quantity * l.uom_factor) * l.unit_cost) ELSE l.amount END))::text AS diff
    FROM stock_move m JOIN voucher_item_line l ON l.tenant_id = m.tenant_id AND l.id = m.item_line_id JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id JOIN account da ON da.id = l.debit_account_id
    WHERE m.voucher_id = ANY(${outsideLr}::uuid[]) AND m.direction = 'in' AND m.reversal_of IS NULL ORDER BY m.voucher_id, l.line_no`.execute(trx)).rows) loaded.set(r.vid, [...(loaded.get(r.vid) ?? []), r]);
  for (const x of lrAcc.values()) {
    const g = lrGroup.get(x.orig);
    const ins = g ? g.ins.map((i) => ({ item: i.item_code, wh: i.wh_code, account: i.debit_code!, ratio: i.cost_ratio, diff: null as string | null })) : (loaded.get(x.orig) ?? []);
    if (!ins.length) continue;
    const exact = g ? lrValues(g).map((v, j) => v.minus(g.ins[j]!.base)) : ins.every((i) => i.diff !== null) ? ins.map((i) => D(i.diff!)) : null;
    const amounts = exact && exact.reduce((t, v) => t.plus(v), ZERO).eq(x.d) ? exact : splitByRatio(x.d, ins.map((i) => i.ratio ?? '0')).map((v) => D(v));
    ins.forEach((i, j) => {
      const k = [x.date, i.account, i.item, i.wh, '', ''].join('|');
      const cur = net.get(k) ?? { date: x.date, account: i.account, item: i.item, wh: i.wh, party: null, asset: null, amount: ZERO };
      net.set(k, { ...cur, amount: cur.amount.plus(amounts[j]!.times(x.sign)) });
    });
  }
  const lines = [...net.values()].filter((g) => !g.amount.isZero());
  const keyOf = (x: { date: string; account: string; item: string; wh: string; party: string | null; asset: string | null; debit: string; credit: string }) =>
    [x.date, x.account, x.item, x.wh, x.party ?? '', x.asset ?? '', x.debit, x.credit].join('|');
  const newKeys = lines.map((g) => keyOf({ ...g, debit: g.amount.gt(0) ? g.amount.toFixed(0) : '0', credit: g.amount.lt(0) ? g.amount.neg().toFixed(0) : '0' })).sort();
  const oldKeys = prevGv.length ? (await sql<{ date: string; account: string; item: string; wh: string; party: string | null; asset: string | null; debit: string; credit: string }>`
    SELECT l.posting_date::text AS date, a.code AS account, i.code AS item, w.code AS wh, p.code AS party, ast.code AS asset, l.debit::text AS debit, l.credit::text AS credit
    FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN item i ON i.id = l.item_id LEFT JOIN warehouse w ON w.id = l.warehouse_id LEFT JOIN party p ON p.id = l.party_id LEFT JOIN asset ast ON ast.id = l.asset_id
    WHERE l.voucher_id = ANY(${prevGv.map((g) => g.id)}::uuid[])`.execute(trx)).rows.map(keyOf).sort() : [];
  const sameAssign = assigned.every((m) => m.cur_amount !== null && D(m.cur_amount).eq(target.get(m.id)!) && D(m.cur_unit_cost!).eq(unitCost.get(m.id)!));
  const unchanged = sameAssign && newKeys.join('\n') === oldKeys.join('\n');

  const delta = assigned.reduce((s, m) => s.plus(target.get(m.id)!.minus(booked(m))), ZERO).plus(newlyBooked);
  // Tồn 0 mà còn giá trị (mọi lần xuất cố định giá...): ghi lại để soát lỗi kho đối chiếu.
  const residual = [...results].filter(([, r]) => D(r.endQty).isZero() && !D(r.endValue).isZero())
    .map(([k, r]) => ({ itemCode: byPair.get(k)![0]!.item_code, warehouseCode: byPair.get(k)![0]!.wh_code, value: r.endValue }));
  const summary = { items: pairs.length, moves: assigned.length, delta: delta.toFixed(0), errors, unchanged, pairs: keys, residual };
  const run = await trx.insertInto('costing_run').values({ tenant_id: ctx.tenantId, period_from: from, period_to: to, method: input.method ?? 'warehouse', warehouse_id: wh?.id ?? null,
    item_id: item?.id ?? null, status: 'done', created_by: ctx.userId, summary: JSON.stringify(summary) }).returning('id').executeTakeFirstOrThrow();

  const voucherIds: string[] = [];
  if (!unchanged) {
    for (const g of prevGv) await S.reverseVoucher(trx, g.id, { postingDate: gvDate(g.posting_date), description: `Đảo chứng từ giá vốn (tính lại giá vốn ${formatVnDate(from)} – ${formatVnDate(to)})` });
    const moved = [...assigned, ...carried];
    if (moved.length) {
      await trx.updateTable('stock_cost_assignment').set({ is_current: false }).where('is_current', '=', true).where('move_id', 'in', moved.map((m) => m.id)).execute();
      for (let i = 0; i < moved.length; i += 2000) await trx.insertInto('stock_cost_assignment').values(moved.slice(i, i + 2000).map((m) => ({
        tenant_id: ctx.tenantId, run_id: run.id, move_id: m.id, lot_no: m.lot_no,
        unit_cost: assignedIds.has(m.id) ? unitCost.get(m.id)! : m.cur_unit_cost!, amount: (assignedIds.has(m.id) ? target.get(m.id)! : D(m.cur_amount!)).toFixed(0) }))).execute();
    }
    for (const date of [...new Set(lines.map((g) => g.date))].sort()) {
      const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'GV', postingDate: date, documentDate: date, currencyCode: 'VND',
        description: `Điều chỉnh giá vốn theo giá thực tế ${formatVnDate(from)} – ${formatVnDate(to)}`,
        lines: lines.filter((g) => g.date === date).map((g) => ({ accountCode: g.account, itemCode: g.item, warehouseCode: g.wh, partyCode: g.party, ...(g.asset && { assetCode: g.asset }),
          debit: g.amount.gt(0) ? g.amount.toFixed(0) : '0', credit: g.amount.lt(0) ? g.amount.neg().toFixed(0) : '0', description: `Giá vốn ${g.item} – kho ${g.wh}` })) },
      { type: 'costing_run', id: run.id });
      await S.postVoucher(trx, v.id);
      voucherIds.push(v.id);
      if (deltaLayers.get(date)?.length) await trx.updateTable('stock_cost_layer').set({ voucher_id: v.id }).where('id', 'in', deltaLayers.get(date)!).execute();
      await trx.updateTable('stock_cost_assignment').set({ voucher_id: v.id }).where('run_id', '=', run.id).where('move_id', 'in', deltaMoves.get(date)!).execute();
    }
    // Ngày mà các dòng GV cân về 0 không có chứng từ: lớp ở đó không còn nằm ở GV nào (GV cũ đã đảo), trả về chưa ghi nhận để lần sau cân lại.
    const noGv = [...deltaLayers].filter(([d]) => !lines.some((g) => g.date === d)).flatMap(([, ids]) => ids);
    if (noGv.length) await trx.updateTable('stock_cost_layer').set({ voucher_id: null }).where('id', 'in', noGv).execute();
    if (voucherIds.length) await trx.updateTable('costing_run').set({ voucher_ids: voucherIds }).where('id', '=', run.id).execute();
  }
  await writeLayers(trx, byPair, toEngine, methodOf);
  await settleState(trx, itemIds, whIds, from, to, unchanged);
  return { runId: run.id, voucherIds, summary: { items: summary.items, moves: summary.moves, delta: summary.delta, errors }, unchanged };
}

// Lớp giá còn lại hiện tại: động cơ chạy lại mọi phát sinh của cặp (cả sau kỳ) với số đã ghi sổ cái (xuất cố định: giá gán của lần chạy, sau kỳ giữ giá gán
// hiện hành hoặc giá tạm tính), lớp nhập nhận lượng, giá trị còn lại; chiều nhập chuyển kho, nhập đảo nhận giá trị mới; lớp thiếu (tồn âm) ghi lại.
// Σ giá trị còn lại = số dư TK kho của kho trên sổ cái hiện tại.
async function writeLayers(trx: Trx, byPair: Map<string, Mv[]>, toEngine: (l: Mv[], fixAll: boolean) => CostMove[], methodOf: (m: Mv) => CostMethod) {
  const ids: number[] = []; const qs: string[] = []; const vs: string[] = []; const vals: (string | null)[] = []; const ucs: (string | null)[] = [];
  const def: { move: number; item: number; wh: number; date: string; lot: string | null; q: string; v: string }[] = [];
  for (const list of byPair.values()) {
    if (!list.length) continue;
    const moves = toEngine(list, true);
    const r = computeCosting(methodOf(list[0]!), { qty: '0', value: '0' }, moves, list[list.length - 1]!.posting_date);
    const layer = new Map(r.layers.map((l) => [Number(l.moveId), l]));
    list.forEach((m, i) => {
      const l = layer.get(m.id);
      if (m.direction === 'out') { if (l) def.push({ move: m.id, item: m.item_id, wh: m.warehouse_id, date: m.posting_date, lot: m.lot_no, q: l.remainingQty, v: l.remainingValue }); return; }
      const dep = m.transfer_id !== null || m.reversal_of !== null || isLrIn(m);
      ids.push(m.id); qs.push(l?.remainingQty ?? '0'); vs.push(l?.remainingValue ?? '0');
      vals.push(dep ? moves[i]!.value : null); ucs.push(dep ? uc(D(moves[i]!.value!), m.quantity) : null);
    });
  }
  if (ids.length) await sql`UPDATE stock_cost_layer c SET remaining_qty = u.q, remaining_value = u.v, value = coalesce(u.val, c.value), unit_cost = coalesce(u.uc, c.unit_cost)
    FROM unnest(${ids}::bigint[], ${qs}::numeric[], ${vs}::numeric[], ${vals}::numeric[], ${ucs}::numeric[]) u(id, q, v, val, uc)
    WHERE c.move_id = u.id AND c.kind = 'receipt'`.execute(trx);
  const pairsItems = [...byPair.keys()].map((k) => Number(k.split(':')[0])); const pairsWh = [...byPair.keys()].map((k) => Number(k.split(':')[1]));
  await sql`DELETE FROM stock_cost_layer c USING unnest(${pairsItems}::bigint[], ${pairsWh}::bigint[]) p(i, w)
    WHERE c.kind = 'deficit' AND c.item_id = p.i AND c.warehouse_id = p.w`.execute(trx);
  if (def.length) await trx.insertInto('stock_cost_layer').values(def.map((d) => ({ tenant_id: sql<string>`app_tenant()`, move_id: d.move, item_id: d.item, warehouse_id: d.wh, lot_no: d.lot,
    kind: 'deficit', posting_date: d.date, qty: d.q, unit_cost: D(d.q).isZero() ? '0' : uc(D(d.v), d.q), value: d.v, remaining_qty: d.q, remaining_value: d.v }))).execute();
}

// Trạng thái "chưa cập nhật": cặp đã tính lại hết kỳ thì xóa đánh dấu trong kỳ; nếu giá vốn sau kỳ đã tính (có gán hiện hành sau ngày cuối kỳ),
// kỳ sau thành chưa cập nhật từ ngày kế tiếp khi lần chạy này đổi giá hoặc vừa xóa đánh dấu.
async function settleState(trx: Trx, itemIds: number[], whIds: number[], from: string, to: string, unchanged: boolean) {
  if (!itemIds.length) return;
  const gone = (await sql<{ k: string }>`DELETE FROM stock_cost_state s USING unnest(${itemIds}::bigint[], ${whIds}::bigint[]) p(i, w)
    WHERE s.item_id = p.i AND s.warehouse_id = p.w AND s.stale_from BETWEEN ${from}::date AND ${to}::date RETURNING s.item_id || ':' || s.warehouse_id AS k`.execute(trx)).rows.map((r) => r.k);
  await sql`INSERT INTO stock_cost_state(tenant_id, item_id, warehouse_id, stale_from)
    SELECT DISTINCT app_tenant(), m.item_id, m.warehouse_id, ${to}::date + 1 FROM stock_move m JOIN unnest(${itemIds}::bigint[], ${whIds}::bigint[]) p(i, w) ON m.item_id = p.i AND m.warehouse_id = p.w
      JOIN stock_cost_assignment a ON a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current
    WHERE m.posting_date > ${to}::date AND (NOT ${unchanged}::boolean OR (m.item_id || ':' || m.warehouse_id) = ANY(${gone}::text[]))
    ON CONFLICT (tenant_id, item_id, warehouse_id) DO UPDATE SET stale_from = least(stock_cost_state.stale_from, excluded.stale_from)`.execute(trx);
}

// Sửa giá nhập thành phẩm của phiếu nhập kho đã ghi sổ: không sửa dòng đã ghi sổ; chèn lớp `adjustment` (giá trị chênh) và đánh dấu giá vốn chưa cập nhật từ ngày phiếu.
// Sổ cái được điều chỉnh bằng chứng từ GV ở lần tính giá vốn sau (Nợ TK kho / Có TK đối ứng của dòng nhập).
export async function adjustReceiptPrice(trx: Trx, ctx: Ctx, voucherId: string, input: { lines: { lineNo: number; unitCost: string }[] }) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('costing'), hashtext(${ctx.tenantId}::text))`.execute(trx);
  const v = await trx.selectFrom('voucher').select(['voucher_type', 'state', 'stock_kind']).where('id', '=', voucherId).executeTakeFirst();
  if (!v || v.voucher_type !== 'PNK') throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy phiếu nhập kho', 404);
  if (v.state !== 'posted') throw new AppError('STATE_INVALID', 'Chỉ sửa giá nhập của phiếu nhập kho đã ghi sổ; phiếu nháp sửa trực tiếp trên phiếu', 409);
  if (v.stock_kind !== 'finished') throw new AppError('RECEIPT_PRICE_NOT_FINISHED', 'Chỉ sửa giá nhập thành phẩm; hàng mua dùng chênh lệch giá mua và chi phí mua hàng', 409);
  const nos = input.lines.map((l) => l.lineNo);
  if (new Set(nos).size !== nos.length) throw new AppError('VALIDATION', 'Dòng hàng bị lặp', 400);
  const cur = (await sql<{ line_no: number; move_id: number; item_id: number; warehouse_id: number; posting_date: string; lot_no: string | null; q: string; cur: string }>`
    SELECT l.line_no, m.id AS move_id, m.item_id, m.warehouse_id, m.posting_date::text AS posting_date, m.lot_no, m.quantity::text AS q,
      (SELECT coalesce(sum(c.value), 0) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind IN ('receipt', 'adjustment'))::text AS cur
    FROM voucher_item_line l JOIN stock_move m ON m.tenant_id = l.tenant_id AND m.item_line_id = l.id AND m.direction = 'in'
    WHERE l.voucher_id = ${voucherId}::uuid AND l.line_no = ANY(${nos}::int[])`.execute(trx)).rows;
  const done: { lineNo: number; before: string; after: string; delta: string }[] = [];
  for (const l of input.lines) {
    const c = cur.find((x) => x.line_no === l.lineNo);
    if (!c) throw new AppError('VALIDATION', `Phiếu không có dòng hàng ${l.lineNo}`, 400);
    const after = D(c.q).times(l.unitCost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP); const delta = after.minus(c.cur);
    if (delta.isZero()) continue;
    await trx.insertInto('stock_cost_layer').values({ tenant_id: ctx.tenantId, move_id: c.move_id, item_id: c.item_id, warehouse_id: c.warehouse_id, lot_no: c.lot_no, kind: 'adjustment',
      posting_date: c.posting_date, qty: '0', unit_cost: '0', value: delta.toFixed(0), remaining_qty: '0', remaining_value: '0' }).execute();
    await sql`INSERT INTO stock_cost_state(tenant_id, item_id, warehouse_id, stale_from) VALUES (${ctx.tenantId}::uuid, ${c.item_id}, ${c.warehouse_id}, ${c.posting_date}::date)
      ON CONFLICT (tenant_id, item_id, warehouse_id) DO UPDATE SET stale_from = least(stock_cost_state.stale_from, excluded.stale_from)`.execute(trx);
    done.push({ lineNo: l.lineNo, before: c.cur, after: after.toFixed(0), delta: delta.toFixed(0) });
  }
  if (done.length) await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after)
    VALUES (${ctx.tenantId}::uuid, ${ctx.userId}::uuid, 'receipt_price_adjust', 'voucher', ${voucherId}, ${JSON.stringify(done.map((d) => ({ lineNo: d.lineNo, value: d.before })))}::jsonb,
      ${JSON.stringify(done.map((d) => ({ lineNo: d.lineNo, value: d.after })))}::jsonb)`.execute(trx);
  return { lines: done };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const hideCost = (auth: { sensitive: Set<string> }) => !auth.sensitive.has('view_cost');
  app.post('/api/inventory/costing-runs', { preHandler: app.requirePermission('costing.run'), schema: { body: costingInput } }, async (req) => {
    const auth = req.auth!;
    const r = await app.withOverride(req, (trx) => runCosting(trx, { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') }, req.body));
    return hideCost(auth) ? { ...r, summary: { ...r.summary, delta: null } } : r; // giá vốn: cần view_cost
  });
  app.put('/api/stock-vouchers/:id/receipt-price', { preHandler: app.requirePermission('costing.run'), schema: { params: z.object({ id: z.string().uuid() }),
    body: z.object({ lines: z.array(z.object({ lineNo: z.number().int().positive(), unitCost: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Đơn giá không hợp lệ') })).min(1).max(500) }) } }, async (req) => {
    const auth = req.auth!;
    if (hideCost(auth)) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
    return app.withOverride(req, (trx) => adjustReceiptPrice(trx, { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') }, req.params.id, req.body));
  });
  app.get('/api/inventory/costing-runs', { preHandler: app.requirePermission('costing.view') }, async (req) => app.withTenant(req, async (trx) => {
    const rows = await sql<{ id: string; periodFrom: string; periodTo: string; method: string; warehouseCode: string | null; itemCode: string | null; status: string; createdAt: string;
      createdBy: string | null; voucherNos: string[]; summary: { items: number; moves: number; delta: string; errors: unknown[]; unchanged: boolean } }>`
      SELECT r.id, r.period_from AS "periodFrom", r.period_to AS "periodTo", r.method, w.code AS "warehouseCode", i.code AS "itemCode", r.status, r.created_at AS "createdAt",
        u.full_name AS "createdBy", r.summary,
        coalesce((SELECT array_agg(v.voucher_no ORDER BY v.posting_date, v.voucher_no) FROM voucher v WHERE v.id = ANY(r.voucher_ids)), '{}') AS "voucherNos"
      FROM costing_run r LEFT JOIN warehouse w ON w.id = r.warehouse_id LEFT JOIN item i ON i.id = r.item_id LEFT JOIN app_user u ON u.id = r.created_by
      ORDER BY r.created_at DESC, r.id LIMIT 200`.execute(trx);
    return rows.rows.map(({ summary, ...r }) => ({ ...r, items: summary.items, moves: summary.moves, errors: summary.errors.length, unchanged: summary.unchanged,
      delta: hideCost(req.auth!) ? null : summary.delta }));
  }));
  app.get('/api/inventory/costing-runs/:id', { preHandler: app.requirePermission('costing.view'), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => app.withTenant(req, async (trx) => {
    if (hideCost(req.auth!)) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
    const run = await trx.selectFrom('costing_run').select(['id', 'period_from', 'period_to', 'method', 'summary', 'voucher_ids']).where('id', '=', req.params.id).executeTakeFirst();
    if (!run) throw new AppError('COSTING_RUN_NOT_FOUND', 'Không tìm thấy lần tính giá vốn', 404);
    const assignments = (await sql<{ moveId: number; postingDate: string; voucherId: string; voucherType: string; voucherNo: string | null; itemCode: string; itemName: string;
      warehouseCode: string; direction: string; quantity: string; unitCost: string; amount: string; booked: string; delta: string; gvNo: string | null; isCurrent: boolean }>`
      SELECT m.id AS "moveId", m.posting_date AS "postingDate", v.id AS "voucherId", v.voucher_type AS "voucherType", v.voucher_no AS "voucherNo", i.code AS "itemCode", i.name AS "itemName",
        w.code AS "warehouseCode", m.direction, m.quantity, a.unit_cost AS "unitCost", a.amount, b.base::text AS booked, (a.amount - b.base)::text AS delta, gv.voucher_no AS "gvNo", a.is_current AS "isCurrent"
      FROM stock_cost_assignment a JOIN stock_move m ON m.id = a.move_id JOIN voucher v ON v.id = m.voucher_id JOIN voucher_item_line l ON l.id = m.item_line_id
      JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id LEFT JOIN voucher gv ON gv.id = a.voucher_id
      CROSS JOIN LATERAL (SELECT CASE WHEN l.unit_cost IS NOT NULL THEN round(coalesce(l.base_quantity, l.quantity * l.uom_factor) * l.unit_cost) ELSE l.amount END AS base) b
      WHERE a.run_id = ${req.params.id}::uuid ORDER BY m.posting_date, i.code, w.code, m.id`.execute(trx)).rows;
    return { id: run.id, periodFrom: run.period_from, periodTo: run.period_to, method: run.method, summary: run.summary, assignments };
  }));
  app.get('/api/inventory/costing-status', { preHandler: app.requirePermission('costing.view') }, async (req) => app.withTenant(req, async (trx) =>
    trx.selectFrom('stock_cost_state as s').innerJoin('item as i', 'i.id', 's.item_id').innerJoin('warehouse as w', 'w.id', 's.warehouse_id')
      .select(['i.code as itemCode', 'i.name as itemName', 'w.code as warehouseCode', 'w.name as warehouseName', 's.stale_from as staleFrom'])
      .orderBy('s.stale_from').orderBy('i.code').orderBy('w.code').execute()));
};
export default routes;
