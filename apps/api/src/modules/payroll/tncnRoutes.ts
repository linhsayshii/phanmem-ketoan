import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { respondReport } from '../reporting/routes.js';
import {
  certificateDocs, certificateQuery, certificates, createTncnReturn, deleteTncnReturn, finalizeTncnReturn, getTncnReturn, listTncnReturns, refreshTncnReturn, renderTncnXml,
  settlement, settlementDocs, tncnListQuery, tncnReturnInput, withholding, withholdingDocs, withholdingQuery, yearQuery,
} from './tncnReturn.js';

// Thuế TNCN (Task 9). Mọi route cần cờ view_salary (403 SALARY_FORBIDDEN): bảng kê, quyết toán, chứng từ khấu trừ cần payroll.view (xuất Excel thêm payroll.export);
// tờ khai 05/KK-TNCN, 05/QTT-TNCN dùng quyền tax_return.* như 01/GTGT. Đọc trong REPEATABLE READ READ ONLY; lập/tính lại/chốt trong một ảnh chụp ghi được.
const SNAPSHOT_RW = { isolation: 'repeatable read' as const };
const routes: FastifyPluginAsyncZod = async (app) => {
  const guard = (perm: string) => ({ preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requirePermission(perm)(req, reply);
    if (!req.auth!.sensitive.has('view_salary')) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
  } });
  const tid = (req: FastifyRequest) => req.auth!.tenantId!;
  const ctx = (req: FastifyRequest) => ({ tenantId: tid(req), userId: req.auth!.userId });
  const format = z.enum(['json', 'html', 'xlsx']).default('json');
  const assertExport = (req: FastifyRequest, f: string) => { if (f === 'xlsx' && !req.auth!.permissions.has('payroll.export')) throw new AppError('FORBIDDEN', 'Thiếu quyền payroll.export', 403); };

  app.get('/api/tncn/withholding', { ...guard('payroll.view'), schema: { querystring: withholdingQuery.extend({ format }) } }, async (req, reply) => {
    const { format: f, ...q } = req.query; assertExport(req, f);
    if (f === 'json') return app.withTenant(req, (trx) => withholding(trx, q), READ_SNAPSHOT);
    const { docs, name } = await app.withTenant(req, async (trx) => { const w = await withholding(trx, q); return { docs: await withholdingDocs(trx, tid(req), w), name: `bang-ke-tncn-${w.year}-${w.periodKind === 'quarter' ? 'Q' : w.periodKind === 'month' ? 'T' : 'N'}${w.period}` }; }, READ_SNAPSHOT);
    return respondReport(reply, docs, f, name);
  });
  app.get('/api/tncn/settlement', { ...guard('payroll.view'), schema: { querystring: yearQuery.extend({ format }) } }, async (req, reply) => {
    const { format: f, ...q } = req.query; assertExport(req, f);
    if (f === 'json') return app.withTenant(req, (trx) => settlement(trx, q), READ_SNAPSHOT);
    const docs = await app.withTenant(req, async (trx) => settlementDocs(trx, tid(req), await settlement(trx, q)), READ_SNAPSHOT);
    return respondReport(reply, docs, f, `quyet-toan-tncn-${q.year}`);
  });
  // Chứng từ khấu trừ thuế TNCN cấp cho cá nhân: HTML một người một trang, tổng hợp cả năm.
  app.get('/api/tncn/certificates', { ...guard('payroll.view'), schema: { querystring: certificateQuery.extend({ format: z.enum(['json', 'html']).default('json') }) } }, async (req, reply) => {
    const { format: f, ...q } = req.query;
    if (f === 'json') return app.withTenant(req, (trx) => certificates(trx, q), READ_SNAPSHOT);
    const docs = await app.withTenant(req, async (trx) => certificateDocs(trx, tid(req), await certificates(trx, q)), READ_SNAPSHOT);
    return respondReport(reply, docs, 'html', `chung-tu-khau-tru-tncn-${q.year}`);
  });

  const R = '/api/tncn/returns';
  const numId = z.object({ id: z.coerce.number().int().positive() });
  app.get(R, { ...guard('tax_return.view'), schema: { querystring: tncnListQuery } }, async (req) => app.withTenant(req, (trx) => listTncnReturns(trx, req.query), READ_SNAPSHOT));
  app.get(`${R}/:id`, { ...guard('tax_return.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getTncnReturn(trx, req.params.id), READ_SNAPSHOT));
  app.post(R, { ...guard('tax_return.create'), schema: { body: tncnReturnInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createTncnReturn(trx, ctx(req), req.body), SNAPSHOT_RW)));
  app.put(`${R}/:id`, { ...guard('tax_return.update'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => refreshTncnReturn(trx, tid(req), req.params.id), SNAPSHOT_RW));
  app.delete(`${R}/:id`, { ...guard('tax_return.delete'), schema: { params: numId } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteTncnReturn(trx, tid(req), req.params.id), SNAPSHOT_RW);
    return reply.status(204).send();
  });
  app.post(`${R}/:id/finalize`, { ...guard('tax_return.finalize'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => finalizeTncnReturn(trx, ctx(req), req.params.id), SNAPSHOT_RW));
  app.get(`${R}/:id/xml`, { ...guard('tax_return.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => renderTncnXml(trx, req.params.id), READ_SNAPSHOT));
};
export default routes;
