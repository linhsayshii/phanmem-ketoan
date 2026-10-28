import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { BOOK_FORMS, createVoucherSet, ctgsLedger, deleteVoucherSet, getBookForm, listVoucherSets, nksc, nkct, setBookForm, voucherSetDetail, voucherSetRegister } from './bookForms.js';
import { assertAllSensitive, regimeOf } from './ledgers.js';
import { ctgsLedgerDoc, ctgsRegisterDoc, ctgsSetDoc, nkctDoc, nkscDoc } from './print/bookFormDocs.js';
import type { ReportDoc } from './print/html.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from './routes.js';

const format = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');
const range = { from: isoDate, to: isoDate };
const year = z.coerce.number().int().min(2000).max(2100);

const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('report.view');
  // Các sổ hình thức này gồm mọi tài khoản (công nợ, giá vốn) nên như Nhật ký chung: cần đủ ba cờ nhạy cảm.
  const book = async <T>(req: FastifyRequest, reply: FastifyReply, q: { from: string; to: string; format: 'json' | 'html' | 'pdf' | 'xlsx' }, fileName: string,
    json: (trx: Transaction<Database>, regime: string) => Promise<T>, doc: (trx: Transaction<Database>, regime: string) => Promise<ReportDoc>) => {
    assertAllSensitive(req.auth!);
    if (q.format === 'json') return app.withTenant(req, async (trx) => json(trx, await regimeOf(trx, q)), READ_SNAPSHOT);
    assertPrint(req.auth!);
    return respondReport(reply, [await app.withTenant(req, async (trx) => doc(trx, await regimeOf(trx, q)), READ_SNAPSHOT)], q.format, fileName);
  };

  app.get('/api/fiscal-years/:year/book-form', { preHandler: app.requireAuth, schema: { params: z.object({ year }) } }, async (req) =>
    ({ fiscalYear: req.params.year, bookForm: await app.withTenant(req, (trx) => getBookForm(trx, req.params.year), READ_SNAPSHOT) }));
  app.put('/api/fiscal-years/:year/book-form', { preHandler: app.requirePermission('period.update'), schema: { params: z.object({ year }), body: z.object({ bookForm: z.enum(BOOK_FORMS) }) } }, async (req) => {
    await app.withTenant(req, (trx) => setBookForm(trx, req.auth!.tenantId!, req.params.year, req.body.bookForm));
    return { fiscalYear: req.params.year, bookForm: req.body.bookForm };
  });

  app.get('/api/reports/books/nksc', { preHandler: view, schema: { querystring: z.object({ ...range, format }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    book(req, reply, req.query, `nhat-ky-so-cai-${req.query.from}-${req.query.to}`, (trx) => nksc(trx, req.query), (trx, regime) => nkscDoc(trx, req.auth!.tenantId!, regime, req.query)));
  app.get('/api/reports/books/nkct', { preHandler: view, schema: { querystring: z.object({ ...range, creditAccountCode: z.string().min(1), format }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    book(req, reply, req.query, `nhat-ky-chung-tu-${req.query.creditAccountCode}-${req.query.from}-${req.query.to}`, (trx, regime) => nkct(trx, regime, req.query), (trx, regime) => nkctDoc(trx, req.auth!.tenantId!, regime, req.query)));
  app.get('/api/reports/books/ctgs-register', { preHandler: view, schema: { querystring: z.object({ ...range, format }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    book(req, reply, req.query, `so-dang-ky-ctgs-${req.query.from}-${req.query.to}`, (trx) => voucherSetRegister(trx, req.query), (trx, regime) => ctgsRegisterDoc(trx, req.auth!.tenantId!, regime, req.query)));
  app.get('/api/reports/books/ctgs-ledger', { preHandler: view, schema: { querystring: z.object({ ...range, accountCode: z.string().min(1), format }).refine(ordered, orderedMsg) } }, async (req, reply) =>
    book(req, reply, req.query, `so-cai-ctgs-${req.query.accountCode}-${req.query.from}-${req.query.to}`, (trx, regime) => ctgsLedger(trx, req.auth!.tenantId!, regime, req.query), (trx, regime) => ctgsLedgerDoc(trx, req.auth!.tenantId!, regime, req.query)));

  // Lập, xem, in, xóa Chứng từ ghi sổ. Xóa chỉ gỡ nhóm (chứng từ gốc và sổ cái không đổi).
  app.get('/api/voucher-sets', { preHandler: app.requirePermission('voucher_set.view'), schema: { querystring: z.object({ fiscalYear: year }) } }, async (req) =>
    app.withTenant(req, (trx) => listVoucherSets(trx, req.query.fiscalYear), READ_SNAPSHOT));
  app.post('/api/voucher-sets', { preHandler: app.requirePermission('voucher_set.create'), schema: { body: z.object({ fiscalYear: z.number().int(), setDate: isoDate, description: z.string().trim().min(1).max(500), dateFrom: isoDate, dateTo: isoDate, voucherType: z.string().min(1).max(10).optional() }) } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createVoucherSet(trx, req.auth!.tenantId!, req.auth!.userId, req.body))));
  app.get('/api/voucher-sets/:id', { preHandler: app.requirePermission('voucher_set.view'), schema: { params: z.object({ id: z.coerce.number().int() }), querystring: z.object({ format }) } }, async (req, reply) => {
    assertAllSensitive(req.auth!);
    if (req.query.format === 'json') return app.withTenant(req, (trx) => voucherSetDetail(trx, req.params.id), READ_SNAPSHOT);
    assertPrint(req.auth!);
    const doc = await app.withTenant(req, async (trx) => { const s = await voucherSetDetail(trx, req.params.id); return ctgsSetDoc(trx, req.auth!.tenantId!, await regimeOf(trx, { from: s.dateFrom, to: s.dateTo }), req.params.id); }, READ_SNAPSHOT);
    return respondReport(reply, [doc], req.query.format, `chung-tu-ghi-so-${req.params.id}`);
  });
  app.delete('/api/voucher-sets/:id', { preHandler: app.requirePermission('voucher_set.delete'), schema: { params: z.object({ id: z.coerce.number().int() }) } }, async (req) => {
    await app.withTenant(req, (trx) => deleteVoucherSet(trx, req.params.id));
    return { ok: true };
  });
};
export default routes;
