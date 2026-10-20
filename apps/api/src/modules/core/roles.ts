import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';
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
      const role = await trx.selectFrom('role').select('code').where('id', '=', req.params.id).executeTakeFirst();
      if (!role) throw new AppError('ROLE_NOT_FOUND', 'Không tìm thấy vai trò', 404);
      if (role.code === 'admin') throw new AppError('SYSTEM_ROLE_LOCKED', 'Vai trò quản trị viên luôn có mọi quyền, không sửa được', 409);
      const old = (await trx.selectFrom('role_permission').select('permission_code').where('role_id', '=', req.params.id).execute()).map((r) => r.permission_code);
      const missing = req.body.permissions.filter((p) => !old.includes(p) && !req.auth!.permissions.has(p));
      if (missing.length) throw new AppError('PERMISSION_NOT_HELD', `Không cấp được quyền bạn không có: ${missing.join(', ')}`, 403);
      await trx.deleteFrom('role_permission').where('role_id', '=', req.params.id).execute();
      if (req.body.permissions.length)
        await trx.insertInto('role_permission').values(req.body.permissions.map((p) => ({ tenant_id: tenantId, role_id: req.params.id, permission_code: p }))).execute();
    });
    return { ok: true };
  });
};
export default routes;
