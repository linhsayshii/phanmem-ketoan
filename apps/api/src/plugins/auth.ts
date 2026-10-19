import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant } from '@kt/db';
import { AppError } from './errors.js';

export interface AuthCtx {
  sessionId: string; userId: string; username: string; tenantId: string | null;
  permissions: Set<string>; sensitive: Set<string>;
}
declare module 'fastify' {
  interface FastifyRequest { auth: AuthCtx | null }
  interface FastifyInstance {
    requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void>;
    requirePermission(code: string): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    const sid = req.cookies['sid'];
    if (!sid) return;
    const unsigned = req.unsignCookie(sid);
    if (!unsigned.valid || !unsigned.value) return;
    const s = await app.db.selectFrom('user_session').innerJoin('app_user', 'app_user.id', 'user_session.user_id')
      .select(['user_session.id', 'user_session.user_id', 'user_session.tenant_id', 'user_session.expires_at', 'app_user.username', 'app_user.is_active'])
      .where('user_session.id', '=', unsigned.value).executeTakeFirst();
    if (!s || !s.is_active || new Date(s.expires_at) < new Date()) return;
    const ctx: AuthCtx = { sessionId: s.id, userId: s.user_id, username: s.username, tenantId: s.tenant_id, permissions: new Set(), sensitive: new Set() };
    if (s.tenant_id) {
      const tenantId = s.tenant_id;
      await withTenant(app.db, { tenantId, userId: s.user_id }, async (trx) => {
        const tu = await trx.selectFrom('tenant_user').select(['role_id', 'sensitive_flags', 'is_active'])
          .where('tenant_id', '=', tenantId).where('user_id', '=', s.user_id).executeTakeFirst();
        if (!tu || !tu.is_active) { ctx.tenantId = null; return; }
        const perms = await trx.selectFrom('role_permission').select('permission_code').where('role_id', '=', tu.role_id).execute();
        ctx.permissions = new Set(perms.map((p) => p.permission_code));
        ctx.sensitive = new Set(tu.sensitive_flags as string[]);
      });
    }
    req.auth = ctx;
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    if (!req.auth.tenantId) throw new AppError('NO_TENANT', 'Chưa chọn công ty', 409);
  });
  app.decorate('requirePermission', (code: string) => async (req: FastifyRequest) => {
    await app.requireAuth(req, undefined as unknown as FastifyReply);
    if (!req.auth!.permissions.has(code)) throw new AppError('FORBIDDEN', `Thiếu quyền ${code}`, 403);
  });
});
