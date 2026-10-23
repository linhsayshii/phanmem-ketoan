import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { dateIso } from '../ledger/vouchers.service.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { deleteLoan, disburse, disburseInput, getLoan, listLoans, lookupContracts, loanInput, repay, repayInput, saveLoan, settleLoan } from './loans.js';

const numId = z.object({ id: z.coerce.number().int().positive() });

// Khế ước vay: hợp đồng, lãi suất theo hiệu lực, lịch trả gốc; giải ngân, trả nợ, tất toán. Tính lãi vay ở Task 10.
const routes: FastifyPluginAsyncZod = async (app) => {
  const tid = (req: { auth: { tenantId: string | null } | null }) => req.auth!.tenantId!;
  const ctx = (req: { auth: { tenantId: string | null; userId: string } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });
  app.get('/api/loans', { preHandler: app.requirePermission('loan.view'), schema: { querystring: z.object({ at: dateIso.optional() }) } }, async (req) => app.withTenant(req, (trx) => listLoans(trx, req.query.at), READ_SNAPSHOT));
  app.get('/api/loans/:id', { preHandler: app.requirePermission('loan.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getLoan(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/loans', { preHandler: app.requirePermission('loan.create'), schema: { body: loanInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveLoan(trx, tid(req), null, req.body))));
  app.put('/api/loans/:id', { preHandler: app.requirePermission('loan.update'), schema: { params: numId, body: loanInput } }, async (req) => app.withTenant(req, (trx) => saveLoan(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/loans/:id', { preHandler: app.requirePermission('loan.delete'), schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteLoan(trx, tid(req), req.params.id)); return reply.status(204).send(); });

  // Giải ngân, trả nợ là chứng từ thường (BC/BN/PKT) đã ghi sổ: sửa bằng đường chung (bỏ ghi sổ, đảo).
  app.post('/api/loans/:id/disburse', { preHandler: [app.requirePermission('loan.update'), app.requirePermission('voucher.create')], schema: { params: numId, body: disburseInput } }, async (req, reply) => {
    const out = await app.withOverride(req, (trx) => disburse(trx, ctx(req), req.params.id, req.body)); notifyRecompute(app, tid(req)); return reply.status(201).send(out);
  });
  app.post('/api/loans/:id/repay', { preHandler: [app.requirePermission('loan.update'), app.requirePermission('voucher.create')], schema: { params: numId, body: repayInput } }, async (req, reply) => {
    const out = await app.withOverride(req, (trx) => repay(trx, ctx(req), req.params.id, req.body)); notifyRecompute(app, tid(req)); return reply.status(201).send(out);
  });
  app.post('/api/loans/:id/settle', { preHandler: app.requirePermission('loan.update'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => settleLoan(trx, tid(req), req.params.id)));

  // Tra cứu F4 cột Khế ước của dòng chứng từ.
  app.get('/api/lookups/contracts', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ q: z.string().default(''), kind: z.enum(['sale', 'purchase', 'loan']).optional(), size: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => lookupContracts(trx, req.query.q, req.query.kind, req.query.size), READ_SNAPSHOT));
};
export default routes;
