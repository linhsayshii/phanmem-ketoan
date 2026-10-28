import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestTenant, setupTestDb, type TestDb } from '@kt/db/testing';
import { runRecurringAll } from '../src/jobs/recurringEntries.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); }, 60_000);
afterAll(async () => { await t.close(); });

describe('job bút toán định kỳ', () => {
  it('tìm công ty có mẫu đang chạy, chạy dưới RLS từng công ty; kỳ chưa có trong năm tài chính được bỏ qua kèm lý do, chạy lại không đổi', async () => {
    const tenantId = await createTestTenant(t.admin, { code: `WR${Date.now()}`, name: 'Worker định kỳ' });
    const e = (await sql<{ id: string }>`INSERT INTO recurring_entry(tenant_id, code, name, frequency, day_of_month, start_date, catch_up, created_by)
      SELECT ${tenantId}::uuid, 'DK1', 'Mẫu', 'monthly', 28, '2026-01-01', true, user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid LIMIT 1 RETURNING id`.execute(t.admin)).rows[0]!.id;
    await sql`INSERT INTO recurring_entry_line(tenant_id, entry_id, line_no, account_code, debit_expr, credit_expr) VALUES (${tenantId}::uuid, ${e}::uuid, 1, '6422', '10', '0'), (${tenantId}::uuid, ${e}::uuid, 2, '1111', '0', '10')`.execute(t.admin);
    const first = await runRecurringAll(t.db);
    const mine = first.details.filter((d) => d.tenantId === tenantId);
    expect(first.tenants).toBeGreaterThanOrEqual(1);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((d) => d.status === 'skipped' && d.code === 'PERIOD_NOT_FOUND')).toBe(true);
    const runs = await sql<{ status: string; n: number }>`SELECT status, count(*)::int AS n FROM recurring_run WHERE entry_id = ${e}::uuid GROUP BY status`.execute(t.admin);
    expect(runs.rows).toEqual([{ status: 'skipped', n: mine.length }]);
    await runRecurringAll(t.db);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM recurring_run WHERE entry_id = ${e}::uuid`.execute(t.admin)).rows[0]!.n).toBe(mine.length); // cùng dòng, không nhân bản
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows[0]!.n).toBe(0);
  });
});
