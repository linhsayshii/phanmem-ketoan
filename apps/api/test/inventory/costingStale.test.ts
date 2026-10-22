import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Line = { itemCode: string; quantity: string; unitPrice?: string; lotNo?: string; fixedUnitCost?: string };
const JAN = { periodFrom: '2026-01-01', periodTo: '2026-01-31' };

// Mỗi kiểm thử một công ty: năm 2026 TT133, ĐVT CAI, nhà cung cấp NCC1.
async function tenant() {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `GS${Date.now()}${n++}` });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  const wh = (code: string, costing_method: string, inventory_account_code = '156') => cat('warehouse', { code, name: `Kho ${code}`, inventory_account_code, costing_method });
  const item = (code: string, tracking = 'none') => cat('item', { code, name: `Hàng ${code}`, base_uom_code: 'CAI', kind: 'goods', tracking });
  const stock = async (body: object) => {
    const r = await call('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); expect(r.statusCode, r.body).toBe(201);
    const p = await call('POST', `/api/vouchers/${r.json().id}/post`, {}); expect(p.statusCode, p.body).toBe(200); return p.json() as { id: string };
  };
  const items = (ls: Line[]) => ls.map((l) => ({ uomCode: 'CAI', ...l }));
  const pnk = (date: string, warehouseCode: string, ls: Line[]) => stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode, partyCode: 'NCC1', items: items(ls) });
  const nhapTp = (date: string, warehouseCode: string, ls: Line[]) => stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: date, warehouseCode, items: items(ls) });
  const pxk = (date: string, warehouseCode: string, ls: Line[]) => stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: date, warehouseCode, items: items(ls) });
  const ck = (date: string, warehouseCode: string, destWarehouseCode: string, ls: Line[]) => stock({ voucherType: 'CK', stockKind: 'transfer', postingDate: date, warehouseCode, destWarehouseCode, items: items(ls) });
  const run = (body: object = {}, c = cookie) => call('POST', '/api/inventory/costing-runs', { ...JAN, ...body }, c);
  type RunOut = { runId: string; voucherIds: string[]; unchanged: boolean; summary: { items: number; moves: number; delta: string | null; errors: { code: string }[] } };
  const runOk = async (body: object = {}) => { const r = await run(body); expect(r.statusCode, r.body).toBe(200); return r.json() as RunOut; };
  // Số dư (Nợ − Có) của tài khoản theo kho đến hết ngày, cộng thẳng từ dòng đã ghi sổ (cả chứng từ bị đảo và bản đảo).
  const bal = async (code: string, whCode: string, asOf = '2026-01-31') => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id JOIN warehouse w ON w.id = l.warehouse_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND a.code = ${code} AND w.code = ${whCode} AND l.posting_date <= ${asOf}::date`.execute(ctx.t.admin)).rows[0]!.n;
  const layers = async (whCode: string, asOf = '2026-01-31') => (await sql<{ q: string; v: string }>`SELECT coalesce(sum(remaining_qty), 0)::text AS q, coalesce(sum(remaining_value), 0)::text AS v
    FROM stock_cost_layer c JOIN warehouse w ON w.id = c.warehouse_id WHERE c.tenant_id = ${tenantId}::uuid AND w.code = ${whCode} AND c.posting_date <= ${asOf}::date`.execute(ctx.t.admin)).rows[0]!;
  // Bất biến mọi lúc: Σ giá trị còn lại của mọi lớp (mọi ngày) = số dư hiện tại TK kho của kho trên sổ cái; trả các kho lệch.
  const drift = async () => (await sql<{ wh: string; layers: string; ledger: string }>`SELECT w.code AS wh,
      (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.tenant_id = w.tenant_id AND c.warehouse_id = w.id)::text AS layers,
      (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
        WHERE l.tenant_id = w.tenant_id AND l.warehouse_id = w.id AND l.account_id = w.inventory_account_id AND v.state IN ('posted','reversed'))::text AS ledger
    FROM warehouse w WHERE w.tenant_id = ${tenantId}::uuid ORDER BY w.code`.execute(ctx.t.admin)).rows.filter((r) => r.layers !== r.ledger);
  const canon = async () => (await sql<{ id: string; c: string }>`SELECT id, fn_voucher_canonical(id) AS c FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type <> 'GV' ORDER BY id`.execute(ctx.t.admin)).rows;
  const gvs = async () => (await sql<{ id: string; state: string; reversal_of_id: string | null; posting_date: string }>`SELECT id, state, reversal_of_id, posting_date FROM voucher
    WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'GV' ORDER BY created_at, id`.execute(ctx.t.admin)).rows;
  const login = async (perms: string[], flags: string[]) => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms })).statusCode).toBe(200);
    const username = `gv_${n++}_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${r.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  const stale = async () => (await call('GET', '/api/inventory/costing-status')).json() as { itemCode: string; warehouseCode: string; staleFrom: string }[];
  const acct = async (code: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND a.code = ${code}`.execute(ctx.t.admin)).rows[0]!.n;
  return { tenantId, call, cat, wh, item, pnk, nhapTp, stale, acct, pxk, ck, run, runOk, bal, layers, drift, canon, gvs, login };
}

describe('giá vốn chưa cập nhật và điều chỉnh giá nhập', () => {
  it('ghi lùi, bỏ ghi sổ, đảo vào tháng đã tính: đánh dấu; tháng chưa tính không đánh dấu; chạy lại đảo GV cũ, sinh GV mới, sổ cái gốc nguyên vẹn', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period'); await t.item('H1');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    await t.pxk('2026-01-20', 'K1', [{ itemCode: 'H1', quantity: '60' }]);
    expect(await t.stale()).toEqual([]);
    await t.runOk();
    expect(await t.stale()).toEqual([]);
    await t.pnk('2026-02-05', 'K1', [{ itemCode: 'H1', quantity: '5', unitPrice: '10' }]); // tháng 2 chưa tính: bình thường
    expect(await t.stale()).toEqual([]);
    const back = await t.pnk('2026-01-05', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '20' }]);
    expect(await t.stale()).toEqual([expect.objectContaining({ itemCode: 'H1', warehouseCode: 'K1', staleFrom: '2026-01-05' })]);
    const before = await t.canon();
    const second = await t.runOk();
    expect(second.unchanged).toBe(false); expect(second.voucherIds).toHaveLength(1);
    expect(await t.canon()).toEqual(before);
    expect(await t.stale()).toEqual([]);
    expect((await t.gvs()).map((g) => g.state).sort()).toEqual(['posted']); // lần tính đầu không chênh (một giá nhập): chưa có GV
    expect(await t.drift()).toEqual([]);
    // đảo phiếu nhập ghi lùi (kỳ mở: đảo vẫn đánh dấu) và bỏ ghi sổ phiếu nhập tháng 2
    const rev = await t.call('POST', `/api/vouchers/${back.id}/reverse`, { postingDate: '2026-01-25' });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(await t.stale()).toEqual([expect.objectContaining({ staleFrom: '2026-01-25' })]);
    await t.runOk();
    expect(await t.stale()).toEqual([]);
    expect(await t.drift()).toEqual([]);
    const feb = (await t.call('GET', '/api/vouchers?type=PNK')).json().rows.find((v: { postingDate: string }) => v.postingDate === '2026-02-05');
    expect((await t.call('POST', `/api/vouchers/${feb.id}/unpost`, {})).statusCode).toBe(200);
    expect(await t.stale()).toEqual([]); // tháng 2 chưa có lần tính nào phủ
  }, 90_000);

  it('sửa giá nhập thành phẩm: lớp adjustment, chưa sửa dòng đã ghi sổ; GV lần sau Nợ 155 / Có 154 và giá vốn xuất theo giá mới; remaining khớp 155', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period', '155'); await t.item('TP1');
    const pn = await t.nhapTp('2026-01-02', 'K1', [{ itemCode: 'TP1', quantity: '100', unitPrice: '10' }]);
    await t.pxk('2026-01-20', 'K1', [{ itemCode: 'TP1', quantity: '60' }]);
    await t.runOk();
    expect(await t.bal('632', 'K1')).toBe('600'); expect(await t.bal('155', 'K1')).toBe('400');
    const before = await t.canon();
    const put = await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '12' }] });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().lines).toEqual([{ lineNo: 1, before: '1000', after: '1200', delta: '200' }]);
    expect(await t.canon()).toEqual(before); // phiếu nhập và sổ cái không bị sửa
    const lay = await sql<{ kind: string; value: string; remaining_value: string; voucher_id: string | null }>`SELECT kind, value::text, remaining_value::text, voucher_id FROM stock_cost_layer
      WHERE tenant_id = ${t.tenantId}::uuid AND kind = 'adjustment'`.execute(ctx.t.admin);
    expect(lay.rows).toEqual([{ kind: 'adjustment', value: '200', remaining_value: '0', voucher_id: null }]);
    expect(await t.stale()).toEqual([expect.objectContaining({ itemCode: 'TP1', staleFrom: '2026-01-02' })]);
    const au = await sql<{ action: string }>`SELECT action FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND action = 'receipt_price_adjust' AND entity_id = ${pn.id}`.execute(ctx.t.admin);
    expect(au.rows).toHaveLength(1);
    expect(await t.drift()).toEqual([]); // trước khi chạy lại: lớp và sổ cái cùng chưa đổi
    // sửa lại cùng giá: không sinh thêm lớp
    expect((await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '12' }] })).json().lines).toEqual([]);
    const r = await t.runOk();
    expect(r.voucherIds).toHaveLength(1);
    expect(await t.canon()).toEqual(before);
    // 155: 1200 − 60 × 12 = 480; 632 = 720; 154: Có 1000 + 200
    expect(await t.bal('155', 'K1')).toBe('480'); expect(await t.bal('632', 'K1')).toBe('720');
    expect(await t.acct('154')).toBe('-1200');
    expect((await t.layers('K1')).v).toBe('480'); expect(await t.drift()).toEqual([]);
    expect(await t.stale()).toEqual([]);
    expect((await t.runOk()).unchanged).toBe(true); // lớp đã ghi nhận ở GV: không ghi lại
    // giá thấp hơn nữa: lớp thứ hai âm, GV mới đảo cũ và ghi lại tổng chênh
    expect((await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '9.5' }] })).json().lines).toEqual([{ lineNo: 1, before: '1200', after: '950', delta: '-250' }]);
    await t.runOk();
    expect(await t.acct('154')).toBe('-950'); // giá nhập thực tế 950
    expect(await t.bal('155', 'K1')).toBe('380'); expect(await t.bal('632', 'K1')).toBe('570');
    expect(await t.drift()).toEqual([]);
  }, 90_000);

  it('giá nhập sửa ở tháng trước, chạy tháng sau: tồn đầu kỳ mang giá mới, GV tháng sau ghi chênh; quyền, loại phiếu, phiếu nháp', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period', '155'); await t.item('TP1'); await t.item('H1');
    const pn = await t.nhapTp('2026-01-02', 'K1', [{ itemCode: 'TP1', quantity: '100', unitPrice: '10' }]);
    await t.runOk();
    expect((await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '11' }] })).statusCode).toBe(200);
    await t.pxk('2026-02-10', 'K1', [{ itemCode: 'TP1', quantity: '50' }]);
    const feb = await t.runOk({ periodFrom: '2026-02-01', periodTo: '2026-02-28' });
    expect(feb.voucherIds).toHaveLength(1);
    expect(await t.bal('632', 'K1', '2026-02-28')).toBe('550'); // 50 × 11
    expect(await t.bal('155', 'K1', '2026-02-28')).toBe('550');
    expect(await t.drift()).toEqual([]);
    expect(await t.stale()).toEqual([expect.objectContaining({ staleFrom: '2026-01-02' })]); // tháng 1 chưa tính lại: vẫn nhắc
    // loại phiếu / nháp / quyền
    const mua = await t.pnk('2026-01-03', 'K1', [{ itemCode: 'H1', quantity: '1', unitPrice: '5' }]);
    const r1 = await t.call('PUT', `/api/stock-vouchers/${mua.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '6' }] });
    expect(r1.statusCode).toBe(409); expect(r1.json().error.code).toBe('RECEIPT_PRICE_NOT_FINISHED');
    const dr = await t.call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-01-04', warehouseCode: 'K1', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '1', unitPrice: '1' }] });
    expect((await t.call('PUT', `/api/stock-vouchers/${dr.json().id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '2' }] })).json().error.code).toBe('STATE_INVALID');
    const noPerm = await t.login(['stock_voucher.view'], ['view_cost']);
    expect((await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '2' }] }, noPerm)).statusCode).toBe(403);
    const noCost = await t.login(['costing.run'], []);
    expect((await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 1, unitCost: '2' }] }, noCost)).statusCode).toBe(403);
    expect((await t.call('PUT', `/api/stock-vouchers/${pn.id}/receipt-price`, { lines: [{ lineNo: 9, unitCost: '2' }] })).statusCode).toBe(400);
  }, 90_000);
});
