import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import { QUEUES, ensureRecomputeQueue, withTenant } from '@kt/db';
import { createTestTenant, setupTestDb, type TestDb } from '@kt/db/testing';
import { createBoss } from '../src/boss.js';
import { recomputeAndRequeue, recomputeBalances } from '../src/jobs/recomputeBalances.js';

let t: TestDb; let tenantId: string;
beforeAll(async () => { t = await setupTestDb(); tenantId = await createTestTenant(t.admin, { code: `WR${Date.now()}`, name: 'Worker' }); }, 60_000);
afterAll(async () => { await t.close(); });

describe('job tính lại số dư', () => {
  it('không có mốc bẩn thì trả 0; có mốc bẩn thì xóa mốc', async () => {
    expect(await recomputeBalances(t.db, { tenantId })).toBe(0);
    await sql`INSERT INTO balance_stale(tenant_id, stale_year, stale_period) VALUES (${tenantId}::uuid, 2026, 1)`.execute(t.admin);
    await recomputeBalances(t.db, { tenantId });
    expect((await sql`SELECT 1 FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows).toHaveLength(0);
  });

  it('tính số dư của chứng từ đã ghi sổ bằng vai trò app_user (qua RLS); kỳ đã tính xong thì lần sau trả 0', async () => {
    const tid = await createTestTenant(t.admin, { code: `WS${Date.now()}`, name: 'Worker số dư' });
    const userId = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tid}::uuid`.execute(t.admin)).rows[0]!.user_id;
    await sql`INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES
      (${tid}::uuid, 2026, 0, '2025-12-31', '2025-12-31', 'TT133'), (${tid}::uuid, 2026, 1, '2026-01-01', '2026-01-31', 'TT133'), (${tid}::uuid, 2026, 2, '2026-02-01', '2026-02-28', 'TT133')`.execute(t.admin);
    await sql`INSERT INTO account(tenant_id, regime, code, name, root_type, normal_balance) VALUES (${tid}::uuid, 'TT133', '1111', 'Tiền mặt', 'asset', 'debit'), (${tid}::uuid, 'TT133', '5113', 'Doanh thu', 'income', 'credit')`.execute(t.admin);
    const acc = async (code: string) => (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tid}::uuid AND code = ${code}`.execute(t.admin)).rows[0]!.id;
    await withTenant(t.db, { tenantId: tid, userId }, async (trx) => {
      const v = await trx.insertInto('voucher').values({ tenant_id: tid, voucher_type: 'PKT', posting_date: '2026-01-10', document_date: '2026-01-10', created_by: userId }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('voucher_line').values([
        { tenant_id: tid, voucher_id: v.id, line_no: 1, account_id: await acc('1111'), posting_date: '2026-01-10', debit: '1000', credit: '0', amount_currency: '1000' },
        { tenant_id: tid, voucher_id: v.id, line_no: 2, account_id: await acc('5113'), posting_date: '2026-01-10', debit: '0', credit: '1000', amount_currency: '-1000' }]).execute();
      await sql`SELECT post_voucher(${v.id}::uuid)`.execute(trx);
    });
    expect((await sql`SELECT 1 FROM balance_stale WHERE tenant_id = ${tid}::uuid`.execute(t.admin)).rows).toHaveLength(1);

    expect(await recomputeBalances(t.db, { tenantId: tid })).toBe(3); // kỳ 0, 1, 2 (kỳ 2 nhận số dư kết chuyển)
    const rows = await sql<{ period_no: number; code: string; closing_debit: string; closing_credit: string }>`SELECT b.period_no, a.code, b.closing_debit, b.closing_credit FROM account_period_balance b
      JOIN account a ON a.id = b.account_id WHERE b.tenant_id = ${tid}::uuid ORDER BY b.period_no, a.code`.execute(t.admin);
    expect(rows.rows).toEqual([
      { period_no: 1, code: '1111', closing_debit: '1000', closing_credit: '0' }, { period_no: 1, code: '5113', closing_debit: '0', closing_credit: '1000' },
      { period_no: 2, code: '1111', closing_debit: '1000', closing_credit: '0' }, { period_no: 2, code: '5113', closing_debit: '0', closing_credit: '1000' }]);
    expect((await sql`SELECT 1 FROM balance_stale WHERE tenant_id = ${tid}::uuid`.execute(t.admin)).rows).toHaveLength(0);
    expect(await recomputeBalances(t.db, { tenantId: tid })).toBe(0);
  }, 30_000);
});

describe('tự xếp lại job khi còn mốc bẩn', () => {
  let boss: PgBoss;
  beforeAll(async () => { boss = createBoss(process.env.DATABASE_ADMIN_URL!); await boss.start(); await ensureRecomputeQueue(boss); }, 60_000);
  afterAll(async () => { await boss.stop({ graceful: false }); });
  const queued = async (tid: string) => (await sql<{ singleton_key: string | null; secs: number }>`SELECT singleton_key, extract(epoch FROM start_after - now())::float8 AS secs FROM pgboss.job
    WHERE name = ${QUEUES.recomputeBalances} AND data->>'tenantId' = ${tid} AND state = 'created'`.execute(t.admin)).rows;

  it('xong mà không còn mốc bẩn thì không gửi job nữa', async () => {
    const tid = await createTestTenant(t.admin, { code: `WQ${Date.now()}`, name: 'Worker không bẩn' });
    expect(await recomputeAndRequeue(t.db, boss, { tenantId: tid })).toEqual({ periods: 0, requeued: false });
    expect(await queued(tid)).toEqual([]);
  });

  // Chạy recomputeAndRequeue trong khi phiên X đặt lại mốc bẩn nhưng chưa commit và giữ khóa dòng: bản tính lại chạy tới câu xóa mốc ở cuối thì chờ,
  // sau đó thấy mốc mới (marked_at khác) nên giữ lại -- đúng tình huống có chứng từ ghi sổ trong lúc tính.
  async function runWhileMarked(tid: string) {
    await sql`INSERT INTO balance_stale(tenant_id, stale_year, stale_period) VALUES (${tid}::uuid, 2026, 1) ON CONFLICT (tenant_id) DO NOTHING`.execute(t.admin);
    const x = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await x.connect();
    try {
      await x.query('BEGIN'); await x.query('SELECT mark_balance_stale($1::uuid, 2026, 3)', [tid]);
      let settled = false; const run = recomputeAndRequeue(t.db, boss, { tenantId: tid }).finally(() => { settled = true; }); run.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 400 && !waiting && !settled; i++) {
        waiting = (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%recompute_balances%' AND pid <> pg_backend_pid()`.execute(t.admin)).rows.length > 0;
        if (!waiting) await new Promise((res) => setTimeout(res, 50));
      }
      expect(waiting, 'recompute_balances phải đang chờ khóa dòng balance_stale').toBe(true);
      await x.query('COMMIT'); return await run;
    } finally { await x.end(); }
  }

  it('mốc bẩn bị đặt lại trong lúc tính (ghi sổ rơi vào khe singleton đã dùng nên job của nó bị bỏ) thì xếp lại job sau 5 giây; tính tiếp xong thì thôi', async () => {
    const tid = await createTestTenant(t.admin, { code: `WR2${Date.now()}`, name: 'Worker xếp lại' });
    expect(await runWhileMarked(tid)).toEqual({ periods: 0, requeued: true });
    const jobs = await queued(tid);
    expect(jobs).toHaveLength(1); expect(jobs[0]!.singleton_key).toBe(tid);
    expect(jobs[0]!.secs).toBeGreaterThan(3); expect(jobs[0]!.secs).toBeLessThanOrEqual(5);
    // lần chạy sau (job xếp lại) xóa được mốc, không xếp lại thêm
    expect(await recomputeAndRequeue(t.db, boss, { tenantId: tid })).toMatchObject({ requeued: false });
    expect(await queued(tid)).toHaveLength(1);
  }, 30_000);

  it('chính sách short: đã có job chờ của công ty thì lần xếp lại sau không thêm job (không dồn chuỗi), công ty khác không bị ảnh hưởng', async () => {
    const tid = await createTestTenant(t.admin, { code: `WR3${Date.now()}`, name: 'Worker không dồn' });
    const other = await createTestTenant(t.admin, { code: `WR4${Date.now()}`, name: 'Worker công ty khác' });
    expect(await runWhileMarked(tid)).toMatchObject({ requeued: true });
    for (let i = 0; i < 3; i++) expect(await runWhileMarked(tid), `lần ${i + 2}`).toMatchObject({ requeued: false }); // vẫn bẩn nhưng đã có job chờ
    expect(await queued(tid)).toHaveLength(1);
    expect(await runWhileMarked(other)).toMatchObject({ requeued: true });
    expect(await queued(other)).toHaveLength(1); expect(await queued(tid)).toHaveLength(1);
  }, 60_000);
});
