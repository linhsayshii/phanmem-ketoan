import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestUser } from '@kt/db/testing';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';
import { hashPassword } from '../src/modules/auth/service.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('xác thực', () => {
  it('đăng nhập đúng trả cookie sid và danh sách công ty; tự chọn công ty khi chỉ có một', async () => {
    const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `AU${Date.now()}` });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ tenantId, permissions: expect.arrayContaining(['voucher.post', 'user.create']) });
  });

  it('sai mật khẩu trả 401 và ghi login_event thất bại', async () => {
    const username = `sai_${Date.now()}`;
    await createTestUser(ctx.t.admin, { username, passwordHash: await hashPassword(TEST_PASSWORD) });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'khac' } });
    expect(res.statusCode).toBe(401);
    const ev = await sql<{ success: boolean }>`SELECT success FROM login_event WHERE username = ${username}`.execute(ctx.t.admin);
    expect(ev.rows).toEqual([{ success: false }]);
  });

  it('chưa đăng nhập thì route bảo vệ trả 401; đăng xuất hủy phiên', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
    const { cookie } = await bootstrapTenant(ctx, { code: `AO${Date.now()}` });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('người dùng thuộc hai công ty phải chọn công ty', async () => {
    const a = await bootstrapTenant(ctx, { code: `AM${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `AN${Date.now()}` });
    // thêm user của a vào b bằng admin
    await sql`INSERT INTO tenant_user(tenant_id, user_id, role_id)
              SELECT ${b.tenantId}::uuid, ${a.userId}::uuid, id FROM role WHERE tenant_id = ${b.tenantId}::uuid AND code = 'xem'`.execute(ctx.t.admin);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: a.username, password: TEST_PASSWORD } });
    expect(res.json()).toMatchObject({ tenantId: null, tenants: expect.arrayContaining([expect.objectContaining({ id: a.tenantId }), expect.objectContaining({ id: b.tenantId })]) });
    const cookie = `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).statusCode).toBe(409);
    const sel = await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId: b.tenantId } });
    expect(sel.statusCode).toBe(200);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().tenantId).toBe(b.tenantId);
    expect(me.json().permissions).not.toContain('user.create');
  });

  const login = (app: TestApp['app'], username: string, password: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers });
  const mk = async (p: string) => { const username = `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; await createTestUser(ctx.t.admin, { username, passwordHash: await hashPassword(TEST_PASSWORD) }); return username; };

  describe('giới hạn đăng nhập sai', () => {
    let lim: TestApp;
    beforeAll(async () => { lim = await createTestApp({ LOGIN_MAX_FAILS_USER: '3' }); });
    afterAll(async () => { await lim.close(); });

    it('sai mật khẩu đủ ngưỡng thì khóa tạm, kể cả khi nhập đúng; tên khác không bị ảnh hưởng', async () => {
      const u = await mk('lk'); const other = await mk('lko');
      for (let i = 0; i < 3; i++) expect((await login(lim.app, u, 'sai')).statusCode).toBe(401);
      const r = await login(lim.app, u, TEST_PASSWORD);
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe('LOGIN_THROTTLED');
      // lần bị chặn không tính thêm: khóa hết hạn sau lần sai thật cuối cùng, không kéo dài theo số lần thử
      expect((await sql<{ n: number }>`SELECT count(*) AS n FROM login_event WHERE username = ${u}`.execute(lim.t.admin)).rows[0]!.n).toEqual(3);
      expect((await login(lim.app, other, TEST_PASSWORD)).statusCode).toBe(200);
    });
    it('tên không tồn tại cũng bị khóa như nhau, không lộ tên có tồn tại', async () => {
      const ghost = `ghost_${Date.now()}`;
      for (let i = 0; i < 3; i++) expect((await login(lim.app, ghost, 'sai')).statusCode).toBe(401);
      expect((await login(lim.app, ghost, 'sai')).statusCode).toBe(429);
    });
    it('đăng nhập đúng trước ngưỡng thì xóa bộ đếm theo tên', async () => {
      const u2 = await mk('xd');
      await login(lim.app, u2, 'sai'); await login(lim.app, u2, 'sai');
      expect((await login(lim.app, u2, TEST_PASSWORD)).statusCode).toBe(200);
      await login(lim.app, u2, 'sai'); await login(lim.app, u2, 'sai');
      expect((await login(lim.app, u2, TEST_PASSWORD)).statusCode).toBe(200);
    });
  });

  it('quá ngưỡng theo IP thì khóa mọi tên từ IP đó', async () => {
    const ipApp = await createTestApp({ TRUST_PROXY: 'true', LOGIN_MAX_FAILS_IP: '4' });
    try {
      const h = { 'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
      for (let i = 0; i < 4; i++) expect((await login(ipApp.app, await mk('ip'), 'sai', h)).statusCode).toBe(401);
      expect((await login(ipApp.app, await mk('ip'), TEST_PASSWORD, h)).statusCode).toBe(429);
    } finally { await ipApp.close(); }
  });
});
