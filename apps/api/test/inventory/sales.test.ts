import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let seq = 0;
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const shape = (v: { lines?: { accountCode: string; debit: string; credit: string }[] }) => v.lines!.map((l) => `${l.accountCode}:${l.debit}:${l.credit}`).sort();
const code = (r: Res) => r.json().error?.code ?? r.json().code;
const moves = async (voucherId: string) => (await sql<{ direction: string; quantity: string }>`
  SELECT direction, quantity::text FROM stock_move WHERE voucher_id = ${voucherId}::uuid ORDER BY id`.execute(ctx.t.admin)).rows;
const lineId = async (voucherId: string) => (await sql<{ id: string }>`SELECT id::text FROM voucher_item_line WHERE voucher_id = ${voucherId}::uuid ORDER BY id LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
const drift = async (wh: string) => (await sql<{ wh: string; l: string; g: string }>`SELECT w.code AS wh, (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.warehouse_id = w.id)::text AS l, (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE l.warehouse_id = w.id AND l.account_id = w.inventory_account_id AND v.state IN ('posted','reversed'))::text AS g FROM warehouse w WHERE w.code = ${wh} AND
  (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.warehouse_id = w.id) <>
  (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    WHERE l.warehouse_id = w.id AND l.account_id = w.inventory_account_id AND v.state IN ('posted','reversed'))`.execute(ctx.t.admin)).rows;
const pnk = async (item: string, date: string, qty: string, price: string, wh = 'K1', uom = 'CAI') => {
  const r = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: wh, partyCode: 'NCC001', items: [{ itemCode: item, uomCode: uom, quantity: qty, unitPrice: price }] });
  expect(r.statusCode, r.body).toBe(201);
  const p = await call('POST', `/api/vouchers/${r.json().id}/post`, {}); expect(p.statusCode, p.body).toBe(200);
};
const sale = (items: object[], more: object = {}, inv: object = {}) => ({ voucherType: 'BH', postingDate: '2026-03-05', documentDate: '2026-03-05', partyCode: 'KH001', autoPost: true,
  items, invoice: { serial: 'C26TBB', invoiceNo: `B${seq++}`, invoiceDate: '2026-03-05', invoiceGroupCode: '10', ...inv }, ...more });
const sl = (item: string, qty: string, price: string, extra: object = {}) =>
  ({ itemCode: item, uomCode: 'CAI', warehouseCode: 'K1', quantity: qty, unitPrice: price, amountCurrency: String(Number(qty) * Number(price)), taxCodes: ['V10'], ...extra });
const create = async (body: object) => { const r = await call('POST', '/api/invoices', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
const tlb = (orig: { id: string; invoices: { id: string }[] } | null, src: string, item: string, qty: string, price: string, more: object = {}, wh = 'K1') => ({ voucherType: 'TLB', postingDate: '2026-03-08', documentDate: '2026-03-08', partyCode: 'KH001', autoPost: true,
  items: [{ ...sl(item, qty, price, { warehouseCode: wh }), sourceLineId: Number(src) }], invoice: { serial: 'C26TBB', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-08', invoiceGroupCode: '10', ...(orig && { adjustsInvoiceId: orig.invoices[0]!.id }) }, ...more });
const login = async (perms: string[], flags: string[]) => {
  const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
  await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
  const username = `bh_${Date.now()}_${seq++}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
};

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await setupLedgerTenant(ctx, `BH${Date.now()}`));
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
  await call('POST', '/api/catalogs/uom', { code: 'CHAI', name: 'Chai' });
  await call('POST', '/api/catalogs/uom', { code: 'THUNG', name: 'Thùng' });
  for (const c of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) await cat('item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' });
  await cat('item', { code: 'SV1', name: 'Dịch vụ', base_uom_code: 'CAI', kind: 'service', revenue_account_code: '5113' });
  await cat('item', { code: 'CH1', name: 'Nước', base_uom_code: 'CHAI', kind: 'goods', revenue_account_code: '5111' });
  await cat('item_uom', { item_code: 'CH1', uom_code: 'THUNG', factor: '24' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  await cat('warehouse', { code: 'K2', name: 'Kho kỳ', inventory_account_code: '156', costing_method: 'avg_period' });
  await cat('warehouse', { code: 'KG', name: 'Kho gửi bán', inventory_account_code: '157', costing_method: 'avg_moving', kind: 'consignment_out' });
});
afterAll(async () => { await ctx.close(); });

