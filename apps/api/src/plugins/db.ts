import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { withTenant, type Database, type TxOptions } from '@kt/db';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>;
    withTenant<T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>, opts?: TxOptions): Promise<T>;
    withOverride<T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>;
  }
}

export default fp<{ db: Kysely<Database> }>(async (app, opts) => {
  app.decorate('db', opts.db);
  app.decorate('withTenant', <T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>, txOpts?: TxOptions) => {
    if (!req.auth?.tenantId) throw new AppError('NO_TENANT', 'Chưa chọn công ty', 409);
    return withTenant(opts.db, { tenantId: req.auth.tenantId, userId: req.auth.userId, ip: req.ip }, fn, txOpts);
  });
  // Ghi vào kỳ khóa sổ (khóa mềm) chỉ khi có quyền ghi lùi; biến phiên đặt trong giao dịch. Kỳ khóa cứng luôn bị chặn trong SQL.
  app.decorate('withOverride', <T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>) => app.withTenant(req, async (trx) => {
    if (req.auth!.permissions.has('voucher.backdate_locked')) await sql`SELECT set_config('app.override_soft_lock', 'on', true)`.execute(trx);
    return fn(trx);
  }));
});
