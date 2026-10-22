import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CATALOGS, catalogByName } from './catalogs.js';
import { createRow, deleteRow, getRow, hasActiveFlag, listRows, setActive, updateRow } from './crud.js';
import { AppError } from '../../plugins/errors.js';
import { MAX_ERRORS, buildTemplate, importRows, parseWorkbook } from './importExcel.js';

class DryRun extends Error {} // chỉ để hoàn tác giao dịch sau khi kiểm tra thử

const routes: FastifyPluginAsyncZod = async (app) => {
  // Danh mục có `perm` (vật tư, kho) dùng quyền riêng `<perm>.<hành động>`; còn lại dùng catalog.*. Nhập Excel cần quyền thêm.
  const need = (action: 'view' | 'create' | 'update' | 'delete' | 'import') => async (req: FastifyRequest, reply: FastifyReply) => {
    const d = catalogByName((req.params as { name: string }).name);
    return app.requirePermission(d?.perm ? `${d.perm}.${action === 'import' ? 'create' : action}` : `catalog.${action}`)(req, reply);
  };
  const def = (name: string) => { const d = catalogByName(name); if (!d) throw new AppError('NOT_FOUND', `Không có danh mục ${name}`, 404); return d; };
  app.get('/api/catalogs', { preHandler: app.requireAuth }, async () => CATALOGS.map(({ schema, ...rest }) => ({ ...rest, hasActiveFlag: hasActiveFlag({ schema }) })));
  app.get('/api/catalogs/:name', { preHandler: need('view'), schema: { params: z.object({ name: z.string() }),
    querystring: z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).max(10_000).default(1), size: z.coerce.number().int().min(1).max(1000).default(100), active: z.enum(['true', 'false', 'all']).default('true') }) } },
    async (req) => app.withTenant(req, (trx) => listRows(trx, def(req.params.name), req.query)));
  app.get('/api/catalogs/:name/template.xlsx', { preHandler: need('view'), schema: { params: z.object({ name: z.string() }) } }, async (req, reply) => {
    const d = def(req.params.name);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="mau_${d.name}.xlsx"`);
    return reply.send(await buildTemplate(d));
  });
  app.post('/api/catalogs/:name/import', { preHandler: need('import'), schema: { params: z.object({ name: z.string() }), querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const d = def(req.params.name);
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const { rows, errors } = await parseWorkbook(d, await file.toBuffer());
    const total = rows.length + new Set(errors.map((e) => e.row)).size;
    const dry = req.query.mode === 'validate';
    const report = (inserted: number) => ({ total, inserted, errors: [...errors].sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS), errorCount: errors.length });
    // Cả hai chế độ chạy cùng một đường ghi trong giao dịch; kiểm tra thử ném DryRun để hoàn tác nên báo đúng các lỗi như khi nhập thật.
    try {
      const inserted = await app.withTenant(req, async (trx) => { const n = await importRows(trx, req.auth!.tenantId!, d, rows, errors); if (dry) throw new DryRun(); return n; });
      return report(inserted);
    } catch (e) {
      if (dry && (e instanceof DryRun || (e instanceof AppError && e.code === 'IMPORT_ERRORS'))) return report(0);
      throw e;
    }
  });
  app.get('/api/catalogs/:name/:id', { preHandler: need('view'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req) => app.withTenant(req, (trx) => getRow(trx, def(req.params.name), req.params.id)));
  app.post('/api/catalogs/:name', { preHandler: need('create'), schema: { params: z.object({ name: z.string() }) } },
    async (req, reply) => reply.status(201).send({ id: await app.withTenant(req, (trx) => createRow(trx, req.auth!.tenantId!, def(req.params.name), req.body)) }));
  app.put('/api/catalogs/:name/:id', { preHandler: need('update'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req) => { await app.withTenant(req, (trx) => updateRow(trx, def(req.params.name), req.params.id, req.body)); return { ok: true }; });
  for (const [action, active] of [['deactivate', false], ['activate', true]] as const)
    app.post(`/api/catalogs/:name/:id/${action}`, { preHandler: need('update'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
      async (req) => { await app.withTenant(req, (trx) => setActive(trx, def(req.params.name), req.params.id, active)); return { ok: true }; });
  app.delete('/api/catalogs/:name/:id', { preHandler: need('delete'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req, reply) => { await app.withTenant(req, (trx) => deleteRow(trx, def(req.params.name), req.params.id)); return reply.status(204).send(); });
};
export default routes;
