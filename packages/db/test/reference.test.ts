import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { setupTestDb, type TestDb } from '../src/testing.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

describe('dữ liệu tham chiếu', () => {
  it('permission và coa_template được nạp, app_user không sửa được', async () => {
    const p = await sql<{ n: string }>`SELECT count(*) AS n FROM permission`.execute(t.admin);
    expect(Number(p.rows[0]!.n)).toBeGreaterThan(30);
    const c = await sql<{ regime: string; n: string }>`SELECT regime, count(*) AS n FROM coa_template GROUP BY regime ORDER BY regime`.execute(t.admin);
    expect(String(c.rows.find((r) => r.regime === 'TT133')!.n)).toMatch(/^\d{3}$/);  // int8 được parse thành number
    await expect(sql`INSERT INTO coa_template(regime, code, name, root_type, normal_balance, source) VALUES ('TT133','999','x','asset','debit','x')`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
});
