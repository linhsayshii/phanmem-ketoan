import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';

// Tồn khả dụng theo ĐVT cơ sở đến hết ngày (cộng stock_move vào, trừ ra; hàng chưa ghi sổ không tính).
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/inventory/on-hand', { preHandler: app.requirePermission('stock_voucher.view'),
    schema: { querystring: z.object({ itemCode: z.string().min(1), warehouseCode: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const r = await trx.selectFrom('stock_move as m').innerJoin('item as i', 'i.id', 'm.item_id').innerJoin('warehouse as w', 'w.id', 'm.warehouse_id')
        .select(sql<string>`coalesce(sum(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END), 0)::text`.as('q'))
        .where('i.code', '=', req.query.itemCode).where('w.code', '=', req.query.warehouseCode).where('m.posting_date', '<=', req.query.date).executeTakeFirstOrThrow();
      const ok = await trx.selectFrom('item').select('id').where('code', '=', req.query.itemCode).executeTakeFirst();
      if (!ok) throw new AppError('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${req.query.itemCode}"`, 404);
      return { itemCode: req.query.itemCode, warehouseCode: req.query.warehouseCode, date: req.query.date, quantity: Number(r.q).toFixed(4) };
    }));
};
export default routes;
