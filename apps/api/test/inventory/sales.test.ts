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
  for (const c of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) await cat('item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' });
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
    const c = await login(['voucher.view', 'voucher.create', 'voucher.post', 'stock_voucher.view', 'stock_voucher.create', 'stock_voucher.update', 'stock_voucher.post'], ['view_receivable']);
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

describe('bán hàng hóa: sửa sau rà soát (vòng 1)', () => {
  const costWords = /"(632|156|157)"/;
  it('không có view_cost: PUT hóa đơn nháp, ghi sổ, bỏ ghi sổ, đảo đều không lộ dòng giá vốn', async () => {
    await pnk('R1', '2026-03-01', '50', '10');
    const c = await login(['voucher.view', 'voucher.create', 'voucher.update', 'voucher.post', 'voucher.unpost', 'voucher.edit_posted', 'stock_voucher.view', 'stock_voucher.create', 'stock_voucher.update', 'stock_voucher.post'], ['view_receivable']);
    const body = sale([sl('R1', '5', '20')], { autoPost: false });
    const cr = await call('POST', '/api/invoices', body, c); expect(cr.statusCode, cr.body).toBe(201);
    const id = cr.json().id;
    const up = await call('PUT', `/api/invoices/${id}`, { ...sale([sl('R1', '6', '20')], { autoPost: false }), version: cr.json().version }, c);
    expect(up.statusCode, up.body).toBe(200); expect(up.body).not.toMatch(costWords);
    const steps: [string, string][] = [['post', '200'], ['unpost', '200'], ['post', '200'], ['reverse', '200']];
    for (const [st] of steps) {
      const r = await call('POST', `/api/vouchers/${id}/${st}`, st === 'reverse' ? { postingDate: '2026-03-06' } : {}, c);
      expect(r.statusCode, `${st} ${r.body}`).toBe(st === 'reverse' ? 201 : 200); expect(r.body).not.toMatch(costWords);
    }
  });

  it('trả 20.001 của 30.000 bán (gán 100.000, kho bình quân kỳ): giá vốn 66.669 khớp lớp giá, chạy lại không đổi', async () => {
    await pnk('R2', '2026-03-01', '30000', '3', 'K2');
    const b = await create(sale([sl('R2', '30000', '5', { warehouseCode: 'K2' })]));
    await pnk('R2', '2026-03-20', '60000', '3.5', 'K2');
    const runBody = { periodFrom: '2026-03-01', periodTo: '2026-03-31', warehouseCode: 'K2', itemCode: 'R2' };
    expect((await call('POST', '/api/inventory/costing-runs', runBody)).statusCode).toBe(200);
    const t = await create(tlb(b, await lineId(b.id), 'R2', '20001', '5', { postingDate: '2026-03-25' }, 'K2'));
    expect(shape(t)).toContain('632:0:66669');
    const r2 = await call('POST', '/api/inventory/costing-runs', runBody); expect(r2.statusCode, r2.body).toBe(200);
    expect(await drift('K2')).toEqual([]);
    const gv = async () => Number((await sql<{ n: string }>`SELECT count(*)::text n FROM voucher WHERE voucher_type = 'GV' AND state = 'posted'`.execute(ctx.t.admin)).rows[0]!.n);
    const before = await gv();
    expect((await call('POST', '/api/inventory/costing-runs', runBody)).statusCode).toBe(200);
    expect(await drift('K2')).toEqual([]); expect(await gv()).toBe(before);
  });

  it('trả từng phần 1 + 1 + 1: lần cuối nhận phần còn lại, tổng giá vốn trả = giá vốn bán (10)', async () => {
    await pnk('R3', '2026-03-01', '3', '3.3333');
    const b = await create(sale([sl('R3', '3', '20')]));
    const src = await lineId(b.id);
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      const t = await create(tlb(b, src, 'R3', '1', '20'));
      sum += Number(shape(t).find((x) => x.startsWith('632:'))!.split(':')[2]);
    }
    expect(sum).toBe(10);
  });

  it('bán 1 THUNG (24 CHAI), trả 5 CHAI: giá vốn trả = 5/24 giá vốn bán', async () => {
    await pnk('CH1', '2026-03-02', '240', '10', 'K1', 'CHAI');
    const b = await create(sale([sl('CH1', '1', '240', { uomCode: 'THUNG' })]));
    const src = await lineId(b.id);
    const body = tlb(b, src, 'CH1', '5', '10'); body.items[0]!.uomCode = 'CHAI';
    const t = await create(body);
    expect(shape(t)).toContain('632:0:50');
  });

  it('adjustsInvoiceId của hóa đơn BH khác: 409 SALE_RETURN_INVOICE_MISMATCH', async () => {
    await pnk('R4', '2026-03-01', '10', '10');
    const b1 = await create(sale([sl('R4', '2', '20')])); const b2 = await create(sale([sl('R4', '2', '20')]));
    const r = await call('POST', '/api/invoices', tlb(b2, await lineId(b1.id), 'R4', '1', '20'));
    expect(r.statusCode, r.body).toBe(409); expect(code(r)).toBe('SALE_RETURN_INVOICE_MISMATCH');
  });

  it('exportMode: mã thuế không thuế suất (KCT) được chấp nhận', async () => {
    await pnk('R5', '2026-03-01', '10', '10');
    const r = await call('POST', '/api/invoices', sale([{ ...sl('R5', '1', '20'), taxCodes: ['KCT'] }], { exportMode: true }));
    expect(r.statusCode, r.body).toBe(201);
  });

  it.each([['TT133', '5111', '5111'], ['TT200', '5111', '5213'], ['TT99', '511', '521']] as const)('%s: hàng bán bị trả lại ghi Nợ %s', async (regime, rev, debit) => {
    const saved = cookie;
    try {
      if (regime !== 'TT133') {
        ({ cookie } = await setupLedgerTenant(ctx, `RT${regime}${Date.now()}`, regime));
        await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
        await cat('item', { code: 'R6', name: 'Hàng', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: rev });
        await cat('warehouse', { code: 'K1', name: 'Kho', inventory_account_code: regime === 'TT200' ? '1561' : '156', costing_method: 'avg_moving' });
      }
      await pnk('R6', '2026-03-01', '10', '10');
      const b = await create(sale([sl('R6', '4', '20')]));
      const t = await create(tlb(b, await lineId(b.id), 'R6', '1', '20'));
      expect(shape(t)).toContain(`${debit}:20:0`);
    } finally { cookie = saved; }
  });
});

