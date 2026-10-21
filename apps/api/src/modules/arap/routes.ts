import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { todayVn } from '@kt/domain';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { isoDate } from '../reporting/routes.js';
import { listOpenItems } from './openItems.js';
import { autoInput, autoSettle, listQuery, listSettlements, settle, settleInput, unsettle } from './settlement.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  // Khoản công nợ theo chứng từ và dư còn lại tại ngày (mặc định hôm nay); onlyOpen mặc định chỉ khoản còn dư.
  app.get('/api/open-items', { preHandler: app.requirePermission('settlement.view'),
    schema: { querystring: z.object({ accountCode: z.string().min(1), partyCode: z.string().min(1).optional(), asOf: isoDate.optional(), onlyOpen: z.enum(['true', 'false']).default('true') }) } }, async (req) =>
    app.withTenant(req, (trx) => listOpenItems(trx, req.auth!, req.auth!.tenantId!, { ...req.query, asOf: req.query.asOf ?? todayVn(), onlyOpen: req.query.onlyOpen === 'true' }), READ_SNAPSHOT));

  // Đối trừ và hủy đối trừ qua app.withOverride: kỳ khóa sổ chỉ khi có quyền ghi lùi (như chứng từ, tỷ giá xuất quỹ); kỳ khóa cứng luôn bị chặn trong SQL.
  app.get('/api/settlements', { preHandler: app.requirePermission('settlement.view'), schema: { querystring: listQuery } }, async (req) =>
    app.withTenant(req, (trx) => listSettlements(trx, req.auth!, req.auth!.tenantId!, { ...req.query, today: todayVn() }), READ_SNAPSHOT));
  app.post('/api/settlements', { preHandler: app.requirePermission('settlement.create'), schema: { body: settleInput } }, async (req, reply) => {
    const out = await app.withOverride(req, (trx) => settle(trx, req.auth!, req.body));
    if (out.fxVoucherId) notifyRecompute(app, req.auth!.tenantId!); // chứng từ CL đã ghi sổ
    return reply.status(201).send(out);
  });
  app.post('/api/settlements/auto', { preHandler: app.requirePermission('settlement.create'), schema: { body: autoInput } }, async (req) => {
    const out = await app.withOverride(req, (trx) => autoSettle(trx, req.auth!, req.body));
    if (out.groups) notifyRecompute(app, req.auth!.tenantId!);
    return out;
  });
  app.delete('/api/settlements/groups/:groupId', { preHandler: app.requirePermission('settlement.delete'), schema: { params: z.object({ groupId: z.string().uuid() }) } }, async (req, reply) => {
    await app.withOverride(req, (trx) => unsettle(trx, req.auth!, req.params.groupId));
    notifyRecompute(app, req.auth!.tenantId!);
    return reply.status(204).send();
  });
};
export default routes;
