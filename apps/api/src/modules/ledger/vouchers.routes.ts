import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import { QUEUES, type Database } from '@kt/db';
import * as S from './vouchers.service.js';
import { AppError } from '../../plugins/errors.js';

const idParam = z.object({ id: z.string().uuid() });

const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: FastifyRequest) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });
  // Báo worker tính lại số dư sau khi giao dịch đã commit. Hàng đợi tạo một lần (như tenants.ts); lỗi chỉ ghi log, không làm hỏng thao tác đã commit.
  let queueReady: Promise<void> | undefined;
  const notify = (tenantId: string) => {
    const boss = app.boss;
    if (!boss) return;
    queueReady ??= boss.createQueue(QUEUES.recomputeBalances);
    queueReady.then(() => boss.send(QUEUES.recomputeBalances, { tenantId }, { singletonKey: tenantId, singletonSeconds: 5 })).catch((e) => { queueReady = undefined; app.log.error(e); });
  };
  // Ghi vào kỳ khóa mềm chỉ khi có quyền; biến phiên được đặt trong transaction.
  const withOverride = <T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>) => app.withTenant(req, async (trx) => {
    if (req.auth!.permissions.has('voucher.backdate_locked')) await sql`SELECT set_config('app.override_soft_lock', 'on', true)`.execute(trx);
    return fn(trx);
  });

  app.get('/api/voucher-types', { preHandler: app.requireAuth }, async (req) => app.withTenant(req, (trx) => trx.selectFrom('voucher_type').selectAll().where('is_active', '=', true).orderBy('code').execute()));

  app.get('/api/vouchers', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ type: z.string().optional(), from: S.dateIso.optional(), to: S.dateIso.optional(),
      state: z.enum(['draft', 'posted', 'reversed', 'cancelled']).optional(), q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => S.listVouchers(trx, req.query)));
  app.get('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => S.getVoucher(trx, req.params.id)));

  app.post('/api/vouchers', { preHandler: app.requirePermission('voucher.create'), schema: { body: S.voucherInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !req.auth!.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const { autoPost, ...input } = req.body;
    // Gửi lại cùng idempotencyKey trả đúng chứng từ cũ, không ghi sổ lại: chỉ ghi sổ chứng từ vừa tạo (nháp, version 1).
    // Chứng từ đã ghi sổ rồi bỏ ghi sổ có version >= 3 nên không bị ghi sổ lại bởi một yêu cầu gửi lại.
    const dto = await withOverride(req, async (trx) => {
      const v = await S.createVoucher(trx, ctx(req), input);
      return autoPost && v.state === 'draft' && v.version === 1 ? S.postVoucher(trx, v.id) : v;
    });
    if (dto.state === 'posted') notify(req.auth!.tenantId!);
    return reply.status(201).send(dto);
  });

  app.put('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: z.union([S.voucherInput.extend({ version: z.number().int() }), S.metaInput.extend({ version: z.number().int() })]) } }, async (req) => {
    const { version, ...input } = req.body;
    return withOverride(req, (trx) => 'voucherType' in input ? S.updateDraft(trx, req.params.id, version, input) : S.updatePostedMeta(trx, req.params.id, version, input));
  });

  app.post('/api/vouchers/:id/post', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam } }, async (req) => {
    const dto = await withOverride(req, (trx) => S.postVoucher(trx, req.params.id)); notify(req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/unpost', { preHandler: app.requirePermission('voucher.unpost'), schema: { params: idParam } }, async (req) => {
    if (!req.auth!.permissions.has('voucher.edit_posted')) throw new AppError('FORBIDDEN', 'Thiếu quyền sửa sau ghi sổ', 403);
    const dto = await app.withTenant(req, (trx) => S.unpostVoucher(trx, req.params.id)); notify(req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/reverse', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam, body: z.object({ postingDate: S.dateIso, description: z.string().optional() }) } }, async (req, reply) => {
    const dto = await withOverride(req, (trx) => S.reverseVoucher(trx, req.params.id, req.body)); notify(req.auth!.tenantId!); return reply.status(201).send(dto); });
  app.post('/api/vouchers/:id/discard', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => S.discardVoucher(trx, req.params.id)));
  app.post('/api/vouchers/:id/duplicate', { preHandler: app.requirePermission('voucher.create'), schema: { params: idParam, body: z.object({ postingDate: S.dateIso }) } }, async (req, reply) =>
    reply.status(201).send(await withOverride(req, (trx) => S.duplicateVoucher(trx, ctx(req), req.params.id, req.body.postingDate))));
  app.delete('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req, reply) => { await app.withTenant(req, (trx) => S.deleteDraft(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
