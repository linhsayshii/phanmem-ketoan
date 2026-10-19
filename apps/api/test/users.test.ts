import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('người dùng và vai trò', () => {
  it('tạo người dùng vai trò kế toán viên, người đó không có quyền user.create', async () => {
    const admin = await bootstrapTenant(ctx, { code: `US${Date.now()}` });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username: `kt_${Date.now()}`, fullName: 'Kế toán A', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: ['view_cost'] } });
    expect(created.statusCode).toBe(201);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } });
    expect(list.json()).toHaveLength(2);
    const roles = await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: admin.cookie } });
    const kt = roles.json().find((r: { code: string }) => r.code === 'ketoan_vien');
    expect(kt.permissions).toContain('voucher.post');
    expect(kt.permissions).not.toContain('voucher.unpost');
    expect(kt.permissions).not.toContain('user.create');
  });

  it('người không có quyền bị 403', async () => {
    const admin = await bootstrapTenant(ctx, { code: `UV${Date.now()}` });
    const username = `xem_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const res = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'xyz', fullName: 'x', password: 'Matkhau1!', roleCode: 'xem' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('không sửa được người dùng của công ty khác (404) và mật khẩu của họ không đổi', async () => {
    const x = await bootstrapTenant(ctx, { code: `UX${Date.now()}` });
    const y = await bootstrapTenant(ctx, { code: `UY${Date.now()}` });
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/users/${y.userId}`, headers: { cookie: x.cookie }, payload: { password: 'Doimatkhau1!' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('USER_NOT_FOUND');
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: y.username, password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(200);
  });
});
