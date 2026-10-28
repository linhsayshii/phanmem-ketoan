import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { dateIso } from '../master/catalogs.js';
import { deleteParam, listParams, paramInput, payrollParam, saveParam } from './params.js';

// Tham số lương không nhạy cảm (chỉ là thuế suất, tỷ lệ, kèm nguồn) nên xem cần payroll.view; nhập/xóa cần payroll.param.
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/payroll/params', { preHandler: app.requirePermission('payroll.view'), schema: { querystring: z.object({ code: z.string().optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => listParams(trx, req.query.code), READ_SNAPSHOT));
  // Giá trị đang áp dụng tại một ngày (legal_param thắng, payroll_param khi không có), kèm cảnh báo nếu hai nguồn lệch nhau; 409 PAYROLL_PARAM_MISSING khi thiếu.
  app.get('/api/payroll/params/effective', { preHandler: app.requirePermission('payroll.view'), schema: { querystring: z.object({ code: z.string().min(1), date: dateIso }) } }, async (req) =>
    app.withTenant(req, (trx) => payrollParam(trx, req.query.code, req.query.date), READ_SNAPSHOT));
  app.put('/api/payroll/params', { preHandler: app.requirePermission('payroll.param'), schema: { body: paramInput } }, async (req) =>
    app.withTenant(req, (trx) => saveParam(trx, req.auth!.tenantId!, req.body)));
  app.delete('/api/payroll/params/:id', { preHandler: app.requirePermission('payroll.param'), schema: { params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteParam(trx, req.params.id));
    return reply.status(204).send();
  });
};
export default routes;
