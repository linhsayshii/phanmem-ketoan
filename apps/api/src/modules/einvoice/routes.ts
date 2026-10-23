import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { makeProviderCtx, providerFor } from './providers/index.js';
import { deleteProvider, deleteSeries, listProviders, listSeries, providerInput, saveProvider, saveSeries, seriesInput } from './config.js';

const numId = z.object({ id: z.coerce.number().int().positive() });

// Cấu hình nhà cung cấp hóa đơn điện tử và dải ký hiệu.
const routes: FastifyPluginAsyncZod = async (app) => {
  const tid = (req: { auth: { tenantId: string | null } | null }) => req.auth!.tenantId!;
  const cfg = app.requirePermission('einvoice.config');
  app.get('/api/einvoice/providers', { preHandler: app.requirePermission('einvoice.view') }, async (req) => app.withTenant(req, listProviders, READ_SNAPSHOT));
  app.post('/api/einvoice/providers', { preHandler: cfg, schema: { body: providerInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveProvider(trx, tid(req), null, req.body))));
  app.put('/api/einvoice/providers/:id', { preHandler: cfg, schema: { params: numId, body: providerInput } }, async (req) => app.withTenant(req, (trx) => saveProvider(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/einvoice/providers/:id', { preHandler: cfg, schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteProvider(trx, req.params.id)); return reply.status(204).send(); });

  // Thử kết nối: lỗi của nhà cung cấp trả { ok: false, message } (200), không phải lỗi HTTP.
  app.post('/api/einvoice/providers/:id/test', { preHandler: cfg, schema: { params: numId } }, async (req) => app.withTenant(req, async (trx) => {
    const row = await trx.selectFrom('einvoice_provider').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!row) throw new AppError('EINVOICE_PROVIDER_NOT_FOUND', 'Không tìm thấy nhà cung cấp hóa đơn điện tử', 404);
    try {
      await providerFor(row).ping(makeProviderCtx(trx, { tenantId: tid(req), providerId: row.id, einvoiceId: null, userId: req.auth!.userId }));
      return { ok: true, message: 'Kết nối thành công' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }));

  app.get('/api/einvoice/series', { preHandler: app.requirePermission('einvoice.view') }, async (req) => app.withTenant(req, listSeries, READ_SNAPSHOT));
  app.post('/api/einvoice/series', { preHandler: cfg, schema: { body: seriesInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveSeries(trx, tid(req), null, req.body))));
  app.put('/api/einvoice/series/:id', { preHandler: cfg, schema: { params: numId, body: seriesInput } }, async (req) => app.withTenant(req, (trx) => saveSeries(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/einvoice/series/:id', { preHandler: cfg, schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteSeries(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
