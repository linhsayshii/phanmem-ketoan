import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { assertSensitive, regimeOf } from '../reporting/ledgers.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { logCloseStep, runSummary } from '../ledger/periodClose.js';
import { loanDoc, loanReport, loanVouchers } from './reports.js';
import { interestPreview, redactLoanRun, runLoanInterest } from './interest.js';
import { deleteLoan, disburse, disburseInput, getLoan, listLoans, lookupContracts, loanInput, redactLoan, repay, repayInput, saveLoan, settleLoan } from './loans.js';

const numId = z.object({ id: z.coerce.number().int().positive() });

// Khế ước vay: hợp đồng, lãi suất theo hiệu lực, lịch trả gốc; giải ngân, trả nợ, tất toán; tính lãi vay kỳ (LV).
const routes: FastifyPluginAsyncZod = async (app) => {
  // Số dư khế ước vay là công nợ phải trả theo bên cho vay: mọi đọc số liệu khế ước cần view_payable (403 như arap).
  const payable = async (req: { auth: { sensitive: Set<string> } | null }) => assertSensitive(req.auth!, { subledger_kind: 'payable', code: '3411' });
  const tid = (req: { auth: { tenantId: string | null } | null }) => req.auth!.tenantId!;
  // Thao tác ghi (tạo, sửa, giải ngân, trả nợ, tất toán, tính lãi) không cần view_payable, nhưng phản hồi và thông báo lỗi không nêu số liệu khế ước khi thiếu cờ.
  const hide = (req: { auth: { sensitive: Set<string> } | null }) => !req.auth!.sensitive.has('view_payable');
  const ctx = (req: { auth: { tenantId: string | null; userId: string; sensitive: Set<string> } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, hideAmounts: hide(req) });
  app.get('/api/loans', { preHandler: [app.requirePermission('loan.view'), payable], schema: { querystring: z.object({ at: dateIso.optional() }) } }, async (req) => app.withTenant(req, (trx) => listLoans(trx, req.query.at), READ_SNAPSHOT));
  // Sổ theo dõi khế ước vay (JSON; HTML/PDF/Excel cần report.print). Đường tĩnh /report đứng trước /:id.
  app.get('/api/loans/report', { preHandler: [app.requirePermission('report.view'), payable], schema: { querystring: z.object({ from: isoDate, to: isoDate, format: z.enum(['json', 'html', 'pdf', 'xlsx']).default('json') }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const q = req.query; if (q.format !== 'json') assertPrint(req.auth!);
    const out = await app.withTenant(req, async (trx) => { const data = await loanReport(trx, q.from, q.to); return { data, doc: q.format === 'json' ? null : await loanDoc(trx, req.auth!.tenantId!, await regimeOf(trx, q), data) }; }, READ_SNAPSHOT);
    return q.format === 'json' ? out.data : respondReport(reply, [out.doc!], q.format, `so-theo-doi-khe-uoc-${q.from}-${q.to}`);
  });
  app.get('/api/loans/:id', { preHandler: [app.requirePermission('loan.view'), payable], schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getLoan(trx, req.params.id), READ_SNAPSHOT));
  app.get('/api/loans/:id/vouchers', { preHandler: [app.requirePermission('loan.view'), payable], schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => loanVouchers(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/loans', { preHandler: app.requirePermission('loan.create'), schema: { body: loanInput } }, async (req, reply) =>
    reply.status(201).send(redactLoan(await app.withTenant(req, (trx) => saveLoan(trx, tid(req), null, req.body)), hide(req))));
  app.put('/api/loans/:id', { preHandler: app.requirePermission('loan.update'), schema: { params: numId, body: loanInput } }, async (req) => redactLoan(await app.withTenant(req, (trx) => saveLoan(trx, tid(req), req.params.id, req.body)), hide(req)));
  app.delete('/api/loans/:id', { preHandler: app.requirePermission('loan.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteLoan(trx, tid(req), req.params.id)); return reply.status(204).send(); });

  // Giải ngân, trả nợ là chứng từ thường (BC/BN/PKT) đã ghi sổ: sửa bằng đường chung (bỏ ghi sổ, đảo).
  app.post('/api/loans/:id/disburse', { preHandler: [app.requirePermission('loan.update'), app.requirePermission('voucher.create'), app.requirePermission('voucher.post')], schema: { params: numId, body: disburseInput } }, async (req, reply) => {
    const out = await app.withOverride(req, (trx) => disburse(trx, ctx(req), req.params.id, req.body)); notifyRecompute(app, tid(req)); return reply.status(201).send(out);
  });
  app.post('/api/loans/:id/repay', { preHandler: [app.requirePermission('loan.update'), app.requirePermission('voucher.create'), app.requirePermission('voucher.post')], schema: { params: numId, body: repayInput } }, async (req, reply) => {
    const out = await app.withOverride(req, (trx) => repay(trx, ctx(req), req.params.id, req.body)); notifyRecompute(app, tid(req)); return reply.status(201).send(out);
  });
  app.post('/api/loans/:id/settle', { preHandler: app.requirePermission('loan.update'), schema: { params: numId } }, async (req) => redactLoan(await app.withTenant(req, (trx) => settleLoan(trx, tid(req), req.params.id, hide(req))), hide(req)));

  // Lãi dự tính theo tháng theo lịch trả (màn hình khế ước); tính lãi vay kỳ thành chứng từ LV, kỳ khóa sổ cần quyền ghi lùi.
  app.get('/api/loans/:id/interest-preview', { preHandler: [app.requirePermission('loan.view'), payable], schema: { params: numId, querystring: z.object({ from: dateIso, to: dateIso }).refine((q) => q.from <= q.to, 'Từ ngày phải trước hoặc bằng đến ngày') } },
    async (req) => app.withTenant(req, (trx) => interestPreview(trx, req.params.id, req.query.from, req.query.to), READ_SNAPSHOT));
  app.post('/api/loan-runs', { preHandler: app.requirePermission('loan.run'), schema: { body: z.object({ fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(15) }) } }, async (req) => {
    const auth = req.auth!;
    const ctx = { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') };
    const out = await app.withOverride(req, async (trx) => {
      const r = await runLoanInterest(trx, ctx, req.body);
      await logCloseStep(trx, ctx, { fiscalYear: req.body.fiscalYear, periodNo: req.body.periodNo, step: 'loan_interest', ok: true, summary: runSummary(r) });
      return r;
    });
    if (!out.unchanged) notifyRecompute(app, auth.tenantId!);
    return redactLoanRun(out, hide(req));
  });

  // Tra cứu F4 cột Khế ước của dòng chứng từ.
  app.get('/api/lookups/contracts', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ q: z.string().default(''), kind: z.enum(['sale', 'purchase', 'loan']).optional(), size: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => lookupContracts(trx, req.query.q, req.query.kind, req.query.size), READ_SNAPSHOT));
};
export default routes;
