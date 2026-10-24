import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { fixture } from '../inbound/helpers.js';
import { bearer, createKey, createTestApp, setupExtTenant, type ExtTenant } from './helpers.js';
import type { TestApp } from '../helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let t: ExtTenant; let seq = 0;
const ext = (key: string, method: 'GET' | 'POST', url: string, payload?: object) => ctx.app.inject({ method, url: `/api/ext/v1${url}`, headers: bearer(key), ...(payload && { payload }) });
const sale = (more: object = {}) => ({ externalId: `POS-${Date.now()}-${seq++}`, date: '2026-03-10', customer: { code: 'KH001' },
  lines: [{ itemCode: 'SP1', quantity: '2', unitPrice: '100' }, { itemCode: 'SP2', quantity: '1', unitPrice: '50' }], ...more });
const roleId = async () => ((await t.call('GET', '/api/roles')).json() as { id: string; code: string }[]).find((r) => r.code === 'xem')!.id;
const setPerms = async (perms: string[]) => { expect((await t.call('PUT', `/api/roles/${await roleId()}/permissions`, { permissions: perms })).statusCode).toBe(200); };
const loginAs = async (username: string) => {
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
};
const newUser = async (flags: string[]) => {
  const username = `ext_${Date.now()}_${seq++}`;
  const u = await t.call('POST', '/api/users', { username, fullName: 'Người bán', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags });
  expect(u.statusCode, u.body).toBe(201);
  return { username, cookie: await loginAs(username) };
};

beforeAll(async () => { ctx = await createTestApp(); t = await setupExtTenant(ctx, `EX${Date.now()}`); });
afterAll(async () => { await ctx.close(); });

