import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import * as S from './vouchers.service.js';
import { notifyRecompute } from './notifyRecompute.js';
import { AppError } from '../../plugins/errors.js';
import { formNoFor } from '../reporting/print/forms.js';
import { renderPdf } from '../reporting/print/pdf.js';
import { renderVoucherHtml } from '../reporting/print/voucherHtml.js';

const idParam = z.object({ id: z.string().uuid() });
// Sửa chứng từ đã ghi sổ: phải có diễn giải hoặc ít nhất một dòng cần sửa (thân {} hay chỉ { version } không đổi gì).
const metaBody = S.metaInput.extend({ version: z.number().int() }).refine((b) => b.description !== undefined || !!b.lines?.length, 'Không có nội dung cần sửa');

const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: FastifyRequest) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });
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

  app.get('/api/vouchers/:id/print', { preHandler: app.requirePermission('voucher.print'), schema: { params: idParam, querystring: z.object({ format: z.enum(['html', 'pdf']).default('html') }) } }, async (req, reply) => {
    const { v, c } = await app.withTenant(req, async (trx) => {
      const v = await S.getVoucher(trx, req.params.id);
      const t = await trx.selectFrom('tenant').selectAll().where('id', '=', req.auth!.tenantId!).executeTakeFirstOrThrow();
      // chế độ kế toán gắn với năm tài chính của chứng từ (một công ty có thể giữ nhiều chế độ)
      const { regime } = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', v.id).executeTakeFirstOrThrow();
      const f = formNoFor(regime, 'PKT');
      return { v, c: { name: t.name, address: t.address, taxCode: t.tax_code, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, formNo: f.formNo, issuedBy: f.issuedBy } };
    }, READ_SNAPSHOT);
    const html = renderVoucherHtml(v, c);
    if (req.query.format === 'html') return reply.type('text/html; charset=utf-8').send(html);
    // số chứng từ lấy từ tiền tố/hậu tố người dùng cấu hình nên phải mã hóa (RFC 5987), không đưa thẳng vào tiêu đề
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${v.voucherNo ?? 'phieu-ke-toan'}.pdf`)}`).send(await renderPdf(html));
  });

  app.post('/api/vouchers', { preHandler: app.requirePermission('voucher.create'), schema: { body: S.voucherInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !req.auth!.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const { autoPost, ...input } = req.body;
    // Gửi lại cùng idempotencyKey trả đúng chứng từ cũ, không ghi sổ lại: chỉ ghi sổ chứng từ vừa tạo (nháp, version 1).
    // Chứng từ đã ghi sổ rồi bỏ ghi sổ có version >= 3 nên không bị ghi sổ lại bởi một yêu cầu gửi lại.
    const dto = await withOverride(req, async (trx) => {
      const v = await S.createVoucher(trx, ctx(req), input);
      return autoPost && v.state === 'draft' && v.version === 1 ? S.postVoucher(trx, v.id) : v;
    });
    if (dto.state === 'posted') notifyRecompute(app, req.auth!.tenantId!);
    return reply.status(201).send(dto);
  });

  app.put('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: z.union([S.voucherInput.extend({ version: z.number().int() }), metaBody]) } }, async (req) => {
    const { version, ...input } = req.body;
    return withOverride(req, (trx) => 'voucherType' in input ? S.updateDraft(trx, req.params.id, version, input) : S.updatePostedMeta(trx, req.params.id, version, input));
  });

  app.post('/api/vouchers/:id/post', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam } }, async (req) => {
    const dto = await withOverride(req, (trx) => S.postVoucher(trx, req.params.id)); notifyRecompute(app, req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/unpost', { preHandler: app.requirePermission('voucher.unpost'), schema: { params: idParam } }, async (req) => {
    if (!req.auth!.permissions.has('voucher.edit_posted')) throw new AppError('FORBIDDEN', 'Thiếu quyền sửa sau ghi sổ', 403);
    const dto = await app.withTenant(req, (trx) => S.unpostVoucher(trx, req.params.id)); notifyRecompute(app, req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/reverse', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam, body: z.object({ postingDate: S.dateIso, description: z.string().optional() }) } }, async (req, reply) => {
    const dto = await withOverride(req, (trx) => S.reverseVoucher(trx, req.params.id, req.body)); notifyRecompute(app, req.auth!.tenantId!); return reply.status(201).send(dto); });
  app.post('/api/vouchers/:id/discard', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => S.discardVoucher(trx, req.params.id)));
  app.post('/api/vouchers/:id/duplicate', { preHandler: app.requirePermission('voucher.create'), schema: { params: idParam, body: z.object({ postingDate: S.dateIso }) } }, async (req, reply) =>
    reply.status(201).send(await withOverride(req, (trx) => S.duplicateVoucher(trx, ctx(req), req.params.id, req.body.postingDate))));
  app.delete('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req, reply) => { await app.withTenant(req, (trx) => S.deleteDraft(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
