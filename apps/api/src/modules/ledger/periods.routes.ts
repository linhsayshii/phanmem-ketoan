import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listPeriods, lockPeriod, setPeriodModules, unlockPeriod, verifyPeriodHash } from './periods.service.js';

const params = z.object({ year: z.coerce.number().int(), no: z.coerce.number().int().min(0).max(15) });
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/periods', { preHandler: app.requirePermission('period.view'), schema: { querystring: z.object({ year: z.coerce.number().int().optional() }) } }, async (req) => app.withTenant(req, (trx) => listPeriods(trx, req.query.year)));
  app.post('/api/periods/:year/:no/lock', { preHandler: app.requirePermission('period.lock'), schema: { params, body: z.object({ level: z.enum(['soft', 'hard']) }) } }, async (req) => {
    await app.withTenant(req, (trx) => lockPeriod(trx, req.auth!.tenantId!, req.params.year, req.params.no, req.body.level)); return { ok: true }; });
  app.post('/api/periods/:year/:no/unlock', { preHandler: app.requirePermission('period.unlock'), schema: { params } }, async (req) =>
    ({ status: await app.withTenant(req, (trx) => unlockPeriod(trx, req.auth!.tenantId!, req.params.year, req.params.no, req.auth!.permissions.has('period.unlock_hard'))) }));
  app.put('/api/periods/:year/:no/modules', { preHandler: app.requirePermission('period.lock'), schema: { params, body: z.object({ modules: z.array(z.enum(['general', 'cash', 'bank', 'inventory', 'arap', 'assets', 'payroll'])) }) } }, async (req) => {
    await app.withTenant(req, (trx) => setPeriodModules(trx, req.auth!.tenantId!, req.params.year, req.params.no, req.body.modules)); return { ok: true }; });
  app.get('/api/periods/:year/:no/verify-hash', { preHandler: app.requirePermission('period.view'), schema: { params } }, async (req) => app.withTenant(req, (trx) => verifyPeriodHash(trx, req.auth!.tenantId!, req.params.year, req.params.no)));
};
export default routes;
