import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { postWithCashCheck } from '../cash/books.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { createInvoice, getInvoice, invoiceInput, listTaxDefs, updateInvoice } from './service.js';

const idParam = z.object({ id: z.string().uuid() });

// Hóa đơn mua/bán dịch vụ, giảm giá, trả lại: dựng bút toán từ dòng hàng và mã thuế, ghi bảng kê hóa đơn kê khai thuế. Ghi sổ, bỏ ghi sổ, đảo, hủy dùng route /api/vouchers/:id/*.
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/invoices', { preHandler: app.requirePermission('voucher.create'), schema: { body: invoiceInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !req.auth!.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const { autoPost, ...input } = req.body;
    const tenantId = req.auth!.tenantId!;
    // Như POST /api/vouchers: gửi lại cùng idempotencyKey trả hóa đơn cũ, chỉ ghi sổ hóa đơn vừa tạo (nháp, version 1).
    const dto = await app.withOverride(req, async (trx) => {
      const inv = await createInvoice(trx, { tenantId, userId: req.auth!.userId }, input);
      return autoPost && inv.state === 'draft' && inv.version === 1 ? { ...inv, ...(await postWithCashCheck(trx, tenantId, inv.id)) } : inv;
    });
    if (dto.state === 'posted') notifyRecompute(app, tenantId);
    return reply.status(201).send(dto);
  });
  app.put('/api/invoices/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: invoiceInput.extend({ version: z.number().int() }) } }, async (req) => {
    const { version, ...input } = req.body;
    return app.withOverride(req, (trx) => updateInvoice(trx, { tenantId: req.auth!.tenantId! }, req.params.id, version, input));
  });
  // Danh mục mã thuế và phân bổ để trình duyệt xem trước thuế, bút toán bằng động cơ thuế; đứng trước :id (tuyến tĩnh thắng tuyến tham số).
  app.get('/api/invoices/tax-defs', { preHandler: app.requirePermission('voucher.view') }, async (req) => app.withTenant(req, (trx) => listTaxDefs(trx), READ_SNAPSHOT));
  app.get('/api/invoices/:id', { preHandler: app.requirePermission('voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => getInvoice(trx, req.params.id)));
};
export default routes;
