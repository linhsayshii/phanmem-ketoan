import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { D, ZERO, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dayBefore, regimeOf } from '../reporting/ledgers.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { MAX_PRINT_ROWS, type ReportDoc } from '../reporting/print/html.js';
import { cardDocs, expiryDoc, ledgerDocs, reconcileDoc, registerDoc, summaryDoc } from '../reporting/print/stockForms.js';

type Trx = Transaction<Database>;
// Báo cáo kho đọc từ sổ kho (`stock_move`) kèm giá trị: chiều nhập = Σ lớp giá `receipt` + `adjustment` của phát sinh; chiều xuất = giá gán hiện hành
// (`stock_cost_assignment.is_current`), chưa tính giá vốn thì giá tạm tính đã ghi trên dòng hàng (cờ `provisional`).
// Phát sinh của chứng từ đã ghi sổ (kể cả chứng từ bị đảo cùng phát sinh đảo): bỏ ghi sổ thì phát sinh bị xóa nên không cần lọc trạng thái.

export interface Scope { itemId?: number | undefined; warehouseId?: number | undefined; groupIds?: number[] | undefined }
export interface ScopeInput { item?: string | undefined; warehouse?: string | undefined; group?: string | undefined }

// Mã lọc không có trong danh mục thì báo lỗi, không lặng lẽ bỏ bộ lọc. Nhóm hàng gồm cả nhóm con.
export async function resolveScope(trx: Trx, q: ScopeInput): Promise<Scope> {
  const s: Scope = {};
  if (q.item) {
    const r = await trx.selectFrom('item').select('id').where('code', '=', q.item).executeTakeFirst();
    if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có mã hàng "${q.item}"`, 404);
    s.itemId = r.id;
  }
  if (q.warehouse) {
    const r = await trx.selectFrom('warehouse').select('id').where('code', '=', q.warehouse).executeTakeFirst();
    if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có mã kho "${q.warehouse}"`, 404);
    s.warehouseId = r.id;
  }
  if (q.group) {
    const g = await trx.selectFrom('item_group').select('id').where('code', '=', q.group).executeTakeFirst();
    if (!g) throw new AppError('LOOKUP_NOT_FOUND', `Không có nhóm hàng "${q.group}"`, 404);
    s.groupIds = (await sql<{ id: number }>`WITH RECURSIVE t AS (SELECT id FROM item_group WHERE id = ${g.id} UNION SELECT c.id FROM item_group c JOIN t ON c.parent_id = t.id) SELECT id FROM t`.execute(trx)).rows.map((r) => r.id);
  }
  return s;
}
const scopeWhere = (s: Scope) => sql.join([sql`true`,
  ...(s.itemId !== undefined ? [sql`m.item_id = ${s.itemId}`] : []),
  ...(s.warehouseId !== undefined ? [sql`m.warehouse_id = ${s.warehouseId}`] : []),
  ...(s.groupIds ? [sql`i.group_id = ANY(${s.groupIds}::bigint[])`] : [])], sql` AND `);

// Phát sinh kho đến hết ngày `to` kèm giá trị; `withValue` false bỏ tra lớp giá (báo cáo chỉ số lượng).
const mvCte = (s: Scope, to: string, withValue = true) => sql`mv AS (
  SELECT m.id, m.item_id, m.warehouse_id, m.posting_date, m.direction, m.quantity, m.lot_no, m.expiry_date, m.voucher_id, m.reversal_of,
    v.voucher_no, v.voucher_type, v.description, v.day_order, v.seq_no, v.party_id, l.line_no, l.debit_account_id, l.credit_account_id,
    ${withValue ? sql`CASE WHEN m.direction = 'in' THEN coalesce(ly.val, 0)
      ELSE coalesce(a.amount, CASE WHEN l.unit_cost IS NOT NULL THEN round(coalesce(l.base_quantity, l.quantity * l.uom_factor) * l.unit_cost) ELSE l.amount END, 0) END` : sql`0`} AS val,
    (m.direction = 'out' AND a.id IS NULL) AS provisional
  FROM stock_move m JOIN voucher v ON v.id = m.voucher_id JOIN voucher_item_line l ON l.tenant_id = m.tenant_id AND l.id = m.item_line_id JOIN item i ON i.id = m.item_id
  LEFT JOIN stock_cost_assignment a ON a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current
  ${withValue ? sql`LEFT JOIN LATERAL (SELECT sum(c.value) AS val FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind IN ('receipt', 'adjustment')) ly ON true` : sql``}
  WHERE m.posting_date <= ${to}::date AND ${scopeWhere(s)})`;
