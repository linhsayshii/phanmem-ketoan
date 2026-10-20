import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { QUEUES, ensureRecomputeQueue } from '@kt/db';
import { notifyRecompute } from '../src/modules/ledger/notifyRecompute.js';
import { createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

const jobs = async (tid: string, state: string) => (await sql<{ n: number }>`SELECT count(*) AS n FROM pgboss.job WHERE name = ${QUEUES.recomputeBalances} AND data->>'tenantId' = ${tid} AND state = ${state}::pgboss.job_state`.execute(ctx.t.admin)).rows[0]!.n;
const policy = async () => (await sql<{ policy: string }>`SELECT policy FROM pgboss.queue WHERE name = ${QUEUES.recomputeBalances}`.execute(ctx.t.admin)).rows[0]!.policy;

describe('gửi việc tính lại số dư (không có worker chạy)', () => {
  it('chính sách short: nhiều lần gửi cho một công ty chỉ còn một job chờ, mỗi công ty một job; job đang chạy không chặn job mới', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await Promise.all([a, a, a, b].map((tid) => notifyRecompute(ctx.app, tid)));
    expect(await policy()).toBe('short');
    expect([await jobs(a, 'created'), await jobs(b, 'created')]).toEqual([1, 1]);
    expect((await sql<{ policy: string }>`SELECT policy FROM pgboss.job WHERE name = ${QUEUES.recomputeBalances} AND data->>'tenantId' = ${a}`.execute(ctx.t.admin)).rows).toEqual([{ policy: 'short' }]);
    await notifyRecompute(ctx.app, a); expect(await jobs(a, 'created')).toBe(1);
    // job đang chạy (worker đã lấy) không tính vào giới hạn: ghi sổ trong lúc chạy vẫn xếp được job mới, ngay cả trong cùng khe 5 giây
    await sql`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE name = ${QUEUES.recomputeBalances} AND data->>'tenantId' = ${a}`.execute(ctx.t.admin);
    await Promise.all([notifyRecompute(ctx.app, a), notifyRecompute(ctx.app, a)]);
    expect([await jobs(a, 'active'), await jobs(a, 'created'), await jobs(b, 'created')]).toEqual([1, 1, 1]);
  });

  it('hàng đợi cũ có chính sách standard được nâng lên short khi ứng dụng khởi động', async () => {
    await sql`UPDATE pgboss.queue SET policy = 'standard' WHERE name = ${QUEUES.recomputeBalances}`.execute(ctx.t.admin);
    const boss = new PgBoss({ connectionString: process.env.DATABASE_ADMIN_URL!, schema: 'pgboss' });
    await boss.start();
    try {
      await ensureRecomputeQueue(boss); await ensureRecomputeQueue(boss); // idempotent
      expect(await policy()).toBe('short');
      const tid = randomUUID();
      for (let i = 0; i < 3; i++) await boss.send(QUEUES.recomputeBalances, { tenantId: tid }, { singletonKey: tid });
      expect(await jobs(tid, 'created')).toBe(1);
    } finally { await boss.stop({ graceful: false }); }
  });
});
