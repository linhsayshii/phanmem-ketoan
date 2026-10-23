import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { makeProviderCtx, providerFor } from './providers/index.js';
import { dateIso as isoDate } from '../master/catalogs.js';
import { deleteProvider, deleteSeries, listProviders, listSeries, providerInput, saveProvider, saveSeries, seriesInput } from './config.js';
import { discardFailed, einvoiceDto, einvoiceFile, einvoiceQuery, issueEInvoice, refreshEInvoice, retryEInvoice } from './issue.js';
import { adjustInput, cancelInput, issueAdjustment, issueReplacement, cancelEInvoice, replaceInput, reverseMarked, setPaid, voucherOf } from './lifecycle.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { requireStockPerm } from '../ledger/vouchers.routes.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({ status: z.enum(['draft', 'sending', 'issued', 'failed', 'replaced', 'cancelled']).optional(), from: isoDate.optional(), to: isoDate.optional(), q: z.string().trim().max(100).optional() });

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

  // Phát hành, thử lại, bỏ hóa đơn lỗi, tra mã CQT: gọi nhà cung cấp ngoài giao dịch của request (issue.ts tự mở giao dịch từng pha).
  const view = app.requirePermission('einvoice.view');
  const issue = app.requirePermission('einvoice.issue');
  const ectx = (req: { auth: { tenantId: string | null; userId: string; permissions: Set<string> } | null; ip: string }) =>
    ({ tenantId: tid(req), userId: req.auth!.userId, ip: req.ip, canBackdate: req.auth!.permissions.has('voucher.backdate_locked') });
  app.post('/api/einvoices', { preHandler: issue, schema: { body: z.object({ voucherId: z.string().uuid(), issueDate: isoDate.optional() }) } }, async (req, reply) =>
    reply.status(201).send(await issueEInvoice(app.db, ectx(req), req.body.voucherId, { issueDate: req.body.issueDate })));
  app.post('/api/einvoices/:id/retry', { preHandler: issue, schema: { params: numId } }, async (req) => { const r = await retryEInvoice(app.db, ectx(req), req.params.id); notifyRecompute(app, tid(req)); return r; });
  app.post('/api/einvoices/:id/discard', { preHandler: issue, schema: { params: numId } }, async (req) => discardFailed(app.db, ectx(req), req.params.id));
  // Điều chỉnh, thay thế, hủy, thanh toán. Thay thế/hủy đảo chứng từ của hóa đơn gốc: cần thêm quyền ghi sổ (và quyền kho với chứng từ có hàng hóa) như route đảo chứng từ.
  const post = app.requirePermission('voucher.post');
  const stockPerm = (req: FastifyRequest, id: number) => app.withTenant(req, async (trx) => {
    const v = await voucherOf(trx, id);
    if (v) await requireStockPerm(trx, req.auth!, v, 'stock_voucher.post');
  });
  app.post('/api/einvoices/:id/adjust', { preHandler: issue, schema: { params: numId, body: adjustInput } }, async (req, reply) =>
    reply.status(201).send(await issueAdjustment(app.db, ectx(req), req.params.id, req.body)));
  app.post('/api/einvoices/:id/replace', { preHandler: [issue, post], schema: { params: numId, body: replaceInput } }, async (req, reply) => {
    await stockPerm(req, req.params.id);
    const r = await issueReplacement(app.db, ectx(req), req.params.id, req.body); notifyRecompute(app, tid(req)); return reply.status(201).send(r);
  });
  app.post('/api/einvoices/:id/cancel', { preHandler: [issue, post], schema: { params: numId, body: cancelInput } }, async (req) => {
    await stockPerm(req, req.params.id);
    const r = await cancelEInvoice(app.db, ectx(req), req.params.id, req.body); notifyRecompute(app, tid(req)); return r;
  });
  app.post('/api/einvoices/:id/reverse-original', { preHandler: [issue, post], schema: { params: numId } }, async (req) => {
    await stockPerm(req, req.params.id);
    const r = await reverseMarked(app.db, ectx(req), req.params.id); notifyRecompute(app, tid(req)); return r;
  });
  app.post('/api/einvoices/:id/paid', { preHandler: issue, schema: { params: numId, body: z.object({ paid: z.boolean() }) } }, async (req) => setPaid(app.db, ectx(req), req.params.id, req.body.paid));
  app.post('/api/einvoices/:id/refresh', { preHandler: issue, schema: { params: numId } }, async (req) => refreshEInvoice(app.db, ectx(req), req.params.id));

  app.get('/api/einvoices', { preHandler: view, schema: { querystring: listQuery } }, async (req) => app.withTenant(req, async (trx) => {
    const { status, from, to, q } = req.query;
    let qb = einvoiceQuery(trx).where('e.discarded_at', 'is', null);
    if (status) qb = qb.where('e.status', '=', status);
    if (from) qb = qb.where(sql<string>`coalesce(e.issue_date, e.created_at::date)`, '>=', from);
    if (to) qb = qb.where(sql<string>`coalesce(e.issue_date, e.created_at::date)`, '<=', to);
    if (q) { const like = `%${q}%`; qb = qb.where((w) => w.or([w('e.invoice_no', 'ilike', like), w('v.voucher_no', 'ilike', like), w(sql<string>`e.payload->'buyer'->>'name'`, 'ilike', like)])); }
    return (await qb.orderBy('e.id', 'desc').limit(1000).execute()).map(einvoiceDto);
  }, READ_SNAPSHOT));
  app.get('/api/einvoices/:id', { preHandler: view, schema: { params: numId } }, async (req) => app.withTenant(req, async (trx) => {
    const r = await einvoiceQuery(trx).where('e.id', '=', req.params.id).executeTakeFirst();
    if (!r) throw new AppError('EINVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn điện tử', 404);
    const logs = await trx.selectFrom('einvoice_log').select(['id', 'action', 'request', 'response', 'http_status', 'ok', 'error', 'ms', 'created_at']).where('einvoice_id', '=', r.id).orderBy('id').execute();
    return { ...einvoiceDto(r), logs: logs.map((l) => ({ id: l.id, action: l.action, request: l.request, response: l.response, httpStatus: l.http_status, ok: l.ok, error: l.error, ms: l.ms, createdAt: l.created_at })) };
  }, READ_SNAPSHOT));
  app.get('/api/einvoices/:id/file', { preHandler: view, schema: { params: numId, querystring: z.object({ kind: z.enum(['pdf', 'xml']) }) } }, async (req, reply) => {
    const f = await einvoiceFile(app.db, ectx(req), req.params.id, req.query.kind);
    return reply.type(f.contentType).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`).send(f.body);
  });
  // Hóa đơn điện tử hiện hành của chứng từ (bỏ hàng lỗi đã bỏ); chưa có thì { einvoice: null }.
  app.get('/api/vouchers/:id/einvoice', { preHandler: view, schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => app.withTenant(req, async (trx) => {
    const r = await einvoiceQuery(trx).where('e.voucher_id', '=', req.params.id).where('e.discarded_at', 'is', null).orderBy('e.id', 'desc').executeTakeFirst();
    return { einvoice: r ? einvoiceDto(r) : null };
  }, READ_SNAPSHOT));
};
export default routes;
