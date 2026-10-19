import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { seedAbc } from '../src/seed/demo-abc.js';

describe('dữ liệu mẫu ABC', () => {
  it('chạy hai lần chỉ tạo một công ty với 30 đối tượng và hệ thống tài khoản', async () => {
    const url = process.env.DATABASE_ADMIN_URL!;
    const a = await seedAbc(url); const b = await seedAbc(url);
    expect(b.tenantId).toBe(a.tenantId); expect(b.created).toBe(false);
    const c = new pg.Client({ connectionString: url }); await c.connect();
    const n = await c.query('SELECT count(*)::int AS n FROM party WHERE tenant_id = $1', [a.tenantId]);
    const acc = await c.query('SELECT count(*)::int AS n FROM account WHERE tenant_id = $1', [a.tenantId]);
    const fp = await c.query('SELECT count(*)::int AS n FROM fiscal_period WHERE tenant_id = $1', [a.tenantId]);
    await c.end();
    expect(n.rows[0].n).toBe(30); expect(acc.rows[0].n).toBeGreaterThan(100); expect(fp.rows[0].n).toBe(13);
  });
});
