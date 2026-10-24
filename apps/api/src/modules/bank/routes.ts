import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { createFeed, deleteFeed, feedInput, feedUpdate, listFeeds, rotateFeed, updateFeed } from './feeds.js';
import { deleteFormat, formatInput, importStatement, listFormats, MAX_IMPORT_BYTES, saveFormat } from './statementImport.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({ bankAccountId: z.coerce.number().int().positive().optional(), status: z.enum(['new', 'matched', 'ignored']).optional(), from: dateIso.optional(), to: dateIso.optional(),
  q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) });
const money = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền không hợp lệ');
const manualInput = z.object({ bankAccountId: z.number().int().positive(), valueDate: dateIso, amountIn: money.optional(), amountOut: money.optional(), description: z.string().trim().max(1000).optional(),
  reference: z.string().trim().max(100).optional(), counterName: z.string().trim().max(255).optional(), counterAccount: z.string().trim().max(50).optional() });

// Quyền (migration 0078): xem hộp thư = view; kết nối và mẫu sao kê = create/update/delete; nhập sao kê và nhập tay thêm giao dịch = create; bỏ qua / hoàn bỏ qua giao dịch = match (đối chiếu).
const routes: FastifyPluginAsyncZod = async (app) => {
  const tid = (req: { auth: { tenantId: string | null } | null }) => req.auth!.tenantId!;
  const view = app.requirePermission('bank_feed.view');
  const create = app.requirePermission('bank_feed.create');
  const update = app.requirePermission('bank_feed.update');
  const del = app.requirePermission('bank_feed.delete');
  const match = app.requirePermission('bank_feed.match');
  const baseUrl = (req: { protocol: string; hostname: string }) => app.config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;

  app.get('/api/bank-feeds', { preHandler: view }, async (req) => app.withTenant(req, listFeeds, READ_SNAPSHOT));
  app.post('/api/bank-feeds', { preHandler: create, schema: { body: feedInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createFeed(trx, tid(req), baseUrl(req), req.body))));
  app.put('/api/bank-feeds/:id', { preHandler: update, schema: { params: numId, body: feedUpdate } }, async (req) => app.withTenant(req, (trx) => updateFeed(trx, req.params.id, req.body)));
  app.post('/api/bank-feeds/:id/rotate', { preHandler: update, schema: { params: numId } }, async (req) => app.withTenant(req, (trx) => rotateFeed(trx, req.params.id, baseUrl(req))));
  app.delete('/api/bank-feeds/:id', { preHandler: del, schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteFeed(trx, req.params.id)); return reply.status(204).send(); });

  app.get('/api/bank-statement-formats', { preHandler: view }, async (req) => app.withTenant(req, listFormats, READ_SNAPSHOT));
  app.post('/api/bank-statement-formats', { preHandler: update, schema: { body: formatInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveFormat(trx, tid(req), null, req.body))));
  app.put('/api/bank-statement-formats/:id', { preHandler: update, schema: { params: numId, body: formatInput } }, async (req) => app.withTenant(req, (trx) => saveFormat(trx, tid(req), req.params.id, req.body)));
  app.delete('/api/bank-statement-formats/:id', { preHandler: update, schema: { params: numId } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteFormat(trx, req.params.id)); return reply.status(204).send(); });

  const txnDto = (r: Record<string, unknown>) => ({ id: r.id, bankAccountId: r.bank_account_id, feedId: r.feed_id, source: r.source, externalId: r.external_id, txnTime: r.txn_time, valueDate: r.value_date,
    amountIn: r.amount_in, amountOut: r.amount_out, balanceAfter: r.balance_after, description: r.description, reference: r.reference, counterAccount: r.counter_account, counterName: r.counter_name,
    paymentCode: r.payment_code, status: r.status, voucherId: r.voucher_id, matchedAt: r.matched_at });
  const cols = ['id', 'bank_account_id', 'feed_id', 'source', 'external_id', 'txn_time', 'value_date', 'amount_in', 'amount_out', 'balance_after', 'description', 'reference', 'counter_account', 'counter_name', 'payment_code', 'status', 'voucher_id', 'matched_at'] as const;

  app.get('/api/bank-transactions', { preHandler: view, schema: { querystring: listQuery } }, async (req) => app.withTenant(req, async (trx) => {
    const { bankAccountId, status, from, to, q, limit, offset } = req.query;
    let qb = trx.selectFrom('bank_transaction').select(cols);
    if (bankAccountId) qb = qb.where('bank_account_id', '=', bankAccountId);
    if (status) qb = qb.where('status', '=', status);
    if (from) qb = qb.where('value_date', '>=', from);
    if (to) qb = qb.where('value_date', '<=', to);
    if (q) { const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; qb = qb.where((eb) => eb.or([sql<boolean>`description ILIKE ${like}`, sql<boolean>`reference ILIKE ${like}`, sql<boolean>`counter_name ILIKE ${like}`, sql<boolean>`payment_code ILIKE ${like}`])); }
    return (await qb.orderBy('value_date', 'desc').orderBy('id', 'desc').limit(limit).offset(offset).execute()).map(txnDto);
  }, READ_SNAPSHOT));

  const flip = (from: string, to: string) => async (req: { params: { id: number } } & Parameters<typeof app.withTenant>[0]) => app.withTenant(req, async (trx) => {
    const r = await trx.updateTable('bank_transaction').set({ status: to }).where('id', '=', req.params.id).where('status', '=', from).returning(cols).executeTakeFirst();
    if (r) return txnDto(r);
    if (!(await trx.selectFrom('bank_transaction').select('id').where('id', '=', req.params.id).executeTakeFirst())) throw new AppError('BANK_TXN_NOT_FOUND', 'Không tìm thấy giao dịch ngân hàng', 404);
    throw new AppError('BANK_TXN_STATE', `Chỉ chuyển được giao dịch đang ở trạng thái "${from === 'new' ? 'mới' : 'bỏ qua'}"`, 409);
  });
  app.post('/api/bank-transactions/:id/ignore', { preHandler: match, schema: { params: numId } }, flip('new', 'ignored'));
  app.post('/api/bank-transactions/:id/unignore', { preHandler: match, schema: { params: numId } }, flip('ignored', 'new'));

  app.post('/api/bank-transactions', { preHandler: create, schema: { body: manualInput } }, async (req, reply) => {
    const b = req.body;
    if (Number(b.amountIn ?? 0) > 0 === Number(b.amountOut ?? 0) > 0) throw new AppError('BANK_TXN_AMOUNT', 'Nhập đúng một trong hai: số tiền vào hoặc số tiền ra (lớn hơn 0)', 400); // chỉ so dấu, không tính tiền
    const r = await app.withTenant(req, async (trx) => {
      if (!(await trx.selectFrom('bank_account').select('id').where('id', '=', b.bankAccountId).executeTakeFirst())) throw new AppError('BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng', 404);
      return trx.insertInto('bank_transaction').values({ tenant_id: tid(req), bank_account_id: b.bankAccountId, source: 'manual', external_id: `man:${randomUUID()}`, value_date: b.valueDate,
        amount_in: b.amountIn ?? '0', amount_out: b.amountOut ?? '0', description: b.description ?? null, reference: b.reference ?? null, counter_name: b.counterName ?? null, counter_account: b.counterAccount ?? null })
        .returning(cols).executeTakeFirstOrThrow();
    });
    return reply.status(201).send(txnDto(r));
  });

  // Nhập sao kê: trường bankAccountId, formatId rồi tệp (multipart). Mọi lỗi dòng nằm trong errors, các dòng hợp lệ vẫn được ghi.
  app.post('/api/bank-transactions/import', { preHandler: create }, async (req) => {
    const fields: Record<string, string> = {}; let file: { name: string; data: Buffer } | null = null;
    for await (const part of req.parts({ throwFileSizeLimit: false, limits: { files: 1, parts: 10, fileSize: MAX_IMPORT_BYTES, fieldSize: 1024 } } as Parameters<typeof req.parts>[0])) {
      if (part.type === 'field') { if (typeof part.value === 'string') fields[part.fieldname] = part.value; continue; }
      const data = await part.toBuffer();
      if ((part.file as { truncated?: boolean }).truncated) throw new AppError('IMPORT_FILE_TOO_LARGE', `Tệp sao kê vượt ${MAX_IMPORT_BYTES / 1024 / 1024} MB`, 413);
      file = { name: part.filename, data };
    }
    const ids = z.object({ bankAccountId: z.coerce.number().int().positive(), formatId: z.coerce.number().int().positive() }).safeParse(fields);
    if (!ids.success || !file) throw new AppError('VALIDATION', 'Cần chọn tài khoản ngân hàng, mẫu sao kê và tệp', 400);
    const f = file;
    return app.withTenant(req, (trx) => importStatement(trx, tid(req), { ...ids.data, file: f.data, filename: f.name }));
  });
};

export default routes;
