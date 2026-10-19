import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('nhật ký kiểm toán', () => {
  it('lọc theo thực thể và hành động, có tên người dùng, không thấy của công ty khác', async () => {
    const a = await bootstrapTenant(ctx, { code: `AL${Date.now()}` });
    const c = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie: a.cookie }, payload: { code: 'HC', name: 'Hành chính' } });
    await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/department/${c.json().id}`, headers: { cookie: a.cookie }, payload: { name: 'Hành chính nhân sự' } });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/audit?entity=department&action=update', headers: { cookie: a.cookie } });
    expect(r.json().total).toBe(1);
    expect(r.json().rows[0]).toMatchObject({ username: a.username, entity: 'department', action: 'update', before: { name: 'Hành chính' }, after: { name: 'Hành chính nhân sự' } });
    const b = await bootstrapTenant(ctx, { code: `AK${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/audit?entity=department', headers: { cookie: b.cookie } })).json().total).toBe(0);
  });
  it('lọc theo mã thực thể, người dùng, khoảng ngày và phân trang (mới nhất trước)', async () => {
    const a = await bootstrapTenant(ctx, { code: `AM${Date.now()}` });
    const ids: string[] = [];
    for (const code of ['P1', 'P2', 'P3']) {
      ids.push((await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie: a.cookie }, payload: { code, name: code } })).json().id);
    }
    const get = async (qs: string) => (await ctx.app.inject({ method: 'GET', url: `/api/audit?entity=department&${qs}`, headers: { cookie: a.cookie } })).json();
    expect((await get(`entityId=${ids[1]}`)).rows.map((x: { entityId: string }) => x.entityId)).toEqual([ids[1]]);
    expect((await get(`userId=${a.userId}`)).total).toBe(3);
    expect((await get('userId=00000000-0000-4000-8000-000000000000')).total).toBe(0);
    expect((await get('from=2000-01-01&to=2000-01-02')).total).toBe(0);
    expect((await get('from=2000-01-01&to=2100-12-31')).total).toBe(3);
    const p1 = await get('size=2&page=1'), p2 = await get('size=2&page=2');
    expect([p1.total, p1.rows.length, p2.total, p2.rows.length]).toEqual([3, 2, 3, 1]);
    expect(p1.rows.map((x: { entityId: string }) => x.entityId)).toEqual([ids[2], ids[1]]);
    expect(p2.rows[0].entityId).toBe(ids[0]);
  });
  it('nhật ký đăng nhập liệt kê lần đăng nhập của người dùng công ty', async () => {
    const a = await bootstrapTenant(ctx, { code: `AJ${Date.now()}` });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/audit/logins', headers: { cookie: a.cookie } });
    expect(r.json().rows[0]).toMatchObject({ username: a.username, success: true });
  });
  it('nhật ký đăng nhập chỉ của người dùng công ty hiện tại, có cả lần thất bại, lọc được theo ngày', async () => {
    const a = await bootstrapTenant(ctx, { code: `AH${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `AG${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: a.username, password: 'sai-mat-khau' } });
    const logins = async (qs = '') => (await ctx.app.inject({ method: 'GET', url: `/api/audit/logins${qs}`, headers: { cookie: a.cookie } })).json() as { rows: { username: string; success: boolean }[]; total: number };
    const all = await logins();
    expect(all.rows.map((x) => [x.username, x.success])).toEqual([[a.username, false], [a.username, true]]);
    expect(all.total).toBe(2);
    expect(all.rows.some((x) => x.username === b.username)).toBe(false);
    expect((await logins('?from=2000-01-01&to=2000-01-02')).total).toBe(0);
    expect((await logins('?size=1&page=2')).rows).toHaveLength(1);
  });
  it('người không có quyền audit.view bị 403', async () => {
    const a = await bootstrapTenant(ctx, { code: `AI${Date.now()}` });
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: a.cookie } })).json() as { id: string; code: string; permissions: string[] }[];
    const xem = roles.find((r) => r.code === 'xem')!;
    await ctx.app.inject({ method: 'PUT', url: `/api/roles/${xem.id}/permissions`, headers: { cookie: a.cookie }, payload: { permissions: xem.permissions.filter((p) => p !== 'audit.view') } });
    const username = `kt_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: a.cookie }, payload: { username, fullName: 'KT', password: TEST_PASSWORD, roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/audit/logins', headers: { cookie } })).statusCode).toBe(403);
  });
});
