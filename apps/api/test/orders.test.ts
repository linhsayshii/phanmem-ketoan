import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string;
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'POST' | 'PUT' | 'GET' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const code = (r: Res) => r.json().error?.code ?? r.json().code;
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const order = (more: object = {}, line: object = {}) => ({ kind: 'quote', docDate: '2026-03-02', partyCode: 'KH001', lines: [{ itemCode: 'S1', uomCode: 'CAI', warehouseCode: 'K1', quantity: '100', unitPrice: '20', taxCode: 'V10', ...line }], ...more });
const mk = async (body: object) => { const r = await call('POST', '/api/orders', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
const delivered = async (id: string) => (await call('GET', `/api/orders/${id}`)).json().lines[0].deliveredQty as string;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await setupLedgerTenant(ctx, `DH${Date.now()}`));
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
  await cat('item', { code: 'S1', name: 'Hàng S1', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  const r = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-01', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'S1', uomCode: 'CAI', quantity: '1000', unitPrice: '10' }] });
  expect((await call('POST', `/api/vouchers/${r.json().id}/post`, {})).statusCode).toBe(200);
});
afterAll(async () => { await ctx.close(); });
const login = async (perms: string[], flags: string[]) => {
  const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
  await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
  const username = `dh_${Date.now()}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
};

describe('báo giá, đơn hàng, hợp đồng', () => {
  // GĐ7 gói 2 (phụ lục B, T1): tổng đơn (SQL) làm tròn như hóa đơn sinh từ đơn (thành tiền dòng làm tròn trước, rồi chiết khấu làm tròn): 1 × 1.234.565 chiết khấu 10% = 1.111.108.
  it('tổng đơn trong danh sách khớp số trên hóa đơn sinh từ đơn (làm tròn hai bước)', async () => {
    const q = await mk(order({}, { quantity: '1', unitPrice: '1234565', discountRate: '10' }));
    const row = ((await call('GET', '/api/orders')).json() as { id: string; total: string }[]).find((x) => x.id === q.id)!;
    expect(row.total).toBe('1111108');
    const inv = await call('POST', `/api/orders/${q.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: '1' }] });
    expect(inv.statusCode, inv.body).toBe(200);
    expect(JSON.stringify(inv.json())).toContain('1111108');
  });

  it('đánh số riêng theo loại; báo giá thành đơn bán; chuyển BH một phần 40/100 rồi phần còn lại', async () => {
    const q = await mk(order());
    expect(q.docNo).toMatch(/^BG-2026-\d{4}$/);
    const so = (await call('POST', `/api/orders/${q.id}/convert`, { to: 'SO' })).json().order;
    expect([so.kind, so.docNo]).toEqual(['sale_order', expect.stringMatching(/^DH-2026-\d{4}$/)]);
    const c1 = await call('POST', `/api/orders/${q.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: '40' }] });
    expect(c1.statusCode, c1.body).toBe(200);
    expect(c1.json().voucher.state).toBe('draft');
    expect(c1.json().voucher.voucherType).toBe('BH');
    expect(c1.json().order.status).toBe('partial');
    expect(await delivered(q.id)).toBe('40.0000');
    expect(code(await call('POST', `/api/orders/${q.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: '61' }] }))).toBe('ORDER_QTY_EXCEEDED');
    const c2 = await call('POST', `/api/orders/${q.id}/convert`, { to: 'BH' });
    expect(c2.json().order.status).toBe('done');
    expect(await delivered(q.id)).toBe('100.0000');
    expect(code(await call('POST', `/api/orders/${q.id}/convert`, { to: 'BH' }))).toBe('ORDER_QTY_EXCEEDED');
  });

  it('xóa, hủy (discard), đảo chứng từ sinh ra trả delivered_qty', async () => {
    const o = await mk(order({ kind: 'sale_order' }));
    const conv = async (qty: string) => (await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: qty }] })).json().voucher;
    const v1 = await conv('10');
    expect((await call('DELETE', `/api/vouchers/${v1.id}`)).statusCode).toBe(204);
    expect(await delivered(o.id)).toBe('0.0000');
    expect((await call('GET', `/api/orders/${o.id}`)).json().status).toBe('confirmed');
    const v2 = await conv('20');
    expect((await call('POST', `/api/vouchers/${v2.id}/discard`)).statusCode).toBe(200);
    expect(await delivered(o.id)).toBe('0.0000');
    const v3 = await conv('30');
    expect((await call('POST', `/api/vouchers/${v3.id}/post`)).statusCode).toBe(200);
    expect(await delivered(o.id)).toBe('30.0000');
    expect((await call('POST', `/api/vouchers/${v3.id}/reverse`, { postingDate: '2026-03-03' })).statusCode).toBe(201);
    expect(await delivered(o.id)).toBe('0.0000');
  });

  it('đơn đã hủy không chuyển; đơn công ty khác 404; thiếu giá và bảng giá điền giá', async () => {
    const o = await mk(order());
    expect((await call('POST', `/api/orders/${o.id}/cancel`)).json().status).toBe('cancelled');
    expect(code(await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH' }))).toBe('ORDER_CANCELLED');
    const other = (await setupLedgerTenant(ctx, `DX${Date.now()}`)).cookie;
    expect((await call('GET', `/api/orders/${o.id}`, undefined, other)).statusCode).toBe(404);
    expect((await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH' }, other)).statusCode).toBe(404);
    const body = order(); delete (body.lines[0] as { unitPrice?: string }).unitPrice;
    expect(code(await call('POST', '/api/orders', body))).toBe('ORDER_PRICE_MISSING');
    const pl = await call('POST', '/api/price-lists', { code: 'BGB', name: 'Bảng giá bán', kind: 'sale', currencyCode: 'VND', validFrom: '2026-01-01', lines: [{ itemCode: 'S1', uomCode: 'CAI', minQty: '0', price: '25', discountRate: '0' }] });
    expect(pl.statusCode, pl.body).toBe(201);
    const priced = await mk(body);
    expect(priced.lines[0].unitPrice).toBe('25.0000');
  });

  it('đơn mua chuyển MH nháp; BH từ đơn mua bị từ chối; hợp đồng gắn đơn', async () => {
    const ct = await call('POST', '/api/contracts', { code: 'HD01', name: 'Hợp đồng mua', kind: 'purchase', partyCode: 'NCC001', value: '5000000' });
    expect(ct.statusCode, ct.body).toBe(201);
    const o = await mk(order({ kind: 'purchase_order', partyCode: 'NCC001', contractCode: 'HD01' }, { unitPrice: '10' }));
    expect(o.docNo).toMatch(/^DM-2026-/); expect(o.contractCode).toBe('HD01');
    expect(code(await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH' }))).toBe('ORDER_KIND_INVALID');
    const c = await call('POST', `/api/orders/${o.id}/convert`, { to: 'MH' });
    expect(c.statusCode, c.body).toBe(200);
    expect([c.json().voucher.voucherType, c.json().voucher.state]).toEqual(['MH', 'draft']);
    expect(code(await call('PUT', `/api/orders/${o.id}`, order({ kind: 'purchase_order', partyCode: 'NCC001' })))).toBe('ORDER_LOCKED');
    const n = (await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE entity = 'doc_order'`.execute(ctx.t.admin)).rows[0]!.n;
    expect(Number(n)).toBeGreaterThan(0);
  });

  it('dòng trùng lineNo bị từ chối; người không có view_cost chuyển BH không thấy dòng giá vốn', async () => {
    const o = await mk(order({ kind: 'sale_order' }));
    const dup = await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: '60' }, { lineNo: 1, quantity: '60' }] });
    expect(dup.statusCode).toBe(400);
    expect(await delivered(o.id)).toBe('0.0000');
    const lim = await login(['order.view', 'order.update', 'voucher.create', 'voucher.view', 'stock_voucher.create', 'stock_voucher.view'], []);
    const r = await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: '10' }] }, lim);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().voucher.lines.some((l: { accountCode: string }) => l.accountCode.startsWith('632'))).toBe(false);
    const full = await call('POST', `/api/orders/${o.id}/convert`, { to: 'BH', lines: [{ lineNo: 1, quantity: '10' }] });
    expect(full.json().voucher.lines.some((l: { accountCode: string }) => l.accountCode.startsWith('632'))).toBe(true);
  });
});
