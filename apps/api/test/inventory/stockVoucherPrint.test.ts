import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { voucherFormFor } from '../../src/modules/reporting/print/forms.js';

let ctx: TestApp; let cookie: string;
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const cat = async (name: string, payload: object) => { expect((await call('POST', `/api/catalogs/${name}`, payload)).statusCode).toBe(201); };
const make = async (type: 'PNK' | 'PXK' | 'CK', stockKind: string, date: string, extra: object = {}) => {
  const r = await call('POST', '/api/stock-vouchers', { voucherType: type, stockKind, postingDate: date, warehouseCode: 'K1', description: 'Phiếu kho', personName: 'Nguyễn Văn A',
    items: [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '100', unitPrice: '10' }, { itemCode: 'SP2', uomCode: 'CAI', quantity: '3', unitPrice: '1500' }], ...extra });
  expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string };
};
const post = async (id: string) => expect((await call('POST', `/api/vouchers/${id}/post`, {})).statusCode).toBe(200);
const print = (id: string, q = '', c = cookie) => call('GET', `/api/vouchers/${id}/print${q}`, undefined, c);

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `IN${Date.now()}` }));
  await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('item', { code: 'SP1', name: 'Hàng một', base_uom_code: 'CAI', kind: 'goods' });
  await cat('item', { code: 'SP2', name: 'Hàng hai', base_uom_code: 'CAI', kind: 'goods' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  await cat('warehouse', { code: 'K2', name: 'Kho phụ', inventory_account_code: '156', costing_method: 'avg_moving' });
});
afterAll(async () => { await ctx.close(); });

describe('in phiếu nhập kho 01-VT, phiếu xuất kho 02-VT', () => {
  it('PNK: tiêu đề, mẫu số TT133, cột, tổng bằng chữ, chữ ký; PDF tạo được', async () => {
    const v = await make('PNK', 'purchase', '2026-02-01', { partyCode: 'NCC1' }); await post(v.id);
    const r = await print(v.id); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['PHIẾU NHẬP KHO', 'Mẫu số 01 - VT', 'Ban hành theo Thông tư số 133/2016/TT-BTC', 'Theo chứng từ', 'Thực nhập', 'Đơn giá', 'Thành tiền', 'Hàng một', 'SP2', 'Kho chính', 'Nguyễn Văn A',
      '5.500', 'Năm nghìn năm trăm đồng', 'Người giao hàng', 'Thủ kho', 'Kế toán trưởng', 'Ngày 01 tháng 02 năm 2026']) expect(r.body, t).toContain(t);
    expect(r.body).not.toContain('Giám đốc');
    const pdf = await print(v.id, '?format=pdf'); expect(pdf.statusCode).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('PXK: 02-VT có Yêu cầu, Thực xuất, Giám đốc; CK ghi kho chuyển đến; mẫu sai chiều 400', async () => {
    const x = await make('PXK', 'sale', '2026-02-05'); await post(x.id);
    const r = await print(x.id); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['PHIẾU XUẤT KHO', 'Mẫu số 02 - VT', 'Yêu cầu', 'Thực xuất', 'Người nhận hàng', 'Giám đốc', 'Lý do xuất kho']) expect(r.body, t).toContain(t);
    // phiếu xuất: đơn giá là giá vốn bình quân (10 và 1.500), thành tiền 1.000 + 4.500
    expect(r.body).toMatch(/<td class="num">10<\/td><td class="num">1\.000<\/td>/); expect(r.body).toMatch(/<td class="num">1\.500<\/td><td class="num">4\.500<\/td>/); expect(r.body).toContain('5.500');
    expect((await print(x.id, '?form=01-VT')).statusCode).toBe(400);
    const k = await make('CK', 'transfer', '2026-02-06', { destWarehouseCode: 'K2' });
    const c = await print(k.id); expect(c.statusCode, c.body).toBe(200); expect(c.body).toContain('PHIẾU XUẤT KHO'); expect(c.body).toMatch(/<td class="num">1\.500<\/td><td class="num">4\.500<\/td>/);
  });

  it('thiếu view_cost: in được nhưng bỏ đơn giá, thành tiền, bằng chữ; thiếu quyền xem phiếu kho thì 403', async () => {
    const v = await make('PXK', 'sale', '2026-02-07');
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    const mk = async (perms: string[]) => {
      await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
      const username = `thukho_${Math.random().toString(36).slice(2, 8)}`;
      expect((await call('POST', '/api/users', { username, fullName: 'Thủ kho', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
      return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    };
    const keeper = await mk(['voucher.view', 'voucher.print', 'stock_voucher.view']);
    const r = await print(v.id, '', keeper); expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Hàng một'); expect(r.body).not.toContain('Đơn giá'); expect(r.body).not.toContain('Thành tiền'); expect(r.body).not.toContain('viết bằng chữ');
    expect((await call('GET', `/api/vouchers/${v.id}`, undefined, keeper)).statusCode).toBe(403); // GET vẫn chặn
    expect((await print(v.id, '', cookie)).body).toContain('Đơn giá');
    const noView = await mk(['voucher.view', 'voucher.print']);
    expect((await print(v.id, '', noView)).statusCode).toBe(403);
  });

  it('TT200 chưa có văn bản gốc: không có mẫu số; TT99 có', () => {
    expect(voucherFormFor('TT200', '01-VT')).toBeNull();
    expect(voucherFormFor('TT99', '02-VT')?.formNo).toBe('02 - VT');
  });
});
