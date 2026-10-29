import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

// Đối chiếu doanh thu năm với ngưỡng NĐ 68/2026 (đã sửa bởi NĐ 141/2026): 1 tỷ (miễn, hóa đơn điện tử), 3 tỷ (phương pháp TNCN), 50 tỷ (khai tháng). Số tính tay.
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('GET /api/hkd/revenue-check', () => {
  it('ngưỡng lấy từ tham số pháp lý; doanh thu 1 tỷ chưa vượt, thêm 1 đồng thì vượt và phải dùng hóa đơn điện tử', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `TH${Date.now()}` }); const h = { cookie };
    expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: h, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT152' } })).statusCode).toBe(201);
    const g = (await ctx.app.inject({ method: 'POST', url: '/api/hkd/groups', headers: h, payload: { code: 'BH', name: 'Bán hàng' } })).json() as { id: number };
    const rev = (date: string, amount: string) => ctx.app.inject({ method: 'POST', url: '/api/hkd/entries', headers: h, payload: { entryDate: date, description: 'Bán', kind: 'revenue', amount, groupId: g.id } });
    const check = async (year = 2026) => (await ctx.app.inject({ method: 'GET', url: `/api/hkd/revenue-check?year=${year}`, headers: h })).json() as { revenue: string; thresholds: Record<string, string | null>; messages: string[] };
    await rev('2026-03-01', '600000000'); await rev('2026-06-01', '400000000');
    let r = await check();
    expect(r.thresholds).toEqual({ exempt: '1000000000', einvoice: '1000000000', pitMethod: '3000000000', vatMonthly: '50000000000' });
    expect(r.revenue).toBe('1000000000');
    expect(r.messages[0]).toContain('từ 1.000.000.000 đồng trở xuống'); expect(r.messages.some((m) => m.includes('hóa đơn điện tử'))).toBe(false);
    await rev('2026-07-01', '1');
    r = await check();
    expect(r.revenue).toBe('1000000001');
    expect(r.messages[0]).toContain('vượt 1.000.000.000 đồng'); expect(r.messages.some((m) => m.includes('phải áp dụng hóa đơn điện tử'))).toBe(true);
    expect(r.messages.some((m) => m.includes('không quá 3.000.000.000 đồng'))).toBe(true);
    await rev('2026-08-01', '2000000000');
    r = await check();
    expect(r.messages.some((m) => m.includes('trên 3.000.000.000 đồng: thuế TNCN tính theo thu nhập tính thuế'))).toBe(true);
    // năm chưa có tham số (trước 2026): báo chưa có, không đối chiếu
    const old = await check(2025);
    expect(old.thresholds.exempt).toBeNull(); expect(old.messages[0]).toContain('Chưa có tham số ngưỡng');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/hkd/revenue-check?year=abc', headers: h })).statusCode).toBe(400);
  });
});
