import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface BackupOpts { adminUrl: string; dir: string; keep: number; pgDumpPath?: string }

export async function runBackup(opts: BackupOpts): Promise<{ file: string; bytes: number; pruned: string[] }> {
  mkdirSync(opts.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const file = path.join(opts.dir, `ketoan_${stamp}.dump`);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(opts.pgDumpPath ?? 'pg_dump', ['--format=custom', '--no-owner', '--file', file, '--dbname', opts.adminUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', reject); p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump thoát mã ${code}: ${err}`))));
    });
  } catch (e) {
    rmSync(file, { force: true }); // pg_dump để lại file rỗng khi lỗi: không để nó chiếm chỗ bản tốt trong đợt dọn
    throw e;
  }
  const all = readdirSync(opts.dir).filter((f) => /^ketoan_\d{8}T\d{6}\.dump$/.test(f)).sort();
  const pruned = all.slice(0, Math.max(0, all.length - opts.keep));
  for (const f of pruned) unlinkSync(path.join(opts.dir, f));
  return { file, bytes: statSync(file).size, pruned };
}
