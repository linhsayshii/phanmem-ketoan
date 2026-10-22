import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { D } from '@kt/domain';
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';

export interface StockWarning { code: 'STOCK_NEGATIVE'; message: string; itemCode: string; warehouseCode: string; date: string; shortBy: string }
// Chế độ warn: ghi sổ đã qua, nêu các cặp hàng–kho bị xuất âm từ phiếu này (cùng giao dịch, sau khi ghi sổ).
export async function stockNegativeWarnings(trx: Transaction<Database>, tenantId: string, voucherId: string): Promise<StockWarning[]> {
  if ((await getSettings(trx, tenantId)).stock_negative !== 'warn') return [];
  const r = await sql<{ item: string; wh: string; d: string; bal: string }>`
    SELECT i.code AS item, w.code AS wh, f.d::text AS d, f.bal::text AS bal
    FROM (SELECT DISTINCT item_id, warehouse_id, posting_date FROM stock_move WHERE voucher_id = ${voucherId}::uuid AND direction = 'out') k
    CROSS JOIN LATERAL fn_stock_first_negative(k.item_id, k.warehouse_id, k.posting_date) f
    JOIN item i ON i.id = k.item_id JOIN warehouse w ON w.id = k.warehouse_id ORDER BY i.code, w.code`.execute(trx);
  return r.rows.map((x) => {
    const shortBy = D(x.bal).neg().toFixed(); const [y, m, d] = x.d.split('-');
    return { code: 'STOCK_NEGATIVE' as const, message: `Hàng ${x.item} ở kho ${x.wh} thiếu ${shortBy} tại ngày ${d}/${m}/${y}`, itemCode: x.item, warehouseCode: x.wh, date: x.d, shortBy };
  });
}

// Tồn khả dụng theo ĐVT cơ sở đến hết ngày (cộng stock_move vào, trừ ra; hàng chưa ghi sổ không tính).
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/inventory/on-hand', { preHandler: app.requirePermission('stock_voucher.view'),
    schema: { querystring: z.object({ itemCode: z.string().min(1), warehouseCode: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), uomCode: z.string().min(1).optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const r = await trx.selectFrom('stock_move as m').innerJoin('item as i', 'i.id', 'm.item_id').innerJoin('warehouse as w', 'w.id', 'm.warehouse_id')
        .select(sql<string>`coalesce(sum(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END), 0)::text`.as('q'))
        .where('i.code', '=', req.query.itemCode).where('w.code', '=', req.query.warehouseCode).where('m.posting_date', '<=', req.query.date).executeTakeFirstOrThrow();
      if (!await trx.selectFrom('item').select('id').where('code', '=', req.query.itemCode).executeTakeFirst()) throw new AppError('ITEM_NOT_FOUND', `Không có vật tư hàng hóa mã "${req.query.itemCode}"`, 404);
      if (!await trx.selectFrom('warehouse').select('id').where('code', '=', req.query.warehouseCode).executeTakeFirst()) throw new AppError('WAREHOUSE_NOT_FOUND', `Không có kho mã "${req.query.warehouseCode}"`, 404);
      const base = D(r.q).toFixed(4);
      if (!req.query.uomCode) return { itemCode: req.query.itemCode, warehouseCode: req.query.warehouseCode, date: req.query.date, quantity: base };
      // ĐVT hỏi: ĐVT cơ sở (hệ số 1) hoặc ĐVT quy đổi khai báo cho hàng; lượng theo ĐVT hỏi = cơ sở / hệ số, làm tròn 4 chữ số.
      const f = await trx.selectFrom('item_uom as u').innerJoin('item as i', 'i.id', 'u.item_id').innerJoin('uom', 'uom.id', 'u.uom_id').select('u.factor').where('i.code', '=', req.query.itemCode).where('uom.code', '=', req.query.uomCode).executeTakeFirst();
      const own = f ? null : await trx.selectFrom('item as i').innerJoin('uom', 'uom.id', 'i.base_uom_id').select('i.id').where('i.code', '=', req.query.itemCode).where('uom.code', '=', req.query.uomCode).executeTakeFirst();
      if (!f && !own) throw new AppError('UOM_NOT_FOUND', `Hàng "${req.query.itemCode}" không có đơn vị tính "${req.query.uomCode}"`, 404);
      return { itemCode: req.query.itemCode, warehouseCode: req.query.warehouseCode, date: req.query.date, quantity: base, uomCode: req.query.uomCode, uomQuantity: D(base).div(f ? f.factor : 1).toDecimalPlaces(4).toFixed(4) };
    }));
};
export default routes;
