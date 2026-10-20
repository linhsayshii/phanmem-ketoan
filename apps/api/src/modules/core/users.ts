import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, SENSITIVE_FLAGS } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { hashPassword } from '../auth/service.js';

const userBody = z.object({
  username: z.string().min(3).max(50).regex(/^[a-z0-9_.]+$/),
  fullName: z.string().min(1), password: z.string().min(8),
  roleCode: z.string().min(1), sensitiveFlags: z.array(z.enum(SENSITIVE_FLAGS)).default([]),
});

const SELF_MSG = 'Không tự đổi vai trò, cờ dữ liệu nhạy cảm hay trạng thái của chính mình';

// người thao tác phải có mọi cờ mà giá trị thay đổi (gán hoặc gỡ)
function assertHoldsFlags(held: Set<string>, changed: string[]) {
  if (changed.some((f) => !held.has(f))) throw new AppError('SENSITIVE_FLAG_NOT_HELD', 'Không gán hay gỡ được cờ dữ liệu nhạy cảm mà chính bạn không có', 403);
}

type Trx = Parameters<Parameters<FastifyInstance['withTenant']>[1]>[0];

// quyền của vai trò vượt quá quyền người thao tác? vai trò `admin` tính là mọi quyền
async function roleExceeds(trx: Trx, held: Set<string>, role: { id: string; code: string }) {
  if (role.code === 'admin') return PERMISSIONS.some((p) => !held.has(p.code));
  const perms = await trx.selectFrom('role_permission').select('permission_code').where('role_id', '=', role.id).execute();
  return perms.some((p) => !held.has(p.permission_code));
}

// khóa các quản trị viên đang hoạt động của công ty (chống hai thao tác hạ quyền đồng thời cùng qua), rồi từ chối nếu `userId` là người cuối cùng
async function assertNotLastAdmin(trx: Trx, tenantId: string, userId: string) {
  const admins = await trx.selectFrom('tenant_user').innerJoin('role', 'role.id', 'tenant_user.role_id')
    .select('tenant_user.user_id').where('tenant_user.tenant_id', '=', tenantId).where('role.code', '=', 'admin').where('tenant_user.is_active', '=', true)
    .forUpdate().execute();
  if (admins.some((a) => a.user_id === userId) && !admins.some((a) => a.user_id !== userId))
    throw new AppError('LAST_ADMIN', 'Công ty phải còn ít nhất một quản trị viên đang hoạt động', 409);
}

