import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
const jobIds: string[] = [];
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => {
  // chỉ xóa đúng job mà test này tạo (singleton 60 giây làm lần chạy lại liền sau nhận 409 nếu bỏ sót)
  await sql`DELETE FROM pgboss.job WHERE name = 'backup' AND id = ANY(${jobIds}::uuid[])`.execute(ctx.t.admin);
  await ctx.close();
});

describe('sao lưu', () => {
  it('đưa job vào hàng đợi backup; bấm lần hai liền sau bị 409', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `BK${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/backup/run', headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(typeof r.json().jobId).toBe('string');
    jobIds.push(r.json().jobId);
    const job = await ctx.app.boss!.getJobById('backup', r.json().jobId);
    expect(job?.name).toBe('backup');
    expect(job?.retryLimit).toBe(3);
    expect(job?.retryDelay).toBe(60);
    const again = await ctx.app.inject({ method: 'POST', url: '/api/backup/run', headers: { cookie } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('BACKUP_ALREADY_QUEUED');
  });

  it('liệt kê các file .dump trong thư mục sao lưu, mới nhất trước', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `BL${Date.now()}` });
    const dir = mkdtempSync(path.join(tmpdir(), 'kt-api-backup-'));
    const prev = ctx.app.config.BACKUP_DIR;
    try {
      for (const n of ['ketoan_20250101T000000.dump', 'ketoan_20250102T000000.dump', 'ghi-chu.txt', 'ketoan_20250103T000000.dump.part']) writeFileSync(path.join(dir, n), 'abc');
      ctx.app.config.BACKUP_DIR = dir;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual([
        { name: 'ketoan_20250102T000000.dump', bytes: 3, mtime: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) },
        { name: 'ketoan_20250101T000000.dump', bytes: 3, mtime: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) },
      ]);
      // thư mục chưa có: danh sách rỗng; lỗi khác (đường dẫn là file → ENOTDIR) không bị nuốt
      ctx.app.config.BACKUP_DIR = path.join(dir, 'khong-ton-tai');
      expect((await ctx.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } })).json()).toEqual([]);
      ctx.app.config.BACKUP_DIR = path.join(dir, 'ghi-chu.txt');
      const bad = await ctx.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
      expect(bad.statusCode).toBe(500);
      expect(bad.json().error.code).toBe('INTERNAL');
    } finally { ctx.app.config.BACKUP_DIR = prev; rmSync(dir, { recursive: true, force: true }); }
  });

  it('người không có quyền backup.run bị 403 ở cả hai route', async () => {
    const admin = await bootstrapTenant(ctx, { code: `BF${Date.now()}` });
    const username = `xem_bk_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    for (const [method, url] of [['POST', '/api/backup/run'], ['GET', '/api/backup']] as const) {
      const res = await ctx.app.inject({ method, url, headers: { cookie } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });
});

describe('BACKUP_DIR trong env.ts của api', () => {
  it('đường dẫn tương đối được tính từ gốc repo, đường dẫn tuyệt đối giữ nguyên', async () => {
    const prev = process.env.BACKUP_DIR;
    try {
      process.env.BACKUP_DIR = './backups'; vi.resetModules(); await import('../src/env.js');
      expect(process.env.BACKUP_DIR).toBe(path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'backups'));
      process.env.BACKUP_DIR = '/backups'; vi.resetModules(); await import('../src/env.js');
      expect(process.env.BACKUP_DIR).toBe('/backups');
    } finally { if (prev === undefined) delete process.env.BACKUP_DIR; else process.env.BACKUP_DIR = prev; }
  });
});
