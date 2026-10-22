import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { postWithCashCheck } from '../cash/books.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { assertVoucherSensitive, requireStockPerm, withStockWarnings } from '../ledger/vouchers.routes.js';
import { createSchedule, deleteSchedule, getSchedule, listSchedules, runAmortization, runInput, scheduleInput, scheduleUpdate, updateSchedule } from './amortization.js';
import { createInvoice, getInvoice, invoiceInput, listTaxDefs, updateInvoice } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const numId = z.object({ id: z.coerce.number().int().positive() });

// Hóa đơn mua/bán dịch vụ, giảm giá, trả lại: dựng bút toán từ dòng hàng và mã thuế, ghi bảng kê hóa đơn kê khai thuế. Ghi sổ, bỏ ghi sổ, đảo, hủy dùng route /api/vouchers/:id/*.
// Ghi sổ ngay khi lập: hóa đơn mua hàng hóa, trả lại hàng mua có dòng hàng cần thêm quyền stock_voucher.post như route ghi sổ.
const postStocked = async (trx: Parameters<typeof requireStockPerm>[0], tenantId: string, id: string, auth: Parameters<typeof requireStockPerm>[1]) => { await requireStockPerm(trx, auth, id, 'stock_voucher.post'); return postWithCashCheck(trx, tenantId, id); };
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/invoices', { preHandler: app.requirePermission('voucher.create'), schema: { body: invoiceInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !req.auth!.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const { autoPost, ...input } = req.body;
    const tenantId = req.auth!.tenantId!;
    // Như POST /api/vouchers: gửi lại cùng idempotencyKey trả hóa đơn cũ, chỉ ghi sổ hóa đơn vừa tạo (nháp, version 1).
    const dto = await app.withOverride(req, async (trx) => {
      const inv = await createInvoice(trx, { tenantId, userId: req.auth!.userId, auth: req.auth! }, input);
      return autoPost && inv.state === 'draft' && inv.version === 1 ? withStockWarnings(trx, tenantId, { ...inv, ...(await postStocked(trx, tenantId, inv.id, req.auth!)) }, inv.id) : inv;
    });
    if (dto.state === 'posted') notifyRecompute(app, tenantId);
    return reply.status(201).send(dto);
  });
  app.put('/api/invoices/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: invoiceInput.extend({ version: z.number().int() }) } }, async (req) => {
    const { version, ...input } = req.body;
    return app.withOverride(req, (trx) => updateInvoice(trx, { tenantId: req.auth!.tenantId!, auth: req.auth! }, req.params.id, version, input));
  });
  // Danh mục mã thuế và phân bổ để trình duyệt xem trước thuế, bút toán bằng động cơ thuế; đứng trước :id (tuyến tĩnh thắng tuyến tham số).
  app.get('/api/invoices/tax-defs', { preHandler: app.requirePermission('voucher.view') }, async (req) => app.withTenant(req, (trx) => listTaxDefs(trx), READ_SNAPSHOT));
  app.get('/api/invoices/:id', { preHandler: app.requirePermission('voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, async (trx) => {
    const inv = await getInvoice(trx, req.params.id);
    if (inv.voucherType === 'MH' || inv.voucherType === 'TLM') await assertVoucherSensitive(trx, req.auth!, inv); // hóa đơn mua hàng hóa mang giá trị tồn kho: cần view_cost
    return inv;
  }));

  // ---- Doanh thu nhận trước: lịch phân bổ (3387 → doanh thu) và chạy phân bổ theo kỳ (chứng từ PB) ----
  app.get('/api/amortizations', { preHandler: app.requirePermission('amortization.view') }, async (req) => app.withTenant(req, (trx) => listSchedules(trx), READ_SNAPSHOT));
  app.get('/api/amortizations/:id', { preHandler: app.requirePermission('amortization.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getSchedule(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/amortizations', { preHandler: app.requirePermission('amortization.create'), schema: { body: scheduleInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createSchedule(trx, req.auth!.tenantId!, req.auth!.userId, req.body))));
  app.put('/api/amortizations/:id', { preHandler: app.requirePermission('amortization.update'), schema: { params: numId, body: scheduleUpdate } }, async (req) =>
    app.withTenant(req, (trx) => updateSchedule(trx, req.auth!.tenantId!, req.params.id, req.body)));
  app.delete('/api/amortizations/:id', { preHandler: app.requirePermission('amortization.delete'), schema: { params: numId } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteSchedule(trx, req.auth!.tenantId!, req.params.id));
    return reply.status(204).send();
  });
  app.post('/api/amortizations/run', { preHandler: app.requirePermission('amortization.run'), schema: { body: runInput } }, async (req) => {
    const auth = req.auth!;
    const out = await app.withOverride(req, (trx) => runAmortization(trx, { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') }, req.body));
    if (out.created.length || out.reversedVoucherIds.length) notifyRecompute(app, auth.tenantId!);
    return out;
  });
};
export default routes;
