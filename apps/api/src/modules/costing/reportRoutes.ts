import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { respondReport } from '../reporting/routes.js';
import { costCard, expenseSummary, ledger154, normCompare, reportScope, spanScope, toDoc, type Report } from './reports.js';

// Báo cáo giá thành (Task 12): quyền cost_run.view VÀ cờ view_cost (403) ở API; json và html: chỉ cần hai điều đó;
// xlsx và pdf (xuất tệp): thêm report.print như sổ kế toán (không có quyền xuất riêng cho giá thành ở 0094, QĐ #851). Đọc trong giao dịch REPEATABLE READ READ ONLY.
const format = z.enum(['json', 'html', 'xlsx', 'pdf']).default('json');
const routes: FastifyPluginAsyncZod = async (app) => {
  const view = { preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requirePermission('cost_run.view')(req, reply);
    if (!req.auth!.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
  } };
  const serve = async (req: FastifyRequest, reply: FastifyReply, fmt: z.infer<typeof format>, build: (trx: Transaction<Database>) => Promise<Report>) => {
    if (fmt === 'json') return app.withTenant(req, build, READ_SNAPSHOT);
    if ((fmt === 'xlsx' || fmt === 'pdf') && !req.auth!.permissions.has('report.print')) throw new AppError('FORBIDDEN', 'Thiếu quyền report.print', 403);
    const { doc, name } = await app.withTenant(req, async (trx) => { const r = await build(trx); return { doc: await toDoc(trx, req.auth!.tenantId!, r), name: r.fileName }; }, READ_SNAPSHOT);
    return respondReport(reply, [doc], fmt, name);
  };
  const P = '/api/costing/reports';
  const tid = (req: FastifyRequest) => req.auth!.tenantId!;
  app.get(`${P}/card`, { ...view, schema: { querystring: reportScope.extend({ format }) } }, async (req, reply) => serve(req, reply, req.query.format, (trx) => costCard(trx, tid(req), req.query)));
  app.get(`${P}/ledger-154`, { ...view, schema: { querystring: reportScope.extend({ format }) } }, async (req, reply) => serve(req, reply, req.query.format, (trx) => ledger154(trx, tid(req), req.query)));
  app.get(`${P}/expense-summary`, { ...view, schema: { querystring: spanScope.and(z.object({ format })) } }, async (req, reply) => serve(req, reply, req.query.format, (trx) => expenseSummary(trx, req.query)));
  app.get(`${P}/norm-compare`, { ...view, schema: { querystring: reportScope.extend({ format }) } }, async (req, reply) => serve(req, reply, req.query.format, (trx) => normCompare(trx, req.query)));
};
export default routes;
