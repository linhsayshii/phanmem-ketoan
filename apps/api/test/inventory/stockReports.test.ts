import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

// Dữ liệu Task 4 với fifo: nhập 100@10 (02/01), xuất 60 (10/01), nhập 50@12 (15/01), xuất 70 (20/01).
async function tenant() {
  const { cookie } = await bootstrapTenant(ctx, { code: `BK${Date.now()}${n++}` });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('warehouse', { code: 'K1', name: 'Kho K1', inventory_account_code: '156', costing_method: 'fifo' });
  await cat('item', { code: 'X', name: 'Hàng X', base_uom_code: 'CAI', kind: 'goods', tracking: 'none' });
  const stock = async (body: object) => {
    const r = await call('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); expect(r.statusCode, r.body).toBe(201);
    expect((await call('POST', `/api/vouchers/${r.json().id}/post`, {})).statusCode).toBe(200);
  };
  const pnk = (date: string, quantity: string, unitPrice: string) => stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'X', uomCode: 'CAI', quantity, unitPrice }] });
  const pxk = (date: string, quantity: string) => stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: date, warehouseCode: 'K1', items: [{ itemCode: 'X', uomCode: 'CAI', quantity }] });
  await pnk('2026-01-02', '100', '10'); await pxk('2026-01-10', '60'); await pnk('2026-01-15', '50', '12'); await pxk('2026-01-20', '70');
  const login = async (perms: string[], flags: string[]) => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms })).statusCode).toBe(200);
    const username = `bk_${n++}_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${r.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  const run = async () => { const r = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-01', periodTo: '2026-01-31', warehouseCode: 'K1' }); expect(r.statusCode, r.body).toBe(200); };
  return { call, login, run };
}
const Q = 'from=2026-01-01&to=2026-01-31&item=X';

describe('báo cáo kho', () => {
  it('NXT, thẻ kho, sổ chi tiết sau tính giá vốn fifo', async () => {
    const t = await tenant(); await t.run();
    const s = (await t.call('GET', `/api/reports/stock-summary?${Q}`)).json();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ openingQty: '0', openingValue: '0', inQty: '150', inValue: '1600', outQty: '130', outValue: '1360', closingQty: '20', closingValue: '240', provisional: false });
    const c = (await t.call('GET', `/api/reports/stock-card?${Q}`)).json();
    expect(c.cards[0].lines.map((l: { balanceQty: string }) => l.balanceQty)).toEqual(['100', '40', '90', '20']);
    const l = (await t.call('GET', `/api/reports/stock-ledger?${Q}`)).json();
    expect(l.ledgers[0].lines.map((x: { unitPrice: string }) => x.unitPrice)).toEqual(['10', '10', '12', '10.8571']);
    expect(l.ledgers[0]).toMatchObject({ closingQty: '20', closingValue: '240' });
    const e = await t.call('GET', '/api/reports/stock-expiry?asOf=2026-01-31&days=30'); expect(e.statusCode).toBe(200);
    const o = (await t.call('GET', `/api/reports/stock-register?${Q}&direction=out`)).json();
    expect(o.rows).toHaveLength(2); expect(o.totalValue).toBe('1360');
  }, 60_000);

  it('thiếu view_cost: 403 ở sổ chi tiết và NXT, thẻ kho vẫn xem được', async () => {
    const t = await tenant(); const c = await t.login(['report.view'], []);
    expect((await t.call('GET', `/api/reports/stock-ledger?${Q}`, undefined, c)).statusCode).toBe(403);
    expect((await t.call('GET', `/api/reports/stock-summary?${Q}`, undefined, c)).statusCode).toBe(403);
    expect((await t.call('GET', '/api/reports/stock-reconcile?asOf=2026-01-31', undefined, c)).statusCode).toBe(403);
    expect((await t.call('GET', `/api/reports/stock-card?${Q}`, undefined, c)).statusCode).toBe(200);
  }, 60_000);

  it('đối chiếu: chênh trước khi tính giá vốn, 0 chênh sau đó; giá xuất tạm tính có cờ', async () => {
    const t = await tenant();
    const s = (await t.call('GET', `/api/reports/stock-summary?${Q}`)).json();
    expect(s.rows[0].provisional).toBe(true); expect(s.banners.messages.length).toBeGreaterThan(0);
    const before = (await t.call('GET', '/api/reports/stock-reconcile?asOf=2026-01-31')).json();
    expect(before.ok).toBe(false); expect(before.differences.length).toBeGreaterThan(0);
    await t.run();
    const after = (await t.call('GET', '/api/reports/stock-reconcile?asOf=2026-01-31')).json();
    expect(after.differences).toEqual([]); expect(after.ok).toBe(true);
  }, 60_000);

  it('in PDF và XLSX', async () => {
    const t = await tenant(); await t.run();
    for (const r of ['stock-summary', 'stock-card', 'stock-ledger']) {
      const p = await t.call('GET', `/api/reports/${r}?${Q}&format=pdf`); expect(p.statusCode, p.body).toBe(200); expect(p.headers['content-type']).toContain('pdf');
      const x = await t.call('GET', `/api/reports/${r}?${Q}&format=xlsx`); expect(x.statusCode, x.body).toBe(200);
    }
  }, 120_000);
});