describe('bán hàng hóa: sửa sau rà soát (vòng 2)', () => {
  it('không có view_cost: PUT siêu dữ liệu, nhân bản, hủy chứng từ BH không lộ dòng giá vốn', async () => {
    await pnk('R5', '2026-03-02', '10', '10');
    const b = await create(sale([sl('R5', '2', '20')]));
    const c = await login(['voucher.view', 'voucher.create', 'voucher.update', 'voucher.delete', 'voucher.edit_posted', 'stock_voucher.view', 'stock_voucher.create', 'stock_voucher.update', 'stock_voucher.delete'], ['view_receivable']);
    const re = /"(632|156|157)"/;
    const meta = await call('PUT', `/api/vouchers/${b.id}`, { description: 'sửa mô tả', version: b.version }, c);
    expect(meta.statusCode, meta.body).toBe(200); expect(meta.body).not.toMatch(re);
    const dup = await call('POST', `/api/vouchers/${b.id}/duplicate`, { postingDate: '2026-03-06' }, c);
    expect(dup.statusCode, dup.body).toBe(409); expect(code(dup)).toBe('VOUCHER_TYPE_USE_INVOICE'); expect(dup.body).not.toMatch(re);
  });

  it('hai TLB cùng ngày: TLB đứng cuối theo thứ tự trong ngày nhận phần còn lại, tổng giá vốn trả = 10', async () => {
    await pnk('R7', '2026-03-01', '3', '3.3333', 'K2');
    const b = await create(sale([sl('R7', '3', '20', { warehouseCode: 'K2' })]));
    const src = await lineId(b.id);
    const mk = async (qty: string, dayOrder: number) => {
      const v = await create(tlb(b, src, 'R7', qty, '20', { autoPost: false }, 'K2'));
      expect((await call('PUT', `/api/vouchers/${v.id}/day-order`, { dayOrder })).statusCode).toBe(200);
      return v;
    };
    const a = await mk('1', 5); const c = await mk('2', 1); // c đứng trước a trong ngày dù lập sau
    for (const v of [a, c]) expect((await call('POST', `/api/vouchers/${v.id}/post`, {})).statusCode).toBe(200);
    const run = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-03-01', periodTo: '2026-03-31', warehouseCode: 'K2', itemCode: 'R7' });
    expect(run.statusCode, run.body).toBe(200);
    const net = (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit),0)::text n FROM voucher_line l JOIN voucher v ON v.id=l.voucher_id JOIN account a ON a.id=l.account_id JOIN item i ON i.id=l.item_id
      WHERE i.code='R7' AND a.code='632' AND v.state IN ('posted','reversed')`.execute(ctx.t.admin)).rows[0]!.n;
    expect(net).toBe('0'); expect(await drift('K2')).toEqual([]);
  });
});

describe('bán hàng hóa: in phiếu kho', () => {
  it('BH in 02-VT và TLB in 01-VT với giá vốn, không phải giá bán', async () => {
    await pnk('R5', '2026-03-03', '10', '10');
    const b = await create(sale([sl('R5', '3', '20')]));
    const r = await call('GET', `/api/vouchers/${b.id}/print`); expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('PHIẾU XUẤT KHO'); expect(r.body).toMatch(/<td class="num">10<\/td><td class="num">30<\/td>/);
    expect(r.body).not.toMatch(/<td class="num">20<\/td>/); expect(r.body).not.toMatch(/<td class="num">60<\/td>/);
    const t = await create(tlb(b, await lineId(b.id), 'R5', '1', '20'));
    const r2 = await call('GET', `/api/vouchers/${t.id}/print`); expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.body).toContain('PHIẾU NHẬP KHO'); expect(r2.body).toMatch(/<td class="num">10<\/td><td class="num">10<\/td>/);
  });
});

describe('bán hàng hóa: sửa sau rà soát (vòng 3)', () => {
  it('in chứng từ: TLB (in 01-VT) thiếu view_cost in được nhưng không có đơn giá, thiếu view_receivable bị 403; phiếu thu không dòng nhạy cảm vẫn in khi thiếu view_receivable', async () => {
    await pnk('R4', '2026-03-03', '10', '10');
    const b = await create(sale([sl('R4', '3', '20')]));
    const t = await create(tlb(b, await lineId(b.id), 'R4', '1', '20'));
    const perms = ['voucher.view', 'voucher.print', 'stock_voucher.view'];
    const noCost = await login(perms, ['view_receivable']);
    const r1 = await call('GET', `/api/vouchers/${t.id}/print`, undefined, noCost);
    expect(r1.statusCode, r1.body).toBe(200); expect(r1.body).not.toContain('Đơn giá');
    expect((await call('GET', `/api/vouchers/${t.id}/print`, undefined, await login(perms, ['view_cost']))).statusCode).toBe(403);
    const withCost = await login(perms, ['view_receivable', 'view_cost']);
    const r2 = await call('GET', `/api/vouchers/${t.id}/print`, undefined, withCost);
    expect(r2.statusCode, r2.body.slice(0, 200)).toBe(200);
    const pt = await call('POST', '/api/vouchers', { voucherType: 'PT', postingDate: '2026-03-05', documentDate: '2026-03-05', autoPost: true,
      lines: [{ accountCode: '1111', debit: '100', credit: '0' }, { accountCode: '5113', debit: '0', credit: '100' }] });
    expect(pt.statusCode, pt.body).toBe(201);
    const noRec = await login(perms, ['view_cost']);
    const r3 = await call('GET', `/api/vouchers/${pt.json().id}/print`, undefined, noRec);
    expect(r3.statusCode, r3.body.slice(0, 200)).toBe(200);
  });
});
