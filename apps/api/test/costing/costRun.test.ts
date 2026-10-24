import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 11a: chạy giá thành kỳ và chứng từ GT (Nợ 154 / Có 621, 622, 627 theo đối tượng). Năm 2026 TT99, năm 2025 TT133 (cùng công ty).
// Số tính tay ghi trong từng ca. Không có lớp giá nhập thành phẩm 155/632 (Task 11b).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let owner: string; let tenantId: string; let userId: string;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, payload?: object, cookie = owner) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, payload, cookie); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.statusCode === 204 ? null : r.json();
};
const fail = async (method: M, url: string, status: number, code: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, payload, cookie); expect(r.statusCode, r.body).toBe(status); expect(r.json().error.code).toBe(code); return r.json().error;
};
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi phí sản xuất', lines, autoPost: true });
const stock = async (body: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
const run = (year: number, month: number, params: object = {}) => ok('POST', '/api/costing/runs', { year, month, params });
const voucher = (id: string) => ok('GET', `/api/vouchers/${id}`);
// Số dư phát sinh (Nợ − Có) của tài khoản (theo đầu số) trong khoảng ngày, cộng từ dòng đã ghi sổ (cả chứng từ bị đảo và bản đảo).
const net = async (prefix: string, from: string, to: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
  WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND starts_with(a.code, ${prefix}) AND l.posting_date BETWEEN ${from}::date AND ${to}::date`.execute(ctx.t.admin)).rows[0]!.n;
const runRow = async (y: number, m: number) => (await sql<{ status: string; voucher_id: string | null }>`SELECT status, voucher_id FROM cost_run WHERE tenant_id = ${tenantId}::uuid AND year = ${y} AND month = ${m}`.execute(ctx.t.admin)).rows[0]!;
// Dòng chứng từ kèm mã vật tư (DTO chứng từ chung không trả mã vật tư của dòng sổ cái).
const gtLines = async (id: string) => (await sql<{ a: string; d: string; c: string; o: string | null; p: string | null; i: string | null }>`SELECT a.code AS a, l.debit::text AS d, l.credit::text AS c,
  o.code AS o, p.code AS p, i.code AS i FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN cost_object o ON o.id = l.cost_object_id
  LEFT JOIN project p ON p.id = l.project_id LEFT JOIN item i ON i.id = l.item_id WHERE l.voucher_id = ${id}::uuid`.execute(ctx.t.admin)).rows.map((r) => [r.a, r.d, r.c, r.o, r.p, r.i]);
const byCode = (r: Json) => Object.fromEntries((r.objects as Json[]).map((o) => [o.code, o]));
// Câu lệnh SQL ngoài luồng dưới danh nghĩa người dùng, có thể bật cờ đổi trạng thái như unpost_voucher.
const asUser = (q: ReturnType<typeof sql>, stateChange = false) => ctx.t.admin.transaction().execute(async (trx) => {
  await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`.execute(trx);
  if (stateChange) await sql`SELECT set_config('app.state_change', 'on', true), set_config('app.unposting', 'on', true)`.execute(trx);
  await q.execute(trx);
});
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `gt_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId, userId } = await bootstrapTenant(ctx, { code: `CR${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2025, 'TT133'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime });
  for (const [name, body] of [['party', { code: 'NCC1', name: 'Nhà cung cấp', is_vendor: true }], ['project', { code: 'VV1', name: 'Công trình 1' }],
    ['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }], ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_moving' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }],
    ['item', { code: 'TP2', name: 'Ghế đơn', base_uom_code: 'CAI', kind: 'finished' }], ['item', { code: 'TP3', name: 'Ghế đôi', base_uom_code: 'CAI', kind: 'finished' }],
    ['cost_item', { code: 'KM-NVL', name: 'Nguyên vật liệu', cost_element: 'material' }], ['cost_item', { code: 'KM-NC', name: 'Nhân công', cost_element: 'labor' }],
    ['cost_item', { code: 'KM-KHAC', name: 'Chưa phân loại' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  for (const o of [{ code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' }, { code: 'CT1', name: 'Công trình 1', kind: 'project', projectCode: 'VV1' },
    { code: 'NHOM', name: 'Nhóm ghế', kind: 'product', itemCode: 'TP2', method: 'coefficient' }]) await ok('POST', '/api/costing/objects', o);
}, 180_000);
afterAll(async () => { await ctx.close(); });

describe('chạy giá thành TT99', () => {
  let gt3: string;
  it('mua NVL → xuất sản xuất (621) → nhân công 622 → 627 → chạy: GT cân Nợ 154 / Có 621, 622, 627; 627 chung phân bổ theo nhân công', async () => {
    await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
    const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
    const v = await voucher(pxk.id);
    const l621 = (v.lines as Json[]).find((l) => l.accountCode === '621')!;
    expect(l621.debit).toBe('600000');
    await ok('PUT', `/api/vouchers/${pxk.id}`, { version: v.version, lines: [{ lineNo: l621.lineNo, costObjectCode: 'SP1' }] }); // gắn đối tượng sau ghi sổ (D3)
    await pkt('2026-03-10', [L('622', '400000', '0', { costObjectCode: 'SP1' }), L('622', '200000', '0', { projectCode: 'VV1' }), L('111', '0', '600000')]);
    await pkt('2026-03-15', [L('6272', '50000', '0', { costObjectCode: 'SP1' }), L('6277', '300000', '0'), L('111', '0', '350000')]);
    // Nhập kho 50 bàn theo giá tạm tính (lớp giá thật là Task 11b).
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-03-31', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '50', unitPrice: '10000' }] });

    const params = { overheadBasis: 'direct_labor', objects: [{ objectCode: 'SP1', wip: 'direct_material', outputs: [{ wipQty: '10' }] }, { objectCode: 'CT1', completed: false }] };
    const pre = await ok('POST', '/api/costing/runs/preview', { year: 2026, month: 3, params });
    expect(pre.blockers).toEqual({ unclassified: [], unassigned: [] });
    expect(pre.sharedOverhead).toBe('300000');
    const res = await run(2026, 3, params);
    expect(res).toMatchObject({ year: 2026, month: 3, status: 'posted', regime: 'TT99', unchanged: false, stale: false, reversedVoucherIds: [], voucherNo: expect.stringMatching(/^GT/) });
    expect(res.objects.map((o: Json) => o.code)).toEqual(['CT1', 'SP1']); // NHOM chưa có chi phí: không vào lần chạy
    const o = byCode(res);
    // SP1: 627 chung 300.000 chia theo nhân công 400.000 : 200.000 → 200.000 / 100.000. Dở dang theo NVL: 600.000 ÷ (50 + 10) × 10 = 100.000.
    expect(o.SP1).toMatchObject({ method: 'simple', wipMethod: 'direct_material', overheadBasis: '400000', allocatedOverhead: '200000',
      opening: { material: '0', labor: '0', overhead: '0' }, incurred: { material: '600000', labor: '400000', overhead: '250000' },
      closing: { material: '100000', labor: '0', overhead: '0' }, cost: { material: '500000', labor: '400000', overhead: '250000' }, total: '1150000',
      completedQty: '50', wipQty: '10', unitCost: '23000.0000' });
    expect(o.SP1.outputs).toEqual([expect.objectContaining({ lineNo: 1, itemCode: 'TP1', qty: '50', total: '1150000', unitCost: '23000.0000' })]);
    // CT1 chưa hoàn thành: toàn bộ là dở dang.
    expect(o.CT1).toMatchObject({ method: 'project', allocatedOverhead: '100000', closing: { material: '0', labor: '200000', overhead: '100000' }, total: '0', completed: false });
    expect(res).toEqual(expect.objectContaining({ warnings: [] }));

    gt3 = res.voucherId;
    const gt = await voucher(gt3);
    expect(gt).toMatchObject({ voucherType: 'GT', state: 'posted', postingDate: '2026-03-31' });
    expect((await gtLines(gt3)).sort()).toEqual([
      ['154', '100000', '0', 'CT1', 'VV1', null], ['154', '200000', '0', 'CT1', 'VV1', null],
      ['154', '250000', '0', 'SP1', null, 'TP1'], ['154', '400000', '0', 'SP1', null, 'TP1'], ['154', '600000', '0', 'SP1', null, 'TP1'],
      ['621', '0', '600000', 'SP1', null, null], ['622', '0', '200000', 'CT1', 'VV1', null], ['622', '0', '400000', 'SP1', null, null],
      ['6272', '0', '50000', 'SP1', null, null], ['6277', '0', '300000', null, null, null]].sort());
    // Sau GT: 621/622/627 tháng 3 về 0; 154 nhận đủ chi phí phát sinh (1.550.000) trừ nhập kho tạm tính 500.000.
    for (const a of ['621', '622', '627']) expect(await net(a, '2026-03-01', '2026-03-31')).toBe('0');
    expect(await net('154', '2026-03-01', '2026-03-31')).toBe('1050000');
    // Chạy lại không đổi → giữ GT.
    const same = await run(2026, 3, params);
    expect(same).toMatchObject({ unchanged: true, voucherId: gt3, reversedVoucherIds: [] });
    // audit lần chạy
    const audits = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'cost_run'`.execute(ctx.t.admin)).rows[0]!.n;
    expect(Number(audits)).toBeGreaterThan(0);
  });

  it('dở dang chuyển kỳ; sửa chi phí kỳ trước → kỳ sau "Cần chạy lại"; chạy lại đảo GT cũ, sinh mới', async () => {
    await pkt('2026-04-08', [L('621', '200000', '0', { costObjectCode: 'SP1' }), L('622', '100000', '0', { costObjectCode: 'SP1' }), L('111', '0', '300000')]);
    const p4 = { objects: [{ objectCode: 'SP1', wip: 'direct_material', outputs: [{ qty: '20' }] }, { objectCode: 'CT1', completed: true }] };
    const a4 = await run(2026, 4, p4);
    const o4 = byCode(a4);
    // SP1: đầu kỳ NVL 100.000 (cuối tháng 3) + 200.000 → hoàn thành 20, không dở dang: 400.000, 20.000/cái. CT1 hoàn thành: dở dang 300.000 thành giá thành.
    expect(o4.SP1).toMatchObject({ opening: { material: '100000', labor: '0', overhead: '0' }, total: '400000', unitCost: '20000.0000', closing: { material: '0', labor: '0', overhead: '0' } });
    expect(o4.CT1).toMatchObject({ opening: { labor: '200000', overhead: '100000' }, total: '300000', completed: true, closing: { material: '0', labor: '0', overhead: '0' } });
    expect(a4.warnings).toEqual(['Đối tượng SP1: sản phẩm TP1 có giá thành 400000 nhưng chưa có phiếu nhập kho thành phẩm trong kỳ']);
    expect((await ok('GET', '/api/costing/runs?year=2026')).map((r: Json) => [r.month, r.stale])).toEqual([[3, false], [4, false]]);

    // Bổ sung NVL tháng 3: kỳ 3 cần chạy lại; chạy lại → đảo GT cũ, GT mới; dở dang cuối 3 đổi (660.000 ÷ 60 × 10 = 110.000) → kỳ 4 cần chạy lại.
    await pkt('2026-03-20', [L('621', '60000', '0', { costObjectCode: 'SP1' }), L('111', '0', '60000')]);
    expect((await ok('GET', '/api/costing/runs/2026/3')).stale).toBe(true);
    const params3 = (await ok('GET', '/api/costing/runs/2026/3')).params;
    const re3 = await run(2026, 3, params3);
    expect(re3).toMatchObject({ unchanged: false, reversedVoucherIds: [gt3], status: 'posted' });
    expect(re3.voucherId).not.toBe(gt3);
    expect((await voucher(gt3)).state).toBe('reversed');
    expect(byCode(re3).SP1.closing.material).toBe('110000');
    expect(await net('621', '2026-03-01', '2026-03-31')).toBe('0');
    expect((await ok('GET', '/api/costing/runs?year=2026')).map((r: Json) => [r.month, r.stale])).toEqual([[3, false], [4, true]]);
    const re4 = await run(2026, 4, p4);
    expect(byCode(re4).SP1.opening.material).toBe('110000');
    // GT tháng 4 không đổi (phát sinh tháng 4 như cũ): giữ chứng từ, chỉ thay kết quả.
    expect(re4).toMatchObject({ unchanged: false, voucherId: a4.voucherId, reversedVoucherIds: [] });
    expect(byCode(re4).SP1.total).toBe('410000');
    gt3 = re3.voucherId;
  });

  it('hệ số: nhóm ghế chia theo sản lượng quy đổi; dòng 154 chỉ theo đối tượng', async () => {
    await pkt('2026-06-05', [L('621', '350000', '0', { costObjectCode: 'NHOM' }), L('111', '0', '350000')]);
    const r = await run(2026, 6, { objects: [{ objectCode: 'NHOM', outputs: [{ itemCode: 'TP2', qty: '100', coefficient: '1' }, { itemCode: 'TP3', qty: '50', coefficient: '1.5' }] }] });
    // 100 × 1 + 50 × 1,5 = 175 sản phẩm chuẩn; 350.000 ÷ 175 = 2.000 → TP2 200.000 (2.000/cái), TP3 150.000 (3.000/cái).
    expect(byCode(r).NHOM.outputs.map((x: Json) => [x.itemCode, x.coefficient, x.total, x.unitCost])).toEqual([['TP2', '1', '200000', '2000.0000'], ['TP3', '1.5', '150000', '3000.0000']]);
    expect((await gtLines(r.voucherId)).filter((l) => l[0] === '154')).toEqual([['154', '350000', '0', 'NHOM', null, null]]);
    const out = (await sql<{ code: string; total: string }>`SELECT i.code, y.total::text FROM cost_run_output y JOIN cost_run r ON r.id = y.run_id JOIN item i ON i.id = y.item_id
      WHERE r.tenant_id = ${tenantId}::uuid AND r.year = 2026 AND r.month = 6 ORDER BY i.code`.execute(ctx.t.admin)).rows;
    expect(out).toEqual([{ code: 'TP2', total: '200000' }, { code: 'TP3', total: '150000' }]);
  });

  it('chặn khi NVL/nhân công chưa gắn đối tượng (409 COST_RUN_UNASSIGNED kèm dòng); 627 chung không có tiêu thức → 409', async () => {
    const v = await pkt('2026-05-10', [L('621', '70000', '0'), L('111', '0', '70000')]);
    const e = await fail('POST', '/api/costing/runs', 409, 'COST_RUN_UNASSIGNED', { year: 2026, month: 5, params: {} });
    expect(e.details.lines).toEqual([{ objectCode: null, accountCode: '621', costItemCode: null, costItemName: null, amount: '70000' }]);
    expect((await ok('POST', '/api/costing/runs/preview', { year: 2026, month: 5, params: {} })).blockers.unassigned).toHaveLength(1);
    await ok('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-05-10' });
    await pkt('2026-05-11', [L('6277', '10000', '0'), L('111', '0', '10000')]); // 627 chung, không đối tượng nào có nhân công
    await fail('POST', '/api/costing/runs', 409, 'OVERHEAD_BASIS_ZERO', { year: 2026, month: 5, params: {} });
    // Phân bổ nhập tay cho CT1 → chạy được.
    const r = await run(2026, 5, { overheadBasis: 'manual', objects: [{ objectCode: 'CT1', basis: '1' }] });
    expect(byCode(r).CT1).toMatchObject({ allocatedOverhead: '10000', closing: { overhead: '10000' } });
  });

  it('đường gỡ liên kết GT: route chung 409; đảo, bỏ ghi sổ, hủy, xóa ngoài luồng → lần chạy "Cần chạy lại"; chạy lại sinh GT mới', async () => {
    for (const [u, p] of [['unpost'], ['reverse', { postingDate: '2026-03-31' }], ['discard']] as [string, object?][]) {
      const r = await call('POST', `/api/vouchers/${gt3}/${u}`, p);
      expect([u, r.statusCode, r.json().error.code]).toEqual([u, 409, 'VOUCHER_SYSTEM_GENERATED']);
    }
    expect((await call('DELETE', `/api/vouchers/${gt3}`)).statusCode).toBe(409);
    await expect(sql`SELECT unpost_voucher(${gt3}::uuid)`.execute(ctx.t.admin)).rejects.toThrow(/VOUCHER_SYSTEM_GENERATED/);
    // Đảo ngoài luồng (hàm SQL).
    await asUser(sql`SELECT reverse_voucher(${gt3}::uuid, '2026-03-31'::date, NULL)`);
    expect(await runRow(2026, 3)).toEqual({ status: 'unlinked', voucher_id: null });
    expect((await ok('GET', '/api/costing/runs/2026/3')).stale).toBe(true);
    const again = await run(2026, 3, (await ok('GET', '/api/costing/runs/2026/3')).params);
    expect(again).toMatchObject({ status: 'posted', unchanged: false, reversedVoucherIds: [] });
    expect(await net('621', '2026-03-01', '2026-03-31')).toBe('0');
    const cur = again.voucherId as string;
    // Bỏ ghi sổ ngoài luồng (đổi trạng thái trực tiếp, vượt chặn nguồn): posted → draft → gỡ.
    await asUser(sql`UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = ${cur}::uuid`, true);
    expect(await runRow(2026, 3)).toEqual({ status: 'unlinked', voucher_id: null });
    // Hủy ngoài luồng: gắn lại rồi hủy → gỡ.
    await sql`UPDATE cost_run SET voucher_id = ${cur}::uuid, status = 'posted' WHERE tenant_id = ${tenantId}::uuid AND year = 2026 AND month = 3`.execute(ctx.t.admin);
    await asUser(sql`UPDATE voucher SET state = 'cancelled' WHERE id = ${cur}::uuid`, true);
    expect(await runRow(2026, 3)).toEqual({ status: 'unlinked', voucher_id: null });
    // Xóa chứng từ nháp: khóa ngoại SET NULL → gỡ.
    const d = await sql<{ id: string }>`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, state, description, currency_code, created_by)
      SELECT tenant_id, 'GT', '2026-03-31', '2026-03-31', 'draft', 'nháp', 'VND', created_by FROM voucher WHERE id = ${cur}::uuid RETURNING id`.execute(ctx.t.admin);
    await sql`UPDATE cost_run SET voucher_id = ${d.rows[0]!.id}::uuid, status = 'posted' WHERE tenant_id = ${tenantId}::uuid AND year = 2026 AND month = 3`.execute(ctx.t.admin);
    await sql`DELETE FROM voucher WHERE id = ${d.rows[0]!.id}::uuid`.execute(ctx.t.admin);
    expect(await runRow(2026, 3)).toEqual({ status: 'unlinked', voucher_id: null });
  });

  it('thiếu view_cost → 403 mọi route; thiếu cost_run.run → 403 khi chạy; kỳ chưa chạy 404', async () => {
    const noCost = await userWith('ketoan_vien', ['view_receivable', 'view_payable']);
    for (const [m, u, p] of [['GET', '/api/costing/runs?year=2026'], ['GET', '/api/costing/runs/2026/3'], ['POST', '/api/costing/runs/preview', { year: 2026, month: 3 }],
      ['POST', '/api/costing/runs', { year: 2026, month: 3 }]] as [M, string, object?][]) {
      const r = await call(m, u, p, noCost);
      expect([u, r.statusCode, r.json().error.message]).toEqual([u, 403, 'Không có quyền xem giá vốn']);
    }
    const viewer = await userWith('xem', ['view_cost']);
    expect((await call('GET', '/api/costing/runs/2026/4', undefined, viewer)).statusCode).toBe(200);
    expect((await call('POST', '/api/costing/runs', { year: 2026, month: 4 }, viewer)).statusCode).toBe(403);
    await fail('GET', '/api/costing/runs/2026/11', 404, 'COST_RUN_NOT_FOUND');
    await fail('POST', '/api/costing/runs', 404, 'LOOKUP_NOT_FOUND', { year: 2026, month: 7, params: { objects: [{ objectCode: 'KHONGCO' }] } });
  });
});

describe('chạy giá thành TT133 (tập hợp thẳng 154, không có GT)', () => {
  it('chặn khi còn khoản mục chưa phân loại yếu tố (409 COST_RUN_UNCLASSIFIED kèm khoản mục); hết thì chạy, không sinh chứng từ', async () => {
    await pkt('2025-02-10', [L('154', '300000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-NVL' }), L('154', '100000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-NC' }), L('1111', '0', '400000')]);
    const bad = await pkt('2025-02-11', [L('154', '5000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-KHAC' }), L('1111', '0', '5000')]);
    const e = await fail('POST', '/api/costing/runs', 409, 'COST_RUN_UNCLASSIFIED', { year: 2025, month: 2, params: {} });
    expect(e.details.lines).toEqual([{ objectCode: 'SP1', accountCode: '154', costItemCode: 'KM-KHAC', costItemName: 'Chưa phân loại', amount: '5000' }]);
    await ok('POST', `/api/vouchers/${bad.id}/reverse`, { postingDate: '2025-02-11' });
    const r = await run(2025, 2, { objects: [{ objectCode: 'SP1', outputs: [{ qty: '10' }] }] });
    expect(r).toMatchObject({ regime: 'TT133', status: 'calculated', voucherId: null, unchanged: false });
    expect(byCode(r).SP1).toMatchObject({ incurred: { material: '300000', labor: '100000', overhead: '0' }, total: '400000', unitCost: '40000.0000' });
    expect(await run(2025, 2, { objects: [{ objectCode: 'SP1', outputs: [{ qty: '10' }] }] })).toMatchObject({ unchanged: true, voucherId: null });
  });
});
