import { mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface BackupOpts { adminUrl: string; dir: string; keep: number; pgDumpPath?: string }

export async function runBackup(opts: BackupOpts): Promise<{ file: string; bytes: number; pruned: string[] }> {
  mkdirSync(opts.dir, { recursive: true });
  for (const f of readdirSync(opts.dir)) if (/^ketoan_\d{8}T\d{6}\.dump\.part$/.test(f)) rmSync(path.join(opts.dir, f), { force: true }); // file dở dang do bị giết cứng ở lần trước
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const file = path.join(opts.dir, `ketoan_${stamp}.dump`);
  const part = `${file}.part`; // chỉ đổi tên thành file cuối khi pg_dump xong, nên không bao giờ có file .dump dở dang
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(opts.pgDumpPath ?? 'pg_dump', ['--format=custom', '--no-owner', '--file', part, '--dbname', opts.adminUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', reject); p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump thoát mã ${code}: ${err}`))));
    });
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true }); // pg_dump để lại file rỗng/dở dang khi lỗi hoặc bị giết
    throw e;
  }
  const all = readdirSync(opts.dir).filter((f) => /^ketoan_\d{8}T\d{6}\.dump$/.test(f)).sort();
  const pruned = all.slice(0, Math.max(0, all.length - opts.keep));
  for (const f of pruned) unlinkSync(path.join(opts.dir, f));
  return { file, bytes: statSync(file).size, pruned };
}
