import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { accountDetail, accountLedger, assertCanView, generalJournal, trialBalance } from './ledgers.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Ngày không hợp lệ');
const range = { from: isoDate, to: isoDate };
const ordered = (q: { from: string; to: string }) => q.from <= q.to;
const orderedMsg = { message: 'Từ ngày phải trước hoặc bằng đến ngày' };

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
};
export default routes;
