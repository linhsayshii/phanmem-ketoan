import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CATALOGS, catalogByName } from './catalogs.js';
import { createRow, deleteRow, getRow, listRows, updateRow } from './crud.js';
import { AppError } from '../../plugins/errors.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  const def = (name: string) => { const d = catalogByName(name); if (!d) throw new AppError('NOT_FOUND', `Không có danh mục ${name}`, 404); return d; };
  app.get('/api/catalogs', { preHandler: app.requirePermission('catalog.view') }, async () => CATALOGS.map(({ schema: _s, ...rest }) => rest));
  app.get('/api/catalogs/:name', { preHandler: app.requirePermission('catalog.view'), schema: { params: z.object({ name: z.string() }),
    querystring: z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(1000).default(100) }) } },
    async (req) => app.withTenant(req, (trx) => listRows(trx, def(req.params.name), req.query)));
  app.get('/api/catalogs/:name/:id', { preHandler: app.requirePermission('catalog.view'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req) => app.withTenant(req, (trx) => getRow(trx, def(req.params.name), req.params.id)));
  app.post('/api/catalogs/:name', { preHandler: app.requirePermission('catalog.create'), schema: { params: z.object({ name: z.string() }) } },
    async (req, reply) => reply.status(201).send({ id: await app.withTenant(req, (trx) => createRow(trx, req.auth!.tenantId!, def(req.params.name), req.body)) }));
  app.put('/api/catalogs/:name/:id', { preHandler: app.requirePermission('catalog.update'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req) => { await app.withTenant(req, (trx) => updateRow(trx, def(req.params.name), req.params.id, req.body)); return { ok: true }; });
  app.delete('/api/catalogs/:name/:id', { preHandler: app.requirePermission('catalog.delete'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req, reply) => { await app.withTenant(req, (trx) => deleteRow(trx, def(req.params.name), req.params.id)); return reply.status(204).send(); });
};
export default routes;
