import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { assertPrint, respondReport } from '../reporting/routes.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { invoiceRegister, reconcileDoc, reconcileTax, registerDoc } from './register.js';
import { offsetInput, runVatOffset } from './vatOffset.js';
import { createReturn, finalizeReturn, getReturn, listReturns, returnInput, returnUpdate, updateReturn } from './vatReturn.js';

const period = { year: z.coerce.number().int().min(2000).max(2100), period: z.coerce.number().int().min(1).max(12), periodKind: z.enum(['month', 'quarter']).default('month') };

const numId = z.object({ id: z.coerce.number().int().positive() });
// Lập, sửa, chốt tờ khai đọc nhiều truy vấn (bảng kê mua, bán, kỳ trước): một ảnh chụp, vẫn ghi được. Lập đồng thời cùng kỳ: bản sau gặp UNIQUE (409 DUPLICATE).
const SNAPSHOT_RW = { isolation: 'repeatable read' as const };

const routes: FastifyPluginAsyncZod = async (app) => {
  // Bảng kê hóa đơn nội bộ theo kỳ kê khai; in (html/pdf/xlsx) cần thêm report.print. Dựng trong giao dịch REPEATABLE READ READ ONLY, PDF/Excel dựng ngoài giao dịch.
  app.get('/api/tax/invoices', { preHandler: app.requirePermission('tax.view'), schema: { querystring: z.object({ direction: z.enum(['purchase', 'sale']), ...period, format: z.enum(['json', 'html', 'pdf', 'xlsx']).default('json') }) } }, async (req, reply) => {
    const { format, direction, ...q } = req.query; const tenantId = req.auth!.tenantId!;
    if (format === 'json') return app.withTenant(req, (trx) => invoiceRegister(trx, direction, q), READ_SNAPSHOT);
    assertPrint(req.auth!);
    const doc = await app.withTenant(req, async (trx) => registerDoc(trx, tenantId, await invoiceRegister(trx, direction, q)), READ_SNAPSHOT);
    return respondReport(reply, [doc], format, `bang-ke-hoa-don-${direction === 'purchase' ? 'mua-vao' : 'ban-ra'}-${q.year}-${q.periodKind === 'month' ? 'T' : 'Q'}${q.period}`);
  });

  // Đối chiếu thuế hóa đơn với sổ cái; Excel là danh sách chứng từ lệch.
  app.get('/api/tax/reconcile', { preHandler: app.requirePermission('tax.view'), schema: { querystring: z.object({ ...period, format: z.enum(['json', 'xlsx']).default('json') }) } }, async (req, reply) => {
    const { format, ...q } = req.query; const tenantId = req.auth!.tenantId!;
    if (format === 'json') return app.withTenant(req, (trx) => reconcileTax(trx, q), READ_SNAPSHOT);
    assertPrint(req.auth!);
    const doc = await app.withTenant(req, async (trx) => reconcileDoc(trx, tenantId, q, await reconcileTax(trx, q)), READ_SNAPSHOT);
    return respondReport(reply, [doc], format, `doi-chieu-thue-${q.year}-${q.periodKind === 'month' ? 'T' : 'Q'}${q.period}`);
  });

  // Tờ khai 01/GTGT: lập (lần đầu hoặc bổ sung), sửa nháp, chốt; danh sách và chi tiết đọc trong giao dịch REPEATABLE READ READ ONLY.
  app.get('/api/tax/vat-returns', { preHandler: app.requirePermission('tax_return.view'), schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => listReturns(trx, req.query.year), READ_SNAPSHOT));
  app.get('/api/tax/vat-returns/:id', { preHandler: app.requirePermission('tax_return.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getReturn(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/tax/vat-returns', { preHandler: app.requirePermission('tax_return.create'), schema: { body: returnInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createReturn(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.body), SNAPSHOT_RW)));
  app.put('/api/tax/vat-returns/:id', { preHandler: app.requirePermission('tax_return.update'), schema: { params: numId, body: returnUpdate } }, async (req) =>
    app.withTenant(req, (trx) => updateReturn(trx, req.auth!.tenantId!, req.params.id, req.body), SNAPSHOT_RW));
  app.post('/api/tax/vat-returns/:id/finalize', { preHandler: app.requirePermission('tax_return.finalize'), schema: { params: numId } }, async (req) =>
    app.withTenant(req, (trx) => finalizeReturn(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.params.id), SNAPSHOT_RW));

  // Khấu trừ thuế GTGT cuối kỳ (chứng từ KTT); kỳ khóa sổ cần quyền ghi lùi ngày.
  app.post('/api/tax/vat-offset', { preHandler: app.requirePermission('tax.offset'), schema: { body: offsetInput } }, async (req) => {
    const auth = req.auth!;
    const out = await app.withOverride(req, (trx) => runVatOffset(trx, { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') }, req.body));
    if (!out.unchanged) notifyRecompute(app, auth.tenantId!);
    return out;
  });
};
export default routes;
