import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { SENSITIVE_FLAGS } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { hashPassword } from '../auth/service.js';

const userBody = z.object({
  username: z.string().min(3).max(50).regex(/^[a-z0-9_.]+$/),
  fullName: z.string().min(1), password: z.string().min(8),
  roleCode: z.string().min(1), sensitiveFlags: z.array(z.enum(SENSITIVE_FLAGS)).default([]),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/users', { preHandler: app.requirePermission('user.view') }, async (req) =>
    app.withTenant(req, (trx) => trx.selectFrom('tenant_user').innerJoin('app_user', 'app_user.id', 'tenant_user.user_id')
      .innerJoin('role', 'role.id', 'tenant_user.role_id')
      .select(['app_user.id', 'app_user.username', 'app_user.full_name as fullName', 'role.code as roleCode', 'tenant_user.sensitive_flags as sensitiveFlags', 'tenant_user.is_active as isActive'])
      .orderBy('app_user.username').execute()));

  app.post('/api/users', { preHandler: app.requirePermission('user.create'), schema: { body: userBody } }, async (req, reply) => {
    const b = req.body; const tenantId = req.auth!.tenantId!;
    const passwordHash = await hashPassword(b.password);
    const id = await app.withTenant(req, async (trx) => {
      const role = await trx.selectFrom('role').select('id').where('code', '=', b.roleCode).executeTakeFirst();
      if (!role) throw new AppError('ROLE_NOT_FOUND', `Không có vai trò ${b.roleCode}`, 404);
      const existing = await trx.selectFrom('app_user').select('id').where('username', '=', b.username).executeTakeFirst();
      const userId = existing?.id ?? (await trx.insertInto('app_user').values({ username: b.username, full_name: b.fullName, password_hash: passwordHash }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('tenant_user').values({ tenant_id: tenantId, user_id: userId, role_id: role.id, sensitive_flags: JSON.stringify(b.sensitiveFlags) }).execute();
      return userId;
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/users/:id', { preHandler: app.requirePermission('user.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: userBody.partial().omit({ username: true }) } }, async (req) => {
    const b = req.body; const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      // app_user không có RLS: phải xác nhận người dùng thuộc công ty hiện tại (RLS của tenant_user đã giới hạn theo công ty)
      const member = await trx.selectFrom('tenant_user').select('user_id').where('user_id', '=', req.params.id).executeTakeFirst();
      if (!member) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng trong công ty', 404);
      if (b.roleCode) {
        const role = await trx.selectFrom('role').select('id').where('code', '=', b.roleCode).executeTakeFirstOrThrow();
        await trx.updateTable('tenant_user').set({ role_id: role.id }).where('tenant_id', '=', tenantId).where('user_id', '=', req.params.id).execute();
      }
      if (b.sensitiveFlags) await trx.updateTable('tenant_user').set({ sensitive_flags: JSON.stringify(b.sensitiveFlags) }).where('tenant_id', '=', tenantId).where('user_id', '=', req.params.id).execute();
      if (b.fullName) await trx.updateTable('app_user').set({ full_name: b.fullName }).where('id', '=', req.params.id).execute();
      if (b.password) {
        await trx.updateTable('app_user').set({ password_hash: await hashPassword(b.password) }).where('id', '=', req.params.id).execute();
        await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id) VALUES (${tenantId}::uuid, app_user_id(), 'reset_password', 'app_user', ${req.params.id})`.execute(trx);
      }
    });
    return { ok: true };
  });

  app.put('/api/users/:id/active', { preHandler: app.requirePermission('user.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ isActive: z.boolean() }) } }, async (req) => {
    await app.withTenant(req, (trx) => trx.updateTable('tenant_user').set({ is_active: req.body.isActive })
      .where('tenant_id', '=', req.auth!.tenantId!).where('user_id', '=', req.params.id).execute());
    return { ok: true };
  });
};
export default routes;
