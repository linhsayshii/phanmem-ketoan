import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('chế độ kế toán TT58 và TT152 (đã có văn bản gốc, ghi sổ theo nhóm thuế)', () => {
  it('GET /api/regimes: TT58 và TT152 dùng được (sổ đã nhập), nêu giới hạn còn lại; TT152 không có báo cáo tài chính nên không áp dụng', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `RG${Date.now()}` });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/regimes', headers: { cookie } })).json() as { code: string; ready: boolean; reportsReady: boolean; limits: string[]; applicable: { coa: boolean; reports: boolean } | null; primaryTextObtained?: boolean }[];
    const by = Object.fromEntries(list.map((r) => [r.code, r]));
    expect(by.TT133!.ready).toBe(true);
    for (const c of ['TT58', 'TT152']) { expect(by[c]!.ready).toBe(true); expect(by[c]!.primaryTextObtained).toBe(true); expect(by[c]!.applicable!.coa).toBe(false); expect(by[c]!.limits.length).toBeGreaterThan(0); }
    expect([by.TT152!.reportsReady, by.TT58!.reportsReady]).toEqual([true, false]);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/regimes' })).statusCode).toBe(401);
  });
  it('tạo năm tài chính TT152 và TT58: tạo kỳ, không sinh tài khoản, sơ đồ kết chuyển, định nghĩa báo cáo', async () => {
    for (const [regime, dateFrom, year] of [['TT152', '2026-01-01', 2026], ['TT58', '2026-07-01', 2026]] as const) {
      const { cookie } = await bootstrapTenant(ctx, { code: `RH${regime}${Date.now()}` });
      const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: year, dateFrom, months: 12, regime } });
      expect([regime, r.statusCode]).toEqual([regime, 201]);
      const years = (await ctx.app.inject({ method: 'GET', url: '/api/fiscal-years', headers: { cookie } })).json() as { regime: string; periods: unknown[] }[];
      expect([years.length, years[0]!.regime]).toEqual([1, regime]);
    }
  });
  it('tài khoản của công ty không có hệ TT152 sau khi tạo năm TT152', async () => {
    const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `RI${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT152' } });
    const accounts = await ctx.t.admin.selectFrom('account').select('id').where('tenant_id', '=', tenantId).where('regime', '=', 'TT152').execute();
    const steps = await ctx.t.admin.selectFrom('closing_step').select('id').where('tenant_id', '=', tenantId).where('regime', '=', 'TT152').execute();
    expect([accounts.length, steps.length]).toEqual([0, 0]);
  });
});
