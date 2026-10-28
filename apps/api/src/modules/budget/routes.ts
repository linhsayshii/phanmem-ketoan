import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { sensitiveDenial } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { effectiveBranch } from '../branch/scope.js';
import { getSetting, putSetting, settingInput } from './alert.js';
import { analyticsOverview } from './analytics.js';
import { budgetDrill, budgetReport } from './actuals.js';
import { buildBudgetXlsx, parseBudgetXlsx } from './excel.js';
import { approveBudget, budgetInput, budgetNotFound, copyFromActual, copyInput, createBudget, deleteBudget, getBudget, listBudgets, newVersion, replaceLines, assertDraft, updateBudget } from './service.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const month = z.coerce.number().int().min(1).max(12);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
class DryRun extends Error {}

// Ngân sách (dự toán), báo cáo thực hiện so với ngân sách, cảnh báo vượt ngân sách, phân tích tài chính.
const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: { auth: { tenantId: string | null; userId: string } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });
  const view = app.requirePermission('budget.view');

  app.get('/api/budgets', { preHandler: view, schema: { querystring: z.object({ year: z.coerce.number().int().optional() }) } }, async (req) => app.withTenant(req, (trx) => listBudgets(trx, req.query.year), READ_SNAPSHOT));
  app.post('/api/budgets', { preHandler: app.requirePermission('budget.create'), schema: { body: budgetInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createBudget(trx, ctx(req), req.body))));
  app.post('/api/budgets/copy-actual', { preHandler: app.requirePermission('budget.create'), schema: { body: copyInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => copyFromActual(trx, ctx(req), req.body, (a) => sensitiveDenial(req.auth!, a) === null))));
  app.get('/api/budgets/template.xlsx', { preHandler: view }, async (_req, reply) =>
    reply.header('content-type', XLSX).header('content-disposition', 'attachment; filename="mau_ngan_sach.xlsx"').send(await buildBudgetXlsx([], { title: 'Mẫu nhập ngân sách' })));

  // Cấu hình cảnh báo vượt ngân sách của công ty (tắt mặc định).
  app.get('/api/budget-settings', { preHandler: view }, async (req) => app.withTenant(req, (trx) => getSetting(trx), READ_SNAPSHOT));
  app.put('/api/budget-settings', { preHandler: app.requirePermission('budget.approve'), schema: { body: settingInput } }, async (req) => app.withTenant(req, (trx) => putSetting(trx, req.auth!.tenantId!, req.body)));

  app.get('/api/budgets/:id', { preHandler: view, schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getBudget(trx, req.params.id), READ_SNAPSHOT));
  app.put('/api/budgets/:id', { preHandler: app.requirePermission('budget.update'), schema: { params: numId, body: budgetInput.omit({ fiscalYear: true }) } }, async (req) => app.withTenant(req, (trx) => updateBudget(trx, ctx(req), req.params.id, req.body)));
  app.delete('/api/budgets/:id', { preHandler: app.requirePermission('budget.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteBudget(trx, req.params.id)); return reply.status(204).send(); });
  app.post('/api/budgets/:id/approve', { preHandler: app.requirePermission('budget.approve'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => approveBudget(trx, ctx(req), req.params.id)));
  app.post('/api/budgets/:id/new-version', { preHandler: app.requirePermission('budget.create'), schema: { params: numId } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => newVersion(trx, ctx(req), req.params.id))));

  // Thực hiện so với ngân sách đến tháng `month`; thực tế từ sổ cái, cờ nhạy cảm theo từng tài khoản dưới tiền tố (403 như sổ chi tiết).
  app.get('/api/budgets/:id/report', { preHandler: [view, app.requirePermission('report.view')], schema: { params: numId, querystring: z.object({ month }) } }, async (req) =>
    app.withTenant(req, (trx) => budgetReport(trx, req.auth!, req.params.id, req.query.month), READ_SNAPSHOT));
  app.get('/api/budgets/:id/lines/:lineId/entries', { preHandler: [view, app.requirePermission('report.view')], schema: { params: numId.extend({ lineId: z.coerce.number().int().positive() }), querystring: z.object({ month: month.optional() }) } }, async (req) => {
    const r = await app.withTenant(req, (trx) => budgetDrill(trx, req.auth!, req.params.id, req.params.lineId, req.query.month ?? null), READ_SNAPSHOT);
    if (!r) throw new AppError('BUDGET_LINE_NOT_FOUND', 'Không có dòng ngân sách', 404);
    return r;
  });

  app.get('/api/budgets/:id/export.xlsx', { preHandler: view, schema: { params: numId } }, async (req, reply) => {
    const b = await app.withTenant(req, (trx) => getBudget(trx, req.params.id), READ_SNAPSHOT);
    return reply.header('content-type', XLSX).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`ngan-sach-${b.fiscalYear}-v${b.version}.xlsx`)}`).send(await buildBudgetXlsx(b.lines, { title: `${b.name} (${b.fiscalYear}, phiên bản ${b.version})` }));
  });
  // Nhập Excel thay toàn bộ dòng của ngân sách nháp. validate chỉ kiểm tra, commit ghi.
  app.post('/api/budgets/:id/import-lines', { preHandler: app.requirePermission('budget.update'), schema: { params: numId, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const { lines, errors } = await parseBudgetXlsx(await file.toBuffer());
    if (errors.length) throw new AppError('IMPORT_ERRORS', `Tệp có ${errors.length} lỗi, chưa nhập dòng nào`, 400, errors.slice(0, 500));
    const dry = req.query.mode === 'validate';
    try {
      await app.withTenant(req, async (trx) => {
        const b = await assertDraft(trx, req.params.id).catch((e) => { throw e instanceof AppError && e.code === 'BUDGET_NOT_FOUND' ? budgetNotFound() : e; });
        await replaceLines(trx, req.auth!.tenantId!, req.params.id, b.fiscal_year, lines);
        if (dry) throw new DryRun();
      });
    } catch (e) { if (!(e instanceof DryRun)) throw e; }
    return { mode: req.query.mode, lines: lines.length };
  });

  app.get('/api/analytics/overview', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100), month: month.default(12) }) } }, async (req) =>
    app.withTenant(req, (trx) => analyticsOverview(trx, req.auth!.tenantId!, req.auth!, req.query.year, req.query.month, effectiveBranch(req.auth!, undefined)), READ_SNAPSHOT));
};
export default routes;
