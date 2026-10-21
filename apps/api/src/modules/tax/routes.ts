import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { assertPrint, respondReport } from '../reporting/routes.js';
import { invoiceRegister, reconcileDoc, reconcileTax, registerDoc } from './register.js';

const period = { year: z.coerce.number().int().min(2000).max(2100), period: z.coerce.number().int().min(1).max(12), periodKind: z.enum(['month', 'quarter']).default('month') };

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
};
export default routes;
