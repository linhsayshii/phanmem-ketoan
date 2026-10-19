import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('sao lưu', () => {
  it('đưa job vào hàng đợi backup', async () => {
    // singletonSeconds: 60 chặn bấm trùng, nên chạy lại test trong vòng 1 phút sẽ nhận jobId null nếu job cũ còn
    await sql`DELETE FROM pgboss.job WHERE name = 'backup'`.execute(ctx.t.admin);
    const { cookie } = await bootstrapTenant(ctx, { code: `BK${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/backup/run', headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(typeof r.json().jobId).toBe('string');
    const job = await ctx.app.boss!.getJobById('backup', r.json().jobId);
    expect(job?.name).toBe('backup');
  });

  it('liệt kê các file .dump trong thư mục sao lưu, mới nhất trước', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `BL${Date.now()}` });
    const dir = mkdtempSync(path.join(tmpdir(), 'kt-api-backup-'));
    const prev = ctx.app.config.BACKUP_DIR;
    try {
      for (const n of ['ketoan_20250101T000000.dump', 'ketoan_20250102T000000.dump', 'ghi-chu.txt']) writeFileSync(path.join(dir, n), 'abc');
      ctx.app.config.BACKUP_DIR = dir;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual([
        { name: 'ketoan_20250102T000000.dump', bytes: 3, mtime: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) },
        { name: 'ketoan_20250101T000000.dump', bytes: 3, mtime: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) },
      ]);
      ctx.app.config.BACKUP_DIR = path.join(dir, 'khong-ton-tai');
      expect((await ctx.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } })).json()).toEqual([]);
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
