import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { Database } from './types.js';

// numeric (1700) và int8 (20) giữ nguyên dạng chuỗi: không bao giờ để driver ép sang number.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'

export interface TenantCtx {
  tenantId: string;
  userId?: string;
  ip?: string;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export async function withTenant<T>(
  db: Kysely<Database>,
  ctx: TenantCtx,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true),
                     set_config('app.current_user', ${ctx.userId ?? ''}, true),
                     set_config('app.client_ip', ${ctx.ip ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}
