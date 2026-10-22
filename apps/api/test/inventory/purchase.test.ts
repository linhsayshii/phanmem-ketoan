import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let seq = 0;
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const shape = (v: { lines?: { accountCode: string; debit: string; credit: string }[]; ledgerLines?: { accountCode: string; debit: string; credit: string }[] }) =>
  (v.lines ?? v.ledgerLines!).map((l) => `${l.accountCode}:${l.debit}:${l.credit}`).sort();
const moves = async (voucherId: string) => (await sql<{ direction: string; quantity: string; posting_date: string }>`
  SELECT direction, quantity::text, posting_date::text FROM stock_move WHERE voucher_id = ${voucherId}::uuid ORDER BY id`.execute(ctx.t.admin)).rows;
const layers = async (voucherId: string) => (await sql<{ kind: string; value: string; unit_cost: string; voucher_id: string | null }>`
  SELECT c.kind, c.value::text, c.unit_cost::text, c.voucher_id::text FROM stock_cost_layer c JOIN stock_move m ON m.id = c.move_id WHERE m.voucher_id = ${voucherId}::uuid ORDER BY c.id`.execute(ctx.t.admin)).rows;
const mh = (items: object[], more: object = {}, inv: object = {}) => ({ voucherType: 'MH', stockMode: 'through_stock', postingDate: '2026-03-01', documentDate: '2026-03-01', partyCode: 'NCC001', autoPost: true,
  items, invoice: { serial: 'C26TAA', invoiceNo: `M${seq++}`, invoiceDate: '2026-03-01', invoiceGroupCode: '01', ...inv }, ...more });
const line = (item: string, qty: string, price: string, extra: object = {}) =>
  ({ itemCode: item, uomCode: 'CAI', warehouseCode: 'K1', quantity: qty, unitPrice: price, amountCurrency: String(Number(qty) * Number(price)), taxCodes: ['V10'], ...extra });
