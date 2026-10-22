import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;
const QTY_RE = /^\d{1,16}(\.\d{1,4})?$/;
const RATE_RE = /^\d{1,3}(\.\d{1,4})?$/;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const priceLineInput = z.object({
  itemCode: z.string().min(1), uomCode: z.string().min(1),
  minQty: z.string().regex(QTY_RE).default('0'),
  price: z.string().regex(QTY_RE), // tiền ngoại tệ có thể lẻ: NUMERIC(20,4)
  discountRate: z.string().regex(RATE_RE).default('0'),
});
export const priceListInput = z.object({
  code: z.string().min(1).max(30), name: z.string().min(1).max(200),
  kind: z.enum(['sale', 'purchase']), currencyCode: z.string().length(3),
  partyGroupCode: z.string().min(1).nullish(),
  validFrom: dateStr, validTo: dateStr.nullish(), priority: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
  lines: z.array(priceLineInput).max(20_000).optional(),
});
export type PriceLineInput = z.infer<typeof priceLineInput>;
export type PriceListInput = z.infer<typeof priceListInput>;

export interface ResolveArgs { kind: 'sale' | 'purchase'; itemId: number; uomId: number; partyId?: string; date: string; qty: string; currency: string }

// Chọn dòng giá: bảng giá còn hiệu lực đúng loại tiền; nhóm của đối tượng trước bảng chung, rồi priority cao, rồi bảng mới hơn; trong bảng lấy bậc min_qty lớn nhất ≤ qty.
export async function resolvePrice(trx: Trx, a: ResolveArgs): Promise<{ price: string; discountRate: string; priceListId: number } | null> {
  const r = await sql<{ price: string; discountRate: string; priceListId: string }>`
    SELECT l.price::text AS price, l.discount_rate::text AS "discountRate", p.id::text AS "priceListId"
    FROM price_list p JOIN price_list_line l ON l.tenant_id = p.tenant_id AND l.price_list_id = p.id
    WHERE p.tenant_id = app_tenant() AND p.kind = ${a.kind} AND p.is_active AND p.currency_code = ${a.currency}
      AND p.valid_from <= ${a.date}::date AND (p.valid_to IS NULL OR p.valid_to >= ${a.date}::date)
      AND l.item_id = ${a.itemId} AND l.uom_id = ${a.uomId} AND l.min_qty <= ${a.qty}::numeric
      AND (p.party_group_id IS NULL OR p.party_group_id = (SELECT group_id FROM party WHERE tenant_id = p.tenant_id AND id = ${a.partyId ?? null}::uuid))
    ORDER BY (p.party_group_id IS NOT NULL) DESC, p.priority DESC, p.valid_from DESC, p.id DESC, l.min_qty DESC LIMIT 1`.execute(trx);
  const row = r.rows[0];
  return row ? { price: row.price, discountRate: row.discountRate, priceListId: Number(row.priceListId) } : null;
}

