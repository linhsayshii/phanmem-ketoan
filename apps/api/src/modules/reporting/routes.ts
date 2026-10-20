import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { accountDetail, accountLedger, assertCanView, generalJournal, trialBalance } from './ledgers.js';
import { copyReportTemplates, drillLine, evaluateFinancialReport, saveReportDef } from './financial.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Ngày không hợp lệ');
const range = { from: isoDate, to: isoDate };
const ordered = (q: { from: string; to: string }) => q.from <= q.to;
const orderedMsg = { message: 'Từ ngày phải trước hoặc bằng đến ngày' };
const regimeEnum = z.enum(['TT99', 'TT133', 'TT200', 'TT58']);
const reportCode = z.string().min(1).max(20);

const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('report.view');
  app.get('/api/reports/ledgers/general-journal', { preHandler: view, schema: { querystring: z.object(range).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, (trx) => generalJournal(trx, req.query)));
  // Cờ nhạy cảm (công nợ, giá vốn) kiểm tra trong cùng giao dịch với truy vấn sổ.
  app.get('/api/reports/ledgers/account', { preHandler: view, schema: { querystring: z.object({ ...range, accountCode: z.string().min(1), mode: z.enum(['voucher', 'subaccount', 't']).default('voucher') }).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, async (trx) => { await assertCanView(trx, req.auth!, req.query); return accountLedger(trx, req.auth!.tenantId!, req.query); }));
  app.get('/api/reports/ledgers/detail', { preHandler: view, schema: { querystring: z.object({ ...range, accountCode: z.string().min(1), partyCode: z.string().optional(), costItemCode: z.string().optional(), projectCode: z.string().optional(), departmentCode: z.string().optional() }).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, async (trx) => { await assertCanView(trx, req.auth!, req.query); return accountDetail(trx, req.auth!.tenantId!, req.query); }));
  app.get('/api/reports/ledgers/trial-balance', { preHandler: view, schema: { querystring: z.object({ ...range, level: z.coerce.number().int().min(1).max(6).optional(), splitParty: z.enum(['true', 'false']).default('true') }).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, (trx) => trialBalance(trx, req.auth!.tenantId!, { ...req.query, splitParty: req.query.splitParty === 'true' })));

  // ---- Báo cáo tài chính theo dòng (B01/B02/B03) ----
  app.get('/api/reports/financial', { preHandler: view, schema: { querystring: z.object({ regime: regimeEnum.optional(), year: z.coerce.number().int().optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      // Năm tài chính xác định chế độ: báo cáo của năm 2026 là bộ của hệ tài khoản năm đó.
      const regime = req.query.regime ?? (req.query.year === undefined ? undefined : (await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', req.query.year).executeTakeFirst())?.regime);
      if (req.query.year !== undefined && !regime) return [];
      let q = trx.selectFrom('report_def').select(['id', 'regime', 'report_code as reportCode', 'name', 'form_no as formNo']);
      if (regime) q = q.where('regime', '=', regime);
      return q.orderBy('regime').orderBy('report_code').execute();
    }));
  app.get('/api/reports/financial/:code', { preHandler: view, schema: { params: z.object({ code: reportCode }), querystring: z.object({ ...range, comparePrevYear: z.enum(['true', 'false']).default('false') }).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, (trx) => evaluateFinancialReport(trx, req.auth!.tenantId!, { reportCode: req.params.code, from: req.query.from, to: req.query.to, comparePrevYear: req.query.comparePrevYear === 'true' })));
  app.get('/api/reports/financial/:code/lines/:lineCode', { preHandler: view, schema: { params: z.object({ code: reportCode, lineCode: z.string().min(1) }), querystring: z.object(range).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, (trx) => drillLine(trx, req.auth!.tenantId!, { reportCode: req.params.code, lineCode: req.params.lineCode, ...req.query }, req.auth!)));
  // Định nghĩa báo cáo của công ty: xem dòng, lưu lại toàn bộ dòng (kiểm tra công thức trước khi ghi), nạp lại một báo cáo từ mẫu hệ thống.
  app.get('/api/report-defs/:code', { preHandler: app.requirePermission('report_def.view'), schema: { params: z.object({ code: reportCode }), querystring: z.object({ regime: regimeEnum }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const d = await trx.selectFrom('report_def').select('id').where('report_code', '=', req.params.code).where('regime', '=', req.query.regime).executeTakeFirst();
      if (!d) return { lines: [] };
      const rows = await trx.selectFrom('report_line').selectAll().where('report_def_id', '=', d.id).orderBy('sort_order').execute();
      return { lines: rows.map((l) => ({ lineCode: l.line_code, label: l.label, parentLineCode: l.parent_line_code, source: l.source, side: l.side, formula: l.formula, sortOrder: l.sort_order, isBold: l.is_bold, negate: l.negate, noteRef: l.note_ref })) };
    }));
  app.put('/api/report-defs/:code', { preHandler: app.requirePermission('report_def.update'), schema: { params: z.object({ code: reportCode }), body: z.object({ regime: regimeEnum, lines: z.array(z.object({
    lineCode: z.string().min(1), label: z.string(), parentLineCode: z.string().nullable(), source: z.enum(['balance', 'movement', 'pair', 'lines']), side: z.enum(['debit', 'credit', 'net_debit', 'net_credit']),
    formula: z.string().nullable(), isBold: z.boolean().default(false), negate: z.boolean().default(false), noteRef: z.string().nullable().default(null) })) }) } }, async (req) => {
    await app.withTenant(req, (trx) => saveReportDef(trx, req.auth!.tenantId!, req.body.regime, req.params.code, req.body.lines));
    return { ok: true };
  });
  app.post('/api/report-defs/:code/reload', { preHandler: app.requirePermission('report_def.update'), schema: { params: z.object({ code: reportCode }), body: z.object({ regime: regimeEnum }) } }, async (req) =>
    ({ lines: await app.withTenant(req, (trx) => copyReportTemplates(trx, req.auth!.tenantId!, req.body.regime, req.params.code)) }));
};
export default routes;