const pnk = async (item: string, date: string, qty: string, price: string, extra: object = {}) => {
  const r = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: item, uomCode: 'CAI', quantity: qty, ...(price && { unitPrice: price }) }], ...extra });
  expect(r.statusCode, r.body).toBe(201); return r.json();
};
const post = async (id: string) => { const r = await call('POST', `/api/vouchers/${id}/post`, {}); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const create = async (body: object) => { const r = await call('POST', '/api/invoices', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await setupLedgerTenant(ctx, `MH${Date.now()}`));
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
  for (const c of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) await cat('item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
});
afterAll(async () => { await ctx.close(); });

describe('mua hàng hóa (MH, TLM)', () => {
  it('qua kho: 100 x 10 thuế 10%: Nợ 156 1.000, Nợ 1331 100, Có 331 1.100; stock_move in; hóa đơn vào bảng kê', async () => {
    const v = await create(mh([line('A1', '100', '10')]));
    expect(v.state).toBe('posted');
    expect(shape(v)).toEqual(['1331:100:0', '156:1000:0', '331:0:1100']);
    expect(await moves(v.id)).toEqual([{ direction: 'in', quantity: '100.0000', posting_date: '2026-03-01' }]);
    expect(await layers(v.id)).toMatchObject([{ kind: 'receipt', value: '1000', unit_cost: '10.0000' }]);
    expect(v.invoices).toHaveLength(1); expect(v.invoices[0]).toMatchObject({ baseAmount: '1000', taxAmount: '100' });
    const reg = await sql<{ n: string }>`SELECT count(*)::text AS n FROM voucher_invoice WHERE voucher_id = ${v.id}::uuid AND direction = 'purchase'`.execute(ctx.t.admin);
    expect(reg.rows[0]!.n).toBe('1');
  });

  it('hàng về trước hóa đơn: PNK tạm tính 10, MH giá thật 10,5 → lớp điều chỉnh +50, 156 = 1.050, không thêm stock_move', async () => {
    const p = await post((await pnk('A2', '2026-03-01', '100', '10')).id);
    const inv = await create(mh([line('A2', '100', '10.5', { amountCurrency: '1050' })], { stockMode: 'goods_first', postingDate: '2026-03-05', documentDate: '2026-03-05', receiptVoucherIds: [p.id] }, { invoiceDate: '2026-03-05' }));
    expect(shape(inv)).toEqual(['1331:105:0', '156:50:0', '331:0:155']);
    expect(await moves(inv.id)).toEqual([]);
    expect(await layers(p.id)).toMatchObject([{ kind: 'receipt', value: '1000' }, { kind: 'adjustment', value: '50', voucher_id: inv.id }]);
    expect(inv.invoices[0]).toMatchObject({ baseAmount: '1050', taxAmount: '105' });
    const bal = await sql<{ d: string }>`SELECT sum(l.debit - l.credit)::text AS d FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN item i ON i.id = l.item_id
      JOIN voucher v ON v.id = l.voucher_id WHERE a.code = '156' AND i.code = 'A2' AND v.state = 'posted'`.execute(ctx.t.admin);
    expect(bal.rows[0]!.d).toBe('1050');
    // bỏ ghi sổ MH: lớp điều chỉnh được triệt tiêu, tổng về 1.000
    const u = await call('POST', `/api/vouchers/${inv.id}/unpost`, {}); expect(u.statusCode, u.body).toBe(200);
    expect((await layers(p.id)).reduce((s, l) => s + Number(l.value), 0)).toBe(1000);
    // PNK đã ghi nhận hóa đơn thì không bỏ ghi sổ được khi MH đang ghi sổ
    await post(inv.id);
    expect((await layers(p.id)).reduce((s, l) => s + Number(l.value), 0)).toBe(1050);
    const bad = await call('POST', `/api/vouchers/${p.id}/unpost`, {}); expect(bad.statusCode).toBe(409);
  });

  it('hóa đơn về trước hàng: MH Nợ 151, không stock_move; PNK theo hóa đơn chuyển 151 → 156, tồn tăng từ ngày nhập', async () => {
    const inv = await create(mh([line('A3', '100', '10')], { stockMode: 'invoice_first' }));
    expect(shape(inv)).toEqual(['1331:100:0', '151:1000:0', '331:0:1100']);
    expect(await moves(inv.id)).toEqual([]);
    const p = await pnk('A3', '2026-03-10', '100', '', { sourceInvoiceIds: [inv.id] });
    expect(shape(p)).toEqual(['151:0:1000', '156:1000:0']);
    await post(p.id);
    expect(await moves(p.id)).toEqual([{ direction: 'in', quantity: '100.0000', posting_date: '2026-03-10' }]);
    const oh = async (d: string) => (await call('GET', `/api/inventory/on-hand?itemCode=A3&warehouseCode=K1&date=${d}`)).json().quantity;
    expect(Number(await oh('2026-03-05'))).toBe(0); expect(Number(await oh('2026-03-10'))).toBe(100);
    // hóa đơn đã có phiếu nhập ghi sổ: không bỏ ghi sổ được
    const bad = await call('POST', `/api/vouchers/${inv.id}/unpost`, {}); expect(bad.statusCode).toBe(409);
  });

  it('trả lại 20 cái: xuất theo giá nhập gốc 10: Nợ 331 220, Có 156 200, Có 1331 20', async () => {
    const orig = await create(mh([line('A4', '100', '10')]));
    const r = await call('POST', '/api/invoices', { voucherType: 'TLM', stockMode: 'through_stock', postingDate: '2026-03-12', documentDate: '2026-03-12', partyCode: 'NCC001', autoPost: true,
      items: [{ itemCode: 'A4', uomCode: 'CAI', warehouseCode: 'K1', quantity: '20', sourceLineId: orig.items[0].id, amountCurrency: '200', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-12', invoiceGroupCode: '01', adjustsInvoiceId: orig.invoices[0].id } });
    expect(r.statusCode, r.body).toBe(201); const t = r.json();
    expect(shape(t)).toEqual(['1331:0:20', '156:0:200', '331:220:0']);
    expect(await moves(t.id)).toEqual([{ direction: 'out', quantity: '20.0000', posting_date: '2026-03-12' }]);
    // sai tiền so với giá nhập gốc bị chặn
    const bad = await call('POST', '/api/invoices', { voucherType: 'TLM', stockMode: 'through_stock', postingDate: '2026-03-12', documentDate: '2026-03-12', partyCode: 'NCC001',
      items: [{ itemCode: 'A4', uomCode: 'CAI', warehouseCode: 'K1', quantity: '20', sourceLineId: orig.items[0].id, amountCurrency: '250', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-12', invoiceGroupCode: '01', adjustsInvoiceId: orig.invoices[0].id } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('PURCHASE_RETURN_AMOUNT_MISMATCH');
    // giảm giá không trả hàng: giảm giá vốn, lớp điều chỉnh âm
    const d = await call('POST', '/api/invoices', { voucherType: 'TLM', stockMode: 'through_stock', postingDate: '2026-03-13', documentDate: '2026-03-13', partyCode: 'NCC001', autoPost: true,
      items: [{ itemCode: 'A4', sourceLineId: orig.items[0].id, amountCurrency: '50', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-13', invoiceGroupCode: '01', adjustsInvoiceId: orig.invoices[0].id } });
    expect(d.statusCode, d.body).toBe(201);
    expect(shape(d.json())).toEqual(['1331:0:5', '156:0:50', '331:55:0']);
    expect(await layers(orig.id)).toMatchObject([{ kind: 'receipt', value: '1000' }, { kind: 'adjustment', value: '-50', voucher_id: d.json().id }]);
  });

  it('chiết khấu thương mại 5%: giá nhập 9,5 mỗi cái', async () => {
    const v = await create(mh([line('A5', '100', '10', { discountRate: '5', discountCurrency: '50' })]));
    expect(shape(v)).toEqual(['1331:95:0', '156:950:0', '331:0:1045']);
    expect(await layers(v.id)).toMatchObject([{ kind: 'receipt', value: '950', unit_cost: '9.5000' }]);
  });

  it('đảo MH: stock_move đảo, 331 đảo; hàng đã xuất thì STOCK_NEGATIVE', async () => {
    const a = await create(mh([line('A6', '10', '10')]));
    const rv = await call('POST', `/api/vouchers/${a.id}/reverse`, { postingDate: '2026-03-02' });
    expect(rv.statusCode, rv.body).toBe(201);
    const rid = rv.json().id;
    expect(await moves(rid)).toEqual([{ direction: 'out', quantity: '10.0000', posting_date: '2026-03-02' }]);
    expect(shape(rv.json())).toEqual(['1331:0:10', '156:0:100', '331:110:0']);
    const b = await create(mh([line('A7', '10', '10')]));
    const x = await call('POST', '/api/stock-vouchers', { voucherType: 'PXK', stockKind: 'sale', postingDate: '2026-03-03', warehouseCode: 'K1', items: [{ itemCode: 'A7', uomCode: 'CAI', quantity: '10' }] });
    expect(x.statusCode, x.body).toBe(201); await post(x.json().id);
    const bad = await call('POST', `/api/vouchers/${b.id}/reverse`, { postingDate: '2026-03-04' });
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('STOCK_NEGATIVE');
  });
});
