import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('năm tài chính', () => {
  it('tạo năm 2026 TT99 sinh 13 kỳ (0..12), không tạo trùng năm', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FY${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ periods: 13 });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/fiscal-years', headers: { cookie } });
    expect(list.json()[0]).toMatchObject({ fiscalYear: 2026, regime: 'TT99', dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    expect(list.json()[0].periods).toHaveLength(13);
    expect(list.json()[0].periods[0]).toMatchObject({ periodNo: 0, dateFrom: '2025-12-31', status: 'open' });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' } });
    expect(dup.statusCode).toBe(409);
  });
  it('năm sau phải nối tiếp ngày kết thúc năm trước', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FZ${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' } });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-02-01', months: 12, regime: 'TT99' } });
    expect(bad.json().error.code).toBe('FISCAL_YEAR_GAP');
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT99' } });
    expect(ok.statusCode).toBe(201);
  });
  it('tạo công ty mới chuyển phiên sang công ty đó và cập nhật thông tin pháp lý', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FT${Date.now()}` });
    const code = `MOI${Date.now()}`;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/tenants', headers: { cookie }, payload: { code, name: 'Công ty mới', taxCode: '0101234567' } });
    expect(r.statusCode).toBe(201);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().tenantId).toBe(r.json().id);
    await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: { legalRep: 'Nguyễn Văn A', chiefAccountant: 'Trần Thị B' } });
    const c = await ctx.app.inject({ method: 'GET', url: '/api/company', headers: { cookie } });
    expect(c.json()).toMatchObject({ code, taxCode: '0101234567', legalRep: 'Nguyễn Văn A', chiefAccountant: 'Trần Thị B' });
  });
});
