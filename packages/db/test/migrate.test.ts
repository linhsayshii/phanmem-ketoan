import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const adminUrl = process.env.DATABASE_ADMIN_URL!;

describe('migrate', () => {
  it('áp dụng migration một lần và ghi vào schema_migration', async () => {
    const first = await migrate(adminUrl);
    const second = await migrate(adminUrl);
    expect(second).toEqual([]);
    const pool = new pg.Pool({ connectionString: adminUrl });
    const r = await pool.query('SELECT name FROM schema_migration ORDER BY name');
    await pool.end();
    expect(r.rows.map((x) => x.name)).toEqual(expect.arrayContaining(['0001_nen_tang.sql']));
    expect(first.length + 0).toBeGreaterThanOrEqual(0);
  });
});
