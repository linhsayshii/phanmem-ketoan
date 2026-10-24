import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { assertPrint, respondReport } from '../reporting/routes.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { logCloseStep, periodOfDate, runSummary } from '../ledger/periodClose.js';
import { invoiceRegister, reconcileDoc, reconcileTax, registerDoc } from './register.js';
import { offsetInput, runVatOffset } from './vatOffset.js';
import { createReturn, deleteReturn, finalizeReturn, getReturn, listReturns, previewReturn, returnDoc, returnInput, returnUpdate, templateOfPeriod, updateReturn } from './vatReturn.js';
import { XML_FORMATS } from './xml/index.js';
import { renderReturnXml } from './vatXml.js';
import { AppError } from '../../plugins/errors.js';
import { citEstimate, createEstimateVoucher, estimateQuery, estimateVoucherInput } from './citEstimate.js';
import { citReturnInput, citReturnUpdate, citTemplateFor, createCitReturn, deleteCitReturn, finalizeCitReturn, getCitReturn, listCitReturns, previewCitReturn, renderCitXml, updateCitReturn } from './citReturn.js';

const period = { year: z.coerce.number().int().min(2000).max(2100), period: z.coerce.number().int().min(1).max(12), periodKind: z.enum(['month', 'quarter']).default('month') };

const numId = z.object({ id: z.coerce.number().int().positive() });
// Lập, sửa, chốt tờ khai đọc nhiều truy vấn (bảng kê mua, bán, kỳ trước): một ảnh chụp, vẫn ghi được. Lập đồng thời cùng kỳ: bản sau gặp UNIQUE, createReturn đổi thành 409 TAX_RETURN_DRAFT_EXISTS.
const SNAPSHOT_RW = { isolation: 'repeatable read' as const };

