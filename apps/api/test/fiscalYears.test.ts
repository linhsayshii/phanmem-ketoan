import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('năm tài chính', () => {
  it('tạo năm 2026 TT133 sinh 13 kỳ (0..12), không tạo trùng năm', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FY${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ periods: 13 });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/fiscal-years', headers: { cookie } });
    expect(list.json()[0]).toMatchObject({ fiscalYear: 2026, regime: 'TT133', dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    expect(list.json()[0].periods).toHaveLength(13);
    expect(list.json()[0].periods[0]).toMatchObject({ periodNo: 0, dateFrom: '2025-12-31', status: 'open' });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    expect(dup.statusCode).toBe(409);
  });
  it('sơ đồ kết chuyển nạp theo chế độ của năm tài chính', async () => {
    const stepsOf = async (regime: string) => {
      const { cookie } = await bootstrapTenant(ctx, { code: `FK${regime}${Date.now()}` });
      await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime } });
      const steps = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { fromAccounts: string[]; toAccount: string }[];
      const reload = await ctx.app.inject({ method: 'POST', url: '/api/closing/steps/reload', headers: { cookie } });
      expect(reload.statusCode, reload.body).toBe(200);
      return { steps, reloaded: reload.json().count as number };
    };
    const t99 = await stepsOf('TT99');
    expect(t99.steps[0]).toMatchObject({ fromAccounts: ['521'], toAccount: '511' });
    const t133 = await stepsOf('TT133');
    expect(t133.steps.flatMap((s) => s.fromAccounts)).not.toContain('521');
    expect(t133.reloaded).toBe(t133.steps.length);
  });
  it('năm mới đổi chế độ thì thêm sơ đồ kết chuyển của chế độ mới, giữ sơ đồ cũ; chưa có năm thì nạp lại bị từ chối', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FR${Date.now()}` });
    const steps = async (regime: string) => (await ctx.app.inject({ method: 'GET', url: `/api/closing/steps?regime=${regime}`, headers: { cookie } })).json() as { stepOrder: number; fromAccounts: string[]; toAccount: string }[];
    const noYear = await ctx.app.inject({ method: 'POST', url: '/api/closing/steps/reload', headers: { cookie } });
    expect([noYear.statusCode, noYear.json().error.code]).toEqual([409, 'NO_FISCAL_YEAR']);
    const mk = (fiscalYear: number, regime: string) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime } });
    expect((await mk(2026, 'TT133')).statusCode).toBe(201);
    expect((await steps('TT133')).flatMap((s) => s.fromAccounts)).not.toContain('521');
    expect((await mk(2027, 'TT99')).statusCode).toBe(201);
    expect((await steps('TT99'))[0]).toMatchObject({ stepOrder: 1, fromAccounts: ['521'], toAccount: '511' });
    expect((await steps('TT133')).flatMap((s) => s.fromAccounts)).not.toContain('521'); // sơ đồ TT133 còn nguyên
  });
  it('năm sau phải nối tiếp ngày kết thúc năm trước', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FZ${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-02-01', months: 12, regime: 'TT133' } });
    expect(bad.json().error.code).toBe('FISCAL_YEAR_GAP');
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT133' } });
    expect(ok.statusCode).toBe(201);
  });
  it('ngày bắt đầu không phải ngày đầu tháng bị từ chối 400 VALIDATION, không phải 500', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FD${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-15', months: 12, regime: 'TT99' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
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
  it('sửa công ty: thân rỗng không gây lỗi, null xóa trường, mã trùng không đổi phiên', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FE${Date.now()}` });
    const empty = await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: {} });
    expect(empty.statusCode).toBe(200);
    await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: { phone: '0901234567', address: 'Hà Nội' } });
    const cleared = await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: { phone: null } });
    expect(cleared.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/company', headers: { cookie } })).json()).toMatchObject({ phone: null, address: 'Hà Nội' });
    const code = `DUP${Date.now()}`;
    const first = await ctx.app.inject({ method: 'POST', url: '/api/tenants', headers: { cookie }, payload: { code, name: 'A' } });
    expect(first.statusCode).toBe(201);
    const again = await ctx.app.inject({ method: 'POST', url: '/api/tenants', headers: { cookie }, payload: { code, name: 'B' } });
    expect(again.statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().tenantId).toBe(first.json().id);
  });
  // GĐ7 gói 2 (C4, TB6): chế độ chưa sẵn sàng hoặc ngoài hiệu lực không tạo được năm tài chính nếu không xác nhận rõ.
  it('TT200 chưa đối chiếu và hết hiệu lực từ 2026: 409 REGIME_NOT_READY; TT99 cho năm 2025: 409 REGIME_NOT_EFFECTIVE; xác nhận rõ thì tạo được và có audit_event', async () => {
    const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `FG${Date.now()}` });
    const mk = (fiscalYear: number, regime: string, more: object = {}) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime, ...more } });
    const e = (r: { statusCode: number; json: () => { error?: { code?: string } } }) => [r.statusCode, r.json().error?.code];
    expect(e(await mk(2025, 'TT200'))).toEqual([409, 'REGIME_NOT_READY']); // chưa đối chiếu Phụ lục 1 dù năm 2025 còn trong hiệu lực
    expect(e(await mk(2025, 'TT99'))).toEqual([409, 'REGIME_NOT_EFFECTIVE']);
    expect(e(await mk(2025, 'TT99', { confirmRegimeOverride: false }))).toEqual([409, 'REGIME_NOT_EFFECTIVE']);
    expect((await mk(2025, 'TT200', { confirmRegimeOverride: true })).statusCode).toBe(201);
    expect(e(await mk(2026, 'TT200'))).toEqual([409, 'REGIME_NOT_READY']);
    expect((await mk(2026, 'TT99')).statusCode).toBe(201); // TT99 từ 2026: không cần xác nhận
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'fiscal_year_regime_override'`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
    const { cookie: c2 } = await bootstrapTenant(ctx, { code: `FH${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c2 }, payload: { fiscalYear: 2025, dateFrom: '2025-01-01', months: 12, regime: 'TT99', confirmRegimeOverride: true } });
    expect(r.statusCode, r.body).toBe(201); // ngoài hiệu lực nhưng đã xác nhận
    const none = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c2 }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT58', confirmRegimeOverride: true } });
    expect(e(none)).toEqual([409, 'COA_TEMPLATE_PENDING']); // chế độ chưa có dữ liệu: xác nhận không mở được
  });
});
