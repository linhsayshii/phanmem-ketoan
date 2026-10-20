import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// Bỏ BOM UTF-8 và đổi CRLF thành LF trước khi băm: bản checkout Windows (core.autocrlf) phải cho cùng checksum với LF đã lưu.
export const normalizeSql = (s: string) => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export const checksum = (s: string) => sha256(normalizeSql(s));

// Migration đã áp dụng là bất biến: nội dung tệp phải khớp checksum đã lưu, nếu không thì dừng trước khi áp dụng bất cứ migration mới nào (sửa tại chỗ làm các môi trường lệch nhau mà không ai biết).
// Dòng chưa có checksum (cơ sở dữ liệu tạo trước khi có cột này) được điền theo tệp hiện tại ở lần thấy đầu tiên. MIGRATE_ALLOW_CHECKSUM_CHANGE=1: chấp nhận nội dung mới và ghi đè checksum (chỉ khi cố ý).
export async function migrate(adminUrl: string, dir: string = defaultDir): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await client.query('ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS checksum text');
    const done = new Map((await client.query('SELECT name, checksum FROM schema_migration')).rows.map((r) => [r.name as string, r.checksum as string | null]));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const sums = new Map<string, string>(); const texts = new Map<string, string>();
    for (const f of files) { const text = normalizeSql(await readFile(path.join(dir, f), 'utf8')); texts.set(f, text); sums.set(f, sha256(text)); }
    const allow = process.env.MIGRATE_ALLOW_CHECKSUM_CHANGE === '1';
    for (const f of files) {
      if (!done.has(f)) continue;
      const stored = done.get(f); const now = sums.get(f)!;
      if (stored === now) continue;
      if (stored && !allow) throw new Error(`Migration ${f} đã được áp dụng nhưng tệp bị sửa sau đó (checksum đã lưu ${stored.slice(0, 12)}…, hiện tại ${now.slice(0, 12)}…). Migration đã áp dụng là bất biến: hãy tạo migration mới thay vì sửa; nếu cố ý chấp nhận nội dung mới, đặt MIGRATE_ALLOW_CHECKSUM_CHANGE=1.`);
      await client.query('UPDATE schema_migration SET checksum = $2 WHERE name = $1', [f, now]);
    }
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(texts.get(f)!);
        await client.query('INSERT INTO schema_migration(name, checksum) VALUES ($1, $2)', [f, sums.get(f)]);
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
