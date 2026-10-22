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
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `GV${Date.now()}${n++}` });
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
  return { tenantId, call, cat, wh, item, pnk, pxk, ck, run, runOk, bal, layers, drift, canon, gvs, login };
}
type T = Awaited<ReturnType<typeof tenant>>;

// Dữ liệu Task 4: nhập 100@10 (02/01), xuất 60 (10/01), nhập 50@12 (15/01), xuất 70 (20/01). Đích danh: lô A, B; lần xuất 70 = 30 lô A + 40 lô B.
async function scenario(t: T, wh: string, item: string, method: string) {
  const lot = method === 'specific';
  await t.wh(wh, method); await t.item(item, lot ? 'lot' : 'none');
  await t.pnk('2026-01-02', wh, [{ itemCode: item, quantity: '100', unitPrice: '10', ...(lot && { lotNo: 'A' }) }]);
  await t.pxk('2026-01-10', wh, [{ itemCode: item, quantity: '60', ...(lot && { lotNo: 'A' }) }]);
  await t.pnk('2026-01-15', wh, [{ itemCode: item, quantity: '50', unitPrice: '12', ...(lot && { lotNo: 'B' }) }]);
  await t.pxk('2026-01-20', wh, lot ? [{ itemCode: item, quantity: '30', lotNo: 'A' }, { itemCode: item, quantity: '40', lotNo: 'B' }] : [{ itemCode: item, quantity: '70' }]);
}
// Bất biến: Σ giá trị còn lại của lớp giá = số dư TK kho của kho trên sổ cái; Σ lượng còn lại = nhập − xuất.
async function assertLayers(t: T, wh: string, account = '156') {
  const l = await t.layers(wh);
  expect(l.v).toBe(await t.bal(account, wh));
  expect(await t.drift()).toEqual([]);
  return l;
}

