import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { resolveByCodes } from '../inventory/priceLists.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { redactCost } from '../invoices/sales.js';
import { createInvoice, invoiceInput, type InvoiceDto } from '../invoices/service.js';
import { syncOrders } from './link.js';

type Trx = Transaction<Database>;
type CreateCtx = Parameters<typeof createInvoice>[1];
const QTY = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số lượng không hợp lệ');
const KINDS = ['quote', 'sale_order', 'purchase_order'] as const;
const PREFIX = { quote: 'BG', sale_order: 'DH', purchase_order: 'DM' } as const;
type Kind = (typeof KINDS)[number];

export const orderLineInput = z.object({
  itemCode: z.string().min(1), uomCode: z.string().min(1).optional(), warehouseCode: z.string().min(1).nullable().optional(), quantity: QTY,
  unitPrice: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Đơn giá không hợp lệ').optional(), // bỏ trống: lấy từ bảng giá
  discountRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).refine((s) => Number(s) <= 100, 'Tỷ lệ chiết khấu tối đa 100%').optional(), taxCode: z.string().min(1).nullable().optional(),
});
export const orderInput = z.object({
  kind: z.enum(KINDS), docDate: dateIso, partyCode: z.string().min(1), contractCode: z.string().min(1).nullable().optional(),
  currencyCode: z.string().length(3).default('VND'), fxRate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).optional(), note: z.string().max(1000).nullable().optional(),
  lines: z.array(orderLineInput).min(1).max(500, 'Tối đa 500 dòng mỗi đơn'),
});
export type OrderInput = z.infer<typeof orderInput>;
export const convertInput = z.object({
  to: z.enum(['SO', 'BH', 'MH']), date: dateIso.optional(), warehouseCode: z.string().min(1).optional(),
  lines: z.array(z.object({ lineNo: z.number().int().positive(), quantity: QTY })).refine((a) => new Set(a.map((x) => x.lineNo)).size === a.length, 'Mỗi dòng chỉ được chuyển một lần').optional(),
});
export const contractInput = z.object({
  code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(255), partyCode: z.string().min(1).nullable().optional(), kind: z.enum(['sale', 'purchase']),
  signedDate: dateIso.nullable().optional(), validTo: dateIso.nullable().optional(), value: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).default('0'),
  currencyCode: z.string().length(3).default('VND'), status: z.enum(['draft', 'active', 'expired', 'terminated']).default('active'), note: z.string().max(1000).nullable().optional(),
});

