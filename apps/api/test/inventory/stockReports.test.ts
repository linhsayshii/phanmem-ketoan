import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

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
    // Ngày quá khứ cũng chính xác: tại 15/01 chưa có lần xuất 20/01.
    for (const d of ['2026-01-10', '2026-01-15', '2026-01-02']) expect((await t.call('GET', `/api/reports/stock-reconcile?asOf=${d}`)).json().differences, d).toEqual([]);
  }, 60_000);

  it('in PDF và XLSX', async () => {
    const t = await tenant(); await t.run();
    for (const r of ['stock-summary', 'stock-card', 'stock-ledger']) {
      const p = await t.call('GET', `/api/reports/${r}?${Q}&format=pdf`); expect(p.statusCode, p.body).toBe(200); expect(p.headers['content-type']).toContain('pdf');
      const x = await t.call('GET', `/api/reports/${r}?${Q}&format=xlsx`); expect(x.statusCode, x.body).toBe(200);
    }
  }, 120_000);
});

describe('báo cáo kho: lớp điều chỉnh theo ngày chứng từ nguồn, mẫu in theo chế độ', () => {
  it('hóa đơn mua giá thật ghi sau (05/04): NXT tháng 3 không đổi và bằng 156 trên sổ cái; tháng 4 có điều chỉnh', async () => {
    const { cookie } = await setupLedgerTenant(ctx, `BKA${Date.now()}`);
    const call = (method: 'GET' | 'POST', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
    expect((await call('POST', '/api/catalogs/item', { code: 'A2', name: 'Hàng A2', base_uom_code: 'CAI', kind: 'goods' })).statusCode).toBe(201);
    expect((await call('POST', '/api/catalogs/warehouse', { code: 'K1', name: 'Kho', inventory_account_code: '156', costing_method: 'avg_moving' })).statusCode).toBe(201);
    const r = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-20', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'A2', uomCode: 'CAI', quantity: '100', unitPrice: '10' }] });
    expect(r.statusCode, r.body).toBe(201); const pnk = r.json().id as string;
    expect((await call('POST', `/api/vouchers/${pnk}/post`, {})).statusCode).toBe(200);
    const inv = await call('POST', '/api/invoices', { voucherType: 'MH', stockMode: 'goods_first', postingDate: '2026-04-05', documentDate: '2026-04-05', partyCode: 'NCC001', autoPost: true, receiptVoucherIds: [pnk],
      items: [{ itemCode: 'A2', uomCode: 'CAI', warehouseCode: 'K1', quantity: '100', unitPrice: '10.5', amountCurrency: '1050', taxCodes: ['V10'] }], invoice: { serial: 'C26TAA', invoiceNo: `BK${Date.now()}`, invoiceDate: '2026-04-05', invoiceGroupCode: '01' } });
    expect(inv.statusCode, inv.body).toBe(201);
    const gl = async (to: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state IN ('posted','reversed') AND a.code = '156' AND v.tenant_id = (SELECT tenant_id FROM voucher WHERE id = ${pnk}) AND l.posting_date <= ${to}::date`.execute(ctx.t.admin)).rows[0]!.n;
    const nxt = async (from: string, to: string) => (await call('GET', `/api/reports/stock-summary?from=${from}&to=${to}&item=A2`)).json().rows[0];
    const mar = await nxt('2026-03-01', '2026-03-31');
    expect(mar).toMatchObject({ inValue: '1000', closingValue: '1000' }); expect(mar.closingValue).toBe(await gl('2026-03-31'));
    const apr = await nxt('2026-04-01', '2026-04-30');
    expect(apr).toMatchObject({ openingValue: '1000', inQty: '0', inValue: '50', closingValue: '1050' }); expect(apr.closingValue).toBe(await gl('2026-04-30'));
    // sổ chi tiết tháng 4 có dòng chỉ giá trị theo chứng từ nguồn
    const led = (await call('GET', '/api/reports/stock-ledger?from=2026-04-01&to=2026-04-30&item=A2')).json().ledgers[0];
    expect(led.lines).toHaveLength(1); expect(led.lines[0]).toMatchObject({ postingDate: '2026-04-05', inQty: '0', inValue: '50', balanceValue: '1050' });
    const rec = (await call('GET', '/api/reports/stock-reconcile?asOf=2026-03-31')).json(); expect(rec.differences).toEqual([]);
  });

  it('mẫu in: TT133 có chữ ký riêng và tiêu đề của S06-DNN; TT99 dùng chữ ký mặc định', async () => {
    const t = await tenant(); await t.run();
    const html133 = (await t.call('GET', `/api/reports/stock-ledger?${Q}&format=html`)).body;
    expect(html133).toContain('Mẫu số S06-DNN'); expect(html133).toContain('(SẢN PHẨM, HÀNG HÓA)'); expect(html133).toContain('Người lập biểu');
    const html99 = (await t.call('GET', `/api/reports/stock-summary?${Q}&format=html`)).body;
    expect(html99).toContain('Người ghi sổ');
  }, 60_000);
});