describe('tính giá vốn', () => {
  it.each([['avg_period', '1387', '213'], ['avg_moving', '1378', '222'], ['fifo', '1360', '240'], ['specific', '1380', '220']])(
    '%s: tổng giá vốn xuất %s, tồn cuối %s; 632 và 156 trên sổ cái khớp', async (method, cogs, endValue) => {
      const t = await tenant();
      await scenario(t, 'K1', 'H1', method);
      expect(await t.bal('632', 'K1')).toBe('1347'); // giá tạm tính: 600 + 70 × 10,6667
      const r = await t.runOk({ warehouseCode: 'K1' });
      expect(r.unchanged).toBe(false); expect(r.summary).toMatchObject({ items: 1, moves: method === 'specific' ? 3 : 2, errors: [] });
      expect(D(r.summary.delta)).toBe(Number(cogs) - 1347);
      expect(r.voucherIds).toHaveLength(Number(cogs) === 1347 ? 0 : 1);
      expect(await t.bal('632', 'K1')).toBe(cogs);
      expect(await t.bal('156', 'K1')).toBe(endValue);
      expect(await assertLayers(t, 'K1')).toEqual({ q: '20.0000', v: endValue });
    }, 60_000);

  it('chạy lại không đổi dữ liệu: unchanged và không sinh chứng từ; phiếu nhập đã tính giá vốn không bỏ ghi sổ được kể cả cho tồn âm', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'fifo');
    const first = await t.runOk();
    expect(first.voucherIds).toHaveLength(1);
    const again = await t.runOk();
    expect(again).toMatchObject({ unchanged: true, voucherIds: [] });
    expect((await t.gvs()).map((g) => g.state)).toEqual(['posted']);
    expect(await t.bal('632', 'K1')).toBe('1360');
    expect((await t.call('PUT', '/api/settings', { stock_negative: 'allow' })).statusCode).toBe(200);
    const pn = (await t.call('GET', '/api/vouchers?type=PNK')).json().rows.find((v: { postingDate: string }) => v.postingDate === '2026-01-15');
    const u = await t.call('POST', `/api/vouchers/${pn.id}/unpost`, {});
    expect(u.statusCode, u.body).toBe(409); expect(u.json().error.code).toBe('STOCK_CONSUMED');
  }, 60_000);

  it('ghi lùi phiếu nhập vào tháng đã tính: costing-status báo từ ngày đó; chạy lại đảo GV cũ, sinh GV mới; không dòng sổ cái nào bị sửa', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'avg_period');
    const first = await t.runOk();
    await t.pnk('2026-01-05', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '20' }]);
    // đánh dấu "chưa cập nhật" khi ghi lùi là Task 10; ở đây ghi trạng thái như Task 10 sẽ ghi để kiểm đọc và xóa sau lần chạy
    await sql`INSERT INTO stock_cost_state(tenant_id, item_id, warehouse_id, stale_from) SELECT ${t.tenantId}::uuid, i.id, w.id, '2026-01-05'
      FROM item i, warehouse w WHERE i.tenant_id = ${t.tenantId}::uuid AND w.tenant_id = i.tenant_id AND i.code = 'H1' AND w.code = 'K1'`.execute(ctx.t.admin);
    const st = await t.call('GET', '/api/inventory/costing-status');
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json()).toEqual([expect.objectContaining({ itemCode: 'H1', warehouseCode: 'K1', staleFrom: '2026-01-05' })]);
    const before = await t.canon();
    const second = await t.runOk();
    expect(await t.canon()).toEqual(before);
    const gv = await t.gvs();
    const old = first.voucherIds[0]!; const cur = second.voucherIds[0]!;
    expect(gv.map((g) => [g.id === old ? 'cũ' : g.id === cur ? 'mới' : g.reversal_of_id === old ? 'đảo' : '?', g.state, g.posting_date]).sort())
      .toEqual([['cũ', 'reversed', '2026-01-31'], ['mới', 'posted', '2026-01-31'], ['đảo', 'posted', '2026-01-31']]);
    // bình quân (1.000 + 200 + 600) / 160 = 11,25: xuất 675 + 788
    expect(await t.bal('632', 'K1')).toBe('1463');
    expect(await assertLayers(t, 'K1')).toEqual({ q: '30.0000', v: '337' });
    expect((await t.call('GET', '/api/inventory/costing-status')).json()).toEqual([]);
  }, 60_000);

  it('kỳ khóa mềm không quyền ghi lùi: 409; kỳ khóa cứng: PERIOD_HARD_LOCKED', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'fifo');
    const lock = async (level: string, no = 1) => { const r = await t.call('POST', `/api/periods/2026/${no}/lock`, { level }); expect(r.statusCode, r.body).toBe(200); };
    await lock('soft');
    const c = await t.login(['costing.run', 'costing.view'], ['view_cost']);
    const soft = await t.run({}, c);
    expect(soft.statusCode, soft.body).toBe(409); expect(soft.json().error.code).toBe('PERIOD_SOFT_LOCKED');
    expect((await t.runOk()).voucherIds).toHaveLength(1); // quản trị có quyền ghi lùi
    await lock('hard', 0); await lock('hard');
    const hard = await t.run();
    expect(hard.statusCode).toBe(409); expect(hard.json().error.code).toBe('PERIOD_HARD_LOCKED');
  }, 60_000);

  it('GV không bỏ ghi sổ/hủy/đảo qua route chung → VOUCHER_SYSTEM_GENERATED; không lập tay', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'avg_moving');
    const [id] = (await t.runOk()).voucherIds;
    for (const [url, body] of [['unpost', {}], ['discard', {}], ['reverse', { postingDate: '2026-01-31' }]] as const) {
      const r = await t.call('POST', `/api/vouchers/${id}/${url}`, body);
      expect(r.statusCode, `${url} ${r.body}`).toBe(409); expect(r.json().error.code).toBe('VOUCHER_SYSTEM_GENERATED');
    }
    const m = await t.call('POST', '/api/vouchers', { voucherType: 'GV', postingDate: '2026-01-31', documentDate: '2026-01-31', lines: [{ accountCode: '632', debit: '1' }, { accountCode: '1111', credit: '1' }] });
    expect(m.statusCode).toBe(409); expect(m.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
    const v = (await t.call('GET', `/api/vouchers/${id}`)).json();
    expect(v).toMatchObject({ voucherType: 'GV', state: 'posted', sourceDocType: 'costing_run', postingDate: '2026-01-31' });
  }, 60_000);

  it('chuyển kho giữa hai kho khác phương pháp: kho đến nhập theo giá gán của kho đi', async () => {
    const t = await tenant();
    await t.wh('KF', 'fifo'); await t.wh('KG', 'avg_moving', '157'); await t.item('H1');
    await t.pnk('2026-01-02', 'KF', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    await t.pnk('2026-01-03', 'KF', [{ itemCode: 'H1', quantity: '50', unitPrice: '12' }]);
    await t.ck('2026-01-10', 'KF', 'KG', [{ itemCode: 'H1', quantity: '120' }]); // giá tạm 120 × 10,6667 = 1.280
    await t.pxk('2026-01-20', 'KG', [{ itemCode: 'H1', quantity: '60' }]);
    expect(await t.bal('157', 'KG')).toBe('640');
    const r = await t.runOk({ warehouseCode: 'KF' }); // chạy kho đi: kho đến tính theo
    expect(r.summary.items).toBe(2);
    // FIFO kho đi: 1.000 + 20 × 12 = 1.240; kho đến bình quân di động: xuất 60 = 620
    expect(await t.bal('156', 'KF')).toBe('360');
    expect(await t.bal('157', 'KG')).toBe('620');
    expect(await t.bal('632', 'KG')).toBe('620');
    expect(await assertLayers(t, 'KF')).toEqual({ q: '30.0000', v: '360' });
    expect(await assertLayers(t, 'KG', '157')).toEqual({ q: '60.0000', v: '620' });
    const kgIn = (await sql<{ value: string }>`SELECT c.value FROM stock_cost_layer c JOIN warehouse w ON w.id = c.warehouse_id WHERE c.tenant_id = ${t.tenantId}::uuid AND w.code = 'KG'`.execute(ctx.t.admin)).rows;
    expect(kgIn.map((x) => x.value)).toEqual(['1240']);
    expect((await t.runOk()).unchanged).toBe(true);
  }, 60_000);

  it('cố định giá vốn: dòng xuất fixed_cost giữ đúng đơn giá', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period'); await t.item('H1');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    await t.pnk('2026-01-15', 'K1', [{ itemCode: 'H1', quantity: '50', unitPrice: '12' }]);
    const fixed = await t.pxk('2026-01-20', 'K1', [{ itemCode: 'H1', quantity: '60', fixedUnitCost: '9.5' }]);
    await t.pxk('2026-01-25', 'K1', [{ itemCode: 'H1', quantity: '70' }]);
    const r = await t.runOk();
    const d = await t.call('GET', `/api/inventory/costing-runs/${r.runId}`);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().assignments.find((a: { voucherId: string }) => a.voucherId === fixed.id)).toMatchObject({ unitCost: '9.5000', amount: '570', booked: '570', delta: '0' });
    expect(await t.bal('632', 'K1')).toBe('1317'); // 570 + 70 × 10,6667
    expect(await assertLayers(t, 'K1')).toEqual({ q: '20.0000', v: '283' });
  }, 60_000);

  it('thiếu quyền costing.run → 403; không view_cost → chi tiết gán giá 403', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'fifo');
    const { runId } = await t.runOk();
    const noRun = await t.login(['costing.view'], ['view_cost']);
    expect((await t.run({}, noRun)).statusCode).toBe(403);
    expect((await t.call('GET', `/api/inventory/costing-runs/${runId}`, undefined, noRun)).statusCode).toBe(200);
    const noCost = await t.login(['costing.run', 'costing.view'], []);
    expect((await t.call('GET', `/api/inventory/costing-runs/${runId}`, undefined, noCost)).statusCode).toBe(403);
    const list = await t.call('GET', '/api/inventory/costing-runs', undefined, noCost);
    expect(list.statusCode).toBe(200); expect(list.json()[0]).toMatchObject({ id: runId, delta: null });
    expect((await t.call('GET', '/api/inventory/costing-runs')).json()[0]).toMatchObject({ id: runId, delta: '13' });
  }, 60_000);
});