const routes: FastifyPluginAsyncZod = async (app) => {
  // Bảng kê hóa đơn nội bộ theo kỳ kê khai; in (html/pdf/xlsx) cần thêm report.print. Dựng trong giao dịch REPEATABLE READ READ ONLY, PDF/Excel dựng ngoài giao dịch.
  app.get('/api/tax/invoices', { preHandler: app.requirePermission('tax.view'), schema: { querystring: z.object({ direction: z.enum(['purchase', 'sale']), ...period, format: z.enum(['json', 'html', 'pdf', 'xlsx']).default('json') }) } }, async (req, reply) => {
    const { format, direction, ...q } = req.query; const tenantId = req.auth!.tenantId!;
    if (format === 'json') return app.withTenant(req, (trx) => invoiceRegister(trx, direction, q), READ_SNAPSHOT);
    assertPrint(req.auth!);
    const doc = await app.withTenant(req, async (trx) => registerDoc(trx, tenantId, await invoiceRegister(trx, direction, q)), READ_SNAPSHOT);
    return respondReport(reply, [doc], format, `bang-ke-hoa-don-${direction === 'purchase' ? 'mua-vao' : 'ban-ra'}-${q.year}-${q.periodKind === 'month' ? 'T' : 'Q'}${q.period}`);
  });

  // Đối chiếu thuế hóa đơn với sổ cái; Excel là danh sách chứng từ lệch.
  app.get('/api/tax/reconcile', { preHandler: app.requirePermission('tax.view'), schema: { querystring: z.object({ ...period, format: z.enum(['json', 'xlsx']).default('json') }) } }, async (req, reply) => {
    const { format, ...q } = req.query; const tenantId = req.auth!.tenantId!;
    if (format === 'json') return app.withTenant(req, (trx) => reconcileTax(trx, q), READ_SNAPSHOT);
    assertPrint(req.auth!);
    const doc = await app.withTenant(req, async (trx) => reconcileDoc(trx, tenantId, q, await reconcileTax(trx, q)), READ_SNAPSHOT);
    return respondReport(reply, [doc], format, `doi-chieu-thue-${q.year}-${q.periodKind === 'month' ? 'T' : 'Q'}${q.period}`);
  });

  // Tờ khai 01/GTGT: lập (lần đầu hoặc bổ sung), sửa nháp, chốt; danh sách và chi tiết đọc trong giao dịch REPEATABLE READ READ ONLY.
  app.get('/api/tax/vat-returns', { preHandler: app.requirePermission('tax_return.view'), schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => listReturns(trx, req.auth!.tenantId!, req.query.year), READ_SNAPSHOT));
  app.get('/api/tax/vat-template', { preHandler: app.requirePermission('tax_return.view'), schema: { querystring: z.object(period) } }, async (req) =>
    app.withTenant(req, (trx) => templateOfPeriod(trx, req.query), READ_SNAPSHOT));
  app.get('/api/tax/vat-returns/:id/hints', { preHandler: app.requirePermission('tax_return.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => previewReturn(trx, req.params.id), READ_SNAPSHOT));
  app.get('/api/tax/vat-returns/:id', { preHandler: app.requirePermission('tax_return.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getReturn(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/tax/vat-returns', { preHandler: app.requirePermission('tax_return.create'), schema: { body: returnInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createReturn(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.body), SNAPSHOT_RW)));
  app.put('/api/tax/vat-returns/:id', { preHandler: app.requirePermission('tax_return.update'), schema: { params: numId, body: returnUpdate } }, async (req) =>
    app.withTenant(req, (trx) => updateReturn(trx, req.auth!.tenantId!, req.params.id, req.body), SNAPSHOT_RW));
  app.delete('/api/tax/vat-returns/:id', { preHandler: app.requirePermission('tax_return.delete'), schema: { params: numId } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteReturn(trx, req.auth!.tenantId!, req.params.id), SNAPSHOT_RW);
    return reply.status(204).send();
  });
  app.post('/api/tax/vat-returns/:id/finalize', { preHandler: app.requirePermission('tax_return.finalize'), schema: { params: numId } }, async (req) =>
    app.withTenant(req, (trx) => finalizeReturn(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.params.id), SNAPSHOT_RW));

  // In tờ khai theo bố cục mẫu (html, pdf): cần thêm report.print; bản nháp in kèm chữ "bản nháp".
  app.get('/api/tax/vat-returns/:id/print', { preHandler: app.requirePermission('tax_return.view'), schema: { params: numId, querystring: z.object({ format: z.enum(['html', 'pdf']).default('pdf') }) } }, async (req, reply) => {
    assertPrint(req.auth!);
    const { doc, name } = await app.withTenant(req, async (trx) => returnDoc(trx, req.auth!.tenantId!, await getReturn(trx, req.params.id)), READ_SNAPSHOT);
    return respondReport(reply, [doc], req.query.format, name);
  });

  // Các định dạng XML có và đã kiểm chứng chưa: màn hình cảnh báo trước khi tải.
  app.get('/api/tax/xml-formats', { preHandler: app.requirePermission('tax_return.view') }, async () => Object.values(XML_FORMATS).map((f) => ({ id: f.id, formCode: f.formCode, verified: f.verified })));

  // Xuất XML qua adapter định dạng (XML_FORMATS). Chỉ tờ khai đã chốt: bản nháp có thể còn lệch sổ. verified = false: tiêu đề x-kt-unverified để màn hình cảnh báo "chưa kiểm chứng với HTKK".
  // signedSession: tải bản đã ký của phiên ký số (của chính người dùng, đã ký xong, đúng tờ khai này) thay cho bản chưa ký.
  app.get('/api/tax/vat-returns/:id/xml', { preHandler: app.requirePermission('tax_return.view'), schema: { params: numId, querystring: z.object({ format: z.string().default('htkk-01gtgt'), signedSession: z.string().uuid().optional() }) } }, async (req, reply) => {
    if (!req.auth!.permissions.has('tax.view')) throw new AppError('FORBIDDEN', 'Thiếu quyền tax.view', 403);
    if (req.query.signedSession && req.query.format !== 'htkk-01gtgt') throw new AppError('SIGNED_FORMAT_MISMATCH', 'Bản đã ký chỉ có ở định dạng htkk-01gtgt', 400); // phiên ký luôn dựng định dạng mặc định
    const r = await app.withTenant(req, async (trx) => {
      const out = await renderReturnXml(trx, req.auth!.tenantId!, req.params.id, req.query.format);
      if (!req.query.signedSession) return out;
      const sess = await trx.selectFrom('signing_session').select(['signed_xml']).where('id', '=', req.query.signedSession).where('user_id', '=', req.auth!.userId)
        .where('doc_kind', '=', 'vat_return').where('doc_ref', '=', String(req.params.id)).where('status', '=', 'signed').executeTakeFirst();
      if (!sess?.signed_xml) throw new AppError('SIGNING_SESSION_NOT_FOUND', 'Không tìm thấy phiên ký đã hoàn tất cho tờ khai này', 404);
      return { ...out, xml: sess.signed_xml, file: out.file.replace(/\.xml$/, '_signed.xml') };
    }, READ_SNAPSHOT);
    if (!r.verified) reply.header('x-kt-unverified', '1');
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.file)}`).send(r.xml);
  });

  // Khấu trừ thuế GTGT cuối kỳ (chứng từ KTT); kỳ khóa sổ cần quyền ghi lùi ngày.
  app.post('/api/tax/vat-offset', { preHandler: app.requirePermission('tax.offset'), schema: { body: offsetInput } }, async (req) => {
    const auth = req.auth!;
    const ctx = { tenantId: auth.tenantId!, userId: auth.userId, canBackdate: auth.permissions.has('voucher.backdate_locked') };
    const out = await app.withOverride(req, async (trx) => {
      const r = await runVatOffset(trx, ctx, req.body);
      const p = await periodOfDate(trx, req.body.date);
      if (p?.to === req.body.date) await logCloseStep(trx, ctx, { fiscalYear: p.fiscalYear, periodNo: p.periodNo, step: 'vat_offset', ok: true, summary: runSummary(r) });
      return r;
    });
    if (!out.unchanged) notifyRecompute(app, auth.tenantId!);
    return out;
  });
  // ---- Thuế TNDN: tạm tính quý (đọc giá vốn tổng hợp như B02, theo quyền cit.view), tờ khai quyết toán 03/TNDN ----
  app.get('/api/cit/estimate', { preHandler: app.requirePermission('cit.view'), schema: { querystring: estimateQuery } }, async (req) =>
    app.withTenant(req, (trx) => citEstimate(trx, req.auth!.tenantId!, req.query), READ_SNAPSHOT));
  // Lập PKT nháp chi phí thuế TNDN tạm tính quý: cần thêm quyền lập chứng từ.
  app.post('/api/cit/estimate/voucher', { preHandler: app.requirePermission('cit.create'), schema: { body: estimateVoucherInput } }, async (req, reply) => {
    if (!req.auth!.permissions.has('voucher.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.create', 403);
    return reply.status(201).send(await app.withTenant(req, (trx) => createEstimateVoucher(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.body)));
  });
  app.get('/api/cit/template', { preHandler: app.requirePermission('cit.view'), schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }) } }, async (req) =>
    app.withTenant(req, (trx) => citTemplateFor(trx, req.query.year), READ_SNAPSHOT));
  app.get('/api/cit/returns', { preHandler: app.requirePermission('cit.view'), schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => listCitReturns(trx, req.query.year), READ_SNAPSHOT));
  app.get('/api/cit/returns/:id', { preHandler: app.requirePermission('cit.view'), schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => getCitReturn(trx, req.params.id), READ_SNAPSHOT));
  app.get('/api/cit/returns/:id/hints', { preHandler: app.requirePermission('cit.view'), schema: { params: numId } }, async (req) =>
    app.withTenant(req, (trx) => previewCitReturn(trx, req.auth!.tenantId!, req.params.id), READ_SNAPSHOT));
  app.post('/api/cit/returns', { preHandler: app.requirePermission('cit.create'), schema: { body: citReturnInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createCitReturn(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.body), SNAPSHOT_RW)));
  app.put('/api/cit/returns/:id', { preHandler: app.requirePermission('cit.update'), schema: { params: numId, body: citReturnUpdate } }, async (req) =>
    app.withTenant(req, (trx) => updateCitReturn(trx, req.auth!.tenantId!, req.params.id, req.body), SNAPSHOT_RW));
  app.delete('/api/cit/returns/:id', { preHandler: app.requirePermission('cit.delete'), schema: { params: numId } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteCitReturn(trx, req.auth!.tenantId!, req.params.id), SNAPSHOT_RW);
    return reply.status(204).send();
  });
  // Chốt tờ khai TNDN dùng chung quyền chốt tờ khai thuế (kế toán viên mặc định không có).
  app.post('/api/cit/returns/:id/finalize', { preHandler: app.requirePermission('tax_return.finalize'), schema: { params: numId } }, async (req) => {
    if (!req.auth!.permissions.has('cit.update')) throw new AppError('FORBIDDEN', 'Thiếu quyền cit.update', 403);
    return app.withTenant(req, (trx) => finalizeCitReturn(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.params.id), SNAPSHOT_RW);
  });
  // XML 03/TNDN (định dạng htkk-03tndn, chưa kiểm chứng: tiêu đề x-kt-unverified); signedSession: bản đã ký của phiên ký số của chính người dùng.
  app.get('/api/cit/returns/:id/xml', { preHandler: app.requirePermission('cit.view'), schema: { params: numId, querystring: z.object({ signedSession: z.string().uuid().optional() }) } }, async (req, reply) => {
    const r = await app.withTenant(req, async (trx) => {
      const out = await renderCitXml(trx, req.auth!.tenantId!, req.params.id);
      if (!req.query.signedSession) return out;
      const sess = await trx.selectFrom('signing_session').select(['signed_xml']).where('id', '=', req.query.signedSession).where('user_id', '=', req.auth!.userId)
        .where('doc_kind', '=', 'cit_return').where('doc_ref', '=', String(req.params.id)).where('status', '=', 'signed').executeTakeFirst();
      if (!sess?.signed_xml) throw new AppError('SIGNING_SESSION_NOT_FOUND', 'Không tìm thấy phiên ký đã hoàn tất cho tờ khai này', 404);
      return { ...out, xml: sess.signed_xml, file: out.file.replace(/\.xml$/, '_signed.xml') };
    }, READ_SNAPSHOT);
    if (!r.verified) reply.header('x-kt-unverified', '1');
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.file)}`).send(r.xml);
  });
};
export default routes;
