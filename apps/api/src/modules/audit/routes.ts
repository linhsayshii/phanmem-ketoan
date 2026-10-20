import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';

// Khoảng ngày tính theo giờ Việt Nam, không theo múi giờ của máy chủ DB: từ 00:00 ngày bắt đầu đến hết ngày kết thúc (cùng biểu thức với gói xuất cho cơ quan thẩm quyền).
const fromTs = (d: string) => sql<string>`(${d}::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
const beforeTs = (d: string) => sql<string>`((${d}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
const paging = { page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/audit', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({
      entity: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(), action: z.string().optional(),
      from: z.string().optional(), to: z.string().optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const q = req.query;
      let base = trx.selectFrom('audit_event as a').leftJoin('app_user as u', 'u.id', 'a.user_id');
      if (q.entity) base = base.where('a.entity', '=', q.entity);
      if (q.entityId) base = base.where('a.entity_id', '=', q.entityId);
      if (q.userId) base = base.where('a.user_id', '=', q.userId);
      if (q.action) base = base.where('a.action', '=', q.action);
      if (q.from) base = base.where('a.ts', '>=', fromTs(q.from));
      if (q.to) base = base.where('a.ts', '<', beforeTs(q.to));
      const total = Number((await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base.select(['a.id', 'a.ts', 'u.username', 'a.action', 'a.entity', 'a.entity_id as entityId', 'a.before', 'a.after', 'a.ip'])
        .orderBy('a.id', 'desc').limit(q.size).offset((q.page - 1) * q.size).execute();
      return { rows, total };
    }));

  app.get('/api/audit/logins', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({ from: z.string().optional(), to: z.string().optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const tenantId = req.auth!.tenantId!;
      let base = trx.selectFrom('login_event as l').where('l.username', 'in', trx.selectFrom('tenant_user').innerJoin('app_user', 'app_user.id', 'tenant_user.user_id').select('app_user.username').where('tenant_user.tenant_id', '=', tenantId));
      if (req.query.from) base = base.where('l.ts', '>=', fromTs(req.query.from));
      if (req.query.to) base = base.where('l.ts', '<', beforeTs(req.query.to));
      const total = Number((await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base.select(['l.ts', 'l.username', 'l.success', 'l.ip']).orderBy('l.id', 'desc').limit(req.query.size).offset((req.query.page - 1) * req.query.size).execute();
      return { rows, total };
    }));
};
export default routes;
