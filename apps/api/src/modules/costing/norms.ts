import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { likePattern } from '../master/crud.js';

type Trx = Transaction<Database>;
// Định mức NVL (GĐ6 Task 10b): lượng vật tư cho MỘT đơn vị sản phẩm (ĐVT cơ sở), hao hụt % cộng thêm; theo sản phẩm (vật tư) hoặc đối tượng tập hợp chi phí, có khoảng hiệu lực.
const code = z.string().trim().min(1).max(50);
export const costNormInput = z.object({
  itemCode: code.nullable().optional(), costObjectCode: code.nullable().optional(),
  validFrom: dateIso, validTo: dateIso.nullable().optional(), note: z.string().trim().max(500).nullable().optional(),
  lines: z.array(z.object({
    itemCode: code, quantity: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'Số lượng tối đa 6 chữ số thập phân').refine((v) => D(v).gt(0), 'Số lượng phải lớn hơn 0'),
    lossPercent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ hao hụt từ 0 đến 999,9999').optional(), note: z.string().trim().max(500).nullable().optional(),
  }).strict()).min(1).max(500),
}).strict().superRefine((b, c) => {
  if (!b.itemCode === !b.costObjectCode) c.addIssue({ code: 'custom', path: ['itemCode'], message: 'Chọn đúng một trong sản phẩm hoặc đối tượng tập hợp chi phí' });
  if (b.validTo && b.validTo < b.validFrom) c.addIssue({ code: 'custom', path: ['validTo'], message: 'Đến ngày phải sau hoặc bằng từ ngày' });
  const seen = new Set<string>();
  b.lines.forEach((l, i) => { if (seen.has(l.itemCode)) c.addIssue({ code: 'custom', path: ['lines', i, 'itemCode'], message: `Vật tư ${l.itemCode} lặp lại trong định mức` }); seen.add(l.itemCode); });
});
export type CostNormInput = z.infer<typeof costNormInput>;
export interface CostNormLineDto { lineNo: number; itemCode: string; itemName: string; uomCode: string | null; quantity: string; lossPercent: string; grossQuantity: string; note: string | null }
export interface CostNormDto { id: number; itemCode: string | null; itemName: string | null; costObjectCode: string | null; costObjectName: string | null; validFrom: string; validTo: string | null; note: string | null; lineCount: number; lines?: CostNormLineDto[] }

const base = (trx: Trx) => trx.selectFrom('cost_norm as n').leftJoin('item as i', 'i.id', 'n.item_id').leftJoin('cost_object as o', 'o.id', 'n.cost_object_id')
  .select(['n.id', 'i.code as itemCode', 'i.name as itemName', 'o.code as costObjectCode', 'o.name as costObjectName', 'n.valid_from as validFrom', 'n.valid_to as validTo', 'n.note',
    sql<number>`(SELECT count(*)::int FROM cost_norm_line l WHERE l.norm_id = n.id)`.as('lineCount')]);

export async function listCostNorms(trx: Trx, f: { q?: string | undefined; itemCode?: string | undefined; costObjectCode?: string | undefined; date?: string | undefined }): Promise<CostNormDto[]> {
  let q = base(trx);
  if (f.q) { const like = likePattern(f.q); q = q.where((eb) => eb.or([eb('i.code', 'ilike', like), eb('i.name', 'ilike', like), eb('o.code', 'ilike', like), eb('o.name', 'ilike', like)])); }
  if (f.itemCode) q = q.where('i.code', '=', f.itemCode);
  if (f.costObjectCode) q = q.where('o.code', '=', f.costObjectCode);
  if (f.date) q = q.where('n.valid_from', '<=', f.date).where((eb) => eb.or([eb('n.valid_to', 'is', null), eb('n.valid_to', '>=', f.date!)]));
  return q.orderBy(sql`coalesce(i.code, o.code)`).orderBy('n.valid_from', 'desc').limit(2000).execute();
}

