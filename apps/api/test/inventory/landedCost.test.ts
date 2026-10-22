import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Line = { itemCode: string; quantity: string; unitPrice?: string };
type L = { accountCode: string; debit: string; credit: string };
const shape = (ls: L[]) => ls.map((l) => `${l.accountCode}:${l.debit}:${l.credit}`).sort();

// Mỗi kiểm thử một công ty: năm 2026 TT133, ĐVT CAI, nhà cung cấp NCC1, nhà vận chuyển VC1, kho K1 bình quân cuối kỳ.
async function tenant() {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `CP${Date.now()}${n++}` });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('party', { code: 'VC1', name: 'Công ty vận chuyển', is_vendor: true });
  await cat('warehouse', { code: 'K1', name: 'Kho K1', inventory_account_code: '156', costing_method: 'avg_period' });
  for (const c of ['H1', 'H2', 'H3', 'H4', 'H5']) await cat('item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods' });
  const posted = async (url: string, body: object) => {
    const r = await call('POST', url, body); expect(r.statusCode, r.body).toBe(201);
    const p = await call('POST', `/api/vouchers/${r.json().id}/post`, {}); expect(p.statusCode, p.body).toBe(200); return r.json() as { id: string };
  };
  const items = (ls: Line[]) => ls.map((l) => ({ uomCode: 'CAI', ...l }));
  const pnk = (date: string, ls: Line[]) => posted('/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC1', items: items(ls) });
  const pxk = (date: string, ls: Line[]) => posted('/api/stock-vouchers', { voucherType: 'PXK', stockKind: 'sale', postingDate: date, warehouseCode: 'K1', items: items(ls) });
  const cpm = (body: object) => call('POST', '/api/landed-costs', { postingDate: '2026-01-10', partyCode: 'VC1', basis: 'value', ...body });
  const run = async () => { const r = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-01', periodTo: '2026-01-31' }); expect(r.statusCode, r.body).toBe(200); return r.json() as { voucherIds: string[]; unchanged: boolean }; };
  const layers = async (voucherId: string) => (await sql<{ kind: string; value: string; voucher_id: string | null; item: string }>`
    SELECT c.kind, c.value::text, c.voucher_id::text, i.code AS item FROM stock_cost_layer c JOIN stock_move m ON m.id = c.move_id JOIN item i ON i.id = c.item_id WHERE m.voucher_id = ${voucherId}::uuid ORDER BY c.id`.execute(ctx.t.admin)).rows;
  // Σ giá trị còn lại của lớp theo (TK kho, kho) = số dư TK kho của kho trên sổ cái; trả các kho lệch.
  const drift = async () => (await sql<{ wh: string; layers: string; ledger: string }>`SELECT w.code AS wh,
      (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.tenant_id = w.tenant_id AND c.warehouse_id = w.id)::text AS layers,
      (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
        WHERE l.tenant_id = w.tenant_id AND l.warehouse_id = w.id AND l.account_id = w.inventory_account_id AND v.state IN ('posted','reversed'))::text AS ledger
    FROM warehouse w WHERE w.tenant_id = ${tenantId}::uuid ORDER BY w.code`.execute(ctx.t.admin)).rows.filter((r) => r.layers !== r.ledger);
  const itemBal = async (item: string) => (await sql<{ l: string; c: string }>`SELECT
      (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id JOIN item i ON i.id = l.item_id
        WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND a.code = '156' AND i.code = ${item})::text AS l,
      (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c JOIN item i ON i.id = c.item_id WHERE c.tenant_id = ${tenantId}::uuid AND i.code = ${item})::text AS c`.execute(ctx.t.admin)).rows[0]!;
  const gvLines = async (ids: string[]) => ids.length ? (await sql<L>`SELECT a.code AS "accountCode", l.debit::text, l.credit::text FROM voucher_line l JOIN account a ON a.id = l.account_id
    WHERE l.voucher_id = ANY(${ids}::uuid[])`.execute(ctx.t.admin)).rows : [];
  return { tenantId, cookie, call, cat, pnk, pxk, cpm, run, layers, drift, itemBal, gvLines };
}
const code = (r: { json: () => { error: { code: string } } }) => r.json().error.code;

