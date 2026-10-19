import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '@kt/domain';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/permissions', { preHandler: app.requireAuth }, async () => PERMISSIONS);

  app.get('/api/roles', { preHandler: app.requirePermission('role.view') }, async (req) =>
    app.withTenant(req, async (trx) => {
      const roles = await trx.selectFrom('role').select(['id', 'code', 'name', 'is_system as isSystem']).orderBy('code').execute();
      const perms = await trx.selectFrom('role_permission').select(['role_id', 'permission_code']).execute();
      return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_code) }));
    }));

  app.put('/api/roles/:id/permissions', { preHandler: app.requirePermission('role.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ permissions: z.array(z.string()) }) } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      await trx.deleteFrom('role_permission').where('role_id', '=', req.params.id).execute();
      if (req.body.permissions.length)
        await trx.insertInto('role_permission').values(req.body.permissions.map((p) => ({ tenant_id: tenantId, role_id: req.params.id, permission_code: p }))).execute();
    });
    return { ok: true };
  });
};
export default routes;
