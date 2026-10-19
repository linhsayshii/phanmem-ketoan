import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { AppError } from '../../plugins/errors.js';

const companyBody = z.object({
  name: z.string().min(1), taxCode: z.string().regex(/^\d{10}(-\d{3})?$/).nullable().optional(),
  address: z.string().nullable().optional(), legalRep: z.string().nullable().optional(),
  chiefAccountant: z.string().nullable().optional(), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional(),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/tenants', { schema: { body: companyBody.extend({ code: z.string().min(1).max(20).regex(/^[A-Z0-9_]+$/) }) } }, async (req, reply) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const b = req.body;
    const r = await sql<{ id: string }>`SELECT create_tenant(${b.code}, ${b.name}, ${b.taxCode ?? null}, ${req.auth.userId}::uuid) AS id`.execute(app.db);
    const id = r.rows[0]!.id;
    await app.db.updateTable('user_session').set({ tenant_id: id }).where('id', '=', req.auth.sessionId).execute();
    await app.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${id}, true), set_config('app.current_user', ${req.auth!.userId}, true)`.execute(trx);
      await trx.updateTable('tenant').set({ address: b.address ?? null, legal_rep: b.legalRep ?? null, chief_accountant: b.chiefAccountant ?? null, phone: b.phone ?? null, email: b.email ?? null }).where('id', '=', id).execute();
    });
    return reply.status(201).send({ id });
  });

  app.get('/api/company', { preHandler: app.requireAuth }, async (req) =>
    app.withTenant(req, async (trx) => {
      const t = await trx.selectFrom('tenant').selectAll().where('id', '=', req.auth!.tenantId!).executeTakeFirstOrThrow();
      return { id: t.id, code: t.code, name: t.name, taxCode: t.tax_code, address: t.address, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, phone: t.phone, email: t.email };
    }));

  app.put('/api/company', { preHandler: app.requirePermission('company.update'), schema: { body: companyBody.partial() } }, async (req) => {
    const b = req.body;
    await app.withTenant(req, (trx) => trx.updateTable('tenant').set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.taxCode !== undefined ? { tax_code: b.taxCode } : {}),
      ...(b.address !== undefined ? { address: b.address } : {}), ...(b.legalRep !== undefined ? { legal_rep: b.legalRep } : {}),
      ...(b.chiefAccountant !== undefined ? { chief_accountant: b.chiefAccountant } : {}), ...(b.phone !== undefined ? { phone: b.phone } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
    }).where('id', '=', req.auth!.tenantId!).execute());
    return { ok: true };
  });
};
export default routes;