// Thứ tự trong ngày như tính giá vốn: ngày, thứ tự trong ngày của chứng từ, chứng từ đảo sau chứng từ gốc, nhập trước xuất, số chứng từ, dòng.
const MV_ORDER = sql`mv.posting_date, mv.day_order, (mv.reversal_of IS NOT NULL), mv.direction = 'out', mv.seq_no, mv.line_no, mv.id`;
const SQ = sql`(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END)`;
const SV = sql`(CASE WHEN direction = 'in' THEN val ELSE -val END)`;

export const qtyStr = (v: unknown) => D(String(v ?? '0')).toString();
const unitPrice = (val: string, qty: string) => (D(qty).isZero() ? '0' : D(val).div(qty).toDecimalPlaces(4, 4).toString());
export interface Banners { provisional: boolean; stale: { itemCode: string; warehouseCode: string; staleFrom: string }[]; messages: string[] }

// Biểu ngữ: có xuất chưa tính giá vốn (số tạm tính) hoặc cặp hàng–kho giá vốn chưa cập nhật từ ngày <= `to`.
export async function banners(trx: Trx, s: Scope, to: string, provisional: boolean): Promise<Banners> {
  const stale = (await sql<{ itemCode: string; warehouseCode: string; staleFrom: string }>`SELECT i.code AS "itemCode", w.code AS "warehouseCode", st.stale_from::text AS "staleFrom"
    FROM stock_cost_state st JOIN item i ON i.id = st.item_id JOIN warehouse w ON w.id = st.warehouse_id
    WHERE st.stale_from <= ${to}::date ${s.itemId !== undefined ? sql`AND st.item_id = ${s.itemId}` : sql``} ${s.warehouseId !== undefined ? sql`AND st.warehouse_id = ${s.warehouseId}` : sql``}
      ${s.groupIds ? sql`AND i.group_id = ANY(${s.groupIds}::bigint[])` : sql``} ORDER BY i.code, w.code LIMIT 50`.execute(trx)).rows;
  const messages: string[] = [];
  if (provisional) messages.push('Có phát sinh xuất chưa tính giá vốn: giá trị xuất là số tạm tính theo chứng từ; hãy chạy Tính giá vốn để có số chính thức.');
  if (stale.length) messages.push(`Giá vốn chưa cập nhật (có ghi sổ lùi sau lần tính giá vốn) với ${stale.length} cặp hàng - kho, sớm nhất từ ngày ${stale.reduce((m, x) => (x.staleFrom < m ? x.staleFrom : m), stale[0]!.staleFrom)}; hãy chạy lại Tính giá vốn.`);
  return { provisional, stale, messages };
}

interface Bal { qty: Decimal; val: Decimal }
const pairKey = (item: number, wh: number) => `${item}:${wh}`;
// Tồn (lượng, giá trị) từng cặp hàng – kho đến hết ngày `asOf`.
async function balances(trx: Trx, s: Scope, asOf: string): Promise<Map<string, Bal>> {
  const r = await sql<{ item_id: number; warehouse_id: number; q: string; v: string }>`WITH ${mvCte(s, asOf)}
    SELECT item_id, warehouse_id, sum(${SQ})::text AS q, sum(${SV})::text AS v FROM mv GROUP BY 1, 2`.execute(trx);
  return new Map(r.rows.map((x) => [pairKey(x.item_id, x.warehouse_id), { qty: D(x.q), val: D(x.v) }]));
}

