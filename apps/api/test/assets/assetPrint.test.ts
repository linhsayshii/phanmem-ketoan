import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { voucherFormFor } from '../../src/modules/reporting/print/forms.js';
import { assetTenant, createTestApp } from './countHelpers.js';
import type { TestApp } from '../helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('in biên bản TSCĐ', () => {
  it('in 02-TSCĐ từ biến động ghi giảm thanh lý: có nguyên giá, hao mòn đến ngày giảm, giá trị còn lại', async () => {
    const t = await assetTenant(ctx);
    const id = await t.fixed('TS01', '120000000', 60);
    for (const p of [1, 2, 3]) await t.runOk(p);
    const r = await t.ok(t.call('POST', `/api/assets/${id}/decrease`, { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }));
    const p = await t.call('GET', `/api/print/asset-event/${r.eventId}?form=02-TSCD`);
    expect(p.statusCode, p.body).toBe(200);
    // Hao mòn đến 15/03 = 2 kỳ × 2.000.000 + khấu hao một phần 967.742 = 4.967.742; giá trị còn lại 115.032.258.
    expect(p.body).toContain('BIÊN BẢN THANH LÝ TSCĐ');
    expect(p.body).toContain('Mẫu số 02 - TSCĐ');
    for (const s of ['120.000.000', '4.967.742', '115.032.258', 'TS01']) expect(p.body).toContain(s);
    // Mặc định chọn mẫu theo loại biến động; mẫu không khớp biến động thì 400.
    expect((await t.call('GET', `/api/print/asset-event/${r.eventId}`)).body).toContain('BIÊN BẢN THANH LÝ TSCĐ');
    expect((await t.call('GET', `/api/print/asset-event/${r.eventId}?form=01-TSCD`)).statusCode).toBe(400);
  });

  it('in 01-TSCĐ từ ghi tăng và 04-TSCĐ từ đánh giá lại', async () => {
    const t = await assetTenant(ctx);
    const a = await t.ok(t.call('POST', '/api/assets', { code: 'TS09', name: 'Máy khoan', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', lifeUnits: 48 }), 201);
    const inc = await t.ok(t.call('POST', `/api/assets/${a.id}/increase`, { date: '2026-01-10', reason: 'construction', counterAccountCode: '2412', amount: '240000000' }));
    const p1 = await t.call('GET', `/api/print/asset-event/${inc.eventId}?form=01-TSCD`);
    expect(p1.statusCode, p1.body).toBe(200);
    for (const s of ['BIÊN BẢN GIAO NHẬN TSCĐ', 'Mẫu số 01 - TSCĐ', '240.000.000', 'Máy khoan', 'DỤNG CỤ, PHỤ TÙNG KÈM THEO']) expect(p1.body).toContain(s);
    const rv = await t.ok(t.call('POST', `/api/assets/${a.id}/revalue`, { date: '2026-01-31', newCost: '264000000', newAccumulated: '0', counterAccountCode: '4118' }));
    const p4 = await t.call('GET', `/api/print/asset-event/${rv.eventId}`);
    expect(p4.statusCode, p4.body).toBe(200);
    for (const s of ['BIÊN BẢN ĐÁNH GIÁ LẠI TSCĐ', 'Mẫu số 04 - TSCĐ', '240.000.000', '264.000.000', '24.000.000']) expect(p4.body).toContain(s);
    expect((await t.call('GET', `/api/print/asset-event/${inc.eventId}?form=04-TSCD`)).statusCode).toBe(400);
  });

  it('in 05-TSCĐ từ biên bản kiểm kê; TT200 chưa có văn bản gốc nên không in "Mẫu số"', async () => {
    const t = await assetTenant(ctx);
    await t.fixed('TS01', '120000000', 60);
    const c = await t.ok(t.call('POST', '/api/asset-counts', { kind: 'fixed', countDate: '2026-03-31' }), 201);
    await t.ok(t.call('POST', `/api/asset-counts/${c.id}/fill`));
    const p = await t.call('GET', `/api/print/asset-count/${c.id}`);
    expect(p.statusCode, p.body).toBe(200);
    for (const s of ['BIÊN BẢN KIỂM KÊ TÀI SẢN CỐ ĐỊNH', 'Mẫu số 05 - TSCĐ', 'Theo sổ kế toán', 'Theo kiểm kê', '120.000.000']) expect(p.body).toContain(s);

    const t2 = await assetTenant(ctx, 'TT200');
    await t2.fixed('TS01', '120000000', 60);
    const c2 = await t2.ok(t2.call('POST', '/api/asset-counts', { kind: 'fixed', countDate: '2026-03-31' }), 201);
    await t2.ok(t2.call('POST', `/api/asset-counts/${c2.id}/fill`));
    const p2 = await t2.call('GET', `/api/print/asset-count/${c2.id}`);
    expect(p2.statusCode, p2.body).toBe(200);
    expect(p2.body).toContain('BIÊN BẢN KIỂM KÊ TÀI SẢN CỐ ĐỊNH');
    expect(p2.body).not.toContain('Mẫu số');
  });

  it('TT99 in mẫu 01, 02, 04, 05 - TSCĐ; TT200 không có số mẫu', () => {
    for (const k of ['01-TSCĐ', '02-TSCĐ', '04-TSCĐ', '05-TSCĐ']) {
      expect(voucherFormFor('TT99', k)?.formNo).toBe(k.replace('-', ' - '));
      expect(voucherFormFor('TT133', k)?.formNo).toBe(k.replace('-', ' - '));
      expect(voucherFormFor('TT200', k)).toBeNull();
    }
  });
});
