import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';
import { likePattern } from '../master/crud.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  // ĐVT quy đổi của một hàng (dòng cơ sở factor 1 đứng đầu).
  app.get('/api/items/:id/uoms', { preHandler: app.requirePermission('item.view'), schema: { params: z.object({ id: z.string().regex(/^\d{1,15}$/) }) } }, async (req) => app.withTenant(req, async (trx) => {
    const itemId = Number(req.params.id);
    if (!(await trx.selectFrom('item').select('id').where('id', '=', itemId).executeTakeFirst())) throw new AppError('NOT_FOUND', 'Không tìm thấy vật tư hàng hóa', 404);
    const r = await sql<{ id: number; uomCode: string; uomName: string; factor: string; isBase: boolean; isPurchase: boolean; isSale: boolean }>`
      SELECT iu.id, u.code AS "uomCode", u.name AS "uomName", iu.factor, (iu.uom_id = i.base_uom_id) AS "isBase", iu.is_purchase AS "isPurchase", iu.is_sale AS "isSale"
      FROM item_uom iu JOIN item i ON i.id = iu.item_id JOIN uom u ON u.id = iu.uom_id WHERE iu.item_id = ${itemId} ORDER BY (iu.uom_id = i.base_uom_id) DESC, iu.factor, u.code`.execute(trx);
    return r.rows;
  }));
  // Tra cứu F4 cho ô chọn hàng trên chứng từ: chỉ hàng đang dùng.
  app.get('/api/lookups/items', { preHandler: app.requirePermission('item.view'), schema: { querystring: z.object({ q: z.string().default(''), size: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => app.withTenant(req, async (trx) => {
    const like = likePattern(req.query.q);
    const r = await sql<{ id: number; code: string; name: string; baseUom: string; defaultTaxCode: string | null; tracking: string }>`
      SELECT i.id, i.code, i.name, u.code AS "baseUom", i.default_tax_code AS "defaultTaxCode", i.tracking
      FROM item i JOIN uom u ON u.id = i.base_uom_id
      WHERE i.is_active AND (i.code ILIKE ${like} ESCAPE '\\' OR i.name ILIKE ${like} ESCAPE '\\' OR i.barcode ILIKE ${like} ESCAPE '\\') ORDER BY i.code LIMIT ${req.query.size}`.execute(trx);
    return r.rows;
  }));
};
export default routes;