// ---- Bảng tổng hợp Nhập - Xuất - Tồn ----
export interface SummaryRow { itemCode: string; itemName: string; uomCode: string; warehouseCode: string; lotNo: string | null; openingQty: string; openingValue: string; inQty: string; inValue: string; outQty: string; outValue: string; closingQty: string; closingValue: string; provisional: boolean }
export async function stockSummary(trx: Trx, q: { from: string; to: string; detail: 'lot' | 'none'; limit?: number | undefined } & ScopeInput) {
  const s = await resolveScope(trx, q); const lot = q.detail === 'lot';
  const before = sql`posting_date < ${q.from}::date`; const inRange = sql`posting_date >= ${q.from}::date`;
  const rows = (await sql<SummaryRow & { lot: string }>`WITH ${mvCte(s, q.to)}
    SELECT i.code AS "itemCode", i.name AS "itemName", u.code AS "uomCode", w.code AS "warehouseCode", ${lot ? sql`nullif(mv.lot_no, '')` : sql`NULL`} AS "lotNo",
      coalesce(sum(${SQ}) FILTER (WHERE ${before}), 0)::text AS "openingQty", coalesce(sum(${SV}) FILTER (WHERE ${before}), 0)::text AS "openingValue",
      coalesce(sum(quantity) FILTER (WHERE ${inRange} AND direction = 'in'), 0)::text AS "inQty", coalesce(sum(val) FILTER (WHERE ${inRange} AND direction = 'in'), 0)::text AS "inValue",
      coalesce(sum(quantity) FILTER (WHERE ${inRange} AND direction = 'out'), 0)::text AS "outQty", coalesce(sum(val) FILTER (WHERE ${inRange} AND direction = 'out'), 0)::text AS "outValue",
      coalesce(sum(${SQ}), 0)::text AS "closingQty", coalesce(sum(${SV}), 0)::text AS "closingValue", coalesce(bool_or(provisional), false) AS provisional
    FROM mv JOIN item i ON i.id = mv.item_id JOIN uom u ON u.id = i.base_uom_id JOIN warehouse w ON w.id = mv.warehouse_id
    GROUP BY i.code, i.name, u.code, w.code ${lot ? sql`, nullif(mv.lot_no, '')` : sql``}
    HAVING NOT (coalesce(sum(${SQ}) FILTER (WHERE ${before}), 0) = 0 AND coalesce(sum(${SV}) FILTER (WHERE ${before}), 0) = 0 AND count(*) FILTER (WHERE ${inRange}) = 0 AND coalesce(sum(${SQ}), 0) = 0 AND coalesce(sum(${SV}), 0) = 0)
    ORDER BY i.code, w.code, 5 NULLS FIRST ${q.limit === undefined ? sql`` : sql`LIMIT ${q.limit + 1}`}`.execute(trx)).rows;
  const truncated = q.limit !== undefined && rows.length > q.limit; const shown = (truncated ? rows.slice(0, q.limit) : rows).map((r) => ({ ...r, openingQty: qtyStr(r.openingQty), inQty: qtyStr(r.inQty), outQty: qtyStr(r.outQty), closingQty: qtyStr(r.closingQty) }));
  const tot = (k: 'openingValue' | 'inValue' | 'outValue' | 'closingValue') => shown.reduce((a, r) => a.plus(r[k]), ZERO).toString();
  return { rows: shown, truncated, totals: { openingValue: tot('openingValue'), inValue: tot('inValue'), outValue: tot('outValue'), closingValue: tot('closingValue') },
    banners: await banners(trx, s, q.to, shown.some((r) => r.provisional)) };
}

