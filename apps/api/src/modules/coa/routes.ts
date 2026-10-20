import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';
import { addSubAccount, generateAccounts, listAccounts, mergeAccounts, renameAccount } from './service.js';

const regime = z.enum(['TT99', 'TT133', 'TT200', 'TT58']);
const code = z.string().regex(/^\d{1,8}$/);

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/accounts', { preHandler: app.requirePermission('account.view'), schema: { querystring: z.object({ regime }) } },
    async (req) => app.withTenant(req, (trx) => listAccounts(trx, req.query.regime)));
  app.post('/api/accounts/generate', { preHandler: app.requirePermission('account.create'), schema: { body: z.object({ regime }) } },
    async (req, reply) => reply.status(201).send({ count: await app.withTenant(req, (trx) => generateAccounts(trx, req.auth!.tenantId!, req.body.regime)) }));
  app.post('/api/accounts', { preHandler: app.requirePermission('account.create'), schema: { body: z.object({
      regime, parentCode: code, code, name: z.string().min(1), nameEn: z.string().optional(),
      normalBalance: z.enum(['debit', 'credit', 'both']).optional(), trackCurrency: z.boolean().optional(),
      subledgerKind: z.enum(['receivable', 'payable', 'inventory', 'fixed_asset', 'bank', 'cash']).nullable().optional() }) } },
    async (req, reply) => reply.status(201).send({ id: await app.withTenant(req, (trx) => addSubAccount(trx, req.auth!.tenantId!, req.body)) }));
  app.put('/api/accounts/:id', { preHandler: app.requirePermission('account.update'), schema: { params: z.object({ id: z.string().regex(/^\d{1,15}$/).transform(Number) }), body: z.object({
      name: z.string().min(1).optional(), nameEn: z.string().nullable().optional(), isActive: z.boolean().optional(), trackCurrency: z.boolean().optional(),
      subledgerKind: z.enum(['receivable', 'payable', 'inventory', 'fixed_asset', 'bank', 'cash']).nullable().optional() }) } },
    async (req) => {
      const b = req.body;
      const set = {
        ...(b.name !== undefined ? { name: b.name } : {}), ...(b.nameEn !== undefined ? { name_en: b.nameEn } : {}), ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
        ...(b.trackCurrency !== undefined ? { track_currency: b.trackCurrency } : {}), ...(b.subledgerKind !== undefined ? { subledger_kind: b.subledgerKind } : {}) };
      await app.withTenant(req, async (trx) => {
        // Thân rỗng: Kysely sinh "SET" rỗng và Postgres báo lỗi 500, nên chỉ kiểm tra tài khoản có tồn tại.
        const q = Object.keys(set).length ? trx.updateTable('account').set(set).where('id', '=', req.params.id).returning('id') : trx.selectFrom('account').select('id').where('id', '=', req.params.id);
        if (!(await q.executeTakeFirst())) throw new AppError('ACCOUNT_NOT_FOUND', 'Không có tài khoản', 404);
      });
      return { ok: true };
    });
  app.post('/api/accounts/rename', { preHandler: app.requirePermission('account.update'), schema: { body: z.object({ regime, oldCode: code, newCode: code }) } },
    async (req) => { await app.withTenant(req, (trx) => renameAccount(trx, req.auth!.tenantId!, req.body)); return { ok: true }; });
  app.post('/api/accounts/merge', { preHandler: app.requirePermission('account.update'), schema: { body: z.object({ regime, sourceCode: code, targetCode: code }) } },
    async (req) => { await app.withTenant(req, (trx) => mergeAccounts(trx, req.auth!.tenantId!, req.body)); return { ok: true }; });
};
export default routes;
