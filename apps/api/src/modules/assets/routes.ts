import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { regimeOf } from '../reporting/ledgers.js';
import type { ReportDoc } from '../reporting/print/html.js';
import { renderPdf } from '../reporting/print/pdf.js';
import { assetCountHtml, eventFormHtml } from '../reporting/print/assetForms.js';
import { countInput, countUpdate, createCount, deleteCount, fillCount, finishCount, listCounts, loadCount, updateCount } from './assetCount.js';
import { allocationDoc, bookDocs, cardDoc, depreciationDoc, locationDocs, movementDoc, toolRegisterDoc } from '../reporting/print/assetForms.js';
import { allocationSheet, assetCard, assetRegister, assetsByLocation, depreciationSheet, movementReport, toolRegister } from './reports.js';
import { getSettings } from '../core/settings.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { logCloseStep, runSummary } from '../ledger/periodClose.js';
import { listRuns, runAssetPeriod } from './periodRun.js';
import { assetValues, remainingUnitsOf, scheduleView } from './schedule.js';
import { dateIso } from '../ledger/vouchers.service.js';
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

  app.get('/api/assets', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ kind: kindQ.optional(), q: z.string().optional(), at: dateIso.optional() }) } }, async (req) =>
    // Nguyên giá, hao mòn lũy kế tại ngày `at` (mặc định toàn bộ sổ cái) cho màn hình danh sách.
    app.withTenant(req, async (trx) => {
      const rows = await listAssets(trx, req.query.kind, req.query.q);
      const vals = await assetValues(trx, tid(req), req.query.at ?? '9999-12-31', [], rows.map((r) => r.id));
      const withVals = rows.map((r) => ({ ...r, cost: vals.get(r.id)?.cost ?? '0', accumulated: vals.get(r.id)?.accumulated ?? '0' }));
      const remaining = await remainingUnitsOf(trx, withVals);
      return withVals.map((r) => ({ ...r, remainingUnits: remaining.get(r.id) ?? '0' }));
    }, READ_SNAPSHOT));
  app.get('/api/assets/:id', { preHandler: app.requirePermission('asset.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getAsset(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/assets', { preHandler: app.requirePermission('asset.create'), schema: { body: assetInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveAsset(trx, tid(req), null, req.body))));
  app.put('/api/assets/:id', { preHandler: app.requirePermission('asset.update'), schema: { params: numId, body: assetInput } }, async (req) => app.withTenant(req, (trx) => saveAsset(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/assets/:id', { preHandler: app.requirePermission('asset.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteAsset(trx, tid(req), req.params.id)); return reply.status(204).send(); });
  app.put('/api/assets/:id/allocations', { preHandler: app.requirePermission('asset.update'), schema: { params: numId, body: allocationInput } }, async (req) => app.withTenant(req, (trx) => setAllocations(trx, tid(req), req.params.id, req.body)));
  app.get('/api/assets/:id/schedule', { preHandler: app.requirePermission('asset.view'), schema: { params: numId } }, async (req) => app.withTenant(req, async (trx) => (await scheduleView(trx, req.params.id, (await getSettings(trx, tid(req))).fa_proration)).lines, READ_SNAPSHOT));

  // Chạy khấu hao (KH) / phân bổ CCDC, chi phí trả trước (PB) kỳ; kỳ khóa sổ cần quyền ghi lùi.
  app.get('/api/asset-runs', { preHandler: app.requirePermission('asset.view'), schema: { querystring: z.object({ kind: runKind.optional(), year: z.coerce.number().int().optional() }) } },
    async (req) => app.withTenant(req, (trx) => listRuns(trx, req.query.kind, req.query.year), READ_SNAPSHOT));
  app.post('/api/asset-runs', { preHandler: app.requirePermission('asset.run'), schema: { body: z.object({ kind: runKind, fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(15) }) } }, async (req) => {
    const auth = req.auth!;
    const ctx = { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') };
    const out = await app.withOverride(req, async (trx) => {
      const r = await runAssetPeriod(trx, ctx, req.body);
      await logCloseStep(trx, ctx, { fiscalYear: req.body.fiscalYear, periodNo: req.body.periodNo, step: req.body.kind, ok: true, summary: runSummary(r) });
      return r;
    });
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
  // ---- Kiểm kê TSCĐ, CCDC (05 - TSCĐ): số sổ sách điền tại ngày kiểm kê; chênh lệch không tự ghi sổ, màn hình gợi ý Ghi giảm / Ghi tăng ----
  const countId = z.object({ id: z.coerce.number().int().positive() });
  app.get('/api/asset-counts', { preHandler: app.requirePermission('asset.view') }, async (req) => app.withTenant(req, (trx) => listCounts(trx), READ_SNAPSHOT));
  app.get('/api/asset-counts/:id', { preHandler: app.requirePermission('asset.view'), schema: { params: countId } }, async (req) => app.withTenant(req, (trx) => loadCount(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/asset-counts', { preHandler: app.requirePermission('asset.create'), schema: { body: countInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createCount(trx, { tenantId: tid(req), userId: req.auth!.userId }, req.body))));
  app.put('/api/asset-counts/:id', { preHandler: app.requirePermission('asset.update'), schema: { params: countId, body: countUpdate } }, async (req) => app.withTenant(req, (trx) => updateCount(trx, req.params.id, req.body)));
  app.delete('/api/asset-counts/:id', { preHandler: app.requirePermission('asset.delete'), schema: { params: countId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteCount(trx, req.params.id)); return reply.status(204).send(); });
  app.post('/api/asset-counts/:id/fill', { preHandler: app.requirePermission('asset.update'), schema: { params: countId } }, async (req) => app.withTenant(req, (trx) => fillCount(trx, { tenantId: tid(req) }, req.params.id)));
  app.post('/api/asset-counts/:id/finish', { preHandler: app.requirePermission('asset.update'), schema: { params: countId } }, async (req) => app.withTenant(req, (trx) => finishCount(trx, req.params.id)));

  // ---- In biên bản: 01/02/04 - TSCĐ từ biến động, 05 - TSCĐ từ biên bản kiểm kê ----
  const printFmt = z.enum(['html', 'pdf']).default('html');
  const sendForm = async (reply: FastifyReply, f: 'html' | 'pdf', r: { html: string; name: string }) => f === 'html' ? reply.type('text/html; charset=utf-8').send(r.html)
    : reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.name)}.pdf`).send(await renderPdf(r.html));
  app.get('/api/print/asset-event/:eventId', { preHandler: app.requirePermission('asset.view'), schema: { params: z.object({ eventId: z.string().uuid() }), querystring: z.object({ form: z.enum(['01-TSCD', '02-TSCD', '04-TSCD']).optional(), format: printFmt }) } }, async (req, reply) => {
    assertPrint(req.auth!);
    return sendForm(reply, req.query.format, await app.withTenant(req, (trx) => eventFormHtml(trx, tid(req), req.params.eventId, req.query.form), READ_SNAPSHOT));
  });
  app.get('/api/print/asset-count/:id', { preHandler: app.requirePermission('asset.view'), schema: { params: countId, querystring: z.object({ format: printFmt }) } }, async (req, reply) => {
    assertPrint(req.auth!);
    return sendForm(reply, req.query.format, await app.withTenant(req, async (trx) => assetCountHtml(trx, tid(req), await loadCount(trx, req.params.id)), READ_SNAPSHOT));
  });

  // ---- Sổ, thẻ và báo cáo tài sản: đọc trong giao dịch REPEATABLE READ READ ONLY; JSON cho màn hình, html/pdf/xlsx cần thêm quyền report.print ----
  const view = app.requirePermission('report.view');
  const fmt = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');
  const range = z.object({ from: isoDate, to: isoDate, format: fmt });
  const period = z.object({ fiscalYear: z.coerce.number().int(), periodNo: z.coerce.number().int().min(1).max(12), format: fmt });
  const serve = async <T>(req: FastifyRequest, reply: FastifyReply, f: 'json' | 'html' | 'pdf' | 'xlsx', name: string, fetch: (trx: Transaction<Database>) => Promise<T>,
    span: (d: T) => { from: string; to: string }, docs: (trx: Transaction<Database>, regime: string, d: T) => Promise<ReportDoc[]>) => {
    if (f !== 'json') assertPrint(req.auth!);
    const out = await app.withTenant(req, async (trx) => { const d = await fetch(trx); return { d, docs: f === 'json' ? [] : await docs(trx, await regimeOf(trx, span(d)), d) }; }, READ_SNAPSHOT);
    return f === 'json' ? out.d : respondReport(reply, out.docs, f, name);
  };
  app.get('/api/asset-reports/register', { preHandler: view, schema: { querystring: range.extend({ kind: z.literal('fixed').default('fixed') }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    serve(req, reply, req.query.format, `so-tscd-${req.query.from}-${req.query.to}`, (trx) => assetRegister(trx, tid(req), req.query), () => req.query, (trx, regime, d) => bookDocs(trx, tid(req), regime, d)));
  app.get('/api/asset-reports/card/:id', { preHandler: view, schema: { params: numId, querystring: z.object({ to: isoDate, format: fmt }) } }, async (req, reply) =>
    serve(req, reply, req.query.format, `the-tscd-${req.params.id}-${req.query.to}`, (trx) => assetCard(trx, tid(req), req.params.id, req.query.to), (d) => ({ from: d.to, to: d.to }), async (trx, regime, d) => [await cardDoc(trx, tid(req), regime, d)]));
  app.get('/api/asset-reports/by-location', { preHandler: view, schema: { querystring: range.extend({ departmentId: z.coerce.number().int().positive().optional() }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    serve(req, reply, req.query.format, `so-noi-su-dung-${req.query.from}-${req.query.to}`, (trx) => assetsByLocation(trx, tid(req), req.query), () => req.query, (trx, regime, d) => locationDocs(trx, tid(req), regime, d)));
  app.get('/api/asset-reports/depreciation-sheet', { preHandler: view, schema: { querystring: period } }, async (req, reply) =>
    serve(req, reply, req.query.format, `khau-hao-${req.query.fiscalYear}-${req.query.periodNo}`, (trx) => depreciationSheet(trx, tid(req), req.query), (d) => d, async (trx, regime, d) => [await depreciationDoc(trx, tid(req), regime, d)]));
  app.get('/api/asset-reports/allocation-sheet', { preHandler: view, schema: { querystring: period } }, async (req, reply) =>
    serve(req, reply, req.query.format, `phan-bo-ccdc-${req.query.fiscalYear}-${req.query.periodNo}`, (trx) => allocationSheet(trx, req.query), (d) => d, async (trx, regime, d) => [await allocationDoc(trx, tid(req), regime, d)]));
  app.get('/api/asset-reports/movement', { preHandler: view, schema: { querystring: range.extend({ kind: kindQ.default('fixed') }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    serve(req, reply, req.query.format, `tang-giam-tai-san-${req.query.from}-${req.query.to}`, (trx) => movementReport(trx, tid(req), req.query), () => req.query, async (trx, regime, d) => [await movementDoc(trx, tid(req), regime, d)]));
  app.get('/api/asset-reports/tool-register', { preHandler: view, schema: { querystring: range.extend({ kind: z.enum(['tool', 'prepaid']).default('tool') }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    serve(req, reply, req.query.format, `so-${req.query.kind === 'tool' ? 'ccdc' : 'cptt'}-${req.query.from}-${req.query.to}`, (trx) => toolRegister(trx, tid(req), req.query), () => req.query, async (trx, regime, d) => [await toolRegisterDoc(trx, tid(req), regime, d)]));
};
export default routes;
