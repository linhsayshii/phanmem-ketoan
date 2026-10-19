import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import { QUEUES, type Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

const companyBody = z.object({
  name: z.string().min(1), taxCode: z.string().regex(/^\d{10}(-\d{3})?$/).nullable().optional(),
  address: z.string().nullable().optional(), legalRep: z.string().nullable().optional(),
  chiefAccountant: z.string().nullable().optional(), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional(),
});

async function loadCompany(trx: Transaction<Database>, id: string) {
  const t = await trx.selectFrom('tenant').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return { id: t.id, code: t.code, name: t.name, taxCode: t.tax_code, address: t.address, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, phone: t.phone, email: t.email };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/tenants', { schema: { body: companyBody.extend({ code: z.string().min(1).max(20).regex(/^[A-Z0-9_]+$/) }) } }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const b = req.body;
    // một giao dịch: lỗi ở bước nào cũng không để lại công ty dở dang hay phiên đã chuyển
    const id = await app.db.transaction().execute(async (trx) => {
      const r = await sql<{ id: string }>`SELECT create_tenant(${b.code}, ${b.name}, ${b.taxCode ?? null}, ${auth.userId}::uuid) AS id`.execute(trx);
      const tenantId = r.rows[0]!.id;
      await trx.updateTable('user_session').set({ tenant_id: tenantId }).where('id', '=', auth.sessionId).execute();
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${auth.userId}, true)`.execute(trx);
      await trx.updateTable('tenant').set({ address: b.address ?? null, legal_rep: b.legalRep ?? null, chief_accountant: b.chiefAccountant ?? null, phone: b.phone ?? null, email: b.email ?? null }).where('id', '=', tenantId).execute();
      return tenantId;
    });
    return reply.status(201).send({ id });
  });

  app.get('/api/company', { preHandler: app.requireAuth }, async (req) => app.withTenant(req, (trx) => loadCompany(trx, req.auth!.tenantId!)));

  app.put('/api/company', { preHandler: app.requirePermission('company.update'), schema: { body: companyBody.partial() } }, async (req) => {
    const b = req.body;
    const set = {
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.taxCode !== undefined ? { tax_code: b.taxCode } : {}),
      ...(b.address !== undefined ? { address: b.address } : {}), ...(b.legalRep !== undefined ? { legal_rep: b.legalRep } : {}),
      ...(b.chiefAccountant !== undefined ? { chief_accountant: b.chiefAccountant } : {}), ...(b.phone !== undefined ? { phone: b.phone } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
    };
    return app.withTenant(req, async (trx) => {
      if (Object.keys(set).length === 0) return loadCompany(trx, req.auth!.tenantId!); // .set({}) không phải SQL hợp lệ
      await trx.updateTable('tenant').set(set).where('id', '=', req.auth!.tenantId!).execute();
      return { ok: true };
    });
  });

  app.post('/api/backup/run', { preHandler: app.requirePermission('backup.run') }, async (req) => {
    if (!app.boss) throw new AppError('NO_QUEUE', 'Hàng đợi chưa sẵn sàng', 503);
    await app.boss.createQueue(QUEUES.backup);
    const jobId = await app.boss.send(QUEUES.backup, { requestedBy: req.auth!.userId }, { singletonKey: 'manual', singletonSeconds: 60, retryLimit: 3, retryDelay: 60 });
    if (!jobId) throw new AppError('BACKUP_ALREADY_QUEUED', 'Đã có yêu cầu sao lưu đang chờ, thử lại sau 60 giây', 409); // singleton chặn bấm trùng
    return { jobId };
  });
  app.get('/api/backup', { preHandler: app.requirePermission('backup.run') }, async () => {
    let files: string[] = [];
    try { files = readdirSync(app.config.BACKUP_DIR); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // chưa có thư mục = chưa có bản sao lưu; lỗi khác (quyền, mount hỏng) phải lộ ra
    return files.filter((f) => f.endsWith('.dump')).sort().reverse().map((f) => { const s = statSync(path.join(app.config.BACKUP_DIR, f)); return { name: f, bytes: s.size, mtime: s.mtime.toISOString() }; });
  });
};
export default routes;
