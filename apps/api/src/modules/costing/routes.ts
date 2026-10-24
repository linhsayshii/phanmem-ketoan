import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
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
  // F4 trên lưới chứng từ: ai lập được chứng từ là tra được (như khế ước, tài sản).
  app.get('/api/lookups/cost-objects', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ q: z.string().default(''), size: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => lookupCostObjects(trx, req.query.q, req.query.size), READ_SNAPSHOT));
};
export default routes;
