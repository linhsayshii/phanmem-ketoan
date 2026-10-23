import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('tùy chọn hệ thống', () => {
  it('mặc định đầy đủ, cập nhật từng phần, từ chối giá trị sai', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `ST${Date.now()}` });
    const d = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(d.json()).toEqual({ book_form: 'NKC', costing_method: 'avg_period', base_currency: 'VND', hidden_modules: [], extra_dims: [], fx_rate_type: 'transfer_avg', cash_negative: 'warn', fx_outflow_method: 'moving_average', fx_reval_rate_asset: null, fx_reval_rate_liability: null, vat_period: 'month', stock_negative: 'forbid', fa_proration: 'day' });
    const u = await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { costing_method: 'fifo', extra_dims: [{ key: 'ma_thong_ke', label: 'Mã thống kê' }] } });
    expect(u.statusCode).toBe(200);
    const d2 = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(d2.json()).toMatchObject({ costing_method: 'fifo', book_form: 'NKC', extra_dims: [{ key: 'ma_thong_ke', label: 'Mã thống kê' }] });
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { costing_method: 'lifo' } });
    expect(bad.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { vat_period: 'quarter' } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json()).toMatchObject({ vat_period: 'quarter' });
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { vat_period: 'year' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { stock_negative: 'x' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { stock_negative: 'warn' } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json()).toMatchObject({ stock_negative: 'warn' });
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { fa_proration: 'week' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { fa_proration: 'month' } })).statusCode).toBe(200);
  });
  it('đổi fa_proration khi đã có lần chạy khấu hao hiệu lực → 409 FA_PRORATION_LOCKED; gửi lại giá trị cũ vẫn được', async () => {
    const { cookie, tenantId } = await setupLedgerTenant(ctx, `FP${Date.now()}`);
    const put = (fa_proration: string) => ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { fa_proration, vat_period: 'month' } });
    expect((await put('month')).statusCode).toBe(200);
    await ctx.t.admin.insertInto('period_run').values({ tenant_id: tenantId, kind: 'depreciation', fiscal_year: 2026, period_no: 1, result: '{}' }).execute();
    const r = await put('day');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'FA_PRORATION_LOCKED' });
    expect(r.json().error.message).toContain('khấu hao tháng đầu, tháng cuối');
    expect((await put('month')).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json()).toMatchObject({ fa_proration: 'month' });
  });
  it('công ty mới: ketoan_vien có asset.create, loan.create; không có asset.run, loan.run; xem có asset.view', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `GD4${Date.now()}` });
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie } })).json() as { code: string; permissions: string[] }[];
    const perms = async (code: string) => roles.find((r) => r.code === code)!.permissions;
    const kt = await perms('ketoan_vien'); const xem = await perms('xem');
    expect(kt).toEqual(expect.arrayContaining(['asset.create', 'loan.create', 'period_close.view']));
    expect(kt).not.toContain('asset.run'); expect(kt).not.toContain('loan.run');
    expect(xem).toContain('asset.view'); expect(xem).not.toContain('asset.create');
  });
});