describe('bán hàng hóa (BH, TLB)', () => {
  it('60 x 20 thuế 10%, tồn 100 x 10: Nợ 131 1.320, Có 511 1.200, Có 33311 120, Nợ 632 / Có 156 600; stock_move out', async () => {
    await pnk('S1', '2026-03-01', '100', '10');
    const v = await create(sale([sl('S1', '60', '20')]));
    expect(shape(v)).toEqual(['131:1320:0', '156:0:600', '33311:0:120', '5111:0:1200', '632:600:0']);
    expect(await moves(v.id)).toEqual([{ direction: 'out', quantity: '60.0000' }]);
  });

  it('bán 12 THUNG (1 THUNG = 24 CHAI): stock_move out 288', async () => {
    await pnk('CH1', '2026-03-01', '1000', '10', 'K1', 'CHAI');
    const v = await create(sale([sl('CH1', '12', '240', { uomCode: 'THUNG' })]));
    expect(await moves(v.id)).toEqual([{ direction: 'out', quantity: '288.0000' }]);
    expect(shape(v)).toContain('632:2880:0');
  });

  it('dịch vụ: chỉ doanh thu, không stock_move, không giá vốn', async () => {
    const v = await create(sale([{ itemCode: 'SV1', uomCode: 'CAI', quantity: '1', unitPrice: '500', amountCurrency: '500', taxCodes: ['V10'] }]));
    expect(shape(v)).toEqual(['131:550:0', '33311:0:50', '5113:0:500']);
    expect(await moves(v.id)).toEqual([]);
  });

  it('bán thấp hơn giá vốn: cảnh báo SALE_BELOW_COST, số liệu chỉ hiện khi có view_cost', async () => {
    await pnk('S2', '2026-03-01', '100', '10');
    const full = await call('POST', '/api/invoices', sale([sl('S2', '10', '5')]));
    expect(full.statusCode, full.body).toBe(201);
    const w = full.json().warnings.find((x: { code: string }) => x.code === 'SALE_BELOW_COST');
    expect(w).toBeTruthy(); expect(JSON.stringify(w)).toMatch(/\d/);
    const c = await login(['voucher.view', 'voucher.create', 'voucher.post', 'stock_voucher.view', 'stock_voucher.create', 'stock_voucher.post'], ['view_receivable']);
    const r = await call('POST', '/api/invoices', sale([sl('S2', '10', '5')]), c);
    expect(r.statusCode, r.body).toBe(201);
    const w2 = r.json().warnings.find((x: { code: string }) => x.code === 'SALE_BELOW_COST');
    expect(w2).toBeTruthy(); expect(w2.message).not.toMatch(/\d{2}|thấp hơn giá vốn tạm/);
    expect(JSON.stringify(r.json().lines)).not.toContain('"632"');
  });

  it('trả lại 5 CHAI theo giá vốn bán gốc; trả quá số đã bán: RETURN_EXCEEDS_SALE', async () => {
    await pnk('S3', '2026-03-01', '100', '10');
    const b = await create(sale([sl('S3', '20', '30')]));
    const src = await lineId(b.id);
    const t = await create(tlb(b, src, 'S3', '5', '30'));
    expect(shape(t)).toEqual(['131:0:165', '156:50:0', '33311:150:0'.replace('150', '15'), '5111:150:0', '632:0:50'].sort());
    expect(await moves(t.id)).toEqual([{ direction: 'in', quantity: '5.0000' }]);
    const over = await call('POST', '/api/invoices', tlb(b, src, 'S3', '16', '30'));
    expect(over.statusCode).toBe(409); expect(code(over)).toBe('RETURN_EXCEEDS_SALE');
    // BH đã có hàng trả lại thì không bỏ ghi sổ được
    const u = await call('POST', `/api/vouchers/${b.id}/unpost`, {}); expect(u.statusCode).toBe(409);
  });

  it('chuyển sang kho gửi bán 157 rồi bán: Nợ 632 / Có 157', async () => {
    await pnk('S4', '2026-03-01', '50', '10');
    const ck = await call('POST', '/api/stock-vouchers', { voucherType: 'CK', stockKind: 'transfer', postingDate: '2026-03-02', warehouseCode: 'K1', destWarehouseCode: 'KG', items: [{ itemCode: 'S4', uomCode: 'CAI', quantity: '30' }] });
    expect(ck.statusCode, ck.body).toBe(201);
    expect((await call('POST', `/api/vouchers/${ck.json().id}/post`, {})).statusCode).toBe(200);
    const v = await create(sale([sl('S4', '10', '20', { warehouseCode: 'KG' })]));
    expect(shape(v)).toEqual(expect.arrayContaining(['157:0:100', '632:100:0']));
  });

  it('đảo BH: đảo cả stock_move, giá vốn và 131', async () => {
    await pnk('S5', '2026-03-01', '100', '10');
    const b = await create(sale([sl('S5', '10', '20')]));
    const r = await call('POST', `/api/vouchers/${b.id}/reverse`, { postingDate: '2026-03-06' });
    expect(r.statusCode, r.body).toBe(201);
    const rv = r.json();
    expect(shape(rv)).toEqual(expect.arrayContaining(['131:0:220', '156:100:0', '632:0:100']));
    expect(await moves(rv.id)).toEqual([{ direction: 'in', quantity: '10.0000' }]);
  });

  it('xuất khẩu: exportMode dùng thuế suất 0%', async () => {
    await pnk('S6', '2026-03-01', '10', '10');
    const v = await create(sale([{ ...sl('S6', '10', '20'), taxCodes: undefined }], { exportMode: true }));
    expect(shape(v)).toEqual(['131:200:0', '156:0:100', '5111:0:200', '632:100:0']);
    const bad = await call('POST', '/api/invoices', sale([sl('S6', '1', '20')], { exportMode: true }));
    expect(bad.statusCode).toBe(400); expect(code(bad)).toBe('EXPORT_VAT_NOT_ZERO');
  });

  it('giá vốn cuối kỳ bình quân kỳ: BH 60 tạm tính 10, thực tế 10,6667 → GV Nợ 632 / Có 156 chênh +40; hàng trả lại theo giá vốn mới', async () => {
    await pnk('S7', '2026-03-01', '100', '10', 'K2');
    const b = await create(sale([sl('S7', '60', '20', { warehouseCode: 'K2' })]));
    expect(shape(b)).toContain('632:600:0');
    await pnk('S7', '2026-03-20', '50', '12', 'K2');
    const run = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-03-01', periodTo: '2026-03-31', warehouseCode: 'K2', itemCode: 'S7' });
    expect(run.statusCode, run.body).toBe(200);
    const bal = async () => (await sql<{ a: string; c: string }>`SELECT
      coalesce(sum(l.debit) FILTER (WHERE a.code='632'),0)::text a, coalesce(sum(l.debit - l.credit) FILTER (WHERE a.code='156'),0)::text c
      FROM voucher_line l JOIN voucher v ON v.id=l.voucher_id JOIN account a ON a.id=l.account_id JOIN item i ON i.id=l.item_id
      WHERE i.code='S7' AND v.state IN ('posted','reversed')`.execute(ctx.t.admin)).rows[0]!;
    expect(await bal()).toEqual({ a: '640', c: '960' });
    expect(await drift('K2')).toEqual([]);
    // trả lại 6 theo giá vốn thực tế (10,6667): 64; chạy lại giá vốn vẫn khớp
    const t = await create(tlb(b, await lineId(b.id), 'S7', '6', '20', { postingDate: '2026-03-25' }, 'K2'));
    expect(shape(t)).toContain('632:0:64');
    const run2 = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-03-01', periodTo: '2026-03-31', warehouseCode: 'K2', itemCode: 'S7' });
    expect(run2.statusCode, run2.body).toBe(200);
  });

  it('thiếu stock_voucher.post: lập kèm ghi sổ bị 403; TLB thiếu sourceLineId: 400', async () => {
    const c = await login(['voucher.view', 'voucher.create', 'voucher.post', 'stock_voucher.view', 'stock_voucher.create'], ['view_cost']);
    expect((await call('POST', '/api/invoices', sale([sl('S8', '1', '20')]), c)).statusCode).toBe(403);
    const r = await call('POST', '/api/invoices', tlb(null, '', 'S8', '1', '20'));
    expect(r.statusCode).toBe(400);
  });
});
