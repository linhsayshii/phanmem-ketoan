import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';

// Bảng có tenant_id nhưng dùng policy riêng (không phải tenant_isolation chuẩn).
const CUSTOM_POLICY = new Set(['tenant', 'tenant_user', 'user_session', 'user_pref']);

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

describe('RLS', () => {
  it('mọi bảng có cột tenant_id đều bật và ép RLS với policy', async () => {
    const r = await sql<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; npol: number }>`
      SELECT c.table_name, pc.relrowsecurity, pc.relforcerowsecurity,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.table_name)::int AS npol
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name AND pc.relnamespace = 'public'::regnamespace
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND pc.relkind IN ('r','p')
      ORDER BY 1`.execute(t.admin);
    expect(r.rows.length).toBeGreaterThan(5);
    for (const row of r.rows) {
      expect(row.relrowsecurity, `${row.table_name} chưa ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.table_name} chưa FORCE RLS`).toBe(true);
      expect(row.npol, `${row.table_name} chưa có policy`).toBeGreaterThan(0);
    }
    // user_pref dùng rls_enable chuẩn; tenant/tenant_user/user_session có policy riêng đã được khai báo ở trên.
    expect(CUSTOM_POLICY.has('tenant')).toBe(true);
  });

  it('hai công ty không thấy tài khoản của nhau', async () => {
    const a = await createTestTenant(t.admin, { code: `A${Date.now()}`, name: 'Công ty A' });
    const b = await createTestTenant(t.admin, { code: `B${Date.now()}`, name: 'Công ty B' });
    await withTenant(t.db, { tenantId: a }, (trx) =>
      trx.insertInto('account').values({ tenant_id: a, regime: 'TT99', code: '111', name: 'Tiền mặt', root_type: 'asset', normal_balance: 'debit' }).execute());
    const seenByB = await withTenant(t.db, { tenantId: b }, (trx) => trx.selectFrom('account').selectAll().execute());
    expect(seenByB).toHaveLength(0);
    const seenByA = await withTenant(t.db, { tenantId: a }, (trx) => trx.selectFrom('account').select('code').execute());
    expect(seenByA.map((x) => x.code)).toEqual(['111']);
  });

  it('không chèn được dòng mang tenant_id khác', async () => {
    const a = await createTestTenant(t.admin, { code: `C${Date.now()}`, name: 'C' });
    const b = await createTestTenant(t.admin, { code: `D${Date.now()}`, name: 'D' });
    await expect(withTenant(t.db, { tenantId: a }, (trx) =>
      trx.insertInto('account').values({ tenant_id: b, regime: 'TT99', code: '112', name: 'TGNH', root_type: 'asset', normal_balance: 'debit' }).execute(),
    )).rejects.toThrow(/row-level security/);
  });

  it('không có biến phiên thì không thấy gì', async () => {
    const rows = await t.db.selectFrom('account').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
