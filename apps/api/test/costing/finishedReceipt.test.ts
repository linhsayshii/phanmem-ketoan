import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 11b: giá thành vào kho bằng lớp điều chỉnh giá nhập (D4): chạy giá thành chia tổng giá thành cho các dòng PNK thành phẩm của tháng theo số lượng
// (dòng cuối nhận phần dư), chạy giá vốn ghi Nợ 155 / Có 154 phần chênh. Năm 2026 TT99, năm 2025 TT133. Số tính tay ghi trong từng ca.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let owner: string; let tenantId: string;
type M = 'GET' | 'POST' | 'PUT';
const call = (method: M, url: string, payload?: object, cookie = owner) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, payload, cookie); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi phí sản xuất', lines, autoPost: true });
const stock = async (body: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
const costRun = (year: number, month: number, params: object = {}) => ok('POST', '/api/costing/runs', { year, month, params });
const costing = (periodFrom: string, periodTo: string) => ok('POST', '/api/inventory/costing-runs', { periodFrom, periodTo });
// Số dư (Nợ − Có) lũy kế đến ngày của tài khoản (theo đầu số), từ dòng đã ghi sổ (cả chứng từ bị đảo và bản đảo).
const bal = async (prefix: string, from: string, to: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
  WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND starts_with(a.code, ${prefix}) AND l.posting_date BETWEEN ${from}::date AND ${to}::date`.execute(ctx.t.admin)).rows[0]!.n;
// Giá trị nhập hiện tại (lớp nhập + lớp điều chỉnh) của các dòng phiếu nhập, theo thứ tự ngày, số phiếu, dòng; kèm phần do chạy giá thành.
const receipts = async (item: string) => (await sql<{ q: string; v: string; gt: string }>`SELECT m.quantity::text AS q,
    (SELECT sum(c.value) FROM stock_cost_layer c WHERE c.move_id = m.id AND c.kind IN ('receipt', 'adjustment'))::text AS v,
    (SELECT coalesce(sum(c.value), 0) FROM stock_cost_layer c WHERE c.move_id = m.id AND c.cost_run_id IS NOT NULL)::text AS gt
  FROM stock_move m JOIN item i ON i.id = m.item_id JOIN voucher v ON v.id = m.voucher_id JOIN voucher_item_line l ON l.id = m.item_line_id
  WHERE m.tenant_id = ${tenantId}::uuid AND i.code = ${item} AND m.direction = 'in' AND v.voucher_type = 'PNK' ORDER BY m.posting_date, v.seq_no, l.line_no`.execute(ctx.t.admin)).rows
  .map((r) => [r.q.replace(/\.0+$/, ''), r.v, r.gt]);
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `gn_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `GN${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2025, 'TT133'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime });
  for (const [name, body] of [['party', { code: 'NCC1', name: 'Nhà cung cấp', is_vendor: true }],
    ['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }], ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }],
    ['cost_item', { code: 'KM-NVL', name: 'Nguyên vật liệu', cost_element: 'material' }], ['cost_item', { code: 'KM-NC', name: 'Nhân công', cost_element: 'labor' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  await ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
}, 180_000);
afterAll(async () => { await ctx.close(); });

describe('nhập kho thành phẩm theo giá thành TT99', () => {
  const p3 = { objects: [{ objectCode: 'SP1', wip: 'direct_material', outputs: [{ wipQty: '3' }] }] };
  const p4 = { objects: [{ objectCode: 'SP1', outputs: [{ qty: '3' }] }] }; // sản lượng khai tay
  it('mua NVL → xuất 621 → 622 → 627 → giá thành → nhập kho (3 dòng, một dòng giá 0) → bán → giá vốn: 154 = dở dang, 155 = giá thành × tồn, 632 đúng', async () => {
    await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
    const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
    const v = await ok('GET', `/api/vouchers/${pxk.id}`);
    const l621 = (v.lines as Json[]).find((l) => l.accountCode === '621')!;
    await ok('PUT', `/api/vouchers/${pxk.id}`, { version: v.version, lines: [{ lineNo: l621.lineNo, costObjectCode: 'SP1' }] });
    await pkt('2026-03-10', [L('622', '300000', '0', { costObjectCode: 'SP1' }), L('111', '0', '300000')]);
    await pkt('2026-03-15', [L('6272', '100000', '0', { costObjectCode: 'SP1' }), L('111', '0', '100000')]);
    // Nhập kho 9 bàn: PNK-A dòng 1 chưa có giá (D4; phiếu toàn giá 0 không ghi sổ được: STOCK_VALUE_ZERO), dòng 2 giá tạm 100.000; PNK-B 3 cái giá tạm 100.000.
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-03-20', warehouseCode: 'K2', items: [
      { itemCode: 'TP1', uomCode: 'CAI', quantity: '3', unitPrice: '0' }, { itemCode: 'TP1', uomCode: 'CAI', quantity: '3', unitPrice: '100000' }] });
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-03-31', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '3', unitPrice: '100000' }] });
    // Bán 6 cái.
    await stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: '2026-03-31', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '6' }] });

    // Chi phí 600.000 + 300.000 + 100.000 = 1.000.000; dở dang theo NVL: 600.000 ÷ (9 + 3) × 3 = 150.000; giá thành 850.000 (94.444,4444/cái).
    const r = await costRun(2026, 3, p3);
    expect(r.objects[0]).toMatchObject({ code: 'SP1', total: '850000', completedQty: '9', closing: { material: '150000', labor: '0', overhead: '0' } });
    // 850.000 × 3/9 = 283.333,33 → 283.333, 283.333; dòng cuối nhận phần dư 283.334. Lớp điều chỉnh: +283.333, −16.667, −16.666 (Σ 250.000).
    expect(await receipts('TP1')).toEqual([['3', '283333', '283333'], ['3', '283333', '-16667'], ['3', '283334', '-16666']]);
    expect(r.receiptAdjustments.map((x: Json) => [x.itemCode, x.qty, x.before, x.after])).toEqual([['TP1', '3', '0', '283333'], ['TP1', '3', '300000', '283333'], ['TP1', '3', '300000', '283334']]);
    // Giá vốn báo cần chạy lại cho kho thành phẩm.
    expect((await ok('GET', '/api/inventory/costing-status')).map((s: Json) => [s.itemCode, s.warehouseCode, s.staleFrom])).toContainEqual(['TP1', 'K2', '2026-03-20']);

    const gv = await costing('2026-03-01', '2026-03-31');
    expect(gv.summary.errors).toEqual([]); // PNK giá 0 không còn lỗi COSTING_RECEIPT_PRICE_MISSING
    // 154: GT Nợ 1.000.000 − PNK Có 600.000 − GV Có 250.000 = 150.000 = dở dang cuối.
    expect(await bal('154', '2026-01-01', '2026-03-31')).toBe('150000');
    // 632: bình quân cuối kỳ 850.000 ÷ 9 × 6 = 566.666,67 → 566.667; 155 = tồn 3 cái = 850.000 − 566.667 = 283.333.
    expect(await bal('632', '2026-03-01', '2026-03-31')).toBe('566667');
    expect(await bal('155', '2026-01-01', '2026-03-31')).toBe('283333');
    expect((await ok('GET', '/api/inventory/costing-status')).filter((s: Json) => s.itemCode === 'TP1')).toEqual([]);
    // Chạy lại giá thành không đổi: không lớp mới.
    expect(await costRun(2026, 3, p3)).toMatchObject({ unchanged: true, receiptAdjustments: [] });
    const audit = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'cost_run' AND action = 'receipt_price_adjust'`.execute(ctx.t.admin)).rows[0]!.n;
    expect(audit).toBe('1');
  });

  it('dở dang chuyển kỳ 4; sửa chi phí kỳ 3 → giá thành cần chạy lại, lớp cũ được thay, giá vốn cần chạy lại, chạy lại ra số đúng', async () => {
    // Tháng 4: nhân công 100.000; nhập 3 cái giá tạm 50.000. Giá thành = dở dang đầu 150.000 + 100.000 = 250.000 (lớp +100.000).
    await pkt('2026-04-08', [L('622', '100000', '0', { costObjectCode: 'SP1' }), L('111', '0', '100000')]);
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-04-10', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '3', unitPrice: '50000' }] });
    const r4 = await costRun(2026, 4, p4);
    expect(r4.objects[0]).toMatchObject({ opening: { material: '150000' }, total: '250000', closing: { material: '0', labor: '0', overhead: '0' } });
    await costing('2026-04-01', '2026-04-30');
    expect(await bal('154', '2026-01-01', '2026-04-30')).toBe('0');
    expect(await bal('155', '2026-01-01', '2026-04-30')).toBe('533333'); // 283.333 + 250.000

    // Bổ sung 627 tháng 3: 90.000 → giá thành 940.000 (dở dang NVL vẫn 150.000): 313.333, 313.333, 313.334.
    await pkt('2026-03-25', [L('6272', '90000', '0', { costObjectCode: 'SP1' }), L('111', '0', '90000')]);
    expect((await ok('GET', '/api/costing/runs/2026/3')).stale).toBe(true);
    const re3 = await costRun(2026, 3, p3);
    expect(re3.objects[0].total).toBe('940000');
    // Lớp cũ giữ nguyên, lớp mới +30.000 mỗi dòng: giá trị nhập = phần chia mới.
    expect((await receipts('TP1')).slice(0, 3)).toEqual([['3', '313333', '313333'], ['3', '313333', '13333'], ['3', '313334', '13334']]);
    expect((await sql<{ n: string }>`SELECT count(*)::text AS n FROM stock_cost_layer c JOIN cost_run r ON r.id = c.cost_run_id
      WHERE r.tenant_id = ${tenantId}::uuid AND r.year = 2026 AND r.month = 3`.execute(ctx.t.admin)).rows[0]!.n).toBe('6');
    // Kỳ 4 không đổi dở dang đầu nên không cần chạy lại giá thành; giá vốn kho thành phẩm cần chạy lại từ 20/03.
    expect((await ok('GET', '/api/costing/runs?year=2026')).map((x: Json) => [x.month, x.stale])).toEqual([[3, false], [4, false]]);
    expect((await ok('GET', '/api/inventory/costing-status')).map((s: Json) => [s.itemCode, s.staleFrom])).toContainEqual(['TP1', '2026-03-20']);
    const close = await ok('GET', '/api/period-close/2026/3');
    expect((close.steps as Json[]).find((s) => s.key === 'costing')?.status).toBe('rerun');

    await costing('2026-03-01', '2026-03-31');
    // 154 tháng 3 = 1.090.000 − 940.000 = 150.000; 632 = 940.000 ÷ 9 × 6 = 626.666,67 → 626.667; 155 cuối tháng 3 = 313.333.
    expect(await bal('154', '2026-01-01', '2026-03-31')).toBe('150000');
    expect(await bal('632', '2026-03-01', '2026-03-31')).toBe('626667');
    expect(await bal('155', '2026-01-01', '2026-03-31')).toBe('313333');
    await costing('2026-04-01', '2026-04-30');
    expect(await bal('154', '2026-01-01', '2026-04-30')).toBe('0');
    expect(await bal('155', '2026-01-01', '2026-04-30')).toBe('563333'); // 313.333 + 250.000
  });

  it('PNK thêm sau khi chạy (sản lượng khai tay) → giá thành cần chạy lại; chạy lại chia lại cho cả dòng mới; thiếu view_cost 403', async () => {
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-04-30', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '1', unitPrice: '50000' }] });
    expect((await ok('GET', '/api/costing/runs/2026/4')).stale).toBe(true);
    const r = await costRun(2026, 4, p4);
    // Sản lượng khai 3 (cảnh báo lệch số nhập kho) nhưng tổng giá thành chia cho mọi dòng nhập thành phẩm của tháng theo số lượng (4 cái):
    // 250.000 × 3/4 = 187.500 (lớp của giá thành: +100.000 − 62.500 = 37.500 so với giá tạm 150.000); dòng cuối 62.500 (+12.500 so với 50.000).
    expect(r.objects[0]).toMatchObject({ total: '250000', completedQty: '3' });
    expect(r.warnings).toEqual(['Đối tượng SP1: sản lượng hoàn thành TP1 khai 3 khác số nhập kho thành phẩm trong kỳ 4']);
    expect((await receipts('TP1')).slice(3)).toEqual([['3', '187500', '37500'], ['1', '62500', '12500']]);
    const noCost = await userWith('ketoan_vien', ['view_receivable', 'view_payable']);
    for (const [m, u, p] of [['POST', '/api/costing/runs', { year: 2026, month: 4 }], ['GET', '/api/costing/runs/2026/4']] as [M, string, object?][]) {
      const x = await call(m, u, p, noCost);
      expect([u, x.statusCode]).toEqual([u, 403]);
    }
  });
});

