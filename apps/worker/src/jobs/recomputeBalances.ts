import { sql, type Kysely } from 'kysely';
import type PgBoss from 'pg-boss';
import { QUEUES, withTenant, type Database, type RecomputeBalancesJob } from '@kt/db';

// Chạy bằng vai trò app_user trong ngữ cảnh công ty của job (RLS), không dùng quyền admin.
export async function recomputeBalances(db: Kysely<Database>, job: RecomputeBalancesJob): Promise<number> {
  return withTenant(db, { tenantId: job.tenantId }, async (trx) =>
    (await sql<{ n: number }>`SELECT recompute_balances(${job.tenantId}::uuid) AS n`.execute(trx)).rows[0]!.n);
}

// Tính xong mà còn mốc bẩn nghĩa là có chứng từ ghi sổ trong lúc chạy (recompute chỉ xóa đúng mốc nó đã đọc). Lần gửi job của chứng từ đó có thể rơi vào
// khe singleton (5 giây) đã dùng nên bị bỏ; không xếp lại thì số dư bẩn đến lần ghi sổ sau. Xếp lại không dùng singletonSeconds: khe tính theo giờ gửi, trùng khe job đang chạy là bị bỏ.
export async function recomputeAndRequeue(db: Kysely<Database>, boss: Pick<PgBoss, 'send'>, job: RecomputeBalancesJob): Promise<{ periods: number; requeued: boolean }> {
  const periods = await recomputeBalances(db, job);
  const stale = await withTenant(db, { tenantId: job.tenantId }, (trx) => trx.selectFrom('balance_stale').select('tenant_id').where('tenant_id', '=', job.tenantId).executeTakeFirst());
  if (!stale) return { periods, requeued: false };
  await boss.send(QUEUES.recomputeBalances, { tenantId: job.tenantId }, { singletonKey: job.tenantId, startAfter: 5 });
  return { periods, requeued: true };
}
