import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { assertCanView, regimeOf } from '../reporting/ledgers.js';
import { isoDate, respondReport } from '../reporting/routes.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { voucherFormFor } from '../reporting/print/forms.js';
import { renderPdf } from '../reporting/print/pdf.js';
import { bookDoc, cashBalanceAt, cashBook } from './books.js';
import { countInput, createCount, deleteCount, getCount, listCounts, renderCashCountHtml, settleCount, settleInput } from './cashCount.js';

const format = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');
const range = z.object({ from: isoDate, to: isoDate });
const ordered = (q: { from: string; to: string }) => q.from <= q.to;
const orderedMsg = { message: 'Từ ngày phải trước hoặc bằng đến ngày' };
const optional = z.string().min(1).optional();
type BookQuery = { accountCode?: string | undefined; bankAccountNo?: string | undefined; currency?: string | undefined; from: string; to: string; format: 'json' | 'html' | 'pdf' | 'xlsx' };

const routes: FastifyPluginAsyncZod = async (app) => {
  // Số dư tại ngày (cuối ngày asOf) của tài khoản quỹ/ngân hàng; dùng cho "Tồn quỹ" trên phiếu và kiểm kê quỹ.
  app.get('/api/cash/balance', { preHandler: app.requirePermission('voucher.view'),
    schema: { querystring: z.object({ accountCode: z.string().min(1), bankAccountNo: optional, currency: optional, asOf: isoDate }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      await assertCanView(trx, req.auth!, { accountCode: req.query.accountCode, from: req.query.asOf, to: req.query.asOf });
      return cashBalanceAt(trx, req.query);
    }, READ_SNAPSHOT));

  const view = app.requirePermission('report.view');
  const book = async (kind: 'cash' | 'bank', req: FastifyRequest, reply: FastifyReply, q: BookQuery) => {
    const auth = req.auth!;
    if (q.format !== 'json' && !auth.permissions.has('report.print')) throw new AppError('FORBIDDEN', 'Thiếu quyền report.print', 403);
    // Tài liệu in dựng trong giao dịch; PDF/Excel dựng ngoài giao dịch (respondReport).
    const built = await app.withTenant(req, async (trx) => {
      const b = await cashBook(trx, { kind, ...q });
      // Quyền xem dữ liệu nhạy cảm kiểm theo tài khoản sổ cái thực sự đọc, kể cả khi chỉ truyền số tài khoản ngân hàng.
      await assertCanView(trx, auth, { accountCode: b.accountCode, from: q.from, to: q.to });
      return { b, doc: q.format === 'json' ? null : await bookDoc(trx, auth.tenantId!, await regimeOf(trx, q), b) };
    }, READ_SNAPSHOT);
    if (!built.doc || q.format === 'json') return built.b;
    return respondReport(reply, [built.doc], q.format, `${kind === 'cash' ? 'so-quy' : 'so-tien-gui'}-${built.b.bankAccountNo ?? built.b.accountCode}-${q.from}-${q.to}`);
  };

  app.get('/api/reports/cash-book', { preHandler: view,
    schema: { querystring: range.extend({ accountCode: z.string().min(1), currency: optional, format }).refine(ordered, orderedMsg) } }, async (req, reply) => book('cash', req, reply, req.query));
  app.get('/api/reports/bank-book', { preHandler: view,
    schema: { querystring: range.extend({ bankAccountNo: optional, accountCode: optional, currency: optional, format }).refine(ordered, orderedMsg)
      .refine((q) => !!q.bankAccountNo || !!q.accountCode, { message: 'Cần số tài khoản ngân hàng hoặc tài khoản kế toán' }) } }, async (req, reply) => book('bank', req, reply, req.query));

  // ---- Kiểm kê quỹ ----
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const ctx = (req: FastifyRequest) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });
  app.get('/api/cash-counts', { preHandler: app.requirePermission('cash_count.view') }, async (req) => app.withTenant(req, (trx) => listCounts(trx), READ_SNAPSHOT));
  app.get('/api/cash-counts/:id', { preHandler: app.requirePermission('cash_count.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => getCount(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/cash-counts', { preHandler: app.requirePermission('cash_count.create'), schema: { body: countInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createCount(trx, ctx(req), req.body))));
  // Xử lý chênh lệch lập chứng từ nên cần thêm quyền lập chứng từ.
  app.post('/api/cash-counts/:id/settle', { preHandler: app.requirePermission('cash_count.update'), schema: { params: idParam, body: settleInput } }, async (req, reply) => {
    if (!req.auth!.permissions.has('voucher.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.create', 403);
    return reply.status(201).send(await app.withTenant(req, (trx) => settleCount(trx, ctx(req), req.params.id, req.body)));
  });
  app.delete('/api/cash-counts/:id', { preHandler: app.requirePermission('cash_count.delete'), schema: { params: idParam } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteCount(trx, req.params.id)); return reply.status(204).send(); });
  app.get('/api/cash-counts/:id/print', { preHandler: app.requirePermission('cash_count.view'), schema: { params: idParam, querystring: z.object({ format: z.enum(['html', 'pdf']).default('html') }) } }, async (req, reply) => {
    const { html, id } = await app.withTenant(req, async (trx) => {
      const k = await getCount(trx, req.params.id);
      const regime = await regimeOf(trx, { from: k.countDate, to: k.countDate });
      const key = k.currency === 'VND' ? '08a-TT' : '08b-TT';
      // Mẫu số chỉ in khi chế độ có văn bản gốc (TT133, TT99); TT200 chưa có thì bỏ dòng "Mẫu số".
      const f = voucherFormFor(regime, key);
      const company = { ...(await companyInfo(trx, req.auth!.tenantId!, regime, key)), formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '' };
      return { id: k.id, html: renderCashCountHtml(k, company) };
    }, READ_SNAPSHOT);
    if (req.query.format === 'html') return reply.type('text/html; charset=utf-8').send(html);
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(`kiem-ke-quy-${id}.pdf`)}`).send(await renderPdf(html));
  });
};
export default routes;
