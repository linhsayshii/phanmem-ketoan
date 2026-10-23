import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assetTenant, createTestApp } from './countHelpers.js';
import type { TestApp } from '../helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('kiểm kê TSCĐ (05 - TSCĐ)', () => {
  it('kiểm kê TSCĐ cuối tháng 3: fill điền nguyên giá và giá trị còn lại tại ngày; TS thiếu hiện chênh lệch số lượng -1', async () => {
    const t = await assetTenant(ctx);
    const a = await t.fixed('TS01', '120000000', 60); await t.fixed('TS02', '36000000', 36);
    for (const p of [1, 2, 3]) await t.runOk(p);
    const c = await t.ok(t.call('POST', '/api/asset-counts', { kind: 'fixed', countDate: '2026-03-31', members: [{ name: 'Nguyễn Văn A', role: 'Trưởng ban' }] }), 201);
    expect(c).toMatchObject({ status: 'draft', lines: [] });
    const f = await t.ok(t.call('POST', `/api/asset-counts/${c.id}/fill`));
    expect(f.lines.map((l: { code: string }) => l.code)).toEqual(['TS01', 'TS02']);
    expect(f.lines[0]).toMatchObject({ bookQuantity: '1.0000', bookCost: '120000000', bookNbv: '114000000', actualQuantity: null, suggestion: null });
    expect(f.lines[1]).toMatchObject({ bookCost: '36000000', bookNbv: '33000000' });
    // Chưa nhập hết số kiểm kê thì chưa hoàn thành được.
    expect((await t.call('POST', `/api/asset-counts/${c.id}/finish`)).statusCode).toBe(400);
    const u = await t.ok(t.call('PUT', `/api/asset-counts/${c.id}`, { lines: [{ assetId: a, actualQuantity: '1', condition: 'Tốt' }, { assetId: a + 1, actualQuantity: '0', note: 'Không tìm thấy' }] }));
    expect(u.lines[0]).toMatchObject({ diffQuantity: '0.0000', diffCost: '0', diffNbv: '0', suggestion: null });
    expect(u.lines[1]).toMatchObject({ actualQuantity: '0.0000', diffQuantity: '-1.0000', actualCost: '0', actualNbv: '0', diffCost: '-36000000', diffNbv: '-33000000', suggestion: 'decrease' });
    // Điền lại giữ số kiểm kê đã nhập.
    const again = await t.ok(t.call('POST', `/api/asset-counts/${c.id}/fill`));
    expect(again.lines[1]).toMatchObject({ actualQuantity: '0.0000' });
    expect(await t.ok(t.call('POST', `/api/asset-counts/${c.id}/finish`))).toMatchObject({ status: 'done' });
    expect((await t.call('PUT', `/api/asset-counts/${c.id}`, { lines: [] })).statusCode).toBe(409);
    expect((await t.call('DELETE', `/api/asset-counts/${c.id}`)).statusCode).toBe(409);
    expect(await t.ok(t.call('GET', '/api/asset-counts'))).toHaveLength(1);
  });

  it('TS ghi giảm trước ngày kiểm kê không có trong biên bản; xóa được biên bản nháp', async () => {
    const t = await assetTenant(ctx);
    const a = await t.fixed('TS01', '120000000', 60); await t.fixed('TS02', '36000000', 36);
    for (const p of [1, 2, 3]) await t.runOk(p);
    await t.ok(t.call('POST', `/api/assets/${a}/decrease`, { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }));
    const c = await t.ok(t.call('POST', '/api/asset-counts', { kind: 'fixed', countDate: '2026-03-31' }), 201);
    expect((await t.ok(t.call('POST', `/api/asset-counts/${c.id}/fill`))).lines.map((l: { code: string }) => l.code)).toEqual(['TS02']);
    expect((await t.call('DELETE', `/api/asset-counts/${c.id}`)).statusCode).toBe(204);
    expect((await t.call('GET', `/api/asset-counts/${c.id}`)).statusCode).toBe(404);
  });
});
