import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';
import { listTenantsOf, login, logout, selectTenant } from './service.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  const cfg = app.config;
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: cfg.COOKIE_SECURE === 'true', signed: true, maxAge: cfg.SESSION_TTL_HOURS * 3600 };

  app.post('/api/auth/login', { schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1) }) } }, async (req, reply) => {
    const r = await login(app.db, { ...req.body, ip: req.ip, ttlHours: cfg.SESSION_TTL_HOURS,
      limits: { maxFailsUser: cfg.LOGIN_MAX_FAILS_USER, maxFailsIp: cfg.LOGIN_MAX_FAILS_IP, lockMinutes: cfg.LOGIN_LOCK_MINUTES } });
    if (r === 'throttled') {
      req.log.warn({ username: req.body.username, ip: req.ip }, 'đăng nhập bị chặn tạm');
      throw new AppError('LOGIN_THROTTLED', `Đăng nhập sai quá nhiều lần, thử lại sau ${cfg.LOGIN_LOCK_MINUTES} phút`, 429);
    }
    if (!r) throw new AppError('BAD_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu', 401);
    reply.setCookie('sid', r.sessionToken, cookieOpts);
    return { userId: r.userId, tenantId: r.tenantId, tenants: r.tenants };
  });

  app.post('/api/auth/select-tenant', { schema: { body: z.object({ tenantId: z.string().uuid() }) } }, async (req) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const ok = await selectTenant(app.db, req.auth.sessionId, req.auth.userId, req.body.tenantId);
    if (!ok) throw new AppError('FORBIDDEN', 'Không thuộc công ty này', 403);
    return { tenantId: req.body.tenantId };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) await logout(app.db, req.auth.sessionId);
    reply.clearCookie('sid', { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const tenants = await listTenantsOf(app.db, req.auth.userId);
    return { userId: req.auth.userId, username: req.auth.username, tenantId: req.auth.tenantId, tenants,
      permissions: [...req.auth.permissions], sensitive: [...req.auth.sensitive] };
  });
};
export default routes;
