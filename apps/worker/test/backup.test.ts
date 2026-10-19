import '../src/env.js';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runBackup } from '../src/jobs/backup.js';

const hasPgDump = (() => { try { execSync('pg_dump --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasPgDump)('sao lưu', () => {
  const dirs: string[] = [];
  const tmpDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'kt-backup-')); dirs.push(d); return d; };
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('tạo file .dump khác rỗng và chỉ giữ lại keep file mới nhất', async () => {
    const dir = tmpDir();
    for (const n of ['ketoan_20250101T000000.dump', 'ketoan_20250102T000000.dump']) writeFileSync(path.join(dir, n), 'x');
    const r = await runBackup({ adminUrl: process.env.DATABASE_ADMIN_URL!, dir, keep: 2 });
    expect(r.bytes).toBeGreaterThan(1000);
    expect(statSync(r.file).size).toBe(r.bytes);
    expect(r.pruned).toEqual(['ketoan_20250101T000000.dump']);
    expect(readdirSync(dir).sort()).toEqual(['ketoan_20250102T000000.dump', path.basename(r.file)].sort());
  });

  it('báo lỗi khi pg_dump thất bại và không để lại file rỗng hay xóa bản tốt', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'ketoan_20250101T000000.dump'), 'x');
    await expect(runBackup({ adminUrl: process.env.DATABASE_ADMIN_URL!.replace(/\/[^/]+$/, '/khong_ton_tai'), dir, keep: 1 })).rejects.toThrow(/pg_dump thoát mã/);
    await expect(runBackup({ adminUrl: process.env.DATABASE_ADMIN_URL!, dir, keep: 1, pgDumpPath: '/khong/co/pg_dump' })).rejects.toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual(['ketoan_20250101T000000.dump']);
  });
});
if (!hasPgDump) console.warn('CẢNH BÁO: không có pg_dump trên máy, bỏ qua test sao lưu (cài: brew install libpq && brew link --force libpq)');
