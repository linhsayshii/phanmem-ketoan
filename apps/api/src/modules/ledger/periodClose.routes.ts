import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { periodSpan, runAssetPeriod } from '../assets/periodRun.js';
import { redactLoanRun, runLoanInterest } from '../loans/interest.js';
import { runAmortization } from '../invoices/amortization.js';
import { runCosting } from '../inventory/costingRun.js';
import { runOutflowAdjust } from '../cash/fx.js';
import { runRevaluation } from '../cash/revaluation.js';
import { runVatOffset } from '../tax/vatOffset.js';
import { runPayrollStep } from '../payroll/periodStep.js';
import { runCostStep } from '../costing/periodStep.js';
import { runAllClosing } from './closing.js';
import { notifyRecompute } from './notifyRecompute.js';
import { CLOSE_STEPS, closeStatus, logCloseStep, runSummary, stepDef, type CloseStepKey } from './periodClose.js';

const body = z.object({ fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(12), step: z.enum(CLOSE_STEPS.map((s) => s.key) as [CloseStepKey, ...CloseStepKey[]]), skip: z.boolean().optional() });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/period-close/:year/:period', { preHandler: app.requirePermission('period_close.view'),
    schema: { params: z.object({ year: z.coerce.number().int(), period: z.coerce.number().int().min(1).max(12) }) } }, async (req) =>
    app.withTenant(req, (trx) => closeStatus(trx, req.auth!.tenantId!, req.params.year, req.params.period, { salary: req.auth!.sensitive.has('view_salary'), cost: req.auth!.sensitive.has('view_cost') }), READ_SNAPSHOT));

  // Chạy một bước của quy trình (gọi hàm chạy của bước), ghi nhật ký, trả kết quả và trạng thái mới. Bước tùy chọn có thể bỏ qua (skip).
  app.post('/api/period-close/run', { preHandler: app.requirePermission('period_close.view'), schema: { body } }, async (req) => {
    const auth = req.auth!; const { fiscalYear: fy, periodNo: pn, step } = req.body;
    const def = stepDef(step);
    if (!auth.permissions.has(def.permission)) throw new AppError('FORBIDDEN', `Thiếu quyền ${def.permission}`, 403);
    const ctx = { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') };
    const status = (trx: Parameters<typeof closeStatus>[0]) => closeStatus(trx, ctx.tenantId, fy, pn, { salary: auth.sensitive.has('view_salary'), cost: auth.sensitive.has('view_cost') });
    if (req.body.skip) {
      if (!('optional' in def)) throw new AppError('STEP_NOT_OPTIONAL', `Bước "${def.name}" bắt buộc, không bỏ qua được`, 409);
      return app.withTenant(req, async (trx) => {
        await periodSpan(trx, fy, pn);
        if ((await status(trx)).steps.find((x) => x.key === step)!.status !== 'pending') throw new AppError('STEP_NOT_PENDING', `Bước "${def.name}" đã có lần chạy, không bỏ qua được`, 409);
        await logCloseStep(trx, ctx, { fiscalYear: fy, periodNo: pn, step, ok: true, summary: { skipped: true } });
        return { result: { skipped: true }, ...(await status(trx)) };
      });
    }
    if (step === 'closing') {
      const to = (await app.withTenant(req, (trx) => periodSpan(trx, fy, pn), READ_SNAPSHOT)).span.to;
      const result = await runAllClosing(app, req, to);
      return { result, ...(await app.withTenant(req, (trx) => status(trx), READ_SNAPSHOT)) };
    }
    const out = await app.withOverride(req, async (trx) => {
      const { span } = await periodSpan(trx, fy, pn);
      let result: object; let summary: Record<string, unknown>; let ok = true;
      switch (step) {
        // Kỳ có bảng lương/chi phí giá thành: cần cờ như route hạch toán lương, chạy giá thành (403 làm giao dịch hoàn tác); kỳ không có gì (skipped) thì chạy được.
        case 'payroll': {
          const r = await runPayrollStep(trx, ctx, span); ok = !r.needCalculation.length;
          if (!r.skipped && !auth.sensitive.has('view_salary')) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
          result = r;
          summary = { ...runSummary(r), ...(r.skipped ? { skipped: true } : {}), errors: r.needCalculation.length }; break;
        }
        case 'product_cost': { // lỗi chặn (chưa phân loại/gắn đối tượng) → 409 kèm chi tiết khi có view_cost, không kèm số khi thiếu
          const r = await runCostStep(trx, ctx, span, auth.sensitive.has('view_cost'));
          if (!r.skipped && !auth.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
          result = r;
          summary = { ...runSummary(r), ...(r.skipped ? { skipped: true } : {}) }; break;
        }
        case 'tool': case 'prepaid': case 'depreciation': { const r = await runAssetPeriod(trx, ctx, { kind: step, fiscalYear: fy, periodNo: pn }); result = r; summary = runSummary(r); break; }
        case 'loan_interest': { const r = await runLoanInterest(trx, ctx, { fiscalYear: fy, periodNo: pn }); result = redactLoanRun(r, !auth.sensitive.has('view_payable')); summary = runSummary(r); break; } // lãi từng khế ước: cần view_payable
        case 'amortization': {
          const r = await runAmortization(trx, ctx, { fiscalYear: fy, periodNo: pn }); result = r;
          summary = { ...runSummary({ voucherIds: r.created.map((c) => c.voucherId), reversedVoucherIds: r.reversedVoucherIds, unchanged: !r.created.length && r.unchanged > 0 }), skippedSchedules: r.skipped.length }; break;
        }
        case 'costing': {
          const r = await runCosting(trx, ctx, { periodFrom: span.from, periodTo: span.to });
          result = auth.sensitive.has('view_cost') ? r : { ...r, summary: { ...r.summary, delta: null } };
          ok = !r.summary.errors.length; summary = { ...runSummary(r), errors: r.summary.errors.length }; break; // không lưu chênh lệch giá vốn: nhật ký không qua cờ view_cost
        }
        case 'fx_outflow': { const r = await runOutflowAdjust(trx, ctx, { fiscalYear: fy, periodNo: pn }); result = r; summary = runSummary(r); break; }
        case 'fx_revaluation': { const r = await runRevaluation(trx, { ...ctx, sensitive: auth.sensitive }, { date: span.to }); result = r; summary = runSummary(r); break; }
        case 'vat_offset': { const r = await runVatOffset(trx, ctx, { date: span.to }); result = r; summary = runSummary(r); break; }
        default: throw new AppError('VALIDATION', 'Bước không chạy được ở đây', 400);
      }
      await logCloseStep(trx, ctx, { fiscalYear: fy, periodNo: pn, step, ok, summary });
      return { changed: !summary.unchanged, body: { result, ...(await status(trx)) } };
    });
    if (out.changed) notifyRecompute(app, auth.tenantId!);
    return out.body;
  });
};
export default routes;
