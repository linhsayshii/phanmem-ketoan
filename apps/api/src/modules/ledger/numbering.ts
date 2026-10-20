import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { formatVoucherNo } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

const notFound = (code: string) => new AppError('VOUCHER_TYPE_NOT_FOUND', `Không có loại chứng từ ${code}`, 404);
const typeBody = z.object({ name: z.string().min(1).optional(), prefix: z.string().max(20).optional(), suffix: z.string().max(20).optional(),
  padLength: z.number().int().min(1).max(10).optional(), isActive: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0, 'Không có trường nào để cập nhật');

const routes: FastifyPluginAsyncZod = async (app) => {
  app.put('/api/voucher-types/:code', { preHandler: app.requirePermission('setting.update'), schema: { params: z.object({ code: z.string() }), body: typeBody } }, async (req) => {
    const b = req.body;
    const r = await app.withTenant(req, (trx) => trx.updateTable('voucher_type').set({ ...(b.name !== undefined ? { name: b.name } : {}), ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
      ...(b.suffix !== undefined ? { suffix: b.suffix } : {}), ...(b.padLength !== undefined ? { pad_length: b.padLength } : {}), ...(b.isActive !== undefined ? { is_active: b.isActive } : {}) }).where('code', '=', req.params.code).executeTakeFirst());
    if (r.numUpdatedRows === 0n) throw notFound(req.params.code);
    return { ok: true };
  });
  app.get('/api/voucher-types/:code/next-no', { preHandler: app.requirePermission('voucher.view'), schema: { params: z.object({ code: z.string() }), querystring: z.object({ year: z.coerce.number().int() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const vt = await trx.selectFrom('voucher_type').selectAll().where('code', '=', req.params.code).executeTakeFirst();
      if (!vt) throw notFound(req.params.code);
      const c = await trx.selectFrom('voucher_counter').select('last_no').where('voucher_type', '=', vt.code).where('fiscal_year', '=', req.query.year).executeTakeFirst();
      return { preview: formatVoucherNo({ prefix: vt.prefix, suffix: vt.suffix, padLength: vt.pad_length, seq: Number(c?.last_no ?? 0) + 1, year: req.query.year }) };
    }));
  app.post('/api/vouchers/renumber', { preHandler: app.requirePermission('voucher.renumber'), schema: { body: z.object({ voucherType: z.string(), fiscalYear: z.number().int() }) } }, async (req) =>
    app.withTenant(req, async (trx) => ({ count: (await sql<{ n: number }>`SELECT renumber_vouchers(${req.auth!.tenantId!}::uuid, ${req.body.voucherType}, ${req.body.fiscalYear}) AS n`.execute(trx)).rows[0]!.n })));
  // year bỏ trống: so với mọi năm; có year: chỉ năm tài chính đó (số bắt đầu lại mỗi năm nên cùng số có thể có ở năm khác).
  app.get('/api/vouchers/check-no', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ type: z.string(), no: z.string(), year: z.coerce.number().int().optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const v = await trx.selectFrom('voucher').select('id').where('voucher_type', '=', req.query.type).where('voucher_no', '=', req.query.no)
        .$if(req.query.year !== undefined, (q) => q.where('fiscal_year', '=', req.query.year!)).executeTakeFirst();
      return { exists: !!v, voucherId: v?.id };
    }));
};
export default routes;
