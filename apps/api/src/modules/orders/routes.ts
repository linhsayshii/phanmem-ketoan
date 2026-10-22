import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { convertInput, contractInput, convertOrder, createOrder, deleteContract, deleteOrder, getOrder, listContracts, listOrders, orderInput, saveContract, setOrderStatus, updateOrder } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const numId = z.object({ id: z.coerce.number().int().positive() });

// Báo giá, đơn bán, đơn mua, hợp đồng: không ghi sổ cái. Chuyển thành BH/MH nháp qua dịch vụ hóa đơn.
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/orders', { preHandler: app.requirePermission('order.view'), schema: { querystring: z.object({ kind: z.enum(['quote', 'sale_order', 'purchase_order']).optional(), status: z.string().optional(), q: z.string().optional() }) } },
    async (req) => app.withTenant(req, (trx) => listOrders(trx, req.query), READ_SNAPSHOT));
  app.get('/api/orders/:id', { preHandler: app.requirePermission('order.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => getOrder(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/orders', { preHandler: app.requirePermission('order.create'), schema: { body: orderInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createOrder(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.body))));
  app.put('/api/orders/:id', { preHandler: app.requirePermission('order.update'), schema: { params: idParam, body: orderInput } }, async (req) =>
    app.withTenant(req, (trx) => updateOrder(trx, { tenantId: req.auth!.tenantId! }, req.params.id, req.body)));
  app.post('/api/orders/:id/confirm', { preHandler: app.requirePermission('order.update'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => setOrderStatus(trx, req.params.id, 'confirmed')));
  app.post('/api/orders/:id/cancel', { preHandler: app.requirePermission('order.update'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => setOrderStatus(trx, req.params.id, 'cancelled')));
  app.delete('/api/orders/:id', { preHandler: app.requirePermission('order.delete'), schema: { params: idParam } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteOrder(trx, req.params.id)); return reply.status(204).send(); });
  // Sinh BH/MH nháp là lập chứng từ: cần thêm voucher.create.
  app.post('/api/orders/:id/convert', { preHandler: app.requirePermission('order.update'), schema: { params: idParam, body: convertInput } }, async (req) => {
    if (req.body.to !== 'SO') { if (!req.auth!.permissions.has('voucher.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.create', 403); }
    return app.withOverride(req, (trx) => convertOrder(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! }, req.params.id, req.body));
  });

  app.get('/api/contracts', { preHandler: app.requirePermission('order.view'), schema: { querystring: z.object({ kind: z.enum(['sale', 'purchase']).optional() }) } }, async (req) => app.withTenant(req, (trx) => listContracts(trx, req.query.kind), READ_SNAPSHOT));
  app.post('/api/contracts', { preHandler: app.requirePermission('order.create'), schema: { body: contractInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveContract(trx, req.auth!.tenantId!, null, req.body))));
  app.put('/api/contracts/:id', { preHandler: app.requirePermission('order.update'), schema: { params: numId, body: contractInput } }, async (req) => app.withTenant(req, (trx) => saveContract(trx, req.auth!.tenantId!, req.params.id, req.body)));
  app.delete('/api/contracts/:id', { preHandler: app.requirePermission('order.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteContract(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
