import pg from 'pg';
import { PERMISSIONS } from '@kt/domain';

export async function syncReferenceData(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const p of PERMISSIONS) {
      await client.query(
        `INSERT INTO permission(code, name, group_name) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, group_name = EXCLUDED.group_name`,
        [p.code, p.name, p.group],
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { await client.end(); }
}