// không sửa người có quyền hơn mình
async function assertTargetNotAbove(trx: Trx, held: Set<string>, userId: string) {
  const r = await trx.selectFrom('tenant_user').innerJoin('role', 'role.id', 'tenant_user.role_id').select(['role.id', 'role.code']).where('tenant_user.user_id', '=', userId).executeTakeFirstOrThrow();
  if (await roleExceeds(trx, held, r)) throw new AppError('TARGET_EXCEEDS_ACTOR', 'Không sửa được tài khoản có quyền vượt quá quyền của bạn', 403);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/users', { preHandler: app.requirePermission('user.view') }, async (req) =>
    app.withTenant(req, (trx) => trx.selectFrom('tenant_user').innerJoin('app_user', 'app_user.id', 'tenant_user.user_id')
      .innerJoin('role', 'role.id', 'tenant_user.role_id')
      .select(['app_user.id', 'app_user.username', 'app_user.full_name as fullName', 'role.code as roleCode', 'tenant_user.sensitive_flags as sensitiveFlags', 'tenant_user.is_active as isActive'])
      .orderBy('app_user.username').execute()));

  app.post('/api/users', { preHandler: app.requirePermission('user.create'), schema: { body: userBody } }, async (req, reply) => {
    const b = req.body; const tenantId = req.auth!.tenantId!;
    assertHoldsFlags(req.auth!.sensitive, b.sensitiveFlags);
    const passwordHash = await hashPassword(b.password);
    const id = await app.withTenant(req, async (trx) => {
      const role = await trx.selectFrom('role').select('id').where('code', '=', b.roleCode).executeTakeFirst();
      if (!role) throw new AppError('ROLE_NOT_FOUND', `Không có vai trò ${b.roleCode}`, 404);
      if (await roleExceeds(trx, req.auth!.permissions, { id: role.id, code: b.roleCode })) throw new AppError('ROLE_EXCEEDS_ACTOR', 'Không gán được vai trò có quyền vượt quá quyền của bạn', 403);
      // không bao giờ gắn tài khoản sẵn có (toàn cục) vào công ty này: nếu không, admin công ty khác đặt lại được mật khẩu của nó
      const existing = await trx.selectFrom('app_user').select('id').where('username', '=', b.username).executeTakeFirst();
      if (existing) throw new AppError('USERNAME_TAKEN', 'Tên đăng nhập đã tồn tại', 409);
      const userId = (await trx.insertInto('app_user').values({ username: b.username, full_name: b.fullName, password_hash: passwordHash }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('tenant_user').values({ tenant_id: tenantId, user_id: userId, role_id: role.id, sensitive_flags: JSON.stringify(b.sensitiveFlags) }).execute();
      return userId;
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/users/:id', { preHandler: app.requirePermission('user.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: userBody.partial().omit({ username: true }) } }, async (req) => {
    const b = req.body; const tenantId = req.auth!.tenantId!; const id = req.params.id;
    const self = id === req.auth!.userId;
    if (self && (b.roleCode || b.sensitiveFlags)) throw new AppError('SELF_PRIVILEGE_CHANGE', SELF_MSG, 409);
    await app.withTenant(req, async (trx) => {
      // app_user không có RLS: phải xác nhận người dùng thuộc công ty hiện tại (RLS của tenant_user đã giới hạn theo công ty)
      const member = await trx.selectFrom('tenant_user').select(['user_id', 'sensitive_flags']).where('user_id', '=', id).executeTakeFirst();
      if (!member) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng trong công ty', 404);
      if (!self) await assertTargetNotAbove(trx, req.auth!.permissions, id);
      if (b.sensitiveFlags) {
        const old = member.sensitive_flags as string[];
        assertHoldsFlags(req.auth!.sensitive, [...b.sensitiveFlags.filter((f) => !old.includes(f)), ...old.filter((f) => !b.sensitiveFlags!.includes(f as never))]);
      }
      if ((b.password || b.fullName) && !self) {
        const n = (await sql<{ n: number }>`SELECT user_tenant_count(${id}::uuid) AS n`.execute(trx)).rows[0]!.n;
        if (n > 1) throw new AppError('USER_SHARED', 'Người dùng này thuộc nhiều công ty; chỉ chính họ đổi được mật khẩu và họ tên', 409);
      }
      if (b.roleCode) {
        const role = await trx.selectFrom('role').select('id').where('code', '=', b.roleCode).executeTakeFirst();
        if (!role) throw new AppError('ROLE_NOT_FOUND', 'Không tìm thấy vai trò', 404);
        if (await roleExceeds(trx, req.auth!.permissions, { id: role.id, code: b.roleCode })) throw new AppError('ROLE_EXCEEDS_ACTOR', 'Không gán được vai trò có quyền vượt quá quyền của bạn', 403);
        if (b.roleCode !== 'admin') await assertNotLastAdmin(trx, tenantId, id);
        await trx.updateTable('tenant_user').set({ role_id: role.id }).where('tenant_id', '=', tenantId).where('user_id', '=', req.params.id).execute();
      }
      if (b.sensitiveFlags) await trx.updateTable('tenant_user').set({ sensitive_flags: JSON.stringify(b.sensitiveFlags) }).where('tenant_id', '=', tenantId).where('user_id', '=', req.params.id).execute();
      if (b.fullName) {
        await trx.updateTable('app_user').set({ full_name: b.fullName }).where('id', '=', id).execute();
        await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id) VALUES (${tenantId}::uuid, app_user_id(), 'update_full_name', 'app_user', ${id})`.execute(trx);
      }
      if (b.password) {
        await trx.updateTable('app_user').set({ password_hash: await hashPassword(b.password) }).where('id', '=', req.params.id).execute();
        await trx.deleteFrom('user_session').where('user_id', '=', req.params.id).execute();
        await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id) VALUES (${tenantId}::uuid, app_user_id(), 'reset_password', 'app_user', ${req.params.id})`.execute(trx);
      }
    });
    return { ok: true };
  });

  app.put('/api/users/:id/active', { preHandler: app.requirePermission('user.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ isActive: z.boolean() }) } }, async (req) => {
    if (req.params.id === req.auth!.userId) throw new AppError('SELF_PRIVILEGE_CHANGE', SELF_MSG, 409);
    await app.withTenant(req, async (trx) => {
      const member = await trx.selectFrom('tenant_user').select('user_id').where('user_id', '=', req.params.id).executeTakeFirst();
      if (!member) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng trong công ty', 404);
      await assertTargetNotAbove(trx, req.auth!.permissions, req.params.id);
      if (!req.body.isActive) await assertNotLastAdmin(trx, req.auth!.tenantId!, req.params.id);
      await trx.updateTable('tenant_user').set({ is_active: req.body.isActive }).where('tenant_id', '=', req.auth!.tenantId!).where('user_id', '=', req.params.id).execute();
    });
    return { ok: true };
  });
};
export default routes;
