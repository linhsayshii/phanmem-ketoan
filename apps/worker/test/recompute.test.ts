import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { createTestTenant, setupTestDb, type TestDb } from '@kt/db/testing';
import { recomputeBalances } from '../src/jobs/recomputeBalances.js';

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
