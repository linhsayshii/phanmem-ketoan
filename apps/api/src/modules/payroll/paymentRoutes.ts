import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { deleteFormat, exportInput, exportPaymentFile, formatInput, getBatchFile, listBatches, listFormats, previewFormat, previewInput, saveFormat } from './paymentFiles.js';

// Chi lương theo lô (Task 8): mọi route cần payroll.export VÀ cờ view_salary (403 SALARY_FORBIDDEN), kể cả cấu hình mẫu, xem thử và tải lại tệp cũ (QĐ #750).
const routes: FastifyPluginAsyncZod = async (app) => {
  const guard = { preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requirePermission('payroll.export')(req, reply);
    if (!req.auth!.sensitive.has('view_salary')) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
  } };
  const pid = z.object({ id: z.coerce.number().int().positive() });
  const tid = (req: FastifyRequest) => req.auth!.tenantId!;
  const F = '/api/payroll/payment-formats';

  // Danh sách tạo lười mẫu "Chung" nên không đọc trong giao dịch chỉ đọc.
  app.get(F, guard, async (req) => app.withTenant(req, (trx) => listFormats(trx, tid(req))));
  app.post(F, { ...guard, schema: { body: formatInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => saveFormat(trx, tid(req), null, req.body))));
  app.put(`${F}/:id`, { ...guard, schema: { params: pid, body: formatInput } }, async (req) => app.withTenant(req, (trx) => saveFormat(trx, tid(req), req.params.id, req.body)));
  app.delete(`${F}/:id`, { ...guard, schema: { params: pid } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteFormat(trx, req.params.id)); return reply.status(204).send(); });
  app.post(`${F}/preview`, { ...guard, schema: { body: previewInput } }, async (req) => app.withTenant(req, (trx) => previewFormat(trx, req.body), READ_SNAPSHOT));

  app.post('/api/payroll/runs/:id/payment-file', { ...guard, schema: { params: pid, body: exportInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => exportPaymentFile(trx, tid(req), req.params.id, req.body))));
  app.get('/api/payroll/runs/:id/payment-batches', { ...guard, schema: { params: pid } }, async (req) => app.withTenant(req, (trx) => listBatches(trx, req.params.id), READ_SNAPSHOT));
  app.get('/api/payroll/payment-batches/:id/file', { ...guard, schema: { params: pid } }, async (req, reply) => {
    const f = await app.withTenant(req, (trx) => getBatchFile(trx, req.params.id), READ_SNAPSHOT);
    return reply.type(f.contentType).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(f.content);
  });
};
export default routes;
