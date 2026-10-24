import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { PAYROLL_BUILTIN_COLUMNS } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { calculateRun, cancelRun, createRun, deleteRun, getRun, getRunLines, listRuns, previewInput, previewLine, runCreateInput, setManualValues, valuesInput } from './runs.js';
import { cloneInput, cloneStructure, createStructure, deleteStructure, getStructure, listStructures, structureInput, updateStructure } from './structures.js';

// Cấu trúc bảng lương và bảng lương: quyền payroll.* VÀ cờ view_salary trên mọi route (403 SALARY_FORBIDDEN), như hồ sơ lương.
const routes: FastifyPluginAsyncZod = async (app) => {
  const guard = (perm: 'payroll.view' | 'payroll.create' | 'payroll.update' | 'payroll.delete') => ({ preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requirePermission(perm)(req, reply);
    if (!req.auth!.sensitive.has('view_salary')) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
  } });
  const view = guard('payroll.view'), create = guard('payroll.create'), update = guard('payroll.update'), del = guard('payroll.delete');
  const pid = z.object({ id: z.coerce.number().int().positive() });
  const S = '/api/payroll/structures', R = '/api/payroll/runs';
  const tid = (req: FastifyRequest) => req.auth!.tenantId!;

  // Danh sách tạo lười cấu trúc mặc định nên không đọc trong giao dịch chỉ đọc.
  app.get(S, view, async (req) => app.withTenant(req, (trx) => listStructures(trx, tid(req))));
  app.get(`${S}/builtin-columns`, view, async () => PAYROLL_BUILTIN_COLUMNS);
  app.post(`${S}/preview`, { ...view, schema: { body: previewInput } }, async (req) => app.withTenant(req, (trx) => previewLine(trx, tid(req), req.body)));
  app.get(`${S}/:id`, { ...view, schema: { params: pid } }, async (req) => app.withTenant(req, (trx) => getStructure(trx, req.params.id), READ_SNAPSHOT));
  app.post(S, { ...create, schema: { body: structureInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createStructure(trx, tid(req), req.body))));
  app.post(`${S}/:id/clone`, { ...create, schema: { params: pid, body: cloneInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => cloneStructure(trx, tid(req), req.params.id, req.body))));
  app.put(`${S}/:id`, { ...update, schema: { params: pid, body: structureInput } }, async (req) => app.withTenant(req, (trx) => updateStructure(trx, req.params.id, req.body)));
  app.delete(`${S}/:id`, { ...del, schema: { params: pid } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteStructure(trx, req.params.id)); return reply.status(204).send(); });

  app.get(R, { ...view, schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12).optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => listRuns(trx, req.query), READ_SNAPSHOT));
  app.post(R, { ...create, schema: { body: runCreateInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createRun(trx, tid(req), req.body))));
  app.get(`${R}/:id`, { ...view, schema: { params: pid } }, async (req) => app.withTenant(req, (trx) => getRun(trx, tid(req), req.params.id), READ_SNAPSHOT));
  app.get(`${R}/:id/lines`, { ...view, schema: { params: pid } }, async (req) => app.withTenant(req, (trx) => getRunLines(trx, tid(req), req.params.id), READ_SNAPSHOT));
  app.delete(`${R}/:id`, { ...del, schema: { params: pid } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteRun(trx, req.params.id)); return reply.status(204).send(); });
  app.post(`${R}/:id/calculate`, { ...update, schema: { params: pid } }, async (req) => app.withTenant(req, (trx) => calculateRun(trx, tid(req), req.params.id)));
  app.post(`${R}/:id/cancel`, { ...update, schema: { params: pid } }, async (req) => app.withTenant(req, (trx) => cancelRun(trx, tid(req), req.params.id)));
  app.put(`${R}/:id/lines/:employeeId/values`, { ...update, schema: { params: pid.extend({ employeeId: z.coerce.number().int().positive() }), body: valuesInput } }, async (req) =>
    app.withTenant(req, (trx) => setManualValues(trx, tid(req), req.params.id, req.params.employeeId, req.body.values)));
};
export default routes;
