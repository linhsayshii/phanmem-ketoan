import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import type { FastifyRequest } from 'fastify';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { collectCosts } from './collect.js';
import { costRunInput, getCostRun, isStale, listCostRuns, previewCostRun, runCostRun } from './costRun.js';
import { costNormInput, createCostNorm, deleteCostNorm, getCostNorm, listCostNorms, updateCostNorm } from './norms.js';
import { COST_OBJECT_KINDS, costObjectInput, createCostObject, deleteCostObject, getCostObject, listCostObjects, lookupCostObjects, updateCostObject } from './objects.js';

const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

// Giá thành (GĐ6): danh mục đối tượng tập hợp chi phí. Quyền costing_obj.* (0094).
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/costing/objects', { preHandler: app.requirePermission('costing_obj.view'), schema: { querystring: z.object({ q: z.string().optional(), kind: z.enum(COST_OBJECT_KINDS).optional(),
    active: z.enum(['true', 'false', 'all']).default('all'), page: z.coerce.number().int().min(1).max(10_000).default(1), size: z.coerce.number().int().min(1).max(1000).default(100) }) } },
    async (req) => app.withTenant(req, (trx) => listCostObjects(trx, req.query), READ_SNAPSHOT));
  app.get('/api/costing/objects/:id', { preHandler: app.requirePermission('costing_obj.view'), schema: { params: idParam } },
    async (req) => app.withTenant(req, (trx) => getCostObject(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/costing/objects', { preHandler: app.requirePermission('costing_obj.create'), schema: { body: costObjectInput } },
    async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createCostObject(trx, req.auth!.tenantId!, req.body))));
  app.put('/api/costing/objects/:id', { preHandler: app.requirePermission('costing_obj.update'), schema: { params: idParam, body: costObjectInput } },
    async (req) => app.withTenant(req, (trx) => updateCostObject(trx, req.params.id, req.body)));
  app.delete('/api/costing/objects/:id', { preHandler: app.requirePermission('costing_obj.delete'), schema: { params: idParam } },
    async (req, reply) => { await app.withTenant(req, (trx) => deleteCostObject(trx, req.params.id)); return reply.status(204).send(); });
  // Định mức NVL: chỉ số lượng, không có giá trị tiền nên không cần view_cost; cùng quyền costing_obj.* ("đối tượng tập hợp chi phí, định mức").
  app.get('/api/costing/norms', { preHandler: app.requirePermission('costing_obj.view'), schema: { querystring: z.object({ q: z.string().optional(), itemCode: z.string().optional(), costObjectCode: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) } },
    async (req) => app.withTenant(req, (trx) => listCostNorms(trx, req.query), READ_SNAPSHOT));
  app.get('/api/costing/norms/:id', { preHandler: app.requirePermission('costing_obj.view'), schema: { params: idParam } },
    async (req) => app.withTenant(req, (trx) => getCostNorm(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/costing/norms', { preHandler: app.requirePermission('costing_obj.create'), schema: { body: costNormInput } },
    async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createCostNorm(trx, req.auth!.tenantId!, req.body))));
  app.put('/api/costing/norms/:id', { preHandler: app.requirePermission('costing_obj.update'), schema: { params: idParam, body: costNormInput } },
    async (req) => app.withTenant(req, (trx) => updateCostNorm(trx, req.auth!.tenantId!, req.params.id, req.body)));
  app.delete('/api/costing/norms/:id', { preHandler: app.requirePermission('costing_obj.delete'), schema: { params: idParam } },
    async (req, reply) => { await app.withTenant(req, (trx) => deleteCostNorm(trx, req.params.id)); return reply.status(204).send(); });
  // Chi phí sản xuất theo đối tượng là giá trị giá thành: cần cờ view_cost ở API (403), như tính giá vốn.
  app.get('/api/costing/collect', { preHandler: app.requirePermission('cost_run.view'), schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12), objectId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }) } }, async (req) => {
    if (!req.auth!.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
    return app.withTenant(req, (trx) => collectCosts(trx, req.query), READ_SNAPSHOT);
  });
  // Chạy giá thành kỳ (Task 11a): mọi route cần cờ view_cost (giá thành là dữ liệu giá vốn). Xem trước chỉ đọc; Chạy/chạy lại ghi GT (kỳ khóa sổ cần quyền ghi lùi).
  const viewCost = (req: FastifyRequest) => { if (!req.auth!.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403); };
  const period = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
  app.get('/api/costing/runs', { preHandler: app.requirePermission('cost_run.view'), schema: { querystring: period.pick({ year: true }) } }, async (req) => {
    viewCost(req); return app.withTenant(req, (trx) => listCostRuns(trx, req.query.year), READ_SNAPSHOT);
  });
  app.get('/api/costing/runs/:year/:month', { preHandler: app.requirePermission('cost_run.view'), schema: { params: period } }, async (req) => {
    viewCost(req);
    return app.withTenant(req, async (trx) => { const r = await getCostRun(trx, req.params.year, req.params.month); return { ...r, stale: await isStale(trx, r) }; }, READ_SNAPSHOT);
  });
  app.post('/api/costing/runs/preview', { preHandler: app.requirePermission('cost_run.view'), schema: { body: costRunInput } }, async (req) => {
    viewCost(req); return app.withTenant(req, (trx) => previewCostRun(trx, req.body.year, req.body.month, req.body.params), READ_SNAPSHOT);
  });
  app.post('/api/costing/runs', { preHandler: app.requirePermission('cost_run.run'), schema: { body: costRunInput } }, async (req) => {
    viewCost(req);
    const ctx = { tenantId: req.auth!.tenantId!, userId: req.auth!.userId, canBackdate: req.auth!.permissions.has('voucher.backdate_locked') };
    const out = await app.withOverride(req, (trx) => runCostRun(trx, ctx, req.body.year, req.body.month, req.body.params));
    if (!out.unchanged) void notifyRecompute(app, ctx.tenantId);
    return out;
  });
  // F4 trên lưới chứng từ: ai lập được chứng từ là tra được (như khế ước, tài sản).
  app.get('/api/lookups/cost-objects', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ q: z.string().default(''), size: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => lookupCostObjects(trx, req.query.q, req.query.size), READ_SNAPSHOT));
};
export default routes;
