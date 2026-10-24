import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { SENSITIVE_FLAGS_ALL } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { accountDetail, accountLedger, assertAllSensitive, assertCanView, generalJournal, JOURNAL_JSON_LIMIT, regimeOf, trialBalance } from './ledgers.js';
import { copyReportTemplates, drillLine, evaluateFinancialReport, saveReportDef } from './financial.js';
import { bookSetDocs, detailDoc, financialDoc, journalDoc, ledgerDoc, trialBalanceDoc } from './print/bookSet.js';
import { renderReportXlsx } from './print/excel.js';
import { assertPrintable, renderReportsHtml, type ReportDoc } from './print/html.js';
import { renderPdf } from './print/pdf.js';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Ngày không hợp lệ');
const range = { from: isoDate, to: isoDate };
export const ordered = (q: { from: string; to: string }) => q.from <= q.to;
export const orderedMsg = { message: 'Từ ngày phải trước hoặc bằng đến ngày' };
export const assertPrint = (auth: { permissions: Set<string> }) => {
  if (!auth.permissions.has('report.print')) throw new AppError('FORBIDDEN', 'Thiếu quyền report.print', 403);
};
const regimeEnum = z.enum(['TT99', 'TT133', 'TT200', 'TT58']);
const reportCode = z.enum(['B01', 'B02', 'B03']);
const format = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');
type PrintFormat = 'html' | 'pdf' | 'xlsx';