describe('chi phí mua hàng (CPM) phân bổ vào giá nhập kho', () => {
  it('CPM phân bổ cước 600.000 theo giá trị: giá nhập kho các dòng tăng đúng; 156 sổ cái = Σ remaining_value', async () => {
    const t = await tenant();
    const p = await t.pnk('2026-01-05', [{ itemCode: 'H1', quantity: '100', unitPrice: '1000' }, { itemCode: 'H2', quantity: '250', unitPrice: '1000' }, { itemCode: 'H3', quantity: '350', unitPrice: '1000' }]);
    const x = await t.pxk('2026-01-20', [{ itemCode: 'H1', quantity: '40' }]);
    const r = await t.cpm({ receiptVoucherIds: [p.id], costLines: [{ accountCode: '331', amount: '600000', vatAmount: '60000' }], autoPost: true,
      invoices: [{ serial: 'C26TVC', invoiceNo: 'VC001', invoiceDate: '2026-01-10', invoiceGroupCode: '01', taxCode: 'V10', baseAmount: '600000', taxAmount: '60000' }] });
    expect(r.statusCode, r.body).toBe(201);
    const c = r.json();
    expect(c.state).toBe('posted');
    // 600.000 × 100/700, 250/700, 350/700 = 85.714,29 / 214.285,71 / 300.000: làm tròn xuống, 1 đồng dư cho phần lẻ lớn nhất
    expect(c.allocations.map((a: { itemCode: string; amount: string }) => `${a.itemCode}:${a.amount}`)).toEqual(['H1:85714', 'H2:214286', 'H3:300000']);
    expect(shape(c.lines)).toEqual(['1331:60000:0', '156:214286:0', '156:300000:0', '156:85714:0', '331:0:660000']);
    expect(c.invoices).toEqual([expect.objectContaining({ invoiceNo: 'VC001', taxAmount: '60000', partyCode: 'VC1' })]);
    expect((await t.call('GET', '/api/tax/reconcile?year=2026&period=1&periodKind=month')).json().differences).toEqual([]);
    expect(c.costLines).toEqual([expect.objectContaining({ accountCode: '331', amount: '600000', vatAmount: '60000', partyCode: 'VC1' })]);
    expect((await t.layers(p.id)).filter((l) => l.kind === 'adjustment')).toEqual([
      { kind: 'adjustment', value: '85714', voucher_id: c.id, item: 'H1' }, { kind: 'adjustment', value: '214286', voucher_id: c.id, item: 'H2' }, { kind: 'adjustment', value: '300000', voucher_id: c.id, item: 'H3' }]);
    const stale = (await t.call('GET', '/api/inventory/costing-status')).json() as unknown[];
    expect(stale).toEqual([]); // chưa có lần tính giá vốn: không có gì "chưa cập nhật"

    const gv = await t.run();
    // H1: (100.000 + 85.714) / 100 = 1.857,14; xuất 40 = 74.286; phiếu xuất ghi tạm 40.000 → GV chỉ ghi 34.286 (Nợ 632 / Có 156), không ghi lại 600.000 của CPM
    const xl = (await t.call('GET', `/api/stock-vouchers/${x.id}`)).json();
    expect(xl.ledgerLines.find((l: L) => l.accountCode === '632').debit).toBe('40000');
    expect(shape(await t.gvLines(gv.voucherIds))).toEqual(['156:0:34286', '632:34286:0']);
    expect(await t.itemBal('H1')).toEqual({ l: '111428', c: '111428' });
    expect(await t.itemBal('H3')).toEqual({ l: '650000', c: '650000' });
    expect(await t.drift()).toEqual([]);
    // chạy lại không đổi: không GV mới
    expect(await t.run()).toMatchObject({ unchanged: true, voucherIds: [] });
    expect(await t.drift()).toEqual([]);

    // đã tính giá vốn phủ ngày nhập: bỏ ghi sổ CPM bị chặn, đảo được; đảo sinh lớp đối mang id chứng từ đảo
    const un = await t.call('POST', `/api/vouchers/${c.id}/unpost`, {}); expect(un.statusCode).toBe(409); expect(code(un)).toBe('STOCK_COST_ADJUSTED');
    const rv = await t.call('POST', `/api/vouchers/${c.id}/reverse`, { postingDate: '2026-01-25' }); expect(rv.statusCode, rv.body).toBe(201);
    const adj = (await t.layers(p.id)).filter((l) => l.kind === 'adjustment');
    expect(adj.filter((l) => l.voucher_id === rv.json().id).map((l) => l.value)).toEqual(['-85714', '-214286', '-300000']);
    expect(adj.reduce((s, l) => s + Number(l.value), 0)).toBe(0);
    await t.run();
    expect(await t.drift()).toEqual([]);
    expect(await t.itemBal('H1')).toEqual({ l: '60000', c: '60000' });
  });

  it('phân bổ theo số lượng; phiếu nhập đã xuất hết vẫn phân bổ (GV đẩy sang 632); chặn bỏ ghi sổ, đảo phiếu nhập đang được phân bổ', async () => {
    const t = await tenant();
    const p = await t.pnk('2026-01-05', [{ itemCode: 'H4', quantity: '10', unitPrice: '100' }, { itemCode: 'H5', quantity: '30', unitPrice: '10' }]);
    await t.pxk('2026-01-06', [{ itemCode: 'H4', quantity: '10' }]);
    const draft = await t.cpm({ basis: 'quantity', receiptVoucherIds: [p.id], costLines: [{ accountCode: '1111', amount: '400' }] });
    expect(draft.statusCode, draft.body).toBe(201);
    expect(draft.json().allocations.map((a: { amount: string }) => a.amount)).toEqual(['100', '300']);
    // nháp đang phân bổ: phiếu nhập không bỏ ghi sổ, không đảo được
    const un = await t.call('POST', `/api/vouchers/${p.id}/unpost`, {}); expect(un.statusCode).toBe(409); expect(code(un)).toBe('LANDED_COST_REFERENCED');
    const rv = await t.call('POST', `/api/vouchers/${p.id}/reverse`, { postingDate: '2026-01-07' }); expect(rv.statusCode).toBe(409); expect(code(rv)).toBe('LANDED_COST_REFERENCED');
    // sửa nháp: đổi số tiền, phân bổ tính lại
    const put = await t.call('PUT', `/api/landed-costs/${draft.json().id}`, { version: draft.json().version, postingDate: '2026-01-10', basis: 'quantity', receiptVoucherIds: [p.id], costLines: [{ accountCode: '1111', amount: '80' }] });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().allocations.map((a: { amount: string }) => a.amount)).toEqual(['20', '60']);
    const ok = await t.call('POST', `/api/vouchers/${draft.json().id}/post`, {}); expect(ok.statusCode, ok.body).toBe(200);
    // bỏ ghi sổ CPM khi chưa tính giá vốn: lớp đối, tổng về 0; ghi sổ lại thì lớp có lại
    const u = await t.call('POST', `/api/vouchers/${draft.json().id}/unpost`, {}); expect(u.statusCode, u.body).toBe(200);
    expect((await t.layers(p.id)).filter((l) => l.kind === 'adjustment').reduce((s, l) => s + Number(l.value), 0)).toBe(0);
    expect((await t.call('POST', `/api/vouchers/${draft.json().id}/post`, {})).statusCode).toBe(200);
    const gv = await t.run();
    expect(shape(await t.gvLines(gv.voucherIds))).toEqual(['156:0:20', '632:20:0']); // H4 đã xuất hết: 20 đồng chi phí mua vào giá vốn
    expect(await t.itemBal('H4')).toEqual({ l: '0', c: '0' });
    expect(await t.drift()).toEqual([]);
  });

  it('chặn: lập qua chứng từ chung, ngày trước ngày nhập, phiếu nhập nháp, thiếu view_cost', async () => {
    const t = await tenant();
    const gen = await t.call('POST', '/api/vouchers', { voucherType: 'CPM', postingDate: '2026-01-10', documentDate: '2026-01-10', lines: [{ accountCode: '156', debit: '1' }, { accountCode: '1111', credit: '1' }] });
    expect(gen.statusCode).toBe(409); expect(code(gen)).toBe('VOUCHER_TYPE_USE_LANDED_COST');
    const p = await t.pnk('2026-01-15', [{ itemCode: 'H1', quantity: '1', unitPrice: '10' }]);
    const early = await t.cpm({ receiptVoucherIds: [p.id], costLines: [{ accountCode: '1111', amount: '5' }] });
    expect(early.statusCode).toBe(409); expect(code(early)).toBe('LANDED_COST_DATE_INVALID');
    const d = await t.call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-01-05', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'H2', uomCode: 'CAI', quantity: '1', unitPrice: '10' }] });
    const nd = await t.cpm({ receiptVoucherIds: [d.json().id], costLines: [{ accountCode: '1111', amount: '5' }] });
    expect(d.statusCode, d.body).toBe(201); expect(nd.statusCode).toBe(409); expect(code(nd)).toBe('RECEIPT_NOT_POSTED');
    const roles = (await t.call('GET', '/api/roles')).json() as { id: string; code: string }[];
    await t.call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['voucher.view', 'voucher.create', 'stock_voucher.view', 'stock_voucher.create'] });
    const username = `cp_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: ['view_payable'] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    const r = await t.call('POST', '/api/landed-costs', { postingDate: '2026-01-20', basis: 'value', receiptVoucherIds: [p.id], costLines: [{ accountCode: '1111', amount: '5' }] }, c);
    expect(r.statusCode).toBe(403);
    expect((await t.call('GET', '/api/landed-costs/receipts?from=2026-01-01&to=2026-01-31', undefined, c)).statusCode).toBe(403);
    const list = (await t.call('GET', '/api/landed-costs/receipts?from=2026-01-01&to=2026-01-31')).json();
    expect(list.map((v: { id: string; value: string }) => [v.id, v.value])).toEqual([[p.id, '10']]);
  });

  it('nhập khẩu: giá nhập = giá + thuế NK + TTĐB; 3333, 33312, 1331 đúng', async () => {
    const t = await tenant();
    const r = await t.call('POST', '/api/invoices', { voucherType: 'MH', stockMode: 'through_stock', postingDate: '2026-01-08', documentDate: '2026-01-08', partyCode: 'NCC1', currencyCode: 'USD', fxRate: '25000', autoPost: true,
      items: [{ itemCode: 'H1', uomCode: 'CAI', warehouseCode: 'K1', quantity: '100', unitPrice: '10', amountCurrency: '1000', taxCodes: [], importMode: true,
        importTax: '2500000', specialConsumptionTax: '1000000', vatImport: '2850000', vatImportCode: 'V10' }],
      invoice: { invoiceNo: '105123456789', invoiceDate: '2026-01-08', invoiceGroupCode: '01' } });
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json();
    expect(shape(v.lines)).toEqual(['1331:2850000:0', '156:1000000:0', '156:25000000:0', '156:2500000:0', '331:0:25000000', '33312:0:2850000', '3332:0:1000000', '3333:0:2500000']);
    expect(await t.layers(v.id)).toEqual([{ kind: 'receipt', value: '28500000', voucher_id: null, item: 'H1' }]);
    expect(v.items[0]).toMatchObject({ importMode: true, importTax: '2500000', specialConsumptionTax: '1000000', vatImport: '2850000', vatImportCode: 'V10' });
    // bảng kê mua vào: GTGT hàng nhập (cơ sở = hàng + NK + TTĐB); NK, TTĐB ở phần thuế khác; đối chiếu với 1331 không lệch
    const reg = (await t.call('GET', '/api/tax/invoices?direction=purchase&year=2026&period=1&periodKind=month')).json();
    const vat = reg.groups.flatMap((g: { rows: unknown[] }) => g.rows);
    expect(vat).toEqual([expect.objectContaining({ taxCode: 'V10', baseAmount: '28500000', taxAmount: '2850000', isImport: true })]);
    expect(reg.otherTaxes.rows.map((x: { taxCode: string; baseAmount: string; taxAmount: string }) => [x.taxCode, x.baseAmount, x.taxAmount])).toEqual([['NK', '25000000', '2500000'], ['TTDB', '27500000', '1000000']]);
    const rec = (await t.call('GET', '/api/tax/reconcile?year=2026&period=1&periodKind=month')).json();
    expect(rec.differences).toEqual([]);
    expect(rec.debit1331).toBe('2850000');
    // chi phí mua phân bổ thêm vào hàng nhập khẩu: giá nhập = 28.500.000 + 1.500.000
    const c = await t.cpm({ postingDate: '2026-01-12', receiptVoucherIds: [v.id], costLines: [{ accountCode: '331', amount: '1500000' }], autoPost: true });
    expect(c.statusCode, c.body).toBe(201);
    await t.run();
    expect(await t.itemBal('H1')).toEqual({ l: '30000000', c: '30000000' });
    expect(await t.drift()).toEqual([]);
    // dòng không nhập khẩu không ghi thuế nhập khẩu; dòng nhập khẩu không mang mã GTGT
    const bad = await t.call('POST', '/api/invoices', { voucherType: 'MH', stockMode: 'through_stock', postingDate: '2026-01-08', documentDate: '2026-01-08', partyCode: 'NCC1',
      items: [{ itemCode: 'H2', uomCode: 'CAI', warehouseCode: 'K1', quantity: '1', amountCurrency: '10', taxCodes: ['V10'], importMode: true }], invoice: { invoiceNo: 'X1', invoiceDate: '2026-01-08', invoiceGroupCode: '01' } });
    expect(bad.statusCode).toBe(400); expect(code(bad)).toBe('IMPORT_LINE_INVALID');
    const bad2 = await t.call('POST', '/api/invoices', { voucherType: 'MH', stockMode: 'through_stock', postingDate: '2026-01-08', documentDate: '2026-01-08', partyCode: 'NCC1',
      items: [{ itemCode: 'H2', uomCode: 'CAI', warehouseCode: 'K1', quantity: '1', amountCurrency: '10', taxCodes: [], importTax: '1' }], invoice: { invoiceNo: 'X2', invoiceDate: '2026-01-08', invoiceGroupCode: '01' } });
    expect(bad2.statusCode).toBe(400);
  });
});
