import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { todayVn } from '@kt/domain';
import { isoDate } from '../reporting/routes.js';
import { listOpenItems } from './openItems.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  // Khoản công nợ theo chứng từ và dư còn lại tại ngày (mặc định hôm nay); onlyOpen mặc định chỉ khoản còn dư.
  app.get('/api/open-items', { preHandler: app.requirePermission('settlement.view'),
    schema: { querystring: z.object({ accountCode: z.string().min(1), partyCode: z.string().min(1).optional(), asOf: isoDate.optional(), onlyOpen: z.enum(['true', 'false']).default('true') }) } }, async (req) =>
    app.withTenant(req, (trx) => listOpenItems(trx, req.auth!, req.auth!.tenantId!, { ...req.query, asOf: req.query.asOf ?? todayVn(), onlyOpen: req.query.onlyOpen === 'true' }), READ_SNAPSHOT));
};
export default routes;
