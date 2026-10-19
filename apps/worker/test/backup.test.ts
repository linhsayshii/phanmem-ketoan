import '../src/env.js';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runBackup } from '../src/jobs/backup.js';

const hasPgDump = (() => { try { execSync('pg_dump --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('BACKUP_DIR trong env.ts', () => {
  it('đường dẫn tương đối được tính từ gốc repo, đường dẫn tuyệt đối giữ nguyên', async () => {
    const prev = process.env.BACKUP_DIR;
    try {
      process.env.BACKUP_DIR = './backups'; vi.resetModules(); await import('../src/env.js');
      expect(process.env.BACKUP_DIR).toBe(path.join(repoRoot, 'backups'));
      process.env.BACKUP_DIR = '/backups'; vi.resetModules(); await import('../src/env.js');
      expect(process.env.BACKUP_DIR).toBe('/backups');
    } finally { if (prev === undefined) delete process.env.BACKUP_DIR; else process.env.BACKUP_DIR = prev; }
  });
});

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
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('báo lỗi khi pg_dump thất bại và không để lại file rỗng, file .part hay xóa bản tốt', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'ketoan_20250101T000000.dump'), 'x');
    await expect(runBackup({ adminUrl: process.env.DATABASE_ADMIN_URL!.replace(/\/[^/]+$/, '/khong_ton_tai'), dir, keep: 1 })).rejects.toThrow(/pg_dump thoát mã/);
    await expect(runBackup({ adminUrl: process.env.DATABASE_ADMIN_URL!, dir, keep: 1, pgDumpPath: '/khong/co/pg_dump' })).rejects.toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual(['ketoan_20250101T000000.dump']);
  });

  // pg_dump giả: tham số thứ 4 là giá trị của --file
  const fakeDump = (dir: string, body: string) => {
    const p = path.join(dir, 'fake-pg-dump.sh');
    writeFileSync(p, `#!/bin/sh\ncase "$4" in *.part) ;; *) exit 9;; esac\necho dang-do > "$4"\n${body}\n`, { mode: 0o755 });
    return p;
  };

  it('chỉ đổi tên .part thành file cuối sau khi pg_dump thoát mã 0', async () => {
    const dir = tmpDir();
    const r = await runBackup({ adminUrl: 'x', dir, keep: 5, pgDumpPath: fakeDump(dir, '[ -e "${4%.part}" ] && exit 8\nexit 0') });
    expect(readFileSync(r.file, 'utf8')).toBe('dang-do\n');
    expect(existsSync(`${r.file}.part`)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['fake-pg-dump.sh', path.basename(r.file)]);
  });

  it.each([['thoát mã khác 0', 'exit 3', /pg_dump thoát mã 3/], ['bị giết bằng tín hiệu', 'kill -KILL $$', /pg_dump thoát mã null/]])('pg_dump %s giữa chừng không để lại file dở dang', async (_t, body, re) => {
    const dir = tmpDir();
    await expect(runBackup({ adminUrl: 'x', dir, keep: 5, pgDumpPath: fakeDump(dir, body) })).rejects.toThrow(re);
    expect(readdirSync(dir)).toEqual(['fake-pg-dump.sh']);
  });
});
if (!hasPgDump) console.warn('CẢNH BÁO: không có pg_dump trên máy, bỏ qua test sao lưu (cài: brew install libpq && brew link --force libpq)');