// ---- Thẻ kho (S12-DN) và Sổ chi tiết (S10-DN) ----
async function pairInfo(trx: Trx, keys: Iterable<string>) {
  const ids = [...keys].map((k) => k.split(':').map(Number) as [number, number]);
  if (!ids.length) return new Map<string, { itemCode: string; itemName: string; uomCode: string; warehouseCode: string; warehouseName: string; accountCode: string | null }>();
  const r = await sql<{ item_id: number; warehouse_id: number; itemCode: string; itemName: string; uomCode: string; warehouseCode: string; warehouseName: string; accountCode: string | null }>`
    SELECT p.i AS item_id, p.w AS warehouse_id, i.code AS "itemCode", i.name AS "itemName", u.code AS "uomCode", w.code AS "warehouseCode", w.name AS "warehouseName", a.code AS "accountCode"
    FROM unnest(${ids.map((x) => x[0])}::bigint[], ${ids.map((x) => x[1])}::bigint[]) p(i, w) JOIN item i ON i.id = p.i JOIN uom u ON u.id = i.base_uom_id JOIN warehouse w ON w.id = p.w
    LEFT JOIN account a ON a.id = coalesce(w.inventory_account_id, i.inventory_account_id)`.execute(trx);
  return new Map(r.rows.map((x) => [pairKey(x.item_id, x.warehouse_id), x]));
}
export interface CardLine { postingDate: string; inVoucherNo: string | null; outVoucherNo: string | null; description: string | null; inQty: string; outQty: string; balanceQty: string }
export interface Card { itemCode: string; itemName: string; uomCode: string; warehouseCode: string; warehouseName: string; openingQty: string; lines: CardLine[]; totalInQty: string; totalOutQty: string; closingQty: string }
export async function stockCards(trx: Trx, q: { from: string; to: string; item: string; warehouse?: string | undefined; limit?: number | undefined }): Promise<{ cards: Card[]; truncated: boolean }> {
  const s = await resolveScope(trx, { item: q.item, warehouse: q.warehouse });
  const open = await balances(trx, s, dayBefore(q.from));
  // Mỗi chứng từ một dòng theo từng chiều (một phiếu nhiều dòng cùng hàng gộp lại).
  const rows = (await sql<{ item_id: number; warehouse_id: number; d: string; vno: string | null; vtype: string; descr: string | null; direction: 'in' | 'out'; qty: string }>`WITH ${mvCte(s, q.to, false)}
    SELECT item_id, warehouse_id, posting_date::text AS d, min(voucher_no) AS vno, min(voucher_type) AS vtype, min(description) AS descr, direction, sum(quantity)::text AS qty
    FROM mv WHERE posting_date >= ${q.from}::date GROUP BY item_id, warehouse_id, posting_date, voucher_id, direction
    ORDER BY warehouse_id, posting_date, min(day_order), bool_or(reversal_of IS NOT NULL), direction = 'out', min(seq_no), min(id) ${q.limit === undefined ? sql`` : sql`LIMIT ${q.limit + 1}`}`.execute(trx)).rows;
  const truncated = q.limit !== undefined && rows.length > q.limit; const shown = truncated ? rows.slice(0, q.limit) : rows;
  const keys = new Set<string>([...shown.map((r) => pairKey(r.item_id, r.warehouse_id)), ...[...open].filter(([, b]) => !b.qty.isZero()).map(([k]) => k)]);
  const info = await pairInfo(trx, keys); const cards: Card[] = [];
  for (const k of [...keys].sort((a, b) => (info.get(a)!.warehouseCode < info.get(b)!.warehouseCode ? -1 : 1))) {
    const i = info.get(k)!; const [item, wh] = k.split(':').map(Number) as [number, number];
    const openQty = open.get(k)?.qty ?? ZERO; let run = openQty; let tin = ZERO; let tout = ZERO;
    const lines = shown.filter((r) => r.item_id === item && r.warehouse_id === wh).map((r): CardLine => {
      const isIn = r.direction === 'in'; run = isIn ? run.plus(r.qty) : run.minus(r.qty); if (isIn) tin = tin.plus(r.qty); else tout = tout.plus(r.qty);
      return { postingDate: r.d, inVoucherNo: isIn ? (r.vno ?? r.vtype) : null, outVoucherNo: isIn ? null : (r.vno ?? r.vtype), description: r.descr, inQty: isIn ? qtyStr(r.qty) : '0', outQty: isIn ? '0' : qtyStr(r.qty), balanceQty: run.toString() };
    });
    cards.push({ itemCode: i.itemCode, itemName: i.itemName, uomCode: i.uomCode, warehouseCode: i.warehouseCode, warehouseName: i.warehouseName, openingQty: openQty.toString(), lines, totalInQty: tin.toString(), totalOutQty: tout.toString(), closingQty: run.toString() });
  }
  return { cards, truncated };
}

export interface LedgerLine { postingDate: string; voucherNo: string | null; description: string | null; counterAccountCode: string | null; unitPrice: string; inQty: string; inValue: string; outQty: string; outValue: string; balanceQty: string; balanceValue: string; provisional: boolean }
export interface Ledger { itemCode: string; itemName: string; uomCode: string; warehouseCode: string; warehouseName: string; accountCode: string | null; openingQty: string; openingValue: string; lines: LedgerLine[];
  totalInQty: string; totalInValue: string; totalOutQty: string; totalOutValue: string; closingQty: string; closingValue: string }
