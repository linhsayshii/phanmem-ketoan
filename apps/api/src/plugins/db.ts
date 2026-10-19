import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>;
    withTenant<T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>;
  }
}

export default fp<{ db: Kysely<Database> }>(async (app, opts) => {
  app.decorate('db', opts.db);
  app.decorate('withTenant', <T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>) => {
    if (!req.auth?.tenantId) throw new AppError('NO_TENANT', 'Chưa chọn công ty', 409);
    return withTenant(opts.db, { tenantId: req.auth.tenantId, userId: req.auth.userId, ip: req.ip }, fn);
  });
});