describe('nhập kho thành phẩm theo giá thành TT133 (154 tập hợp thẳng, không GT)', () => {
  it('chi phí ghi thẳng 154 → giá thành → lớp giá nhập → giá vốn Nợ 155 / Có 154; 632 đúng', async () => {
    await pkt('2025-02-10', [L('154', '300000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-NVL' }), L('154', '100000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-NC' }), L('1111', '0', '400000')]);
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2025-02-28', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '10', unitPrice: '30000' }] });
    await stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: '2025-02-28', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '4' }] });
    const r = await costRun(2025, 2);
    expect(r).toMatchObject({ regime: 'TT133', status: 'calculated', voucherId: null });
    expect(r.objects[0]).toMatchObject({ total: '400000', unitCost: '40000.0000' });
    expect(r.receiptAdjustments.map((x: Json) => x.after)).toEqual(['400000']);
    await costing('2025-02-01', '2025-02-28');
    // 154: 400.000 − GV 400.000 = 0; 632 = 4 × 40.000; 155 = 6 × 40.000.
    expect(await bal('154', '2025-01-01', '2025-02-28')).toBe('0');
    expect(await bal('632', '2025-02-01', '2025-02-28')).toBe('160000');
    expect(await bal('155', '2025-01-01', '2025-02-28')).toBe('240000');
  });
});
