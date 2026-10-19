import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORD, bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('tùy chọn người dùng', () => {
  it('lưu và đọc lại bộ lọc theo người dùng, không thấy của người khác', async () => {
    const a = await bootstrapTenant(ctx, { code: `PA${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test', headers: { cookie: a.cookie } })).json()).toEqual({ value: null });
    await ctx.app.inject({ method: 'PUT', url: '/api/prefs/filter:test', headers: { cookie: a.cookie }, payload: { value: { q: 'abc', page: 2 } } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test', headers: { cookie: a.cookie } })).json()).toEqual({ value: { q: 'abc', page: 2 } });
    const b = await bootstrapTenant(ctx, { code: `PB${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test', headers: { cookie: b.cookie } })).json()).toEqual({ value: null });
  });

  it('ghi đè khi lưu lại cùng khóa và người khác trong cùng công ty không thấy', async () => {
    const a = await bootstrapTenant(ctx, { code: `PC${Date.now()}` });
    const put = (cookie: string, value: unknown) => ctx.app.inject({ method: 'PUT', url: '/api/prefs/filter:ghi-de', headers: { cookie }, payload: { value } });
    const get = async (cookie: string) => (await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:ghi-de', headers: { cookie } })).json();
    expect((await put(a.cookie, { q: 'một' })).statusCode).toBe(200);
    expect((await put(a.cookie, { q: 'hai' })).statusCode).toBe(200);
    expect(await get(a.cookie)).toEqual({ value: { q: 'hai' } });
    const username = `pref_${Date.now()}`;
    expect((await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: a.cookie }, payload: { username, fullName: 'Xem', password: TEST_PASSWORD, roleCode: 'xem' } })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const other = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect(await get(other)).toEqual({ value: null });
    await put(other, 'chuỗi');
    expect(await get(other)).toEqual({ value: 'chuỗi' });
    expect(await get(a.cookie)).toEqual({ value: { q: 'hai' } });
  });

  it('chưa đăng nhập thì 401; thiếu value thì 400', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/prefs/filter:test', payload: { value: 1 } })).statusCode).toBe(401);
    const a = await bootstrapTenant(ctx, { code: `PD${Date.now()}` });
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/prefs/filter:test', headers: { cookie: a.cookie }, payload: {} })).statusCode).toBe(400);
  });
});
