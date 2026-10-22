import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let cookie: string;
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const draft = async (type: 'PNK' | 'PXK', date: string, item: string, qty: string, uom = 'CAI') => {
  const r = await call('POST', '/api/stock-vouchers', { voucherType: type, stockKind: type === 'PNK' ? 'purchase' : 'sale', postingDate: date, warehouseCode: 'K1', ...(type === 'PNK' && { partyCode: 'NCC1' }),
    description: 'Phiếu kho', items: [{ itemCode: item, uomCode: uom, quantity: qty, ...(type === 'PNK' && { unitPrice: '10' }) }] });
  expect(r.statusCode, r.body).toBe(201); return r.json().id as string;
};
const post = (id: string) => call('POST', `/api/vouchers/${id}/post`, {});
const okPost = async (id: string) => { const r = await post(id); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const setNeg = async (v: string) => expect((await call('PUT', '/api/settings', { stock_negative: v })).statusCode).toBe(200);

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `KS${Date.now()}` }));
  await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  for (const [code, name] of [['CAI', 'Cái'], ['CHAI', 'Chai'], ['THUNG', 'Thùng']]) await call('POST', '/api/catalogs/uom', { code, name });
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) await cat('item', { code: `H${c}`, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods' });
  await cat('item', { code: 'NUOC', name: 'Nước', base_uom_code: 'CHAI', kind: 'goods' });
  await cat('item_uom', { item_code: 'NUOC', uom_code: 'THUNG', factor: '24' });
});
afterAll(async () => { await ctx.close(); });

describe('kiểm soát tồn', () => {
  it('forbid: xuất quá tồn bị 409 STOCK_NEGATIVE nêu hàng, kho, ngày, số thiếu', async () => {
    await okPost(await draft('PNK', '2026-02-01', 'HA', '10'));
    const r = await post(await draft('PXK', '2026-02-05', 'HA', '15'));
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({ code: 'STOCK_NEGATIVE', message: 'Hàng HA ở kho K1 thiếu 5 tại ngày 05/02/2026', details: { itemCode: 'HA', warehouseCode: 'K1', date: '2026-02-05', shortBy: '5' } });
  });

  it('ghi lùi phiếu xuất làm tồn ngày giữa âm: từ chối, nêu ngày bị âm', async () => {
    await okPost(await draft('PNK', '2026-03-01', 'HB', '10'));
    await okPost(await draft('PXK', '2026-03-10', 'HB', '4'));
    const r = await post(await draft('PXK', '2026-03-05', 'HB', '8')); // 05/03 còn 2, 10/03 âm 2
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'STOCK_NEGATIVE', details: { itemCode: 'HB', date: '2026-03-10', shortBy: '2' } });
  });

  it('bỏ ghi sổ phiếu nhập đã xuất: 409 STOCK_CONSUMED nêu phiếu xuất; đảo phiếu nhập đã xuất một phần: 409 STOCK_NEGATIVE', async () => {
    const pn = await okPost(await draft('PNK', '2026-04-01', 'HC', '10'));
    const px = await okPost(await draft('PXK', '2026-04-02', 'HC', '6'));
    const u = await call('POST', `/api/vouchers/${pn.id}/unpost`, {});
    expect(u.statusCode, u.body).toBe(409);
    expect(u.json().error.code).toBe('STOCK_CONSUMED'); expect(u.json().error.message).toContain(px.voucherNo);
    const rv = await call('POST', `/api/vouchers/${pn.id}/reverse`, { postingDate: '2026-04-03' });
    expect(rv.statusCode, rv.body).toBe(409);
    expect(rv.json().error).toMatchObject({ code: 'STOCK_NEGATIVE', details: { itemCode: 'HC', shortBy: '6' } });
  });

  it('cùng ngày nhập trước xuất: phiếu nhập day_order lớn vẫn bù cho phiếu xuất cùng ngày (kiểm tồn cuối ngày)', async () => {
    await okPost(await draft('PNK', '2026-05-01', 'HD', '10'));
    const x = await draft('PXK', '2026-05-10', 'HD', '15'); const n = await draft('PNK', '2026-05-10', 'HD', '5');
    expect((await call('PUT', `/api/vouchers/${n}/day-order`, { dayOrder: 9 })).statusCode).toBe(200);
    expect((await call('PUT', `/api/vouchers/${x}/day-order`, { dayOrder: 1 })).statusCode).toBe(200);
    await okPost(n); await okPost(x);
  });

  it('day-order chỉ cho phiếu kho nháp', async () => {
    const id = await draft('PNK', '2026-05-11', 'HD', '1'); await okPost(id);
    expect((await call('PUT', `/api/vouchers/${id}/day-order`, { dayOrder: 2 })).statusCode).toBe(409);
    expect((await call('PUT', `/api/vouchers/${crypto.randomUUID()}/day-order`, { dayOrder: 2 })).statusCode).toBe(404);
  });

  it('warn: xuất quá tồn ghi sổ được và trả warnings; đảo phiếu nhập cũng cảnh báo', async () => {
    await okPost(await draft('PNK', '2026-06-01', 'HE', '10'));
    const pn = await okPost(await draft('PNK', '2026-06-01', 'HF', '10'));
    await setNeg('warn');
    const x = await okPost(await draft('PXK', '2026-06-02', 'HE', '14'));
    expect(x.warnings).toEqual([{ code: 'STOCK_NEGATIVE', message: 'Hàng HE ở kho K1 thiếu 4 tại ngày 02/06/2026', itemCode: 'HE', warehouseCode: 'K1', date: '2026-06-02', shortBy: '4' }]);
    await okPost(await draft('PXK', '2026-06-02', 'HF', '3'));
    const rv = await call('POST', `/api/vouchers/${pn.id}/reverse`, { postingDate: '2026-06-03' });
    expect(rv.statusCode, rv.body).toBe(201); expect(rv.json().warnings[0]).toMatchObject({ code: 'STOCK_NEGATIVE', itemCode: 'HF', shortBy: '3' });
    await setNeg('forbid');
  });

  it('on-hand theo ĐVT THUNG làm tròn 4 chữ số; ĐVT lạ 404', async () => {
    await okPost(await draft('PNK', '2026-07-01', 'NUOC', '100', 'CHAI'));
    const r = await call('GET', '/api/inventory/on-hand?itemCode=NUOC&warehouseCode=K1&date=2026-07-01&uomCode=THUNG');
    expect(r.json()).toMatchObject({ quantity: '100.0000', uomCode: 'THUNG', uomQuantity: '4.1667' });
    expect((await call('GET', '/api/inventory/on-hand?itemCode=NUOC&warehouseCode=K1&date=2026-07-01&uomCode=CHAI')).json().uomQuantity).toBe('100.0000');
    expect((await call('GET', '/api/inventory/on-hand?itemCode=NUOC&warehouseCode=K1&date=2026-07-01&uomCode=CAI')).statusCode).toBe(404);
  });
});
