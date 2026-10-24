import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { getContract, invoiceFromMilestoneInput, invoiceMilestone, milestonesInput, saveMilestones } from './milestone.js';

const numId = z.object({ id: z.coerce.number().int().positive() });

// Hợp đồng bán/mua: chi tiết kèm đợt thanh toán, lưu đợt, lập hóa đơn từ đợt. Quyền như CRUD hợp đồng (order.*, orders/routes.ts);
// lập hóa đơn là lập chứng từ: cần thêm voucher.create (như chuyển đơn hàng thành BH/MH).
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/contracts/:id', { preHandler: app.requirePermission('order.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getContract(trx, req.params.id), READ_SNAPSHOT));
  app.put('/api/contracts/:id/milestones', { preHandler: app.requirePermission('order.update'), schema: { params: numId, body: milestonesInput } }, async (req) =>
    app.withTenant(req, (trx) => saveMilestones(trx, req.auth!.tenantId!, req.params.id, req.body)));
  app.post('/api/contracts/:id/milestones/:mid/invoice', { preHandler: app.requirePermission('order.update'),
    schema: { params: numId.extend({ mid: z.coerce.number().int().positive() }), body: invoiceFromMilestoneInput } }, async (req, reply) => {
    if (!req.auth!.permissions.has('voucher.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.create', 403);
    const out = await app.withOverride(req, (trx) => invoiceMilestone(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! }, req.params.id, req.params.mid, req.body));
    return reply.status(201).send(out);
  });
};
export default routes;
