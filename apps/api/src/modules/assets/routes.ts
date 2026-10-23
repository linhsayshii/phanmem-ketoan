import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { getSettings } from '../core/settings.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { listRuns, runAssetPeriod } from './periodRun.js';
import { previewSchedule } from './schedule.js';
import { adjustToolValue, cancelEvent, changeLife, decreaseAsset, decreaseInput, increaseAsset, increaseInput, lifeInput, listEvents, resumeAsset, resumeInput, revalueAsset, revalueInput, suspendAsset, suspendInput, toolAdjustInput, toolDecreaseInput, decreaseTool, transferAsset, transferInput } from './events.js';
import { allocationInput, assetInput, categoryInput, deleteAsset, deleteCategory, getAsset, listAssets, listCategories, lookupAssets, saveAsset, saveCategory, setAllocations } from './assets.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const kindQ = z.enum(['fixed', 'tool', 'prepaid']);
const runKind = z.enum(['depreciation', 'tool', 'prepaid']);

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
  app.get('/api/assets/:id/schedule', { preHandler: app.requirePermission('asset.view'), schema: { params: numId } }, async (req) => app.withTenant(req, async (trx) => previewSchedule(trx, req.params.id, (await getSettings(trx, tid(req))).fa_proration), READ_SNAPSHOT));

  // Chạy khấu hao (KH) / phân bổ CCDC, chi phí trả trước (PB) kỳ; kỳ khóa sổ cần quyền ghi lùi.
  app.get('/api/asset-runs', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ kind: runKind.optional(), year: z.coerce.number().int().optional() }) } },
    async (req) => app.withTenant(req, (trx) => listRuns(trx, req.query.kind, req.query.year), READ_SNAPSHOT));
  app.post('/api/asset-runs', { preHandler: app.requirePermission('asset.run'), schema: { body: z.object({ kind: runKind, fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(15) }) } }, async (req) => {
    const auth = req.auth!;
    const out = await app.withOverride(req, (trx) => runAssetPeriod(trx, { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') }, req.body));
    if (!out.unchanged) notifyRecompute(app, auth.tenantId!);
    return out;
  });

  // Biến động tài sản: ghi tăng, ghi giảm, đánh giá lại, điều chuyển, dừng/tiếp tục khấu hao, điều chỉnh thời gian sử dụng; hủy biến động.
  const runCtx = (req: { auth: { tenantId: string | null; userId: string; permissions: Set<string> } | null }) =>
    ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, canBackdate: req.auth!.permissions.has('voucher.backdate_locked') });
  const event = <T extends z.ZodTypeAny>(path: string, body: T, fn: (trx: Transaction<Database>, ctx: ReturnType<typeof runCtx>, id: number, b: z.infer<T>) => Promise<unknown>) =>
    app.post(`/api/assets/:id/${path}`, { preHandler: app.requirePermission('asset.update'), schema: { params: numId, body } }, async (req) => {
      const out = await app.withOverride(req, (trx) => fn(trx, runCtx(req), req.params.id, req.body));
      notifyRecompute(app, tid(req));
      return out;
    });
  event('increase', increaseInput, increaseAsset);
  event('decrease', decreaseInput, decreaseAsset);
  event('decrease-tool', toolDecreaseInput, decreaseTool);
  event('adjust-value', toolAdjustInput, adjustToolValue);
  event('revalue', revalueInput, revalueAsset);
  event('transfer', transferInput, transferAsset);
  event('suspend', suspendInput, suspendAsset);
  event('resume', resumeInput, resumeAsset);
  event('life', lifeInput, changeLife);
  app.post('/api/asset-events/:id/cancel', { preHandler: app.requirePermission('asset.update'), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const out = await app.withOverride(req, (trx) => cancelEvent(trx, runCtx(req), req.params.id));
    notifyRecompute(app, tid(req));
    return out;
  });
  app.get('/api/assets/:id/events', { preHandler: app.requirePermission('asset.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => listEvents(trx, req.params.id), READ_SNAPSHOT));

  app.get('/api/lookups/assets', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ q: z.string().default(''), kind: kindQ.optional(), size: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => lookupAssets(trx, req.query.q, req.query.kind, req.query.size), READ_SNAPSHOT));
};
export default routes;