export async function getCostNorm(trx: Trx, id: number): Promise<CostNormDto> {
  const n = await base(trx).where('n.id', '=', id).executeTakeFirst();
  if (!n) throw new AppError('NOT_FOUND', 'Không tìm thấy định mức', 404);
  const lines = await trx.selectFrom('cost_norm_line as l').innerJoin('item as i', 'i.id', 'l.item_id').leftJoin('uom as u', 'u.id', 'i.base_uom_id')
    .select(['l.line_no as lineNo', 'i.code as itemCode', 'i.name as itemName', 'u.code as uomCode', 'l.quantity', 'l.loss_percent as lossPercent', 'l.note'])
    .where('l.norm_id', '=', id).orderBy('l.line_no').execute();
  // định mức gồm hao hụt = SL × (1 + %/100), 6 chữ số như cột số lượng
  return { ...n, lines: lines.map((l) => ({ ...l, grossQuantity: D(l.quantity).mul(D(l.lossPercent).div(100).add(1)).toDecimalPlaces(6).toFixed(6) })) };
}

async function idOf(trx: Trx, table: 'item' | 'cost_object', c: string, label: string): Promise<number> {
  const r = await trx.selectFrom(table).select('id').where('code', '=', c).executeTakeFirst();
  if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${label} mã "${c}"`, 404);
  return r.id;
}

async function save(trx: Trx, tenantId: string, id: number | null, b: CostNormInput): Promise<CostNormDto> {
  const item_id = b.itemCode ? await idOf(trx, 'item', b.itemCode, 'vật tư hàng hóa') : null;
  const cost_object_id = b.costObjectCode ? await idOf(trx, 'cost_object', b.costObjectCode, 'đối tượng tập hợp chi phí') : null;
  const lineItems = await trx.selectFrom('item').select(['id', 'code']).where('code', 'in', b.lines.map((l) => l.itemCode)).execute();
  const itemIds = new Map(lineItems.map((r) => [r.code, r.id]));
  const missing = b.lines.find((l) => !itemIds.has(l.itemCode));
  if (missing) throw new AppError('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${missing.itemCode}"`, 404);
  if (item_id !== null && itemIds.get(b.itemCode!) !== undefined) throw new AppError('VALIDATION', 'Sản phẩm không thể là nguyên vật liệu của chính nó', 400);
  // Khoảng hiệu lực của cùng sản phẩm/đối tượng không chồng nhau (khóa tư vấn theo đích để hai lần lưu đồng thời không cùng lọt).
  await sql`SELECT pg_advisory_xact_lock(hashtext('cost_norm'), hashtext(${`${item_id ?? ''}:${cost_object_id ?? ''}`}))`.execute(trx);
  const to = b.validTo ?? null;
  const clash = await trx.selectFrom('cost_norm').select(['valid_from', 'valid_to'])
    .where(item_id !== null ? 'item_id' : 'cost_object_id', '=', (item_id ?? cost_object_id)!)
    .$if(id !== null, (qb) => qb.where('id', '<>', id!))
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', b.validFrom)]))
    .$if(to !== null, (qb) => qb.where('valid_from', '<=', to!)).executeTakeFirst();
  if (clash) throw new AppError('NORM_OVERLAP', `Khoảng hiệu lực chồng với định mức đã có (từ ${clash.valid_from}${clash.valid_to ? ` đến ${clash.valid_to}` : ''})`, 409);
  const head = { item_id, cost_object_id, valid_from: b.validFrom, valid_to: to, note: b.note || null };
  if (id === null) id = (await trx.insertInto('cost_norm').values({ tenant_id: tenantId, ...head }).returning('id').executeTakeFirstOrThrow()).id;
  else {
    const r = await trx.updateTable('cost_norm').set({ ...head, updated_at: sql`now()` }).where('id', '=', id).executeTakeFirst();
    if (!r.numUpdatedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy định mức', 404);
    await trx.deleteFrom('cost_norm_line').where('norm_id', '=', id).execute(); // sửa thay toàn bộ dòng
  }
  await trx.insertInto('cost_norm_line').values(b.lines.map((l, i) => ({ tenant_id: tenantId, norm_id: id!, line_no: i + 1, item_id: itemIds.get(l.itemCode)!,
    quantity: l.quantity, loss_percent: l.lossPercent ?? '0', note: l.note || null }))).execute();
  return getCostNorm(trx, id);
}
export const createCostNorm = (trx: Trx, tenantId: string, b: CostNormInput) => save(trx, tenantId, null, b);
export const updateCostNorm = (trx: Trx, tenantId: string, id: number, b: CostNormInput) => save(trx, tenantId, id, b);
export async function deleteCostNorm(trx: Trx, id: number): Promise<void> {
  const r = await trx.deleteFrom('cost_norm').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy định mức', 404);
}