describe('API ngoài /api/ext/v1', () => {
  // Chạy trước các test bán hàng (chúng xuất kho SP1).
  it('stock.read: không view_cost thì không có value', async () => {
    const withCost = await createKey(t, { scopes: ['stock.read'] });
    const a = await ext(withCost.key, 'GET', '/stock?warehouseCode=K1&itemCode=SP1');
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().items[0]).toMatchObject({ itemCode: 'SP1', warehouseCode: 'K1', quantity: '100', value: '1000' });
    await setPerms(['api_key.manage', 'stock_voucher.view']);
    const { cookie } = await newUser([]);
    const k = await t.call('POST', '/api/api-keys', { name: 'k', scopes: ['stock.read'] }, cookie);
    expect(k.statusCode, k.body).toBe(201);
    const b = await ext(k.json().key, 'GET', '/stock?warehouseCode=K1&itemCode=SP1');
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().items[0]).toMatchObject({ quantity: '100' });
    expect(b.json().items[0]).not.toHaveProperty('value');
  });

  it('khóa sales.write tạo BH 2 dòng đã ghi sổ (post_sales) và PT đối trừ; cùng externalId lần hai → cùng voucherId', async () => {
    const { key } = await createKey(t);
    const body = sale({ payment: { method: 'cash', amount: '275' } }); // 2x100 + 1x50 = 250, thuế 10% = 25
    const r1 = await ext(key, 'POST', '/sales', body);
    expect(r1.statusCode, r1.body).toBe(201);
    const j1 = r1.json();
    expect(j1).toMatchObject({ state: 'posted', voucherNo: expect.any(String) });
    const lines = await sql<{ n: string; vt: string }>`SELECT count(*)::text AS n, (SELECT voucher_type FROM voucher WHERE id = ${j1.voucherId}::uuid) AS vt FROM voucher_item_line WHERE voucher_id = ${j1.voucherId}::uuid`.execute(ctx.t.admin);
    expect(lines.rows[0]).toEqual({ n: '2', vt: 'BH' });
    const pt = await sql<{ voucher_type: string; state: string; settled: string }>`
      SELECT v.voucher_type, v.state, coalesce((SELECT sum(s.amount) FROM settlement s JOIN open_item o ON o.id = s.debit_item_id WHERE o.voucher_id = ${j1.voucherId}::uuid), 0)::text AS settled
      FROM voucher v WHERE v.idempotency_key = ${'ext:' + body.externalId + ':pay'}`.execute(ctx.t.admin);
    expect(pt.rows[0]).toEqual({ voucher_type: 'PT', state: 'posted', settled: '275' });
    const r2 = await ext(key, 'POST', '/sales', body);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().voucherId).toBe(j1.voucherId);
    const g = await ext(key, 'GET', `/sales/${body.externalId}`);
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().voucherId).toBe(j1.voucherId);
  });

  it('khách lẻ không mã dùng đối tượng KHACHLE; thanh toán chuyển khoản tạo BC; số tiền thanh toán vượt hóa đơn → 400 và không tạo gì', async () => {
    const { key } = await createKey(t);
    const anon = sale({ customer: {}, payment: { method: 'bank', bankAccountCode: '1017588888', amount: '100' } });
    const r = await ext(key, 'POST', '/sales', anon);
    expect(r.statusCode, r.body).toBe(201);
    const p = await sql<{ code: string; vt: string }>`SELECT p.code, v.voucher_type AS vt FROM voucher v JOIN party p ON p.id = v.party_id WHERE v.idempotency_key IN (${'ext:' + anon.externalId}, ${'ext:' + anon.externalId + ':pay'}) ORDER BY v.voucher_type`.execute(ctx.t.admin);
    expect(p.rows).toEqual([{ code: 'KHACHLE', vt: 'BC' }, { code: 'KHACHLE', vt: 'BH' }]);
    const over = sale({ payment: { method: 'cash', amount: '9999' } });
    expect((await ext(key, 'POST', '/sales', over)).statusCode).toBe(400);
    expect((await ext(key, 'GET', `/sales/${over.externalId}`)).statusCode).toBe(404);
  });

  it('chỉ dịch vụ → HDB; khóa không post_sales để chứng từ nháp', async () => {
    const { key } = await createKey(t, { postSales: false });
    const r = await ext(key, 'POST', '/sales', sale({ lines: [{ itemCode: 'DV1', quantity: '1', unitPrice: '500' }] }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().state).toBe('draft');
    const v = await sql<{ voucher_type: string }>`SELECT voucher_type FROM voucher WHERE id = ${r.json().voucherId}::uuid`.execute(ctx.t.admin);
    expect(v.rows[0]!.voucher_type).toBe('HDB');
    const pay = await ext(key, 'POST', '/sales', sale({ payment: { method: 'cash', amount: '10' } }));
    expect(pay.statusCode).toBe(400); // thanh toán cần chứng từ ghi sổ
  });

  it('GET /items trả mã, tên, ĐVT, thuế suất; GET /stock trả tồn', async () => {
    const { key } = await createKey(t);
    const r = await ext(key, 'GET', '/items?q=SP1');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items).toEqual([expect.objectContaining({ code: 'SP1', name: 'Sản phẩm 1', uomCode: 'CAI', taxRate: '10', salePrice: null })]);
  });

  it('khóa thu hồi → 401; người tạo bị tắt trong công ty → 401; vai trò người tạo mất voucher.create → 403', async () => {
    const base = ['api_key.manage', 'voucher.view', 'voucher.create', 'voucher.post', 'stock_voucher.create', 'item.view', 'settlement.create'];
    await setPerms(base);
    const { username, cookie: mine } = await newUser(['view_receivable']);
    const mk = async () => { const r = await t.call('POST', '/api/api-keys', { name: 'k', scopes: ['sales.write', 'items.read'], defaultWarehouseCode: 'K1' }, mine); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; key: string }; };

    const k1 = await mk();
    expect((await ext(k1.key, 'GET', '/items')).statusCode).toBe(200);
    expect((await t.call('POST', `/api/api-keys/${k1.id}/revoke`, {}, mine)).statusCode).toBe(200);
    const revoked = await ext(k1.key, 'GET', '/items');
    expect(revoked.statusCode).toBe(401);

    const k2 = await mk();
    await setPerms(base.filter((p) => p !== 'voucher.create'));
    const noCreate = await ext(k2.key, 'POST', '/sales', sale());
    expect(noCreate.statusCode, noCreate.body).toBe(403);
    await setPerms(base);
    expect((await ext(k2.key, 'POST', '/sales', sale())).statusCode).toBe(201);

    await sql`UPDATE tenant_user SET is_active = false WHERE tenant_id = ${t.tenantId}::uuid AND user_id = (SELECT id FROM app_user WHERE username = ${username})`.execute(ctx.t.admin);
    const off = await ext(k2.key, 'GET', '/items');
    expect(off.statusCode).toBe(401);
    expect(off.json()).toEqual(revoked.json()); // mọi lỗi xác thực cùng một thân phản hồi
  });

  it('Bearer kt_ gọi /api/vouchers → 401', async () => {
    const { key } = await createKey(t);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/vouchers', headers: bearer(key) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/ext/v1/items' })).statusCode).toBe(401);
    // cookie phiên không thay được khóa trên đường ngoài
    expect((await ctx.app.inject({ method: 'GET', url: '/api/ext/v1/items', headers: { cookie: t.cookie } })).statusCode).toBe(401);
  });

  it('khóa sai một ký tự → 401; 61 yêu cầu/phút → 429', async () => {
    const { key } = await createKey(t, { scopes: ['items.read'] });
    const bad = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0');
    expect((await ext(bad, 'GET', '/items')).statusCode).toBe(401);
    expect((await ext('kt_deadbeef12_abc', 'GET', '/items')).statusCode).toBe(401);
    let last = 0;
    for (let i = 0; i < 60; i++) last = (await ext(key, 'GET', '/items?limit=1')).statusCode;
    expect(last).toBe(200);
    const over = await ext(key, 'GET', '/items?limit=1');
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
  });

  it('audit_event của khóa che key_hash; updatedSince lọc mặt hàng; khóa mới của người khác bị từ chối', async () => {
    const { id } = await createKey(t, { scopes: ['items.read'] });
    const a = await sql<{ h: string | null }>`SELECT after->>'key_hash' AS h FROM audit_event WHERE entity = 'api_key' AND entity_id = ${id} AND action = 'insert'`.execute(ctx.t.admin);
    expect(a.rows).toEqual([{ h: '***' }]);
    const { key } = await createKey(t, { scopes: ['items.read'] });
    const future = await ext(key, 'GET', `/items?updatedSince=${encodeURIComponent('2999-01-01T00:00:00Z')}`);
    expect(future.json().items).toEqual([]);
    const past = await ext(key, 'GET', `/items?updatedSince=${encodeURIComponent('2000-01-01T00:00:00Z')}`);
    expect(past.json().items.length).toBe(3);
    const other = await t.call('POST', '/api/api-keys', { name: 'x', scopes: ['items.read'], userId: '00000000-0000-4000-8000-000000000000' });
    expect(other.statusCode).toBe(403);
  });

  it('POST /api/ext/v1/inbound-invoices XML hợp lệ → inbound_invoice source api', async () => {
    const { key, id } = await createKey(t, { scopes: ['inbound_invoice.write'] });
    const post = () => ctx.app.inject({ method: 'POST', url: '/api/ext/v1/inbound-invoices', headers: { ...bearer(key), 'content-type': 'application/xml' }, payload: fixture('vn-einvoice-vat.xml') });
    const r = await post();
    expect(r.statusCode, r.body).toBe(201);
    const row = await sql<{ source: string; api_key_id: string }>`SELECT source, api_key_id::text FROM inbound_invoice WHERE id = ${r.json().id}`.execute(ctx.t.admin);
    expect(row.rows[0]).toEqual({ source: 'api', api_key_id: id });
    const again = await post();
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('duplicate');
    // phạm vi khác không gọi được
    const items = await createKey(t, { scopes: ['items.read'] });
    const no = await ctx.app.inject({ method: 'POST', url: '/api/ext/v1/inbound-invoices', headers: { ...bearer(items.key), 'content-type': 'application/xml' }, payload: fixture('vn-einvoice-vat.xml') });
    expect(no.statusCode).toBe(403);
  });
});
