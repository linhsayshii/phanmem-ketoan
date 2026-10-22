import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { allocationInput, assetInput, categoryInput, deleteAsset, deleteCategory, getAsset, listAssets, listCategories, lookupAssets, saveAsset, saveCategory, setAllocations } from './assets.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const kindQ = z.enum(['fixed', 'tool', 'prepaid']);

// Thẻ tài sản: TSCĐ, công cụ dụng cụ, chi phí trả trước. Số tiền (nguyên giá, hao mòn) lấy từ sổ cái, thẻ không có trường tiền tự do.
const routes: FastifyPluginAsyncZod = async (app) => {
  const tid = (req: { auth: { tenantId: string | null } | null }) => req.auth!.tenantId!;
  app.get('/api/asset-categories', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ kind: kindQ.optional() }) } }, async (req) => app.withTenant(req, (trx) => listCategories(trx, req.query.kind), READ_SNAPSHOT));
  app.post('/api/asset-categories', { preHandler: app.requirePermission('asset.create'), schema: { body: categoryInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveCategory(trx, tid(req), null, req.body))));
  app.put('/api/asset-categories/:id', { preHandler: app.requirePermission('asset.update'), schema: { params: numId, body: categoryInput } }, async (req) => app.withTenant(req, (trx) => saveCategory(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/asset-categories/:id', { preHandler: app.requirePermission('asset.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteCategory(trx, req.params.id)); return reply.status(204).send(); });

  app.get('/api/assets', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ kind: kindQ.optional(), q: z.string().optional() }) } }, async (req) => app.withTenant(req, (trx) => listAssets(trx, req.query.kind, req.query.q), READ_SNAPSHOT));
  app.get('/api/assets/:id', { preHandler: app.requirePermission('asset.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getAsset(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/assets', { preHandler: app.requirePermission('asset.create'), schema: { body: assetInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveAsset(trx, tid(req), null, req.body))));
  app.put('/api/assets/:id', { preHandler: app.requirePermission('asset.update'), schema: { params: numId, body: assetInput } }, async (req) => app.withTenant(req, (trx) => saveAsset(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/assets/:id', { preHandler: app.requirePermission('asset.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteAsset(trx, tid(req), req.params.id)); return reply.status(204).send(); });
  app.put('/api/assets/:id/allocations', { preHandler: app.requirePermission('asset.update'), schema: { params: numId, body: allocationInput } }, async (req) => app.withTenant(req, (trx) => setAllocations(trx, tid(req), req.params.id, req.body)));

  app.get('/api/lookups/assets', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ q: z.string().default(''), kind: kindQ.optional(), size: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => lookupAssets(trx, req.query.q, req.query.kind, req.query.size), READ_SNAPSHOT));
};
export default routes;