export async function stockLedgers(trx: Trx, q: { from: string; to: string; limit?: number | undefined } & ScopeInput) {
  const s = await resolveScope(trx, q);
  const open = await balances(trx, s, dayBefore(q.from));
  const rows = (await sql<{ item_id: number; warehouse_id: number; d: string; vno: string | null; vtype: string; descr: string | null; direction: 'in' | 'out'; qty: string; val: string; provisional: boolean; cp: string | null }>`WITH ${mvCte(s, q.to)}
    SELECT mv.item_id, mv.warehouse_id, mv.posting_date::text AS d, mv.voucher_no AS vno, mv.voucher_type AS vtype, mv.description AS descr, mv.direction, mv.quantity::text AS qty, mv.val::text AS val, mv.provisional,
      CASE WHEN mv.direction = 'in' THEN ca.code ELSE da.code END AS cp
    FROM mv LEFT JOIN account da ON da.id = mv.debit_account_id LEFT JOIN account ca ON ca.id = mv.credit_account_id
    WHERE mv.posting_date >= ${q.from}::date ORDER BY mv.warehouse_id, mv.item_id, ${MV_ORDER} ${q.limit === undefined ? sql`` : sql`LIMIT ${q.limit + 1}`}`.execute(trx)).rows;
  const truncated = q.limit !== undefined && rows.length > q.limit; const shown = truncated ? rows.slice(0, q.limit) : rows;
  const keys = new Set<string>([...shown.map((r) => pairKey(r.item_id, r.warehouse_id)), ...[...open].filter(([, b]) => !b.qty.isZero() || !b.val.isZero()).map(([k]) => k)]);
  const info = await pairInfo(trx, keys); const out: Ledger[] = []; let provisional = false;
  for (const k of [...keys].sort((a, b) => { const x = info.get(a)!; const y = info.get(b)!; return x.warehouseCode + '\0' + x.itemCode < y.warehouseCode + '\0' + y.itemCode ? -1 : 1; })) {
    const i = info.get(k)!; const [item, wh] = k.split(':').map(Number) as [number, number]; const o = open.get(k) ?? { qty: ZERO, val: ZERO };
    let rq = o.qty; let rv = o.val; let tiq = ZERO; let tiv = ZERO; let toq = ZERO; let tov = ZERO;
    const lines = shown.filter((r) => r.item_id === item && r.warehouse_id === wh).map((r): LedgerLine => {
      const isIn = r.direction === 'in';
      if (isIn) { rq = rq.plus(r.qty); rv = rv.plus(r.val); tiq = tiq.plus(r.qty); tiv = tiv.plus(r.val); } else { rq = rq.minus(r.qty); rv = rv.minus(r.val); toq = toq.plus(r.qty); tov = tov.plus(r.val); }
      if (r.provisional) provisional = true;
      return { postingDate: r.d, voucherNo: r.vno ?? r.vtype, description: r.descr, counterAccountCode: r.cp, unitPrice: unitPrice(r.val, r.qty), inQty: isIn ? qtyStr(r.qty) : '0', inValue: isIn ? r.val : '0',
        outQty: isIn ? '0' : qtyStr(r.qty), outValue: isIn ? '0' : r.val, balanceQty: rq.toString(), balanceValue: rv.toString(), provisional: r.provisional };
    });
    out.push({ itemCode: i.itemCode, itemName: i.itemName, uomCode: i.uomCode, warehouseCode: i.warehouseCode, warehouseName: i.warehouseName, accountCode: i.accountCode, openingQty: o.qty.toString(), openingValue: o.val.toString(), lines,
      totalInQty: tiq.toString(), totalInValue: tiv.toString(), totalOutQty: toq.toString(), totalOutValue: tov.toString(), closingQty: rq.toString(), closingValue: rv.toString() });
  }
  return { ledgers: out, truncated, banners: await banners(trx, s, q.to, provisional) };
}

// ---- Bảng kê nhập / xuất ----
export interface RegisterRow { postingDate: string; voucherNo: string | null; voucherType: string; partyCode: string | null; partyName: string | null; itemCode: string; itemName: string; uomCode: string; warehouseCode: string; lotNo: string | null; quantity: string; unitPrice: string; value: string; provisional: boolean }
export async function stockRegister(trx: Trx, q: { from: string; to: string; direction: 'in' | 'out'; limit?: number | undefined } & ScopeInput) {
  const s = await resolveScope(trx, q);
  const rows = (await sql<RegisterRow>`WITH ${mvCte(s, q.to)}
    SELECT mv.posting_date::text AS "postingDate", coalesce(mv.voucher_no, mv.voucher_type) AS "voucherNo", mv.voucher_type AS "voucherType", p.code AS "partyCode", p.name AS "partyName",
      i.code AS "itemCode", i.name AS "itemName", u.code AS "uomCode", w.code AS "warehouseCode", nullif(mv.lot_no, '') AS "lotNo", mv.quantity::text AS quantity, mv.val::text AS value, mv.provisional
    FROM mv JOIN item i ON i.id = mv.item_id JOIN uom u ON u.id = i.base_uom_id JOIN warehouse w ON w.id = mv.warehouse_id LEFT JOIN party p ON p.id = mv.party_id
    WHERE mv.posting_date >= ${q.from}::date AND mv.direction = ${q.direction}
    ORDER BY mv.posting_date, mv.voucher_no, mv.line_no, mv.id ${q.limit === undefined ? sql`` : sql`LIMIT ${q.limit + 1}`}`.execute(trx)).rows;
  const truncated = q.limit !== undefined && rows.length > q.limit; const shown = (truncated ? rows.slice(0, q.limit) : rows).map((r) => ({ ...r, quantity: qtyStr(r.quantity), unitPrice: unitPrice(r.value, r.quantity) }));
  return { rows: shown, truncated, totalValue: shown.reduce((a, r) => a.plus(r.value), ZERO).toString(), banners: await banners(trx, s, q.to, shown.some((r) => r.provisional)) };
}

