import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(adminUrl: string, dir: string = defaultDir): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sqlText = await readFile(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migration(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} thất bại: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
