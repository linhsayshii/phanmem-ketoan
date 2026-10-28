import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('chế độ kế toán TT58 và TT152 (chờ văn bản gốc)', () => {
  it('GET /api/regimes: TT58 và TT152 chưa sẵn sàng, kèm danh sách văn bản còn thiếu; TT133 sẵn sàng', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `RG${Date.now()}` });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/regimes', headers: { cookie } })).json() as { code: string; ready: boolean; missing: string[] }[];
    const by = Object.fromEntries(list.map((r) => [r.code, r]));
    expect(by.TT133!.ready).toBe(true);
    for (const c of ['TT58', 'TT152']) { expect(by[c]!.ready).toBe(false); expect(by[c]!.missing.length).toBeGreaterThan(0); }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/regimes' })).statusCode).toBe(401);
  });
  it('tạo năm tài chính TT152 bị từ chối 409 COA_TEMPLATE_PENDING và không để lại kỳ nào', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `RH${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT152' } });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'COA_TEMPLATE_PENDING']);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/fiscal-years', headers: { cookie } })).json()).toEqual([]);
  });
});