// ---- Hàng sắp hết hạn theo lô ----
export interface ExpiryRow { itemCode: string; itemName: string; uomCode: string; warehouseCode: string; lotNo: string | null; expiryDate: string; quantity: string; daysLeft: number }
export async function stockExpiry(trx: Trx, q: { asOf: string; days: number } & ScopeInput) {
  const s = await resolveScope(trx, q);
  const rows = (await sql<ExpiryRow>`WITH ${mvCte(s, q.asOf, false)}
    SELECT i.code AS "itemCode", i.name AS "itemName", u.code AS "uomCode", w.code AS "warehouseCode", nullif(mv.lot_no, '') AS "lotNo", max(mv.expiry_date) FILTER (WHERE mv.direction = 'in')::text AS "expiryDate",
      sum(${SQ})::text AS quantity, (max(mv.expiry_date) FILTER (WHERE mv.direction = 'in') - ${q.asOf}::date)::int AS "daysLeft"
    FROM mv JOIN item i ON i.id = mv.item_id JOIN uom u ON u.id = i.base_uom_id JOIN warehouse w ON w.id = mv.warehouse_id
    GROUP BY i.code, i.name, u.code, w.code, nullif(mv.lot_no, '')
    HAVING sum(${SQ}) > 0 AND max(mv.expiry_date) FILTER (WHERE mv.direction = 'in') IS NOT NULL AND max(mv.expiry_date) FILTER (WHERE mv.direction = 'in') <= ${q.asOf}::date + ${q.days}::int
    ORDER BY 6, i.code, w.code`.execute(trx)).rows;
  return { rows: rows.map((r) => ({ ...r, quantity: qtyStr(r.quantity) })) };
}

