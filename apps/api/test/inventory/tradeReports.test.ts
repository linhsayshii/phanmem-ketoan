import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let ctx: TestApp; let cookie: string; let seq = 0;
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const create = async (body: object) => { const r = await call('POST', '/api/invoices', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
const sale = (items: object[], date = '2026-03-05', party = 'KH001') => ({ voucherType: 'BH', postingDate: date, documentDate: date, partyCode: party, autoPost: true, items,
  invoice: { serial: 'C26TBB', invoiceNo: `B${seq++}`, invoiceDate: date, invoiceGroupCode: '10' } });
const sl = (item: string, qty: string, price: string, extra: object = {}) => ({ itemCode: item, uomCode: 'CAI', warehouseCode: 'K1', quantity: qty, unitPrice: price, amountCurrency: String(Number(qty) * Number(price)), taxCodes: ['V10'], ...extra });
const mh = (items: object[], date = '2026-03-02') => ({ voucherType: 'MH', stockMode: 'through_stock', postingDate: date, documentDate: date, partyCode: 'NCC001', autoPost: true, items,
  invoice: { serial: 'C26TAA', invoiceNo: `M${seq++}`, invoiceDate: date, invoiceGroupCode: '01' } });
const login = async (perms: string[], flags: string[]) => {
  const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
  await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
  const username = `tr_${Date.now()}_${seq++}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
};
const Q = 'from=2026-03-01&to=2026-03-31';

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await setupLedgerTenant(ctx, `TR${Date.now()}`));
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
  for (const c of ['S1', 'S2']) await cat('item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
});
afterAll(async () => { await ctx.close(); });

describe('báo cáo bán hàng, mua hàng', () => {
  it('mua 100@10 chiết khấu, bán 60@20 giá vốn 600, trả 5: doanh thu thuần 1.100, giá vốn 550, lãi gộp 550', async () => {
    await create(mh([sl('S1', '100', '10')]));
    const bh = await create(sale([sl('S1', '60', '20')]));
    const reversed = await create(sale([sl('S1', '10', '20')], '2026-03-06'));
    expect((await call('POST', `/api/vouchers/${reversed.id}/reverse`, { postingDate: '2026-03-07' })).statusCode).toBe(201); // đảo: triệt tiêu
    const src = bh.items[0].id;
    await create({ voucherType: 'TLB', postingDate: '2026-03-08', documentDate: '2026-03-08', partyCode: 'KH001', autoPost: true,
      items: [{ ...sl('S1', '5', '20'), sourceLineId: Number(src) }], invoice: { serial: 'C26TBB', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-08', invoiceGroupCode: '10', adjustsInvoiceId: bh.invoices[0].id } });
    const s = (await call('GET', `/api/reports/sales?${Q}&groupBy=item`)).json();
    expect(s.costHidden).toBe(false);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ key: 'S1', soldQty: '60', returnQty: '5', grossSales: '1200', discount: '0', returns: '100', netRevenue: '1100', cogs: '550', grossProfit: '550', provisional: true });
    expect(s.totals).toMatchObject({ netRevenue: '1100', grossProfit: '550' });
    expect(s.banners.messages.length).toBeGreaterThan(0);
    const run = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-03-01', periodTo: '2026-03-31', warehouseCode: 'K1' }); expect(run.statusCode, run.body).toBe(200);
    const s2 = (await call('GET', `/api/reports/sales?${Q}&groupBy=month`)).json();
    expect(s2.rows[0]).toMatchObject({ key: '2026-03', netRevenue: '1100', cogs: '550', grossProfit: '550', provisional: false });
    for (const g of ['party', 'item_group', 'salesperson']) expect((await call('GET', `/api/reports/sales?${Q}&groupBy=${g}`)).statusCode, g).toBe(200);
    // không view_cost: bỏ hai cột, ở mọi định dạng
    const c = await login(['report.view', 'report.print'], []);
    const h = (await call('GET', `/api/reports/sales?${Q}&groupBy=item`, undefined, c)).json();
    expect(h.costHidden).toBe(true); expect(h.rows[0]).not.toHaveProperty('cogs'); expect(h.rows[0]).not.toHaveProperty('grossProfit'); expect(h.totals).not.toHaveProperty('grossProfit'); expect(h.rows[0].netRevenue).toBe('1100');
    for (const f of ['html', 'pdf', 'xlsx']) { const r = await call('GET', `/api/reports/sales?${Q}&format=${f}`, undefined, c); expect(r.statusCode, f).toBe(200); }
    const html = (await call('GET', `/api/reports/sales?${Q}&groupBy=item&format=html`, undefined, c)).body;
    expect(html).not.toContain('Lãi gộp'); expect(html).not.toContain('Giá vốn');
    expect((await call('GET', `/api/reports/sales?${Q}&groupBy=item&format=html`)).body).toContain('Lãi gộp');
  });

  it('mua hàng: giá trị, chiết khấu, trả lại, thuế; chi phí mua chỉ khi có view_cost', async () => {
    const m = await create(mh([sl('S2', '10', '10', { discountRate: '10', discountCurrency: '10' })], '2026-03-10'));
    await create({ voucherType: 'TLM', stockMode: 'through_stock', postingDate: '2026-03-12', documentDate: '2026-03-12', partyCode: 'NCC001', autoPost: true,
      items: [{ itemCode: 'S2', uomCode: 'CAI', warehouseCode: 'K1', quantity: '2', sourceLineId: m.items[0].id, amountCurrency: '18', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-12', invoiceGroupCode: '01', adjustsInvoiceId: m.invoices[0].id } });
    const cp = await call('POST', '/api/landed-costs', { postingDate: '2026-03-14', basis: 'value', receiptVoucherIds: [m.id], costLines: [{ accountCode: '1111', amount: '80' }] }); expect(cp.statusCode, cp.body).toBe(201);
    expect((await call('POST', `/api/vouchers/${cp.json().id}/post`, {})).statusCode).toBe(200);
    const p = (await call('GET', `/api/reports/purchases?${Q}&groupBy=item&item=S2`)).json();
    expect(p.rows[0]).toMatchObject({ key: 'S2', qty: '10', returnQty: '2', purchaseValue: '100', discount: '10', returns: '18', netPurchase: '72', landedCost: '80' });
    const c = await login(['report.view'], []);
    const h = (await call('GET', `/api/reports/purchases?${Q}&groupBy=item`, undefined, c)).json();
    expect(h.costHidden).toBe(true); expect(h.rows[0]).not.toHaveProperty('landedCost');
    for (const g of ['party', 'month']) expect((await call('GET', `/api/reports/purchases?${Q}&groupBy=${g}&format=xlsx`)).statusCode, g).toBe(200);
  });

  it('nhân viên bán hàng, chứng từ đảo khác kỳ, giảm giá bán, xlsx ẩn giá vốn', async () => {
    for (const c of ['NV1', 'NV2']) await cat('employee', { code: c, name: `Nhân viên ${c}` });
    await create(mh([sl('S1', '50', '10')], '2026-04-01'));
    const withEmp = (e: string, body: ReturnType<typeof sale>) => ({ ...body, invoice: { ...body.invoice, employeeCode: e } });
    const a = await create(withEmp('NV1', sale([sl('S1', '10', '20')], '2026-04-03')));
    await create(withEmp('NV2', sale([sl('S1', '5', '20')], '2026-04-04')));
    const sp = (await call('GET', '/api/reports/sales?from=2026-04-01&to=2026-04-30&groupBy=salesperson')).json();
    expect(sp.rows.map((r: { key: string; netRevenue: string }) => [r.key, r.netRevenue])).toEqual([['NV1', '200'], ['NV2', '100']]);
    // đảo sang kỳ sau: kỳ gốc vẫn thấy, kỳ đảo thấy số âm, cộng hai kỳ bằng 0
    expect((await call('POST', `/api/vouchers/${a.id}/reverse`, { postingDate: '2026-05-02' })).statusCode).toBe(201);
    const apr = (await call('GET', '/api/reports/sales?from=2026-04-01&to=2026-04-30&groupBy=month')).json();
    const may = (await call('GET', '/api/reports/sales?from=2026-05-01&to=2026-05-31&groupBy=month')).json();
    expect(apr.rows[0]).toMatchObject({ netRevenue: '300', soldQty: '15' });
    expect(may.rows[0]).toMatchObject({ netRevenue: '-200', soldQty: '-10' });
    // giảm giá bán (GGB) là khoản giảm trừ
    const orig = await create({ ...sale([sl('S1', '1', '1000')], '2026-04-10') });
    await create({ voucherType: 'GGB', postingDate: '2026-04-12', documentDate: '2026-04-12', partyCode: 'KH001', autoPost: true,
      items: [{ description: 'Giảm giá', accountCode: '5113', amountCurrency: '100', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TBB', invoiceNo: `G${seq++}`, invoiceDate: '2026-04-12', invoiceGroupCode: '10', adjustsInvoiceId: orig.invoices[0].id } });
    const gg = (await call('GET', '/api/reports/sales?from=2026-04-10&to=2026-04-12&groupBy=month')).json();
    expect(gg.rows[0]).toMatchObject({ grossSales: '1000', returns: '100', netRevenue: '900' });
    const c = await login(['report.view', 'report.print'], []);
    const x = await ctx.app.inject({ method: 'GET', url: '/api/reports/sales?from=2026-04-01&to=2026-04-30&format=xlsx', headers: { cookie: c } });
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const text: string[] = []; wb.worksheets[0]!.eachRow((r) => r.eachCell((cell) => text.push(String(cell.value))));
    expect(text).toContain('Doanh thu thuần'); expect(text).not.toContain('Lãi gộp'); expect(text).not.toContain('Giá vốn');
  });
});
