import { sql, type Kysely } from 'kysely';
import { withTenant, type Database, type RecomputeBalancesJob } from '@kt/db';

// Chạy bằng vai trò app_user trong ngữ cảnh công ty của job (RLS), không dùng quyền admin.
export async function recomputeBalances(db: Kysely<Database>, job: RecomputeBalancesJob): Promise<number> {
  return withTenant(db, { tenantId: job.tenantId }, async (trx) =>
    (await sql<{ n: number }>`SELECT recompute_balances(${job.tenantId}::uuid) AS n`.execute(trx)).rows[0]!.n);
}