const D = (s: string | null) => Number(s);

describe('tính giá vốn nhiều kỳ, đảo, phạm vi hẹp, tồn âm', () => {
  const state = async (t: T) => (await t.call('GET', '/api/inventory/costing-status')).json() as { itemCode: string; staleFrom: string }[];
  it('kỳ sau dựng tồn đầu từ kỳ trước; đảo phiếu xuất theo giá gán gốc; chạy hẹp một hàng không làm mất chênh của hàng khác; tính lại kỳ trước đánh dấu kỳ sau', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'fifo'); await t.item('H2');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H2', quantity: '10', unitPrice: '5' }]);
    await t.pxk('2026-01-10', 'K1', [{ itemCode: 'H2', quantity: '4' }]);
    await t.pxk('2026-02-05', 'K1', [{ itemCode: 'H1', quantity: '10' }]);
    await t.pnk('2026-02-10', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '15' }]);
    await t.pxk('2026-02-20', 'K1', [{ itemCode: 'H1', quantity: '5' }]);
    const FEB = { periodFrom: '2026-02-01', periodTo: '2026-02-28' };
    await t.runOk(); await t.runOk(FEB);
    // FIFO tháng 2: tồn đầu 20@12; xuất 10 = 120; nhập 10@15; xuất 5 = 60. Giá vốn: 600 + 760 + 120 + 60 (H1) + 20 (H2)
    expect(await t.bal('632', 'K1', '2026-02-28')).toBe('1560');
    expect(await t.layers('K1', '2026-02-28')).toEqual({ q: '21.0000', v: await t.bal('156', 'K1', '2026-02-28') });

    // đảo phiếu xuất 70 ngày 20/01 vào 25/02: nhập lại đúng giá vốn gốc 760 (phiếu đảo ghi giá tạm 747, GV tháng 2 bù 13)
    const px = (await t.call('GET', '/api/vouchers?type=PXK')).json().rows.find((v: { postingDate: string }) => v.postingDate === '2026-01-20');
    expect((await t.call('POST', `/api/vouchers/${px.id}/reverse`, { postingDate: '2026-02-25' })).statusCode).toBe(201);
    await t.runOk(FEB);
    expect(await t.bal('632', 'K1', '2026-02-28')).toBe('800');
    expect(await t.layers('K1', '2026-02-28')).toEqual({ q: '91.0000', v: '1000' });
    expect(await t.bal('156', 'K1', '2026-02-28')).toBe('1000');

    // ghi lùi nhập H2 ngày 01/01 rồi chỉ tính lại H2 tháng 1: GV tháng 1 cũ (có cả chênh H1) đảo, GV mới mang lại chênh H1
    await t.pnk('2026-01-01', 'K1', [{ itemCode: 'H2', quantity: '10', unitPrice: '8' }]);
    const h2 = await t.runOk({ itemCode: 'H2' });
    expect(h2.unchanged).toBe(false); expect(h2.voucherIds).toHaveLength(1);
    expect(await t.bal('632', 'K1', '2026-01-31')).toBe('1392'); // 600 + 760 + 32
    expect(await t.bal('632', 'K1', '2026-02-28')).toBe('812');
    expect((await t.runOk()).unchanged).toBe(true);

    // ghi lùi nhập H1 vào tháng 1, tính lại tháng 1: giá vốn tháng 2 của H1 thành chưa cập nhật từ 01/02, tính tháng 2 thì hết
    await t.pnk('2026-01-01', 'K1', [{ itemCode: 'H1', quantity: '1', unitPrice: '100' }]);
    expect((await t.runOk()).unchanged).toBe(false);
    // lớp còn lại là trạng thái hiện tại (gồm phần xuất tháng 2 giữ số đã ghi): Σ lớp = sổ cái hiện tại
    expect(await t.drift()).toEqual([]);
    expect(await state(t)).toEqual([expect.objectContaining({ itemCode: 'H1', staleFrom: '2026-02-01' })]);
    await t.runOk(FEB);
    expect(await state(t)).toEqual([]);
    expect(await t.layers('K1', '2026-02-28')).toEqual({ q: '102.0000', v: await t.bal('156', 'K1', '2026-02-28') });
    expect(await t.drift()).toEqual([]);
  }, 120_000);

  it('chuyển kho qua lại trong kỳ (bình quân cuối kỳ hai kho) hội tụ; đảo phiếu chuyển kho trả đúng giá đã chuyển; Σ lớp còn lại khớp sổ cái từng kho', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period'); await t.wh('K2', 'avg_period', '157'); await t.item('H1');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    await t.ck('2026-01-10', 'K1', 'K2', [{ itemCode: 'H1', quantity: '50' }]);
    await t.pnk('2026-01-12', 'K2', [{ itemCode: 'H1', quantity: '50', unitPrice: '13' }]);
    const back = await t.ck('2026-01-20', 'K2', 'K1', [{ itemCode: 'H1', quantity: '20' }]);
    await t.pxk('2026-01-25', 'K1', [{ itemCode: 'H1', quantity: '30' }]);
    await t.pxk('2026-01-26', 'K2', [{ itemCode: 'H1', quantity: '30' }]);
    const r = await t.runOk({ warehouseCode: 'K2' });
    expect(r.summary.items).toBe(2);
    for (const [w, a] of [['K1', '156'], ['K2', '157']] as const) await assertLayers(t, w, a);
    expect(D(await t.bal('632', 'K1')) + D(await t.bal('632', 'K2')) + D(await t.bal('156', 'K1')) + D(await t.bal('157', 'K2'))).toBe(1650);
    expect((await t.call('POST', `/api/vouchers/${back.id}/reverse`, { postingDate: '2026-01-28' })).statusCode).toBe(201);
    await t.runOk();
    for (const [w, a] of [['K1', '156'], ['K2', '157']] as const) await assertLayers(t, w, a);
    expect((await t.layers('K2')).q).toBe('70.0000');
    expect((await t.runOk()).unchanged).toBe(true);
  }, 60_000);

  it('tồn âm (cho phép): lớp thiếu lưu lại, kỳ sau bù; Σ lớp còn lại khớp sổ cái; đích danh thiếu lô hủy cả lần chạy', async () => {
    const t = await tenant();
    expect((await t.call('PUT', '/api/settings', { stock_negative: 'allow' })).statusCode).toBe(200);
    await t.wh('K1', 'fifo'); await t.item('H1');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '10' }]);
    await t.pxk('2026-01-03', 'K1', [{ itemCode: 'H1', quantity: '15' }]); // thiếu 5: lớp thiếu −5/−50, nhập 05/01 bù
    await t.pnk('2026-01-05', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '12' }]);
    await t.pxk('2026-01-25', 'K1', [{ itemCode: 'H1', quantity: '8' }]);
    const r = await t.runOk();
    expect(r.summary.errors.map((e) => e.code)).toEqual(['COSTING_NEGATIVE_STOCK', 'COSTING_NEGATIVE_STOCK']);
    expect(await assertLayers(t, 'K1')).toEqual({ q: '-3.0000', v: '-42' }); // xuất 8: còn 5 trị giá 70, thiếu 3 × 14
    await t.pnk('2026-02-02', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '10' }]);
    await t.runOk({ periodFrom: '2026-02-01', periodTo: '2026-02-28' });
    expect(await t.layers('K1', '2026-02-28')).toEqual({ q: '7.0000', v: await t.bal('156', 'K1', '2026-02-28') });

    await t.wh('KD', 'specific'); await t.item('H9');
    await t.pnk('2026-01-02', 'KD', [{ itemCode: 'H9', quantity: '10', unitPrice: '10' }]);
    await t.pxk('2026-01-03', 'KD', [{ itemCode: 'H9', quantity: '2' }]);
    const bad = await t.run({ warehouseCode: 'KD' });
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('COSTING_LOT_MISSING');
    expect((await t.gvs()).length).toBe(1);
  }, 60_000);

  it('bình quân cuối kỳ, đảo phiếu xuất trong kỳ, số tiền lớn: xuất và chiều đảo triệt tiêu, không báo vòng chuyển kho', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period'); await t.item('H1');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H1', quantity: '100', unitPrice: '10000' }]);
    const px = await t.pxk('2026-01-05', 'K1', [{ itemCode: 'H1', quantity: '100' }]);
    await t.pnk('2026-01-03', 'K1', [{ itemCode: 'H1', quantity: '100', unitPrice: '1000000' }]); // ghi lùi trước phiếu xuất
    const rv = await t.call('POST', `/api/vouchers/${px.id}/reverse`, { postingDate: '2026-01-10' });
    expect(rv.statusCode, rv.body).toBe(201);
    const r = await t.runOk();
    expect(r.summary.errors).toEqual([]);
    // bình quân (1.000.000 + 100.000.000) / 200 = 505.000: xuất 50.500.000, đảo trả lại đúng số đó
    const detail = (await t.call('GET', `/api/inventory/costing-runs/${r.runId}`)).json() as { assignments: { direction: string; amount: string }[] };
    expect(detail.assignments.map((a) => [a.direction, a.amount]).sort()).toEqual([['in', '50500000'], ['out', '50500000']]);
    expect(await t.bal('632', 'K1')).toBe('0');
    expect(await t.bal('156', 'K1')).toBe('101000000');
    expect(await t.drift()).toEqual([]);
    expect((await t.runOk()).unchanged).toBe(true);
  }, 60_000);

  it('chuyển kho A → B → A giữa hai kho bình quân cuối kỳ, số tiền lớn: hội tụ đến điểm bất động; chạy lại không đổi', async () => {
    const t = await tenant();
    await t.wh('K1', 'avg_period'); await t.wh('K2', 'avg_period', '157'); await t.item('H1');
    await t.pnk('2026-01-02', 'K1', [{ itemCode: 'H1', quantity: '100', unitPrice: '1000000' }]);
    await t.pnk('2026-01-03', 'K2', [{ itemCode: 'H1', quantity: '50', unitPrice: '3000000' }]);
    await t.ck('2026-01-05', 'K1', 'K2', [{ itemCode: 'H1', quantity: '40' }]);
    await t.ck('2026-01-08', 'K2', 'K1', [{ itemCode: 'H1', quantity: '30' }]);
    await t.pxk('2026-01-20', 'K1', [{ itemCode: 'H1', quantity: '50' }]);
    await t.pxk('2026-01-21', 'K2', [{ itemCode: 'H1', quantity: '30' }]);
    const r = await t.run();
    expect(r.statusCode, r.body).toBe(200);
    expect(await t.drift()).toEqual([]);
    for (const [w, a] of [['K1', '156'], ['K2', '157']] as const) await assertLayers(t, w, a);
    expect((await t.runOk()).unchanged).toBe(true);
  }, 60_000);

  it('tính lại kỳ trước sau khi đã tính kỳ sau: lớp còn lại giữ phần xuất của kỳ sau, Σ lớp = sổ cái hiện tại', async () => {
    const t = await tenant();
    await scenario(t, 'K1', 'H1', 'fifo');
    await t.pxk('2026-02-05', 'K1', [{ itemCode: 'H1', quantity: '10' }]);
    await t.pnk('2026-02-10', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '15' }]);
    await t.runOk(); expect(await t.drift()).toEqual([]);
    await t.runOk({ periodFrom: '2026-02-01', periodTo: '2026-02-28' }); expect(await t.drift()).toEqual([]);
    expect((await t.runOk()).unchanged).toBe(true);
    expect(await t.drift()).toEqual([]);
    expect(await t.layers('K1', '2026-12-31')).toEqual({ q: '20.0000', v: '270' }); // 10 × 12 + 10 × 15
  }, 60_000);

  it('phương pháp chọn khi chạy chỉ áp cho kho theo bộ lọc; kho nhận chuyển kho kéo vào giữ phương pháp của kho', async () => {
    const t = await tenant();
    await t.wh('K1', 'fifo'); await t.wh('K2', 'avg_moving'); await t.item('H1');
    await t.pnk('2026-01-01', 'K1', [{ itemCode: 'H1', quantity: '10', unitPrice: '20' }]);
    await t.pnk('2026-01-02', 'K2', [{ itemCode: 'H1', quantity: '10', unitPrice: '10' }]);
    await t.pxk('2026-01-03', 'K2', [{ itemCode: 'H1', quantity: '10' }]);
    await t.ck('2026-01-05', 'K1', 'K2', [{ itemCode: 'H1', quantity: '10' }]);
    await t.pxk('2026-01-10', 'K2', [{ itemCode: 'H1', quantity: '5' }]);
    const r = await t.runOk({ warehouseCode: 'K1', method: 'avg_period' });
    expect(r.summary.items).toBe(2);
    // K2 bình quân tức thời: 100 + 5 × 20 = 200 (bình quân cuối kỳ sẽ là 150 + 75 = 225)
    expect(await t.bal('632', 'K2')).toBe('200');
    expect(await t.drift()).toEqual([]);
  }, 60_000);
});
