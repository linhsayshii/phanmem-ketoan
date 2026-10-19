import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('tùy chọn hệ thống', () => {
  it('mặc định đầy đủ, cập nhật từng phần, từ chối giá trị sai', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `ST${Date.now()}` });
    const d = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(d.json()).toEqual({ book_form: 'NKC', costing_method: 'avg_period', base_currency: 'VND', hidden_modules: [], extra_dims: [], fx_rate_type: 'transfer_avg' });
    const u = await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { costing_method: 'fifo', extra_dims: [{ key: 'ma_thong_ke', label: 'Mã thống kê' }] } });
    expect(u.statusCode).toBe(200);
    const d2 = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(d2.json()).toMatchObject({ costing_method: 'fifo', book_form: 'NKC', extra_dims: [{ key: 'ma_thong_ke', label: 'Mã thống kê' }] });
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { costing_method: 'lifo' } });
    expect(bad.statusCode).toBe(400);
  });
});