// Tên tệp mã hóa theo RFC 5987 (tên có thể chứa mã tài khoản/báo cáo do người dùng gõ). PDF mở trong tab, Excel tải về. Khổ giấy từng sổ do renderReportsHtml quyết định (CSS), không qua tùy chọn landscape của renderPdf.
export async function respondReport(reply: FastifyReply, docs: ReportDoc[], format: PrintFormat, fileName: string) {
  const name = encodeURIComponent(fileName);
  if (format !== 'xlsx') assertPrintable(docs); // HTML/PDF dựng cả bộ trong một trang: chặn sổ quá lớn, Excel không bị giới hạn
  if (format === 'html') return reply.type('text/html; charset=utf-8').send(renderReportsHtml(docs));
  if (format === 'pdf') return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${name}.pdf`).send(await renderPdf(renderReportsHtml(docs)));
  return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename*=UTF-8''${name}.xlsx`).send(await renderReportXlsx(docs));
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('report.view');
  // In một sổ/báo cáo: cần thêm quyền report.print; hệ tài khoản theo khoảng ngày (như chính các hàm sổ), dựng tài liệu trong giao dịch rồi mới dựng PDF/Excel ngoài giao dịch.
  const printDoc = async (req: FastifyRequest, reply: FastifyReply, fmt: PrintFormat, q: { from: string; to: string }, fileName: string, build: (trx: Transaction<Database>, regime: string) => Promise<ReportDoc>) => {
    assertPrint(req.auth!);
    return respondReport(reply, [await app.withTenant(req, async (trx) => build(trx, await regimeOf(trx, q)), READ_SNAPSHOT)], fmt, fileName);
  };
  app.get('/api/reports/ledgers/general-journal', { preHandler: view, schema: { querystring: z.object({ ...range, format }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    assertAllSensitive(req.auth!); // Nhật ký chung gồm cả công nợ và giá vốn
    if (req.query.format === 'json') return app.withTenant(req, (trx) => generalJournal(trx, req.query, JOURNAL_JSON_LIMIT), READ_SNAPSHOT);
    return printDoc(req, reply, req.query.format, req.query, `nhat-ky-chung-${req.query.from}-${req.query.to}`, (trx, regime) => journalDoc(trx, req.auth!.tenantId!, regime, req.query));
  });
  // Cờ nhạy cảm (công nợ, giá vốn) kiểm tra trong cùng giao dịch với truy vấn sổ.
  app.get('/api/reports/ledgers/account', { preHandler: view, schema: { querystring: z.object({ ...range, accountCode: z.string().min(1), mode: z.enum(['voucher', 'subaccount', 't']).default('voucher'), format }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    if (req.query.format === 'json') return app.withTenant(req, async (trx) => { await assertCanView(trx, req.auth!, req.query); return accountLedger(trx, req.auth!.tenantId!, req.query); }, READ_SNAPSHOT);
    // Bản in luôn là Sổ Cái theo chứng từ (mẫu S03b), không theo `mode` của màn hình.
    return printDoc(req, reply, req.query.format, req.query, `so-cai-${req.query.accountCode}-${req.query.from}-${req.query.to}`, async (trx, regime) => { await assertCanView(trx, req.auth!, req.query); return ledgerDoc(trx, req.auth!.tenantId!, regime, req.query); });
  });
  app.get('/api/reports/ledgers/detail', { preHandler: view, schema: { querystring: z.object({ ...range, accountCode: z.string().min(1), partyCode: z.string().optional(), costItemCode: z.string().optional(), projectCode: z.string().optional(), departmentCode: z.string().optional(), employeeCode: z.string().optional(), contractCode: z.string().optional(), costObjectCode: z.string().optional(), format }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    if (req.query.format === 'json') return app.withTenant(req, async (trx) => { await assertCanView(trx, req.auth!, req.query); return accountDetail(trx, req.auth!.tenantId!, req.query); }, READ_SNAPSHOT);
    return printDoc(req, reply, req.query.format, req.query, `so-chi-tiet-${req.query.accountCode}-${req.query.from}-${req.query.to}`, async (trx, regime) => { await assertCanView(trx, req.auth!, req.query); return detailDoc(trx, req.auth!.tenantId!, regime, req.query); });
  });
  app.get('/api/reports/ledgers/trial-balance', { preHandler: view, schema: { querystring: z.object({ ...range, level: z.coerce.number().int().min(1).max(6).optional(), splitParty: z.enum(['true', 'false']).default('true'), format }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    assertAllSensitive(req.auth!); // mọi tài khoản, kể cả công nợ và giá vốn
    const q = { ...req.query, splitParty: req.query.splitParty === 'true' };
    if (req.query.format === 'json') return app.withTenant(req, (trx) => trialBalance(trx, req.auth!.tenantId!, q), READ_SNAPSHOT);
    return printDoc(req, reply, req.query.format, q, `bang-can-doi-so-phat-sinh-${q.from}-${q.to}`, (trx, regime) => trialBalanceDoc(trx, req.auth!.tenantId!, regime, q));
  });

  // ---- Báo cáo tài chính theo dòng (B01/B02/B03) ----
  app.get('/api/reports/financial', { preHandler: view, schema: { querystring: z.object({ regime: regimeEnum.optional(), year: z.coerce.number().int().optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      // Năm tài chính xác định chế độ: báo cáo của năm 2026 là bộ của hệ tài khoản năm đó.
      const regime = req.query.regime ?? (req.query.year === undefined ? undefined : (await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', req.query.year).executeTakeFirst())?.regime);
      if (req.query.year !== undefined && !regime) return [];
      let q = trx.selectFrom('report_def').select(['id', 'regime', 'report_code as reportCode', 'name', 'form_no as formNo']);
      if (regime) q = q.where('regime', '=', regime);
      return q.orderBy('regime').orderBy('report_code').execute();
    }, READ_SNAPSHOT));
  app.get('/api/reports/financial/:code', { preHandler: view, schema: { params: z.object({ code: reportCode }), querystring: z.object({ ...range, comparePrevYear: z.enum(['true', 'false']).default('false'), format }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    if (req.query.format === 'json') return app.withTenant(req, (trx) => evaluateFinancialReport(trx, req.auth!.tenantId!, { reportCode: req.params.code, from: req.query.from, to: req.query.to, comparePrevYear: req.query.comparePrevYear === 'true' }), READ_SNAPSHOT);
    // Bản in luôn kèm cột so sánh (số đầu năm của B01, năm trước của B02/B03).
    return printDoc(req, reply, req.query.format, req.query, `${req.params.code}-${req.query.from}-${req.query.to}`, (trx, regime) => financialDoc(trx, req.auth!.tenantId!, regime, { reportCode: req.params.code, from: req.query.from, to: req.query.to }));
  });
  app.get('/api/reports/financial/:code/lines/:lineCode', { preHandler: view, schema: { params: z.object({ code: reportCode, lineCode: z.string().min(1) }), querystring: z.object(range).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, (trx) => drillLine(trx, req.auth!.tenantId!, { reportCode: req.params.code, lineCode: req.params.lineCode, ...req.query }, req.auth!), READ_SNAPSHOT));
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

  // ---- In liên tục cả bộ sổ năm: một PDF nhiều phần hoặc một Excel nhiều sheet ----
  app.post('/api/print/book-set', { preHandler: [view, app.requirePermission('report.print')], schema: { body: z.object({ fiscalYear: z.number().int(), include: z.array(z.enum(['journal', 'ledgers', 'trial', 'B01', 'B02', 'B03'])).min(1), format: z.enum(['pdf', 'xlsx']) }) } }, async (req, reply) => {
    // Nhật ký chung, Sổ Cái và Bảng cân đối số phát sinh in mọi tài khoản, gồm công nợ và giá vốn: cần đủ các cờ nhạy cảm như khi xem từng sổ đó.
    if (req.body.include.some((x) => x === 'journal' || x === 'ledgers' || x === 'trial')) for (const flag of SENSITIVE_FLAGS_ALL) if (!req.auth!.sensitive.has(flag)) throw new AppError('FORBIDDEN', `In Nhật ký chung, Sổ Cái và Bảng cân đối số phát sinh cả năm cần cờ nhạy cảm ${flag}`, 403);
    const docs = await app.withTenant(req, (trx) => bookSetDocs(trx, req.auth!.tenantId!, req.body.fiscalYear, req.body.include), READ_SNAPSHOT);
    if (!docs.length) throw new AppError('NOTHING_TO_PRINT', 'Không có sổ hoặc báo cáo nào để in (báo cáo chưa được định nghĩa hoặc không có số liệu)', 404);
    return respondReport(reply, docs, req.body.format, `bo-so-${req.body.fiscalYear}`);
  });
};
export default routes;
