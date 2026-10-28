import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { seedAbc, seedAbcTx } from '../src/seed/demo-abc.js';
import { withTenantClient } from '../src/seed/common.js';
import { setupTestDb } from '../src/testing.js';

// Test tự migrate và đồng bộ coa_template để chạy được cả khi chạy riêng trên CSDL mới.
beforeAll(async () => { const t = await setupTestDb(); await t.close(); });

const url = () => process.env.DATABASE_ADMIN_URL!;
async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url() }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

describe('dữ liệu mẫu ABC', () => {
  it('chạy hai lần chỉ tạo một công ty với 30 đối tượng và hệ thống tài khoản', async () => {
    const url = process.env.DATABASE_ADMIN_URL!;
    const c = new pg.Client({ connectionString: url }); await c.connect();
    const parties = async (id: string) => (await c.query('SELECT count(*)::int AS n FROM party WHERE tenant_id = $1', [id])).rows[0].n as number;
    const a = await seedAbc(url); const before = await parties(a.tenantId); const b = await seedAbc(url);
    expect(b.tenantId).toBe(a.tenantId); expect(b.created).toBe(false);
    // DB kiểm thử dùng chung với sample-abc của API: seed đầy đủ (seedAbcFull) có thể đã thêm đối tượng của năm nghiệp vụ, nên chỉ chặn dưới 30 và kiểm lần hai không thêm gì.
    const after = await parties(a.tenantId);
    expect(after).toBe(before);
    const acc = await c.query('SELECT count(*)::int AS n FROM account WHERE tenant_id = $1', [a.tenantId]);
    const fp = await c.query('SELECT count(*)::int AS n FROM fiscal_period WHERE tenant_id = $1', [a.tenantId]);
    await c.end();
    expect(after).toBeGreaterThanOrEqual(30); expect(acc.rows[0].n).toBeGreaterThan(100); expect(fp.rows[0].n).toBe(13);
  });

  it('tài khoản mặc định của mọi khoản mục chi phí có trong hệ thống tài khoản của công ty', async () => {
    const { tenantId } = await seedAbc(url());
    await withClient(async (c) => {
      const all = await c.query('SELECT count(*)::int AS n FROM cost_item WHERE tenant_id = $1', [tenantId]);
      const missing = await c.query(`SELECT code, default_account_code FROM cost_item ci WHERE tenant_id = $1 AND default_account_code IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = ci.tenant_id AND a.code = ci.default_account_code)`, [tenantId]);
      expect(all.rows[0].n).toBeGreaterThanOrEqual(6); expect(missing.rows).toEqual([]);
    });
  });

  it('mọi dòng nhật ký kiểm toán của công ty mẫu mang người dùng admin', async () => {
    const { tenantId } = await seedAbc(url());
    await withClient(async (c) => {
      const r = await c.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE user_id = (SELECT id FROM app_user WHERE username = 'admin'))::int AS by_admin
        FROM audit_event WHERE tenant_id = $1`, [tenantId]);
      expect(r.rows[0].total).toBeGreaterThan(100); expect(r.rows[0].by_admin).toBe(r.rows[0].total);
    });
  });

  it('lỗi sau khi tạo công ty thì hoàn tác tất cả, không để lại công ty', async () => {
    await withClient(async (c) => {
      let tenantSeenInside = 0;
      await expect(seedAbcTx(c, { code: 'ABC_TEST_FAIL', afterTenant: async () => {
        tenantSeenInside = (await c.query(`SELECT count(*)::int AS n FROM tenant WHERE code = 'ABC_TEST_FAIL'`)).rows[0].n;
        throw new Error('lỗi giả lập');
      } })).rejects.toThrow('lỗi giả lập');
      expect(tenantSeenInside).toBe(1);
      const after = await c.query(`SELECT count(*)::int AS n FROM tenant WHERE code = 'ABC_TEST_FAIL'`);
      expect(after.rows[0].n).toBe(0);
    });
  });

  it('withTenantClient đặt công ty và người dùng trong giao dịch và hoàn tác khi lỗi', async () => {
    const { tenantId } = await seedAbc(url());
    await withClient(async (c) => {
      const admin = (await c.query(`SELECT id FROM app_user WHERE username = 'admin'`)).rows[0].id;
      const seen = await withTenantClient(c, tenantId, async () =>
        (await c.query(`SELECT current_setting('app.current_tenant', true) AS tenant, current_setting('app.current_user', true) AS "user"`)).rows[0], admin);
      expect(seen).toEqual({ tenant: tenantId, user: admin });
      await expect(withTenantClient(c, tenantId, async () => {
        await c.query(`INSERT INTO uom(tenant_id, code, name) VALUES ($1, 'X_HOANTAC', 'x')`, [tenantId]); throw new Error('lỗi giả lập');
      }, admin)).rejects.toThrow('lỗi giả lập');
      const n = await c.query(`SELECT count(*)::int AS n FROM uom WHERE tenant_id = $1 AND code = 'X_HOANTAC'`, [tenantId]);
      expect(n.rows[0].n).toBe(0);
    });
  });
});
