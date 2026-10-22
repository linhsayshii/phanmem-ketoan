import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let cookie: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `BG${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  const cat = (name: string, payload: object) => ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie }, payload });
  await cat('item', { code: 'SP1', name: 'Hàng 1', base_uom_code: 'CAI' });
  await cat('item', { code: 'SP2', name: 'Hàng 2', base_uom_code: 'CAI' });
  await cat('party_group', { code: 'VIP', name: 'Khách VIP' });
  await cat('party', { code: 'KH1', name: 'Khách VIP 1', is_customer: true, group_code: 'VIP' });
  await cat('party', { code: 'KH2', name: 'Khách lẻ', is_customer: true });
});
afterAll(async () => { await ctx.close(); });

const mk = async (body: object) => { const r = await ctx.app.inject({ method: 'POST', url: '/api/price-lists', headers: { cookie }, payload: { kind: 'sale', currencyCode: 'VND', validFrom: '2026-01-01', ...body } }); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };
const line = (price: string, minQty = '0', extra: object = {}) => ({ itemCode: 'SP1', uomCode: 'CAI', minQty, price, ...extra });
const res = async (q: Record<string, string>) => (await ctx.app.inject({ method: 'GET', url: '/api/price-lists/resolve?' + new URLSearchParams({ kind: 'sale', itemCode: 'SP1', uomCode: 'CAI', date: '2026-03-01', qty: '1', ...q }), headers: { cookie } })).json();

describe('bảng giá', () => {
  it('giá theo bậc số lượng: mua 10 lấy giá bậc min_qty 10', async () => {
    await mk({ code: 'BGC', name: 'Bảng giá chung', lines: [line('100000'), line('90000', '10', { discountRate: '2.5' }), line('80000', '100')] });
    expect(await res({ qty: '1' })).toMatchObject({ price: '100000.0000' });
    expect(await res({ qty: '9.9999' })).toMatchObject({ price: '100000.0000' });
    expect(await res({ qty: '10' })).toMatchObject({ price: '90000.0000', discountRate: '2.5000' });
    expect(await res({ qty: '150' })).toMatchObject({ price: '80000.0000' });
  });

  it('bảng giá nhóm khách ưu tiên hơn bảng chung; hết hiệu lực thì bỏ qua', async () => {
    await mk({ code: 'BGV', name: 'Bảng giá VIP', partyGroupCode: 'VIP', priority: 1, lines: [line('70000')] });
    expect(await res({ partyCode: 'KH1' })).toMatchObject({ price: '70000.0000' });
    expect(await res({ partyCode: 'KH2' })).toMatchObject({ price: '100000.0000' });
    expect(await res({})).toMatchObject({ price: '100000.0000' });
    await mk({ code: 'BGH', name: 'Hết hạn', priority: 9, validTo: '2026-02-28', lines: [line('1')] });
    expect(await res({ date: '2026-03-01' })).toMatchObject({ price: '100000.0000' });
    expect(await res({ date: '2026-02-01' })).toMatchObject({ price: '1.0000' });
    expect(await res({ date: '2025-12-31' })).toMatchObject({ price: null });
    await mk({ code: 'BGP', name: 'Ưu tiên cao', priority: 5, lines: [line('95000')] });
    expect(await res({ partyCode: 'KH1' })).toMatchObject({ price: '70000.0000' }); // nhóm vẫn trước priority
    expect(await res({ partyCode: 'KH2' })).toMatchObject({ price: '95000.0000' });
  });

  it('khác loại tiền, loại bảng giá hoặc ĐVT không áp dụng; không có bảng giá thì null', async () => {
    expect(await res({ currency: 'USD' })).toMatchObject({ price: null, priceListId: null });
    expect(await res({ kind: 'purchase' })).toMatchObject({ price: null });
    expect(await res({ itemCode: 'SP2' })).toMatchObject({ price: null });
    await ctx.app.inject({ method: 'POST', url: '/api/catalogs/currency', headers: { cookie }, payload: { code: 'USD', name: 'Đô la Mỹ' } });
    await mk({ code: 'BGU', name: 'USD', currencyCode: 'USD', lines: [line('4.5')] });
    expect(await res({ currency: 'USD' })).toMatchObject({ price: '4.5000' });
  });

  it('sửa thay dòng, xóa, đọc lại; dòng trùng khóa bị từ chối', async () => {
    const id = await mk({ code: 'BGS', name: 'Sửa', kind: 'purchase', lines: [line('5')] });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/price-lists', headers: { cookie }, payload: { code: 'BGD', name: 'x', kind: 'sale', currencyCode: 'VND', validFrom: '2026-01-01', lines: [line('1'), line('2')] } });
    expect(dup.statusCode).toBe(409);
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/price-lists/${id}`, headers: { cookie }, payload: { code: 'BGS', name: 'Sửa 2', kind: 'purchase', currencyCode: 'VND', validFrom: '2026-01-01', lines: [line('6'), line('5', '5')] } });
    expect(put.statusCode, put.body).toBe(200);
    const got = (await ctx.app.inject({ method: 'GET', url: `/api/price-lists/${id}`, headers: { cookie } })).json();
    expect(got).toMatchObject({ name: 'Sửa 2', lines: [expect.objectContaining({ price: '6.0000' }), expect.objectContaining({ minQty: '5.0000' })] });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/price-lists/${id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/price-lists/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('nhập Excel dòng giá: kiểm tra báo lỗi dòng, nhập thật ghi dòng', async () => {
    const id = await mk({ code: 'BGX', name: 'Excel' });
    const book = async (rows: (string | number)[][]) => {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu');
      ws.addRow(['Mã hàng', 'ĐVT', 'Từ số lượng', 'Đơn giá', 'CK']); ws.addRow(['itemCode', 'uomCode', 'minQty', 'price', 'discountRate']); ws.addRow(['VI_DU', 'CAI', 0, 0, 0]);
      rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const imp = async (buf: Buffer, mode: string) => { const f = new FormData(); f.append('file', buf, 'a.xlsx'); return ctx.app.inject({ method: 'POST', url: `/api/price-lists/${id}/import-lines?mode=${mode}`, headers: { cookie, ...f.getHeaders() }, payload: f }); };
    const bad = await imp(await book([['SP1', 'CAI', 0, 10, 0], ['KHONGCO', 'CAI', 0, 10, 0]]), 'validate');
    expect(bad.json().errors).toEqual([expect.objectContaining({ row: 5, column: 'itemCode' })]);
    expect((await imp(await book([['SP1', 'CAI', 0, 10, 0], ['KHONGCO', 'CAI', 0, 10, 0]]), 'commit')).statusCode).toBe(400);
    const good = await book([['SP1', 'CAI', 0, 12, 0], ['SP1', 'CAI', 10, 11, 1.5], ['SP2', 'CAI', 0, 7, 0]]);
    expect((await imp(good, 'validate')).json()).toMatchObject({ inserted: 0, errorCount: 0 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/price-lists/${id}`, headers: { cookie } })).json().lines).toHaveLength(0);
    expect((await imp(good, 'commit')).json()).toMatchObject({ inserted: 3 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/price-lists/${id}`, headers: { cookie } })).json().lines).toHaveLength(3);
  });
});
