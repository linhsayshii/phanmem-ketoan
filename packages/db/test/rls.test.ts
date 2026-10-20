import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '../src/client.js';
import { createTestTenant, createTestUser, newId, setupTestDb, type TestDb } from '../src/testing.js';

// Bảng dùng policy riêng (không phải tenant_isolation chuẩn): vẫn phải ENABLE + FORCE RLS.
const CUSTOM_POLICY = ['tenant', 'tenant_user', 'user_session', 'user_pref'];

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
    // tenant không có cột tenant_id nên truy vấn trên không quét tới; kiểm tra trực tiếp cả nhóm policy riêng.
    const custom = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN (${sql.join(CUSTOM_POLICY)}) ORDER BY 1`.execute(t.admin);
    expect(custom.rows.map((x) => x.relname)).toEqual([...CUSTOM_POLICY].sort());
    for (const row of custom.rows) {
      expect(row.relrowsecurity, `${row.relname} chưa ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} chưa FORCE RLS`).toBe(true);
    }
  });

  it('hai công ty không thấy tài khoản của nhau', async () => {
    const a = await createTestTenant(t.admin, { code: `A${Date.now()}`, name: 'Công ty A' });
    const b = await createTestTenant(t.admin, { code: `B${Date.now()}`, name: 'Công ty B' });
    await withTenant(t.db, { tenantId: a }, (trx) =>
      trx.insertInto('account').values({ tenant_id: a, regime: 'TT99', code: '111', name: 'Tiền mặt', root_type: 'asset', normal_balance: 'debit' }).execute());
    const seenByB = await withTenant(t.db, { tenantId: b }, (trx) => trx.selectFrom('account').selectAll().execute());
    expect(seenByB).toHaveLength(0);
    const seenByA = await withTenant(t.db, { tenantId: a }, (trx) => trx.selectFrom('account').select(['id', 'code']).execute());
    expect(seenByA.map((x) => x.code)).toEqual(['111']);
    // bigint -> number, timestamptz -> string (xem type parser trong client.ts)
    expect(typeof seenByA[0]!.id).toBe('number');
    const ev = await withTenant(t.db, { tenantId: a }, (trx) => trx.selectFrom('audit_event').select(['id', 'ts']).limit(1).executeTakeFirstOrThrow());
    expect(typeof ev.id).toBe('number');
    expect(typeof ev.ts).toBe('string');
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

  it('thành viên của hai công ty chỉ sửa được công ty đang chọn', async () => {
    const u = await createTestUser(t.admin, { username: `m_${newId().slice(0, 8)}`, passwordHash: 'x' });
    const a = await createTestTenant(t.admin, { code: `E${Date.now()}`, name: 'E', ownerUserId: u });
    const b = await createTestTenant(t.admin, { code: `F${Date.now()}`, name: 'F', ownerUserId: u });
    const upd = (id: string) => withTenant(t.db, { tenantId: a, userId: u }, (trx) =>
      trx.updateTable('tenant').set({ name: 'x' }).where('id', '=', id).executeTakeFirst());
    expect(Number((await upd(b)).numUpdatedRows)).toBe(0);
    expect(Number((await upd(a)).numUpdatedRows)).toBe(1);
  });

  it('thành viên nhiều công ty không xóa hay sửa được dòng tenant_user của công ty khác', async () => {
    const u = await createTestUser(t.admin, { username: `n_${newId().slice(0, 8)}`, passwordHash: 'x' });
    const a = await createTestTenant(t.admin, { code: `I${Date.now()}`, name: 'I', ownerUserId: u });
    const b = await createTestTenant(t.admin, { code: `J${Date.now()}`, name: 'J', ownerUserId: u });
    const del = await withTenant(t.db, { tenantId: a, userId: u }, (trx) => trx.deleteFrom('tenant_user').where('tenant_id', '=', b).executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(0);
    const upd = await withTenant(t.db, { tenantId: a, userId: u }, (trx) => trx.updateTable('tenant_user').set({ is_active: false }).where('tenant_id', '=', b).executeTakeFirst());
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const seen = await withTenant(t.db, { tenantId: a, userId: u }, (trx) => trx.selectFrom('tenant_user').select('tenant_id').where('user_id', '=', u).execute());
    expect(seen.map((x) => x.tenant_id).sort()).toEqual([a, b].sort());
  });

  it('create_tenant trả lại app.current_tenant của người gọi', async () => {
    const u = await createTestUser(t.admin, { username: `o_${newId().slice(0, 8)}`, passwordHash: 'x' });
    const a = await createTestTenant(t.admin, { code: `K${Date.now()}`, name: 'K', ownerUserId: u });
    const cur = await t.admin.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${a}, true)`.execute(trx);
      await sql`SELECT create_tenant(${`L${Date.now()}`}, 'L', NULL, ${u}::uuid)`.execute(trx);
      return (await sql<{ v: string }>`SELECT current_setting('app.current_tenant') AS v`.execute(trx)).rows[0]!.v;
    });
    expect(cur).toBe(a);
  });

  it('công ty mới: ketoan_vien không có quyền kết chuyển/định nghĩa báo cáo/số dư đầu kỳ, ketoan_truong có', async () => {
    const a = await createTestTenant(t.admin, { code: `M${Date.now()}`, name: 'M' });
    const has = async (code: string) => (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM role_permission rp JOIN role r ON r.id = rp.role_id
      WHERE rp.tenant_id = ${a} AND r.code = ${code} AND rp.permission_code IN ('closing.run','closing_step.update','report_def.update','opening_balance.update')`.execute(t.admin)).rows[0]!.n;
    expect(await has('ketoan_vien')).toBe(0);
    expect(await has('ketoan_truong')).toBe(4);
    const view = await sql<{ n: number }>`SELECT count(*)::int AS n FROM role_permission rp JOIN role r ON r.id = rp.role_id
      WHERE rp.tenant_id = ${a} AND r.code = 'ketoan_vien' AND rp.permission_code = 'closing_step.view'`.execute(t.admin);
    expect(view.rows[0]!.n).toBe(1);
  });

  it('khoá ngoại theo tenant: không gắn tài khoản cha hay vai trò của công ty khác', async () => {
    const a = await createTestTenant(t.admin, { code: `G${Date.now()}`, name: 'G' });
    const b = await createTestTenant(t.admin, { code: `H${Date.now()}`, name: 'H' });
    const base = { regime: 'TT99', root_type: 'asset', normal_balance: 'debit' } as const;
    const parentA = await t.admin.insertInto('account').values({ ...base, tenant_id: a, code: '1', name: 'Cha A' }).returning('id').executeTakeFirstOrThrow();
    // Trigger fn_account_check (0002) chặn trước bằng ACCOUNT_PARENT_MISMATCH; bật app.bulk_rename để bỏ qua nó và vẫn kiểm chứng khoá ngoại.
    await expect(t.admin.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.bulk_rename', 'on', true)`.execute(trx);
      await trx.insertInto('account').values({ ...base, tenant_id: b, code: '11', name: 'Con B', parent_id: parentA.id }).execute();
    })).rejects.toThrow(/foreign key/);
    const roleA = await t.admin.selectFrom('role').select('id').where('tenant_id', '=', a).where('code', '=', 'admin').executeTakeFirstOrThrow();
    const u = await createTestUser(t.admin, { username: `r_${newId().slice(0, 8)}`, passwordHash: 'x' });
    await expect(t.admin.insertInto('tenant_user').values({ tenant_id: b, user_id: u, role_id: roleA.id, sensitive_flags: '[]' }).execute())
      .rejects.toThrow(/foreign key/);
  });
});
