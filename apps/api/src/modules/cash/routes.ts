import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { assertCanView, regimeOf } from '../reporting/ledgers.js';
import { isoDate, respondReport } from '../reporting/routes.js';
import { bookDoc, cashBalanceAt, cashBook } from './books.js';

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
};
export default routes;
