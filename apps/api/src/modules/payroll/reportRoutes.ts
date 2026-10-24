import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { respondReport } from '../reporting/routes.js';
import { toDoc, bhxhList, compareReport, compareScope, costReport, costScope, insuranceSummary, monthScope, paymentSheet, periodScope, pitReport, pitScope, renderCsv, slipDocs, slipScope, slips, type Report } from './reports.js';
import { buildRunImportTemplate, importRun } from './runImport.js';

// Báo cáo lương, phiếu lương, tệp BHXH và nhập bảng lương từ Excel (Task 7). Mọi route cần quyền payroll.* VÀ cờ view_salary (403 SALARY_FORBIDDEN).
// json và html: payroll.view; xlsx và csv (xuất tệp): thêm payroll.export (QĐ #711). Báo cáo đọc trong giao dịch REPEATABLE READ READ ONLY.
const routes: FastifyPluginAsyncZod = async (app) => {
  const guard = (perm: 'payroll.view' | 'payroll.update') => ({ preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requirePermission(perm)(req, reply);
    if (!req.auth!.sensitive.has('view_salary')) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
  } });
  const view = guard('payroll.view'), update = guard('payroll.update');
  const P = '/api/payroll/reports';
  const format = z.enum(['json', 'html', 'xlsx', 'csv']).default('json');
  const tid = (req: FastifyRequest) => req.auth!.tenantId!;

  const serve = async (req: FastifyRequest, reply: FastifyReply, fmt: z.infer<typeof format>, build: (trx: Transaction<Database>) => Promise<Report>) => {
    if (fmt === 'json') return app.withTenant(req, build, READ_SNAPSHOT);
    if ((fmt === 'xlsx' || fmt === 'csv') && !req.auth!.permissions.has('payroll.export')) throw new AppError('FORBIDDEN', 'Thiếu quyền payroll.export', 403);
    const { doc, name } = await app.withTenant(req, async (trx) => { const r = await build(trx); return { doc: await toDoc(trx, tid(req), r), name: r.fileName }; }, READ_SNAPSHOT);
    if (fmt === 'csv') return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}.csv`).send(renderCsv(doc));
    return respondReport(reply, [doc], fmt, name);
  };
  const route = <S extends z.ZodRawShape>(path: string, shape: z.ZodObject<S>, build: (trx: Transaction<Database>, q: z.infer<z.ZodObject<S>>) => Promise<Report>) =>
    app.get(`${P}/${path}`, { ...view, schema: { querystring: shape.extend({ format }) } }, async (req, reply) => {
      const q = req.query as z.infer<z.ZodObject<S>> & { format: z.infer<typeof format> };
      return serve(req, reply, q.format, (trx) => build(trx, q));
    });
  route('payment-sheet', monthScope, paymentSheet);
  route('insurance', periodScope, insuranceSummary);
  route('cost', costScope, costReport);
  route('pit', pitScope, pitReport);
  route('compare', compareScope, compareReport);
  route('bhxh-list', monthScope, bhxhList);

  // Phiếu lương cá nhân: một nhân viên một trang A4 (HTML để in từ trình duyệt); json trả số liệu từng phiếu.
  app.get(`${P}/slips`, { ...view, schema: { querystring: slipScope.extend({ format: z.enum(['json', 'html']).default('json') }) } }, async (req, reply) => {
    const out = await app.withTenant(req, async (trx) => { const d = await slips(trx, req.query); return req.query.format === 'json' ? d : slipDocs(trx, tid(req), d); }, READ_SNAPSHOT);
    return req.query.format === 'json' ? out : respondReport(reply, out as Awaited<ReturnType<typeof slipDocs>>, 'html', 'phieu-luong');
  });

  // Nhập bảng lương từ Excel: mẫu theo cột nhập tay của cấu trúc, lượt Kiểm tra (không ghi) và lượt Nhập.
  const pid = z.object({ id: z.coerce.number().int().positive() });
  app.get('/api/payroll/runs/:id/import/template.xlsx', { ...view, schema: { params: pid } }, async (req, reply) => {
    const buf = await app.withTenant(req, (trx) => buildRunImportTemplate(trx, req.params.id), READ_SNAPSHOT);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_nhap_bang_luong.xlsx"');
    return reply.send(buf);
  });
  app.post('/api/payroll/runs/:id/import', { ...update, schema: { params: pid, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    return app.withTenant(req, (trx) => importRun(trx, tid(req), req.params.id, buf, req.query.mode));
  });
};
export default routes;
