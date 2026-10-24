import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { todayVn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { regimeOf } from '../reporting/ledgers.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { amendmentsInput, getContract, invoiceFromMilestoneInput, invoiceMilestone, milestonesInput, saveAmendments, saveMilestones } from './milestone.js';
import { contractPnl, pnlDoc, projectPnl } from './pnl.js';
import { assertOverdueFlags, trackContract, trackContracts, trackDoc, trackQuery } from './tracking.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const format = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');

// Hợp đồng bán/mua: chi tiết kèm đợt thanh toán, lưu đợt, lập hóa đơn từ đợt. Quyền như CRUD hợp đồng (order.*, orders/routes.ts);
// lập hóa đơn là lập chứng từ: cần thêm voucher.create (như chuyển đơn hàng thành BH/MH).
// Theo dõi thực hiện, lãi lỗ hợp đồng/vụ việc (Task 13b): quyền contract_track.view; lãi lỗ cần cờ view_cost (giá vốn), số công nợ cần view_receivable/view_payable.
const routes: FastifyPluginAsyncZod = async (app) => {
  const trackView = app.requirePermission('contract_track.view');
  const viewCost = async (req: FastifyRequest) => { if (!req.auth!.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403); };

  // Đường tĩnh (/track, /pnl) được ưu tiên hơn /:id.
  app.get('/api/contracts/track', { preHandler: trackView, schema: { querystring: trackQuery } }, async (req, reply) => {
    const q = req.query; const asOf = q.asOf ?? todayVn(); const overdue = q.overdue === 'true';
    if (overdue) assertOverdueFlags(req.auth!, q.kind);
    if (q.format !== 'json') assertPrint(req.auth!);
    const out = await app.withTenant(req, async (trx) => {
      const data = await trackContracts(trx, req.auth!, { asOf, kind: q.kind, status: q.status, overdue });
      return { data, doc: q.format === 'json' ? null : await trackDoc(trx, req.auth!.tenantId!, await regimeOf(trx, { from: asOf, to: asOf }), data, overdue) };
    }, READ_SNAPSHOT);
    return q.format === 'json' ? out.data : respondReport(reply, [out.doc!], q.format, `${overdue ? 'hop-dong-qua-han' : 'theo-doi-hop-dong'}-${asOf}`);
  });
  const pnlRange = { from: isoDate, to: isoDate, format };
  app.get('/api/contracts/pnl', { preHandler: [trackView, viewCost], schema: { querystring: z.object({ ...pnlRange, contractId: z.coerce.number().int().positive().optional() }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const q = req.query; if (q.format !== 'json') assertPrint(req.auth!);
    const out = await app.withTenant(req, async (trx) => { const data = await contractPnl(trx, q); return { data, doc: q.format === 'json' ? null : await pnlDoc(trx, req.auth!.tenantId!, data) }; }, READ_SNAPSHOT);
    return q.format === 'json' ? out.data : respondReport(reply, [out.doc!], q.format, `lai-lo-hop-dong-${q.from}-${q.to}`);
  });
  app.get('/api/projects/pnl', { preHandler: [trackView, viewCost], schema: { querystring: z.object({ ...pnlRange, projectId: z.coerce.number().int().positive().optional() }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const q = req.query; if (q.format !== 'json') assertPrint(req.auth!);
    const out = await app.withTenant(req, async (trx) => { const data = await projectPnl(trx, q); return { data, doc: q.format === 'json' ? null : await pnlDoc(trx, req.auth!.tenantId!, data) }; }, READ_SNAPSHOT);
    return q.format === 'json' ? out.data : respondReport(reply, [out.doc!], q.format, `lai-lo-vu-viec-${q.from}-${q.to}`);
  });

  app.get('/api/contracts/:id', { preHandler: app.requirePermission('order.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getContract(trx, req.params.id), READ_SNAPSHOT));
  app.get('/api/contracts/:id/track', { preHandler: trackView, schema: { params: numId, querystring: z.object({ asOf: dateIso.optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => trackContract(trx, req.auth!, req.params.id, req.query.asOf ?? todayVn()), READ_SNAPSHOT));
  app.put('/api/contracts/:id/milestones', { preHandler: app.requirePermission('order.update'), schema: { params: numId, body: milestonesInput } }, async (req) =>
    app.withTenant(req, (trx) => saveMilestones(trx, req.auth!.tenantId!, req.params.id, req.body)));
  app.put('/api/contracts/:id/amendments', { preHandler: app.requirePermission('order.update'), schema: { params: numId, body: amendmentsInput } }, async (req) =>
    app.withTenant(req, (trx) => saveAmendments(trx, req.auth!.tenantId!, req.params.id, req.body)));
  app.post('/api/contracts/:id/milestones/:mid/invoice', { preHandler: app.requirePermission('order.update'),
    schema: { params: numId.extend({ mid: z.coerce.number().int().positive() }), body: invoiceFromMilestoneInput } }, async (req, reply) => {
    if (!req.auth!.permissions.has('voucher.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.create', 403);
    const out = await app.withOverride(req, (trx) => invoiceMilestone(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! }, req.params.id, req.params.mid, req.body));
    return reply.status(201).send(out);
  });
};
export default routes;
