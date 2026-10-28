import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { likePattern } from '../master/crud.js';

type Trx = Transaction<Database>;
export const COST_OBJECT_KINDS = ['product', 'project', 'order', 'contract'] as const;
// Tham chiếu bắt buộc theo loại: sản phẩm → vật tư hàng hóa, vụ việc → vụ việc/công trình, đơn hàng → đơn bán (số đơn), hợp đồng → hợp đồng.
const REF = { product: 'itemCode', project: 'projectCode', order: 'orderNo', contract: 'contractCode' } as const;
const opt = z.string().trim().min(1).max(50).nullable().optional();
export const costObjectInput = z.object({
  code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(200), kind: z.enum(COST_OBJECT_KINDS),
  itemCode: opt, projectCode: opt, orderNo: opt, contractCode: opt,
  method: z.enum(['simple', 'coefficient', 'ratio', 'project', 'order']).nullable().optional(), unit: z.string().trim().max(30).nullable().optional(), isActive: z.boolean().optional(),
}).strict().superRefine((b, c) => {
  for (const [kind, key] of Object.entries(REF)) if ((b.kind === kind) !== !!b[key]) c.addIssue({ code: 'custom', path: [key], message: b.kind === kind ? 'Bắt buộc theo loại đối tượng' : 'Không dùng cho loại đối tượng này' });
});
export type CostObjectInput = z.infer<typeof costObjectInput>;
export interface CostObjectDto { id: number; code: string; name: string; kind: string; itemCode: string | null; projectCode: string | null; orderNo: string | null; contractCode: string | null; method: string | null; unit: string | null; isActive: boolean }

const base = (trx: Trx) => trx.selectFrom('cost_object as o').leftJoin('item as i', 'i.id', 'o.item_id').leftJoin('project as p', 'p.id', 'o.project_id')
  .leftJoin('contract as c', 'c.id', 'o.contract_id')
  .select(['o.id', 'o.code', 'o.name', 'o.kind', 'i.code as itemCode', 'p.code as projectCode', sql<string | null>`(SELECT d.doc_no FROM doc_order d WHERE d.id = o.order_id)`.as('orderNo'),
    'c.code as contractCode', 'o.method', 'o.unit', 'o.is_active as isActive']);

export async function listCostObjects(trx: Trx, f: { q?: string | undefined; kind?: (typeof COST_OBJECT_KINDS)[number] | undefined; active: 'true' | 'false' | 'all'; page: number; size: number }) {
  let q = base(trx);
  if (f.q) { const like = likePattern(f.q); q = q.where((eb) => eb.or([eb('o.code', 'ilike', like), eb('o.name', 'ilike', like)])); }
  if (f.kind) q = q.where('o.kind', '=', f.kind);
  if (f.active !== 'all') q = q.where('o.is_active', '=', f.active === 'true');
  const total = Number((await q.clearSelect().select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
  return { rows: (await q.orderBy('o.code').limit(f.size).offset((f.page - 1) * f.size).execute()) as CostObjectDto[], total };
}
export async function getCostObject(trx: Trx, id: number): Promise<CostObjectDto> {
  const r = await base(trx).where('o.id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('NOT_FOUND', 'Không tìm thấy đối tượng tập hợp chi phí', 404);
  return r as CostObjectDto;
}

async function refId(trx: Trx, table: 'item' | 'project' | 'contract', code: string | null | undefined, label: string): Promise<number | null> {
  if (!code) return null;
  const r = await trx.selectFrom(table).select('id').where('code', '=', code).executeTakeFirst();
  if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${label} mã "${code}"`, 404);
  return r.id;
}
async function values(trx: Trx, b: CostObjectInput) {
  let order_id: string | null = null;
  if (b.orderNo) {
    const r = (await sql<{ id: string }>`SELECT id FROM doc_order WHERE kind = 'sale_order' AND doc_no = ${b.orderNo}`.execute(trx)).rows[0];
    if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có đơn bán hàng số "${b.orderNo}"`, 404);
    order_id = r.id;
  }
  return { code: b.code, name: b.name, kind: b.kind, item_id: await refId(trx, 'item', b.itemCode, 'vật tư hàng hóa'), project_id: await refId(trx, 'project', b.projectCode, 'vụ việc'),
    contract_id: await refId(trx, 'contract', b.contractCode, 'hợp đồng'), order_id, method: b.method ?? null, unit: b.unit || null, is_active: b.isActive ?? true };
}
export async function createCostObject(trx: Trx, tenantId: string, b: CostObjectInput): Promise<CostObjectDto> {
  const r = await trx.insertInto('cost_object').values({ tenant_id: tenantId, ...(await values(trx, b)) }).returning('id').executeTakeFirstOrThrow();
  return getCostObject(trx, r.id);
}
// Sửa thay toàn bộ nội dung (đổi loại thì đổi tham chiếu cùng lúc).
export async function updateCostObject(trx: Trx, id: number, b: CostObjectInput): Promise<CostObjectDto> {
  const r = await trx.updateTable('cost_object').set(await values(trx, b)).where('id', '=', id).executeTakeFirst();
  if (!r.numUpdatedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy đối tượng tập hợp chi phí', 404);
  return getCostObject(trx, id);
}
// Đối tượng đã có trên dòng sổ cái: khóa ngoại chặn (23503 → 409 REFERENCED).
export async function deleteCostObject(trx: Trx, id: number): Promise<void> {
  const r = await trx.deleteFrom('cost_object').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy đối tượng tập hợp chi phí', 404);
}
// F4 cột "Đối tượng THCP" của dòng chứng từ: đối tượng đang dùng.
export async function lookupCostObjects(trx: Trx, q: string, size: number) {
  const like = likePattern(q);
  return trx.selectFrom('cost_object').select(['id', 'code', 'name', 'kind']).where('is_active', '=', true)
    .where((eb) => eb.or([eb('code', 'ilike', like), eb('name', 'ilike', like)])).orderBy('code').limit(size).execute();
}