// ---- Đối chiếu kế toán - thủ kho ----
// Lượng: thẻ kho (Σ phát sinh) so với lượng còn lại của lớp giá (sổ chi tiết giá vốn). Giá trị: Σ giá trị còn lại của lớp giá so với số dư sổ cái trên tài khoản kho theo (hàng, kho).
// Lớp giá phản ánh trạng thái sau lần tính giá vốn gần nhất (không có lịch sử theo ngày): đối chiếu theo `asOf` chỉ đúng khi `asOf` không trước phát sinh nào chưa tính vào lớp.
export interface ReconcileRow { itemCode: string | null; warehouseCode: string | null; accountCodes: string | null; cardQty: string; layerQty: string; qtyDiff: string; layerValue: string; ledgerValue: string; valueDiff: string }
export async function stockReconcile(trx: Trx, q: { asOf: string }) {
  const r = (await sql<ReconcileRow>`WITH card AS (SELECT item_id, warehouse_id, sum(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END) AS qty FROM stock_move WHERE posting_date <= ${q.asOf}::date GROUP BY 1, 2),
    lay AS (SELECT item_id, warehouse_id, sum(remaining_qty) AS qty, sum(remaining_value) AS val FROM stock_cost_layer WHERE posting_date <= ${q.asOf}::date GROUP BY 1, 2),
    kho AS (SELECT inventory_account_id AS id FROM warehouse WHERE inventory_account_id IS NOT NULL UNION SELECT inventory_account_id FROM item WHERE inventory_account_id IS NOT NULL),
    led AS (SELECT l.item_id, l.warehouse_id, string_agg(DISTINCT a.code, ', ' ORDER BY a.code) AS acc, sum(l.debit - l.credit) AS val
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${q.asOf}::date AND a.id IN (SELECT id FROM kho) GROUP BY 1, 2)
    , keys AS (SELECT item_id, warehouse_id FROM card UNION SELECT item_id, warehouse_id FROM lay UNION SELECT item_id, warehouse_id FROM led)
    SELECT i.code AS "itemCode", w.code AS "warehouseCode", coalesce(led.acc, wa.code) AS "accountCodes",
      coalesce(card.qty, 0)::text AS "cardQty", coalesce(lay.qty, 0)::text AS "layerQty", (coalesce(card.qty, 0) - coalesce(lay.qty, 0))::text AS "qtyDiff",
      coalesce(lay.val, 0)::text AS "layerValue", coalesce(led.val, 0)::text AS "ledgerValue", (coalesce(lay.val, 0) - coalesce(led.val, 0))::text AS "valueDiff"
    FROM keys k LEFT JOIN card ON card.item_id = k.item_id AND card.warehouse_id = k.warehouse_id LEFT JOIN lay ON lay.item_id = k.item_id AND lay.warehouse_id = k.warehouse_id
      LEFT JOIN led ON led.item_id IS NOT DISTINCT FROM k.item_id AND led.warehouse_id IS NOT DISTINCT FROM k.warehouse_id
      LEFT JOIN item i ON i.id = k.item_id LEFT JOIN warehouse w ON w.id = k.warehouse_id LEFT JOIN account wa ON wa.id = w.inventory_account_id
    ORDER BY w.code NULLS FIRST, i.code NULLS FIRST`.execute(trx)).rows.map((x) => ({ ...x, cardQty: qtyStr(x.cardQty), layerQty: qtyStr(x.layerQty), qtyDiff: qtyStr(x.qtyDiff) }));
  const nz = (v: string) => !D(v).isZero();
  const diffs = r.filter((x) => nz(x.qtyDiff) || nz(x.valueDiff));
  // Tồn 0 mà còn giá trị khớp sổ cái: kết quả hợp lệ khi mọi lần xuất đều cố định giá (phần lệch nằm lại trong tồn), không phải sai lệch.
  const notes = r.filter((x) => !nz(x.layerQty) && nz(x.layerValue) && !nz(x.valueDiff) && !nz(x.qtyDiff)).map((x) => ({ itemCode: x.itemCode, warehouseCode: x.warehouseCode, value: x.layerValue,
    message: 'Tồn bằng 0 nhưng còn giá trị: thường do mọi lần xuất đều cố định giá vốn; khớp sổ cái, không phải sai lệch.' }));
  const byAccount = new Map<string, { accountCodes: string | null; warehouseCode: string | null; layerValue: Decimal; ledgerValue: Decimal }>();
  for (const x of r) { const k = `${x.accountCodes}|${x.warehouseCode}`; const e = byAccount.get(k) ?? { accountCodes: x.accountCodes, warehouseCode: x.warehouseCode, layerValue: ZERO, ledgerValue: ZERO }; e.layerValue = e.layerValue.plus(x.layerValue); e.ledgerValue = e.ledgerValue.plus(x.ledgerValue); byAccount.set(k, e); }
  const byAccountWarehouse = [...byAccount.values()].map((e) => ({ accountCodes: e.accountCodes, warehouseCode: e.warehouseCode, layerValue: e.layerValue.toString(), ledgerValue: e.ledgerValue.toString(), valueDiff: e.layerValue.minus(e.ledgerValue).toString() }));
  const pending = D((await sql<{ n: string }>`SELECT count(*)::text AS n FROM stock_move m WHERE m.direction = 'out' AND m.posting_date <= ${q.asOf}::date
    AND NOT EXISTS (SELECT 1 FROM stock_cost_assignment a WHERE a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current)`.execute(trx)).rows[0]!.n);
  return { asOf: q.asOf, ok: diffs.length === 0, differences: diffs, byAccountWarehouse, notes, uncostedOutMoves: pending.toNumber(),
    banners: await banners(trx, {}, q.asOf, pending.gt(0)) };
}