const one = async (trx: Trx, table: 'item' | 'uom' | 'party_group', code: string, what: string): Promise<string> => {
  const r = await sql<{ id: string }>`SELECT id::text FROM ${sql.table(table)} WHERE code = ${code}`.execute(trx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', `Không tìm thấy ${what} ${code}`, 404);
  return r.rows[0].id;
};

export async function resolveLines(trx: Trx, lines: PriceLineInput[]) {
  const items = new Map<string, string>(); const uoms = new Map<string, string>();
  const out = [];
  for (const l of lines) {
    if (!items.has(l.itemCode)) items.set(l.itemCode, await one(trx, 'item', l.itemCode, 'vật tư hàng hóa'));
    if (!uoms.has(l.uomCode)) uoms.set(l.uomCode, await one(trx, 'uom', l.uomCode, 'đơn vị tính'));
    out.push({ item_id: items.get(l.itemCode)!, uom_id: uoms.get(l.uomCode)!, min_qty: l.minQty, price: l.price, discount_rate: l.discountRate });
  }
  return out;
}

async function insertLines(trx: Trx, tenantId: string, listId: string, lines: PriceLineInput[]) {
  const rows = await resolveLines(trx, lines);
  for (let i = 0; i < rows.length; i += 500)
    await sql`INSERT INTO price_list_line (tenant_id, price_list_id, item_id, uom_id, min_qty, price, discount_rate)
      VALUES ${sql.join(rows.slice(i, i + 500).map((r) => sql`(${tenantId}::uuid, ${listId}::bigint, ${r.item_id}::bigint, ${r.uom_id}::bigint, ${r.min_qty}::numeric, ${r.price}::numeric, ${r.discount_rate}::numeric)`))}`.execute(trx);
}

async function groupId(trx: Trx, code: string | null | undefined): Promise<string | null> {
  return code ? one(trx, 'party_group', code, 'nhóm đối tượng') : null;
}

export async function createPriceList(trx: Trx, tenantId: string, b: PriceListInput): Promise<string> {
  const g = await groupId(trx, b.partyGroupCode);
  const r = await sql<{ id: string }>`INSERT INTO price_list (tenant_id, code, name, kind, currency_code, party_group_id, valid_from, valid_to, priority, is_active)
    VALUES (${tenantId}::uuid, ${b.code}, ${b.name}, ${b.kind}, ${b.currencyCode}, ${g}::uuid, ${b.validFrom}::date, ${b.validTo ?? null}::date, ${b.priority}, ${b.isActive}) RETURNING id::text`.execute(trx);
  const id = r.rows[0]!.id;
  if (b.lines?.length) await insertLines(trx, tenantId, id, b.lines);
  return id;
}

// Có `lines` thì thay toàn bộ dòng giá; vắng thì giữ nguyên.
export async function updatePriceList(trx: Trx, tenantId: string, id: string, b: PriceListInput): Promise<void> {
  const g = await groupId(trx, b.partyGroupCode);
  const r = await sql`UPDATE price_list SET code = ${b.code}, name = ${b.name}, kind = ${b.kind}, currency_code = ${b.currencyCode}, party_group_id = ${g}::uuid,
    valid_from = ${b.validFrom}::date, valid_to = ${b.validTo ?? null}::date, priority = ${b.priority}, is_active = ${b.isActive} WHERE id = ${id}::bigint`.execute(trx);
  if (!r.numAffectedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy bảng giá', 404);
  if (b.lines) { await sql`DELETE FROM price_list_line WHERE price_list_id = ${id}::bigint`.execute(trx); await insertLines(trx, tenantId, id, b.lines); }
}

export async function addLines(trx: Trx, tenantId: string, id: string, lines: PriceLineInput[]): Promise<void> {
  if (!(await sql`SELECT 1 FROM price_list WHERE id = ${id}::bigint`.execute(trx)).rows.length) throw new AppError('NOT_FOUND', 'Không tìm thấy bảng giá', 404);
  await insertLines(trx, tenantId, id, lines);
}

export async function listPriceLists(trx: Trx, q: { kind?: string | undefined }) {
  const r = await sql`SELECT p.id, p.code, p.name, p.kind, p.currency_code AS "currencyCode", g.code AS "partyGroupCode", p.valid_from::text AS "validFrom", p.valid_to::text AS "validTo", p.priority, p.is_active AS "isActive",
      (SELECT count(*)::int FROM price_list_line l WHERE l.price_list_id = p.id) AS "lineCount"
    FROM price_list p LEFT JOIN party_group g ON g.id = p.party_group_id
    WHERE ${q.kind ? sql`p.kind = ${q.kind}` : sql`true`} ORDER BY p.kind, p.priority DESC, p.code`.execute(trx);
  return r.rows;
}

export async function getPriceList(trx: Trx, id: string) {
  const h = (await listPriceLists(trx, {})).find((x) => String((x as { id: number }).id) === id);
  if (!h) throw new AppError('NOT_FOUND', 'Không tìm thấy bảng giá', 404);
  const l = await sql`SELECT l.id, i.code AS "itemCode", i.name AS "itemName", u.code AS "uomCode", l.min_qty::text AS "minQty", l.price::text AS price, l.discount_rate::text AS "discountRate"
    FROM price_list_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = l.uom_id WHERE l.price_list_id = ${id}::bigint ORDER BY i.code, u.code, l.min_qty`.execute(trx);
  return { ...h, lines: l.rows };
}

export async function deletePriceList(trx: Trx, id: string): Promise<void> {
  const r = await sql`DELETE FROM price_list WHERE id = ${id}::bigint`.execute(trx);
  if (!r.numAffectedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy bảng giá', 404);
}

export async function resolveByCodes(trx: Trx, q: { kind: 'sale' | 'purchase'; itemCode: string; uomCode?: string | undefined; partyCode?: string | undefined; date: string; qty: string; currency: string }) {
  const item = await sql<{ id: string; base: string }>`SELECT id::text, base_uom_id::text AS base FROM item WHERE code = ${q.itemCode}`.execute(trx);
  if (!item.rows[0]) throw new AppError('NOT_FOUND', `Không tìm thấy vật tư hàng hóa ${q.itemCode}`, 404);
  const uomId = q.uomCode ? await one(trx, 'uom', q.uomCode, 'đơn vị tính') : item.rows[0].base;
  let partyId: string | undefined;
  if (q.partyCode) { const p = await sql<{ id: string }>`SELECT id::text FROM party WHERE code = ${q.partyCode}`.execute(trx); if (!p.rows[0]) throw new AppError('NOT_FOUND', `Không tìm thấy đối tượng ${q.partyCode}`, 404); partyId = p.rows[0].id; }
  const hit = await resolvePrice(trx, { kind: q.kind, itemId: Number(item.rows[0].id), uomId: Number(uomId), ...(partyId && { partyId }), date: q.date, qty: q.qty, currency: q.currency });
  return hit ?? { price: null, discountRate: null, priceListId: null };
}
