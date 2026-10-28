import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { Database } from './types.js';

// numeric (1700) giữ nguyên dạng chuỗi: không bao giờ để driver ép sang number (tiền dùng decimal.js).
// int8 (20) -> number vì chỉ dùng cho id/đếm (bigint identity), nhỏ hơn nhiều so với 2^53.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'
pg.types.setTypeParser(1184, (v) => v); // timestamptz -> chuỗi, khớp Timestamp trong types.ts
pg.types.setTypeParser(1114, (v) => v); // timestamp -> chuỗi

export interface TenantCtx {
  tenantId: string;
  userId?: string;
  ip?: string;
  // GĐ7 đa chi nhánh: phạm vi chi nhánh (id cách nhau dấu phẩy, 0 = trụ sở chính; rỗng = toàn công ty) và chi nhánh làm việc (mặc định của voucher.branch_id).
  branchScope?: string;
  branchDefault?: string;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

// Mức cô lập và chế độ truy cập của giao dịch. Mặc định read committed, đọc ghi.
export interface TxOptions { isolation?: 'repeatable read'; readOnly?: boolean }
// Báo cáo/sổ chạy nhiều truy vấn: một ảnh chụp dữ liệu duy nhất (repeatable read) và chỉ đọc, để các phần của cùng báo cáo luôn khớp nhau.
export const READ_SNAPSHOT: TxOptions = { isolation: 'repeatable read', readOnly: true };

export async function withTenant<T>(
  db: Kysely<Database>,
  ctx: TenantCtx,
  fn: (trx: Transaction<Database>) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const tx = db.transaction();
  return (opts.isolation ? tx.setIsolationLevel(opts.isolation) : tx).execute(async (trx) => {
    if (opts.readOnly) await sql`SET TRANSACTION READ ONLY`.execute(trx); // phải đứng trước truy vấn đầu tiên
    await sql`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true),
                     set_config('app.current_user', ${ctx.userId ?? ''}, true),
                     set_config('app.client_ip', ${ctx.ip ?? ''}, true),
                     set_config('app.branch_scope', ${ctx.branchScope ?? ''}, true),
                     set_config('app.branch_default', ${ctx.branchDefault ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}