// ---- Đường dẫn ----
const fmt = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');
const scope = { warehouse: z.string().min(1).optional(), item: z.string().min(1).optional(), group: z.string().min(1).optional() };
const range = z.object({ from: isoDate, to: isoDate, format: fmt });
const needCost = (req: FastifyRequest) => {
  if (!req.auth!.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Cần quyền xem giá vốn, giá trị tồn kho (view_cost)', 403);
};

const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('report.view');
  // JSON và HTML/PDF cắt ở MAX_PRINT_ROWS (JSON báo `truncated`, bản in báo lỗi 413); Excel không giới hạn.
  const limitOf = (f: string) => (f === 'xlsx' ? undefined : MAX_PRINT_ROWS);
  const tooLarge = (truncated: boolean, f: string) => { if (truncated && f !== 'json') throw new AppError('PRINT_TOO_LARGE', 'Báo cáo quá lớn để in một lần; hãy xuất Excel hoặc thu hẹp bộ lọc', 413); };
  // Dựng dữ liệu và tài liệu in trong cùng một giao dịch đọc; PDF/Excel dựng ngoài giao dịch.
  const serve = async <T>(req: FastifyRequest, reply: FastifyReply, f: 'json' | 'html' | 'pdf' | 'xlsx', name: string, regimeRange: { from: string; to: string },
    fetch: (trx: Transaction<Database>) => Promise<T>, docs: (trx: Transaction<Database>, regime: string, data: T) => Promise<ReportDoc[]>) => {
    if (f !== 'json') assertPrint(req.auth!);
    const out = await app.withTenant(req, async (trx) => { const data = await fetch(trx); return { data, docs: f === 'json' ? [] : await docs(trx, await regimeOf(trx, regimeRange), data) }; }, READ_SNAPSHOT);
    if (f === 'json') return out.data;
    return respondReport(reply, out.docs, f, name);
  };
  const T = (req: FastifyRequest) => req.auth!.tenantId!;

  app.get('/api/reports/stock-summary', { preHandler: view, schema: { querystring: range.extend({ ...scope, detail: z.enum(['lot', 'none']).default('none') }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    needCost(req); const q = req.query;
    return serve(req, reply, q.format, `nhap-xuat-ton-${q.from}-${q.to}`, q, (trx) => stockSummary(trx, { ...q, limit: limitOf(q.format) }).then((r) => { tooLarge(r.truncated, q.format); return r; }),
      async (trx, regime, r) => [await summaryDoc(trx, T(req), regime, q, r, q.detail === 'lot')]);
  });
  app.get('/api/reports/stock-card', { preHandler: view, schema: { querystring: range.extend({ item: z.string().min(1), warehouse: z.string().min(1).optional() }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const q = req.query; // thẻ kho chỉ có số lượng: không cần view_cost
    return serve(req, reply, q.format, `the-kho-${q.item}-${q.from}-${q.to}`, q, (trx) => stockCards(trx, { ...q, limit: limitOf(q.format) }).then((r) => { tooLarge(r.truncated, q.format); return r; }),
      (trx, regime, r) => cardDocs(trx, T(req), regime, q, r.cards));
  });
  app.get('/api/reports/stock-ledger', { preHandler: view, schema: { querystring: range.extend(scope).refine(ordered, orderedMsg) } }, async (req, reply) => {
    needCost(req); const q = req.query;
    return serve(req, reply, q.format, `so-chi-tiet-vat-tu-${q.from}-${q.to}`, q, (trx) => stockLedgers(trx, { ...q, limit: limitOf(q.format) }).then((r) => { tooLarge(r.truncated, q.format); return r; }),
      (trx, regime, r) => ledgerDocs(trx, T(req), regime, q, r.ledgers, r.banners));
  });
  app.get('/api/reports/stock-register', { preHandler: view, schema: { querystring: range.extend({ ...scope, direction: z.enum(['in', 'out']) }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    needCost(req); const q = req.query;
    return serve(req, reply, q.format, `bang-ke-${q.direction === 'in' ? 'nhap' : 'xuat'}-${q.from}-${q.to}`, q, (trx) => stockRegister(trx, { ...q, limit: limitOf(q.format) }).then((r) => { tooLarge(r.truncated, q.format); return r; }),
      async (trx, regime, r) => [await registerDoc(trx, T(req), regime, q, r)]);
  });
  app.get('/api/reports/stock-expiry', { preHandler: view, schema: { querystring: z.object({ asOf: isoDate, days: z.coerce.number().int().min(0).max(3650).default(30), format: fmt, ...scope }) } }, async (req, reply) => {
    const q = req.query; // chỉ số lượng và hạn dùng: không cần view_cost
    return serve(req, reply, q.format, `han-dung-${q.asOf}`, { from: q.asOf, to: q.asOf }, (trx) => stockExpiry(trx, q), async (trx, regime, r) => [await expiryDoc(trx, T(req), regime, q, r.rows)]);
  });
  app.get('/api/reports/stock-reconcile', { preHandler: view, schema: { querystring: z.object({ asOf: isoDate, format: fmt }) } }, async (req, reply) => {
    needCost(req); const q = req.query;
    return serve(req, reply, q.format, `doi-chieu-kho-${q.asOf}`, { from: q.asOf, to: q.asOf }, (trx) => stockReconcile(trx, q), async (trx, regime, r) => [await reconcileDoc(trx, T(req), regime, r)]);
  });
};
export default routes;