const notFound = () => new AppError('ORDER_NOT_FOUND', 'Không tìm thấy đơn', 404);
async function idOf(trx: Trx, table: 'item' | 'uom' | 'warehouse' | 'party' | 'contract', code: string, what: string): Promise<string> {
  const r = await sql<{ id: string }>`SELECT id::text FROM ${sql.table(table)} WHERE code = ${code}`.execute(trx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', `Không tìm thấy ${what} ${code}`, 404);
  return r.rows[0].id;
}

async function nextNo(trx: Trx, tenantId: string, kind: Kind, date: string): Promise<string> {
  const year = Number(date.slice(0, 4));
  const r = await sql<{ n: number }>`INSERT INTO doc_order_counter(tenant_id, kind, fiscal_year, last_no) VALUES (${tenantId}::uuid, ${kind}, ${year}, 1)
    ON CONFLICT (tenant_id, kind, fiscal_year) DO UPDATE SET last_no = doc_order_counter.last_no + 1 RETURNING last_no AS n`.execute(trx);
  return `${PREFIX[kind]}-${year}-${String(r.rows[0]!.n).padStart(4, '0')}`;
}

async function insertLines(trx: Trx, tenantId: string, orderId: string, b: OrderInput): Promise<void> {
  const priceKind = b.kind === 'purchase_order' ? 'purchase' : 'sale';
  let no = 0;
  for (const l of b.lines) {
    no++;
    const itemId = await idOf(trx, 'item', l.itemCode, 'vật tư hàng hóa');
    const base = (await sql<{ u: string }>`SELECT base_uom_id::text AS u FROM item WHERE id = ${itemId}::bigint`.execute(trx)).rows[0]!.u;
    const uomId = l.uomCode ? await idOf(trx, 'uom', l.uomCode, 'đơn vị tính') : base;
    let price = l.unitPrice; let disc = l.discountRate;
    if (price === undefined) {
      const hit = await resolveByCodes(trx, { kind: priceKind, itemCode: l.itemCode, ...(l.uomCode && { uomCode: l.uomCode }), partyCode: b.partyCode, date: b.docDate, qty: l.quantity, currency: b.currencyCode });
      if (hit.price === null) throw new AppError('ORDER_PRICE_MISSING', `Dòng ${no}: ${l.itemCode} chưa có đơn giá và không tìm thấy trong bảng giá`, 422);
      price = hit.price; disc ??= hit.discountRate ?? undefined;
    }
    const wh = l.warehouseCode ? await idOf(trx, 'warehouse', l.warehouseCode, 'kho') : null;
    await sql`INSERT INTO doc_order_line(tenant_id, order_id, line_no, item_id, uom_id, warehouse_id, quantity, unit_price, discount_rate, tax_code)
      VALUES (${tenantId}::uuid, ${orderId}::uuid, ${no}, ${itemId}::bigint, ${uomId}::bigint, ${wh}::bigint, ${l.quantity}::numeric, ${price}::numeric, ${disc ?? '0'}::numeric, ${l.taxCode ?? null})`.execute(trx);
  }
}

const headerArgs = async (trx: Trx, b: OrderInput) => ({ party: await idOf(trx, 'party', b.partyCode, 'đối tượng'), contract: b.contractCode ? await idOf(trx, 'contract', b.contractCode, 'hợp đồng') : null });

export async function createOrder(trx: Trx, ctx: { tenantId: string; userId: string }, b: OrderInput) {
  const h = await headerArgs(trx, b);
  const no = await nextNo(trx, ctx.tenantId, b.kind, b.docDate);
  const r = await sql<{ id: string }>`INSERT INTO doc_order(tenant_id, kind, doc_no, doc_date, party_id, contract_id, currency_code, fx_rate, note, created_by)
    VALUES (${ctx.tenantId}::uuid, ${b.kind}, ${no}, ${b.docDate}::date, ${h.party}::uuid, ${h.contract}::bigint, ${b.currencyCode}, ${b.fxRate ?? null}::numeric, ${b.note ?? null}, ${ctx.userId}::uuid) RETURNING id::text`.execute(trx);
  await insertLines(trx, ctx.tenantId, r.rows[0]!.id, b);
  return getOrder(trx, r.rows[0]!.id);
}

async function lockOrder(trx: Trx, id: string) {
  const r = await sql<{ id: string; kind: Kind; status: string; docNo: string; docDate: string; partyCode: string; currencyCode: string }>`
    SELECT o.id::text, o.kind, o.status, o.doc_no AS "docNo", o.doc_date::text AS "docDate", p.code AS "partyCode", o.currency_code AS "currencyCode"
    FROM doc_order o JOIN party p ON p.tenant_id = o.tenant_id AND p.id = o.party_id WHERE o.id = ${id}::uuid FOR UPDATE OF o`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
const linkCount = async (trx: Trx, id: string) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM doc_order_link k JOIN doc_order_line l ON l.tenant_id = k.tenant_id AND l.id = k.order_line_id WHERE l.order_id = ${id}::uuid`.execute(trx)).rows[0]!.n);

export async function updateOrder(trx: Trx, ctx: { tenantId: string }, id: string, b: OrderInput) {
  const o = await lockOrder(trx, id);
  if (!['draft', 'confirmed'].includes(o.status) || (await linkCount(trx, id))) throw new AppError('ORDER_LOCKED', 'Đơn đã chuyển thành chứng từ hoặc đã hủy, không sửa được', 409);
  if (b.kind !== o.kind) throw new AppError('ORDER_KIND_INVALID', 'Không đổi loại của đơn', 409);
  const h = await headerArgs(trx, b);
  await sql`UPDATE doc_order SET doc_date = ${b.docDate}::date, party_id = ${h.party}::uuid, contract_id = ${h.contract}::bigint, currency_code = ${b.currencyCode}, fx_rate = ${b.fxRate ?? null}::numeric, note = ${b.note ?? null} WHERE id = ${id}::uuid`.execute(trx);
  await sql`DELETE FROM doc_order_line WHERE order_id = ${id}::uuid`.execute(trx);
  await insertLines(trx, ctx.tenantId, id, b);
  return getOrder(trx, id);
}

export async function setOrderStatus(trx: Trx, id: string, to: 'confirmed' | 'cancelled') {
  const o = await lockOrder(trx, id);
  if (to === 'confirmed' ? o.status !== 'draft' : !['draft', 'confirmed'].includes(o.status) || (await linkCount(trx, id)))
    throw new AppError('ORDER_STATUS_INVALID', to === 'confirmed' ? 'Chỉ duyệt đơn đang nháp' : 'Chỉ hủy đơn chưa chuyển thành chứng từ', 409);
  await sql`UPDATE doc_order SET status = ${to} WHERE id = ${id}::uuid`.execute(trx);
  return getOrder(trx, id);
}

export async function deleteOrder(trx: Trx, id: string): Promise<void> {
  const o = await lockOrder(trx, id);
  if (o.status !== 'draft' || (await linkCount(trx, id))) throw new AppError('ORDER_LOCKED', 'Chỉ xóa đơn nháp chưa chuyển thành chứng từ', 409);
  await sql`DELETE FROM doc_order WHERE id = ${id}::uuid`.execute(trx);
}

export async function getOrder(trx: Trx, id: string) {
  const h = await sql<{ id: string; kind: Kind; docNo: string; docDate: string; status: string; partyCode: string; partyName: string; contractCode: string | null; currencyCode: string; fxRate: string | null; note: string | null }>`
    SELECT o.id::text, o.kind, o.doc_no AS "docNo", o.doc_date::text AS "docDate", o.status, p.code AS "partyCode", p.name AS "partyName", c.code AS "contractCode",
      o.currency_code AS "currencyCode", o.fx_rate::text AS "fxRate", o.note
    FROM doc_order o JOIN party p ON p.tenant_id = o.tenant_id AND p.id = o.party_id LEFT JOIN contract c ON c.tenant_id = o.tenant_id AND c.id = o.contract_id WHERE o.id = ${id}::uuid`.execute(trx);
  if (!h.rows[0]) throw notFound();
  const lines = await sql<{ lineNo: number; itemCode: string; itemName: string; uomCode: string; warehouseCode: string | null; quantity: string; unitPrice: string; discountRate: string; taxCode: string | null; deliveredQty: string }>`
    SELECT l.line_no AS "lineNo", i.code AS "itemCode", i.name AS "itemName", u.code AS "uomCode", w.code AS "warehouseCode", l.quantity::text, l.unit_price::text AS "unitPrice",
      l.discount_rate::text AS "discountRate", l.tax_code AS "taxCode", l.delivered_qty::text AS "deliveredQty"
    FROM doc_order_line l JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id JOIN uom u ON u.tenant_id = l.tenant_id AND u.id = l.uom_id
    LEFT JOIN warehouse w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id WHERE l.order_id = ${id}::uuid ORDER BY l.line_no`.execute(trx);
  const vouchers = await sql<{ id: string; voucherType: string; voucherNo: string | null; state: string }>`
    SELECT DISTINCT v.id::text, v.voucher_type AS "voucherType", v.voucher_no AS "voucherNo", v.state FROM doc_order_link k
    JOIN doc_order_line l ON l.tenant_id = k.tenant_id AND l.id = k.order_line_id JOIN voucher v ON v.tenant_id = k.tenant_id AND v.id = k.voucher_id WHERE l.order_id = ${id}::uuid`.execute(trx);
  return { ...h.rows[0], lines: lines.rows, vouchers: vouchers.rows };
}
export type OrderDto = Awaited<ReturnType<typeof getOrder>>;

export async function listOrders(trx: Trx, q: { kind?: string | undefined; status?: string | undefined; q?: string | undefined }) {
  const r = await sql<{ id: string; kind: string; docNo: string; docDate: string; status: string; partyCode: string; partyName: string; total: string }>`
    SELECT o.id::text, o.kind, o.doc_no AS "docNo", o.doc_date::text AS "docDate", o.status, p.code AS "partyCode", p.name AS "partyName",
      coalesce((SELECT sum(round(l.quantity * l.unit_price * (1 - l.discount_rate / 100), CASE WHEN o.currency_code = 'VND' THEN 0 ELSE 4 END)) FROM doc_order_line l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id), 0)::text AS total
    FROM doc_order o JOIN party p ON p.tenant_id = o.tenant_id AND p.id = o.party_id
    WHERE (${q.kind ?? null}::text IS NULL OR o.kind = ${q.kind ?? null}) AND (${q.status ?? null}::text IS NULL OR o.status = ${q.status ?? null})
      AND (${q.q ?? null}::text IS NULL OR o.doc_no ILIKE '%' || ${q.q ?? null} || '%' OR p.name ILIKE '%' || ${q.q ?? null} || '%')
    ORDER BY o.doc_date DESC, o.doc_no DESC LIMIT 500`.execute(trx);
  return r.rows;
}

// Báo giá thành đơn bán: đổi loại, cấp số mới; hoặc dựng chứng từ BH/MH nháp từ các dòng còn lại (cả đơn hoặc một phần), cộng delivered_qty.
export async function convertOrder(trx: Trx, ctx: CreateCtx, id: string, b: z.infer<typeof convertInput>): Promise<{ order: OrderDto; voucher: InvoiceDto | null }> {
  const o = await lockOrder(trx, id);
  if (o.status === 'cancelled') throw new AppError('ORDER_CANCELLED', 'Đơn đã hủy, không chuyển được', 409);
  if (b.to === 'SO') {
    if (o.kind !== 'quote' || !['draft', 'confirmed'].includes(o.status)) throw new AppError('ORDER_KIND_INVALID', 'Chỉ chuyển báo giá chưa chuyển chứng từ thành đơn bán', 409);
    if (await linkCount(trx, id)) throw new AppError('ORDER_KIND_INVALID', 'Báo giá đã chuyển thành chứng từ', 409);
    const no = await nextNo(trx, ctx.tenantId, 'sale_order', o.docDate);
    await sql`UPDATE doc_order SET kind = 'sale_order', doc_no = ${no} WHERE id = ${id}::uuid`.execute(trx);
    return { order: await getOrder(trx, id), voucher: null };
  }
  if (b.to === 'BH' ? o.kind === 'purchase_order' : o.kind !== 'purchase_order') throw new AppError('ORDER_KIND_INVALID', b.to === 'BH' ? 'BH chỉ sinh từ báo giá hoặc đơn bán' : 'MH chỉ sinh từ đơn mua', 409);
  const lines = await sql<{ id: string; lineNo: number; itemCode: string; uomCode: string; whCode: string | null; kind: string; quantity: string; delivered: string; unitPrice: string; discountRate: string; taxCode: string | null }>`
    SELECT l.id::text, l.line_no AS "lineNo", i.code AS "itemCode", u.code AS "uomCode", w.code AS "whCode", i.kind, l.quantity::text, l.delivered_qty::text AS delivered,
      l.unit_price::text AS "unitPrice", l.discount_rate::text AS "discountRate", l.tax_code AS "taxCode"
    FROM doc_order_line l JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id JOIN uom u ON u.tenant_id = l.tenant_id AND u.id = l.uom_id
    LEFT JOIN warehouse w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id WHERE l.order_id = ${id}::uuid ORDER BY l.line_no FOR UPDATE OF l`.execute(trx);
  const remaining = (l: (typeof lines.rows)[number]) => D(l.quantity).minus(l.delivered);
  const pick = b.lines ?? lines.rows.filter((l) => remaining(l).gt(0)).map((l) => ({ lineNo: l.lineNo, quantity: remaining(l).toFixed(4) }));
  if (!pick.length) throw new AppError('ORDER_QTY_EXCEEDED', 'Đơn đã chuyển hết số lượng', 409);
  const dp = o.currencyCode === 'VND' ? 0 : 4;
  const date = b.date ?? o.docDate;
  const items = pick.map((p) => {
    const l = lines.rows.find((x) => x.lineNo === p.lineNo);
    if (!l) throw new AppError('ORDER_LINE_NOT_FOUND', `Đơn không có dòng ${p.lineNo}`, 404);
    if (D(p.quantity).lte(0) || D(p.quantity).gt(remaining(l))) throw new AppError('ORDER_QTY_EXCEEDED', `Dòng ${p.lineNo}: số lượng chuyển vượt số còn lại ${remaining(l).toFixed(4)}`, 409);
    const wh = l.kind === 'service' ? null : (l.whCode ?? b.warehouseCode ?? null);
    if (l.kind !== 'service' && !wh) throw new AppError('ORDER_WAREHOUSE_REQUIRED', `Dòng ${p.lineNo}: chưa có kho, hãy chọn kho khi chuyển`, 422);
    const gross = D(p.quantity).times(l.unitPrice).toDecimalPlaces(dp);
    return { l, p, item: { description: null, itemCode: l.itemCode, uomCode: l.uomCode, warehouseCode: wh, quantity: p.quantity, unitPrice: l.unitPrice, discountRate: l.discountRate,
      amountCurrency: gross.toFixed(dp), discountCurrency: gross.times(l.discountRate).div(100).toDecimalPlaces(dp).toFixed(dp), taxCodes: l.taxCode ? [l.taxCode] : [] } };
  });
  const sale = b.to === 'BH';
  const input = invoiceInput.parse({ voucherType: b.to, postingDate: date, documentDate: date, partyCode: o.partyCode, currencyCode: o.currencyCode, description: `Theo ${o.docNo}`, items: items.map((x) => x.item),
    invoice: { invoiceNo: o.docNo, invoiceDate: date, invoiceGroupCode: sale ? '10' : '01' } });
  const fx = (await sql<{ fx: string | null }>`SELECT fx_rate::text AS fx FROM doc_order WHERE id = ${id}::uuid`.execute(trx)).rows[0]!.fx;
  const created = await createInvoice(trx, ctx, fx ? { ...input, fxRate: fx } : input);
  for (const x of items)
    await sql`INSERT INTO doc_order_link(tenant_id, order_line_id, voucher_id, quantity) VALUES (${ctx.tenantId}::uuid, ${x.l.id}::bigint, ${created.id}::uuid, ${x.p.quantity}::numeric)`.execute(trx);
  await sql`UPDATE doc_order SET status = 'confirmed' WHERE id = ${id}::uuid AND status = 'draft'`.execute(trx);
  await syncOrders(trx, [id]);
  return { order: await getOrder(trx, id), voucher: ctx.auth ? await redactCost(trx, ctx.auth, created) : created }; // như POST /api/invoices: che dòng giá vốn
}

// ---- Hợp đồng ----
export async function listContracts(trx: Trx, kind?: string) {
  return (await sql`SELECT c.id::int, c.code, c.name, p.code AS "partyCode", c.kind, c.signed_date::text AS "signedDate", c.valid_to::text AS "validTo", c.value::text, c.currency_code AS "currencyCode", c.status, c.note
    FROM contract c LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id WHERE (${kind ?? null}::text IS NULL OR c.kind = ${kind ?? null}) ORDER BY c.code`.execute(trx)).rows;
}
export async function saveContract(trx: Trx, tenantId: string, id: number | null, b: z.infer<typeof contractInput>) {
  const party = b.partyCode ? await idOf(trx, 'party', b.partyCode, 'đối tượng') : null;
  const r = id === null
    ? await sql<{ id: number }>`INSERT INTO contract(tenant_id, code, name, party_id, kind, signed_date, valid_to, value, currency_code, status, note)
        VALUES (${tenantId}::uuid, ${b.code}, ${b.name}, ${party}::uuid, ${b.kind}, ${b.signedDate ?? null}::date, ${b.validTo ?? null}::date, ${b.value}::numeric, ${b.currencyCode}, ${b.status}, ${b.note ?? null}) RETURNING id::int`.execute(trx)
    : await sql<{ id: number }>`UPDATE contract SET code = ${b.code}, name = ${b.name}, party_id = ${party}::uuid, kind = ${b.kind}, signed_date = ${b.signedDate ?? null}::date, valid_to = ${b.validTo ?? null}::date,
        value = ${b.value}::numeric, currency_code = ${b.currencyCode}, status = ${b.status}, note = ${b.note ?? null} WHERE id = ${id}::bigint RETURNING id::int`.execute(trx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', 'Không tìm thấy hợp đồng', 404);
  return (await listContracts(trx)).find((c) => (c as { id: number }).id === r.rows[0]!.id)!;
}
export async function deleteContract(trx: Trx, id: number): Promise<void> {
  const r = await sql`DELETE FROM contract WHERE id = ${id}::bigint`.execute(trx);
  if (!r.numAffectedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy hợp đồng', 404);
}
