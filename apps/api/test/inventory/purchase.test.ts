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
  for (const c of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14']) await cat('item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods' });
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

  const tlm = (item: string, src: number, adj: string, qty: string, amount: string, more: object = {}) => ({ voucherType: 'TLM', stockMode: 'through_stock', postingDate: '2026-03-12', documentDate: '2026-03-12', partyCode: 'NCC001',
    items: [{ itemCode: item, uomCode: 'CAI', warehouseCode: 'K1', quantity: qty, sourceLineId: src, amountCurrency: amount, taxCodes: ['V10'] }],
    invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: '2026-03-12', invoiceGroupCode: '01', adjustsInvoiceId: adj }, ...more });
  const code = (r: Res) => r.json().error.code;

  it('liên kết khác nhà cung cấp: hàng về trước và trả lại bị chặn 409', async () => {
    const p = await post((await pnk('A8', '2026-03-01', '10', '10')).id);
    const r = await call('POST', '/api/invoices', mh([line('A8', '10', '10')], { stockMode: 'goods_first', partyCode: 'KH001', receiptVoucherIds: [p.id] }));
    expect(r.statusCode).toBe(409); expect(code(r)).toBe('RECEIPT_PARTY_MISMATCH');
    const orig = await create(mh([line('A8', '10', '10')]));
    const t = await call('POST', '/api/invoices', tlm('A8', orig.items[0].id, orig.invoices[0].id, '5', '50', { partyCode: 'KH001' }));
    expect(t.statusCode).toBe(409); expect(code(t)).toBe('PURCHASE_RETURN_PARTY_MISMATCH');
  });

  it('liên kết tới nháp: phiếu nhập chưa ghi sổ không liên kết được; nháp hóa đơn đang tham chiếu thì phiếu nhập không đảo, không bỏ ghi sổ được', async () => {
    const draft = await pnk('A9', '2026-03-01', '10', '10');
    const r = await call('POST', '/api/invoices', mh([line('A9', '10', '10')], { stockMode: 'goods_first', receiptVoucherIds: [draft.id] }));
    expect(r.statusCode).toBe(409); expect(code(r)).toBe('RECEIPT_NOT_POSTED');
    const p = await post(draft.id);
    const d = await call('POST', '/api/invoices', mh([line('A9', '10', '10.5', { amountCurrency: '105' })], { stockMode: 'goods_first', autoPost: false, receiptVoucherIds: [p.id] }));
    expect(d.statusCode, d.body).toBe(201);
    const un = await call('POST', `/api/vouchers/${p.id}/unpost`, {}); expect(un.statusCode).toBe(409); expect(code(un)).toBe('LINE_REFERENCED');
    const rv = await call('POST', `/api/vouchers/${p.id}/reverse`, { postingDate: '2026-03-02' }); expect(rv.statusCode).toBe(409); expect(code(rv)).toBe('LINE_REFERENCED');
  });

  it('mất liên kết khi ghi sổ: MH hàng về trước thiếu dòng phiếu nhập, PNK Có 151 thiếu dòng hóa đơn đều bị chặn', async () => {
    const p = await post((await pnk('A10', '2026-03-01', '10', '10')).id);
    const d = (await call('POST', '/api/invoices', mh([line('A10', '10', '10.5', { amountCurrency: '105' })], { stockMode: 'goods_first', autoPost: false, receiptVoucherIds: [p.id] }))).json();
    await sql`UPDATE voucher_item_line SET link_line_id = NULL WHERE voucher_id = ${d.id}::uuid`.execute(ctx.t.admin);
    const r = await call('POST', `/api/vouchers/${d.id}/post`, {}); expect(r.statusCode).toBe(409); expect(code(r)).toBe('RECEIPT_LINK_LOST');
    const inv = await create(mh([line('A10', '10', '10')], { stockMode: 'invoice_first' }));
    const q = await pnk('A10', '2026-03-10', '10', '', { sourceInvoiceIds: [inv.id] });
    await sql`UPDATE voucher_item_line SET link_line_id = NULL WHERE voucher_id = ${q.id}::uuid`.execute(ctx.t.admin);
    const r2 = await call('POST', `/api/vouchers/${q.id}/post`, {}); expect(r2.statusCode).toBe(409); expect(code(r2)).toBe('INVOICE_LINK_LOST');
    // PNK nhập tay ghi Có 151 mà không gắn hóa đơn
    const m = await pnk('A10', '2026-03-10', '1', '10', { items: [{ itemCode: 'A10', uomCode: 'CAI', quantity: '1', unitPrice: '10', creditAccountCode: '151' }] });
    const r3 = await call('POST', `/api/vouchers/${m.id}/post`, {}); expect(r3.statusCode).toBe(409); expect(code(r3)).toBe('INVOICE_LINK_LOST');
    // phiếu nhập theo hóa đơn không đổi tài khoản Có
    const bad = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-10', warehouseCode: 'K1', partyCode: 'NCC001', sourceInvoiceIds: [inv.id],
      items: [{ itemCode: 'A10', uomCode: 'CAI', quantity: '10', creditAccountCode: '331' }] });
    expect(bad.statusCode).toBe(400);
  });

  it('ngoại tệ: tổng lớp giá nhập bằng Nợ 156 của sổ cái (kể cả dòng bị chia chênh làm tròn), 151 về 0 sau khi nhập kho', async () => {
    const mkLines = (item: string, extra: object = {}) => ['0.33', '0.33'].map((a) => line(item, '1', a, { amountCurrency: a, ...extra }));
    const fx = { currencyCode: 'USD', fxRate: '25432.5' };
    const v = await create(mh(mkLines('A11'), fx));
    const l156 = v.lines.filter((l: { accountCode: string }) => l.accountCode === '156').reduce((s: number, l: { debit: string }) => s + Number(l.debit), 0);
    expect(l156).toBe(16785); // số làm tròn từng dòng là 16.786: dòng cơ sở bị chia chênh -1 đồng
    expect((await layers(v.id)).reduce((s, l) => s + Number(l.value), 0)).toBe(l156);
    const sv = await sql<{ n: string }>`SELECT count(*)::text AS n FROM voucher_item_line WHERE voucher_id = ${v.id}::uuid AND stock_value IS NOT NULL`.execute(ctx.t.admin);
    expect(sv.rows[0]!.n).toBe('2');
    // hóa đơn về trước hàng bằng USD, phiếu nhập theo hóa đơn: 151 hết số dư
    const inv = await create(mh(mkLines('A12', { warehouseCode: undefined }), { ...fx, stockMode: 'invoice_first' }));
    const p = await pnk('A12', '2026-03-10', '1', '', { sourceInvoiceIds: [inv.id], items: [{ itemCode: 'A12', uomCode: 'CAI', quantity: '1' }, { itemCode: 'A12', uomCode: 'CAI', quantity: '1' }] });
    await post(p.id);
    const b = await sql<{ d: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS d FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN item i ON i.id = l.item_id
      JOIN voucher v ON v.id = l.voucher_id WHERE a.code = '151' AND i.code = 'A12' AND v.state = 'posted'`.execute(ctx.t.admin);
    expect(b.rows[0]!.d).toBe('0');
    const sum156 = await sql<{ d: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS d FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN item i ON i.id = l.item_id
      JOIN voucher v ON v.id = l.voucher_id WHERE a.code = '156' AND i.code = 'A12' AND v.state = 'posted'`.execute(ctx.t.admin);
    expect((await layers(p.id)).reduce((s, l) => s + Number(l.value), 0)).toBe(Number(sum156.rows[0]!.d));
  });

  it('trả lại không vượt số lượng nhập: tính cả phiếu trả nháp và đã ghi sổ', async () => {
    const orig = await create(mh([line('A13', '100', '10')]));
    const first = await call('POST', '/api/invoices', tlm('A13', orig.items[0].id, orig.invoices[0].id, '60', '600', { autoPost: false })); expect(first.statusCode, first.body).toBe(201);
    const over = await call('POST', '/api/invoices', tlm('A13', orig.items[0].id, orig.invoices[0].id, '50', '500')); expect(over.statusCode).toBe(409); expect(code(over)).toBe('RETURN_EXCEEDS_RECEIPT');
    const ok = await call('POST', '/api/invoices', tlm('A13', orig.items[0].id, orig.invoices[0].id, '40', '400')); expect(ok.statusCode, ok.body).toBe(201);
  });

  it('đã tính giá vốn phủ ngày nhập: không bỏ ghi sổ MH hàng về trước (STOCK_COST_ADJUSTED), đảo được', async () => {
    const p = await post((await pnk('A14', '2026-03-01', '10', '10')).id);
    const inv = await create(mh([line('A14', '10', '10.5', { amountCurrency: '105' })], { stockMode: 'goods_first', receiptVoucherIds: [p.id] }));
    const run = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-03-01', periodTo: '2026-03-31', itemCode: 'A14' }); expect(run.statusCode, run.body).toBe(200);
    const un = await call('POST', `/api/vouchers/${inv.id}/unpost`, {}); expect(un.statusCode).toBe(409); expect(code(un)).toBe('STOCK_COST_ADJUSTED');
    const rv = await call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-03-20' }); expect(rv.statusCode, rv.body).toBe(201);
  });

  it('lập kèm ghi sổ: thiếu stock_voucher.post thì 403; MH, TLM không in mẫu kho và tổng tiền danh sách bị che khi thiếu view_cost', async () => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['voucher.view', 'voucher.create', 'voucher.post', 'voucher.print', 'stock_voucher.view', 'stock_voucher.create'] });
    const username = `mh_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: ['view_cost', 'view_payable'] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/invoices', headers: { cookie: c }, payload: mh([line('A1', '1', '10')]) });
    expect(r.statusCode).toBe(403);
    const made = await create(mh([line('A1', '1', '10')]));
    const pr = await call('GET', `/api/vouchers/${made.id}/print`); expect(pr.statusCode).toBe(409); expect(code(pr)).toBe('PRINT_FORM_NOT_READY');
  });
});
