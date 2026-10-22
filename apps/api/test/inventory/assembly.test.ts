import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

const JAN = { periodFrom: '2026-01-01', periodTo: '2026-01-31' };
// Một công ty: kho K1 (bình quân cuối kỳ, không gắn TK kho nên TK kho theo hàng), linh kiện A, B (TK 156), thành phẩm S (TK 155).
async function tenant() {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `LR${Date.now()}${n++}` });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = cookie) => ctx.app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
  const login = async (perms: string[], flags: string[]) => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms })).statusCode).toBe(200);
    const username = `lr_${n++}_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${r.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('warehouse', { code: 'K1', name: 'Kho một', costing_method: 'avg_period' });
  for (const [code, acc] of [['A', '156'], ['B', '156'], ['S', '155']] as const) await cat('item', { code, name: `Hàng ${code}`, base_uom_code: 'CAI', kind: 'goods', tracking: 'none', inventory_account_code: acc });
  const post = async (id: string) => { const p = await call('POST', `/api/vouchers/${id}/post`, {}); expect(p.statusCode, p.body).toBe(200); return p.json() as { id: string }; };
  const stock = async (body: object) => { const r = await call('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); expect(r.statusCode, r.body).toBe(201); return post(r.json().id); };
  const pnk = (date: string, itemCode: string, quantity: string, unitPrice: string) => stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode, uomCode: 'CAI', quantity, unitPrice }] });
  const pxk = (date: string, itemCode: string, quantity: string) => stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: date, warehouseCode: 'K1', items: [{ itemCode, uomCode: 'CAI', quantity }] });
  const lrDraft = (body: object) => call('POST', '/api/assembly-vouchers', { warehouseCode: 'K1', ...body });
  const lr = async (body: object) => { const r = await lrDraft(body); expect(r.statusCode, r.body).toBe(201); return { draft: r.json(), posted: await post(r.json().id) }; };
  const runOk = async () => { const r = await call('POST', '/api/inventory/costing-runs', JAN); expect(r.statusCode, r.body).toBe(200); return r.json() as { voucherIds: string[]; unchanged: boolean; summary: { errors: unknown[] } }; };
  // Bất biến: Σ giá trị còn lại của lớp giá theo TK kho của hàng = số dư sổ cái TK đó trong kho.
  const drift = async () => (await sql<{ acc: string; layers: string; ledger: string }>`SELECT a.code AS acc,
      (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c JOIN item i ON i.id = c.item_id WHERE c.tenant_id = ${tenantId}::uuid AND i.inventory_account_id = a.id)::text AS layers,
      (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE l.tenant_id = ${tenantId}::uuid AND l.account_id = a.id AND l.warehouse_id IS NOT NULL AND v.state IN ('posted','reversed'))::text AS ledger
    FROM account a WHERE a.tenant_id = ${tenantId}::uuid AND a.code IN ('155', '156') AND a.regime = 'TT133' ORDER BY a.code`.execute(ctx.t.admin)).rows;
  const layerOf = async (voucherId: string) => (await sql<{ item: string; dir: string; v: string }>`SELECT i.code AS item, m.direction AS dir, c.value::text AS v FROM stock_move m JOIN stock_cost_layer c ON c.move_id = m.id AND c.kind = 'receipt'
    JOIN item i ON i.id = m.item_id WHERE m.voucher_id = ${voucherId}::uuid ORDER BY i.code`.execute(ctx.t.admin)).rows;
  const gvLines = async (id: string) => (await sql<{ code: string; item: string; debit: string; credit: string }>`SELECT a.code, i.code AS item, l.debit::text, l.credit::text FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN item i ON i.id = l.item_id
    WHERE l.voucher_id = ${id}::uuid ORDER BY l.line_no`.execute(ctx.t.admin)).rows;
  // Số dư sổ cái từng (TK kho, hàng) so với Σ giá trị còn lại của lớp giá từng hàng.
  const perItem = async () => (await sql<{ item: string; layers: string; ledger: string }>`SELECT i.code AS item,
      (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.tenant_id = ${tenantId}::uuid AND c.item_id = i.id)::text AS layers,
      (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
        WHERE l.tenant_id = ${tenantId}::uuid AND l.item_id = i.id AND a.code IN ('155', '156') AND v.state IN ('posted','reversed'))::text AS ledger
    FROM item i WHERE i.tenant_id = ${tenantId}::uuid AND i.code IN ('A', 'B', 'S') ORDER BY i.code`.execute(ctx.t.admin)).rows;
  return { tenantId, login, perItem, call, pnk, pxk, lr, lrDraft, runOk, drift, layerOf, gvLines, post };
}

const SET = { mode: 'assembly', postingDate: '2026-01-10', outputs: [{ itemCode: 'S', quantity: '1' }], components: [{ itemCode: 'A', quantity: '2' }, { itemCode: 'B', quantity: '1' }], extraCost: '5' };

describe('lắp ráp, tháo dỡ', () => {
  it('lắp ráp: giá bộ tạm = linh kiện × giá tạm + chi phí; sau tính giá vốn đổi theo giá gán, GV điều chỉnh 155/156', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', 'A', '10', '10'); await t.pnk('2026-01-02', 'B', '5', '5');
    const { draft, posted } = await t.lr(SET);
    expect(draft.assembly).toEqual({ mode: 'assembly', extraCost: '5', extraCostAccountCode: '154' });
    expect(draft.items.map((i: { direction: string; amount: string }) => [i.direction, i.amount])).toEqual([['out', '20'], ['out', '5'], ['in', '30']]);
    const gl = (await t.call('GET', `/api/stock-vouchers/${posted.id}`)).json().ledgerLines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit]);
    expect(gl).toEqual(expect.arrayContaining([['155', '30', '0'], ['156', '0', '20'], ['156', '0', '5'], ['154', '0', '5']]));
    await t.pnk('2026-01-15', 'A', '10', '20'); // bình quân kỳ của A = 15: hai cái A xuất lắp = 30
    const r1 = await t.runOk();
    expect(r1.summary.errors).toEqual([]);
    expect(r1.voucherIds).toHaveLength(1);
    expect(await t.gvLines(r1.voucherIds[0]!)).toEqual([{ code: '156', item: 'A', debit: '0', credit: '10' }, { code: '155', item: 'S', debit: '10', credit: '0' }]); // 155 gắn bộ S, 156 gắn linh kiện A
    expect((await t.layerOf(posted.id)).filter((l) => l.dir === 'in')).toEqual([{ item: 'S', dir: 'in', v: '40' }]); // 30 + 5 + 5
    expect(await t.drift()).toSatisfy((rows: { layers: string; ledger: string }[]) => rows.every((r) => r.layers === r.ledger));
    const again = await t.runOk();
    expect(again.unchanged).toBe(true); expect(again.voucherIds).toEqual([]);
  });

  it('tháo dỡ: phân bổ 100% giá trị hàng tháo theo tỷ lệ, dòng cuối nhận phần dư', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', 'A', '10', '10'); await t.pnk('2026-01-02', 'B', '5', '5');
    await t.lr(SET);
    await t.pnk('2026-01-15', 'A', '10', '20');
    const dis = await t.lr({ mode: 'disassembly', postingDate: '2026-01-20', outputs: [{ itemCode: 'S', quantity: '1' }],
      components: [{ itemCode: 'A', quantity: '2', costRatio: '66.6667' }, { itemCode: 'B', quantity: '1', costRatio: '33.3333' }] });
    expect(dis.draft.items.map((i: { direction: string; amount: string }) => [i.direction, i.amount])).toEqual([['out', '30'], ['in', '20'], ['in', '10']]);
    const r = await t.runOk();
    expect(r.summary.errors).toEqual([]);
    const ins = (await t.layerOf(dis.posted.id)).filter((l) => l.dir === 'in');
    // Hàng tháo quay lại kho linh kiện nên đơn giá bình quân kỳ đổi: giá trị hội tụ theo vòng lặp, tỷ lệ 2:1 giữ nguyên.
    expect(Number(ins[0]!.v)).toBe(2 * Number(ins[1]!.v));
    expect(await t.drift()).toSatisfy((rows: { layers: string; ledger: string }[]) => rows.every((x) => x.layers === x.ledger));
    expect((await t.runOk()).unchanged).toBe(true);
  });

  it('tỷ lệ bỏ trống chia theo số lượng × giá tạm; tỷ lệ sai bị từ chối', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', 'S', '1', '90');
    await t.pnk('2026-01-02', 'A', '3', '10'); await t.pnk('2026-01-02', 'B', '1', '30');
    const ex = await t.lrDraft({ mode: 'disassembly', postingDate: '2026-01-10', extraCost: '5', outputs: [{ itemCode: 'S', quantity: '1' }], components: [{ itemCode: 'A', quantity: '1', costRatio: '50' }, { itemCode: 'B', quantity: '1', costRatio: '50' }] });
    expect(ex.json().error.code).toBe('EXTRA_COST_DISASSEMBLY');
    const bad = await t.lrDraft({ mode: 'disassembly', postingDate: '2026-01-10', outputs: [{ itemCode: 'S', quantity: '1' }], components: [{ itemCode: 'A', quantity: '3', costRatio: '60' }, { itemCode: 'B', quantity: '1', costRatio: '50' }] });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('COST_RATIO_INVALID');
    const ok = await t.lr({ mode: 'disassembly', postingDate: '2026-01-10', outputs: [{ itemCode: 'S', quantity: '1' }], components: [{ itemCode: 'A', quantity: '3' }, { itemCode: 'B', quantity: '1' }] });
    expect(ok.draft.items.map((i: { costRatio: string | null }) => i.costRatio)).toEqual([null, '50.0000', '50.0000']); // 3×10 : 1×30
    expect(ok.draft.items.map((i: { amount: string }) => i.amount)).toEqual(['90', '45', '45']);
  });

  it('thiếu linh kiện: STOCK_NEGATIVE; thành phẩm đã xuất thì không bỏ ghi sổ (STOCK_CONSUMED); đảo giữ khớp sổ cái', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', 'A', '1', '10'); await t.pnk('2026-01-02', 'B', '1', '5');
    const short = await t.lrDraft(SET);
    expect(short.statusCode).toBe(201);
    const p = await t.call('POST', `/api/vouchers/${short.json().id}/post`, {});
    expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('STOCK_NEGATIVE');
    await t.pnk('2026-01-03', 'A', '9', '10');
    const { posted } = await t.lr(SET);
    await t.pxk('2026-01-12', 'S', '1');
    await t.runOk();
    const u = await t.call('POST', `/api/vouchers/${posted.id}/unpost`, {});
    expect(u.statusCode).toBe(409); expect(u.json().error.code).toBe('STOCK_CONSUMED');
  });

  it('đảo phiếu lắp ráp sau khi tính giá vốn: lớp giá khớp sổ cái, tính lại không đổi', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', 'A', '10', '10'); await t.pnk('2026-01-02', 'B', '5', '5');
    const { posted } = await t.lr(SET);
    await t.pnk('2026-01-15', 'A', '10', '20');
    await t.runOk();
    const rv = await t.call('POST', `/api/vouchers/${posted.id}/reverse`, { postingDate: '2026-01-20' });
    expect(rv.statusCode, rv.body).toBe(201);
    const r = await t.runOk();
    expect(r.summary.errors).toEqual([]);
    expect(await t.drift()).toSatisfy((rows: { layers: string; ledger: string }[]) => rows.every((x) => x.layers === x.ledger));
    expect((await t.runOk()).unchanged).toBe(true);
  });

  it('GV gắn đúng hàng từng bên: số dư sổ cái từng hàng khớp lớp giá (lắp ráp, đảo, tháo dỡ)', async () => {
    const t = await tenant();
    const same = async () => { const rows = await t.perItem(); expect(rows.map((r) => [r.item, r.ledger]), JSON.stringify(rows)).toEqual(rows.map((r) => [r.item, r.layers])); };
    await t.pnk('2026-01-02', 'A', '10', '10'); await t.pnk('2026-01-02', 'B', '5', '5');
    await t.lr(SET);
    await t.pnk('2026-01-15', 'A', '10', '20');
    await t.runOk(); await same();
    expect((await t.perItem()).find((r) => r.item === 'S')!.ledger).toBe('40');
    const dis = await t.lr({ mode: 'disassembly', postingDate: '2026-01-20', outputs: [{ itemCode: 'S', quantity: '1' }], components: [{ itemCode: 'A', quantity: '2', costRatio: '50' }, { itemCode: 'B', quantity: '1', costRatio: '50' }] });
    await t.runOk(); await same();
    expect((await t.call('POST', `/api/vouchers/${dis.posted.id}/reverse`, { postingDate: '2026-01-25' })).statusCode).toBe(201);
    await t.runOk(); await same();
  });

  it('thiếu view_cost: ghi sổ, bỏ ghi, đảo phiếu kho và LR không lộ dòng, tổng tiền', async () => {
    const t = await tenant();
    const draft = async (body: object, url = '/api/stock-vouchers') => { const r = await t.call('POST', url, { description: 'x', ...body }); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };
    const pnkId = await draft({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-01-02', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'A', uomCode: 'CAI', quantity: '10', unitPrice: '10' }] });
    await t.pnk('2026-01-02', 'B', '5', '5');
    const lrId = (await t.lrDraft(SET)).json().id as string;
    const u = await t.login(['voucher.post', 'voucher.unpost', 'voucher.edit_posted', 'voucher.view', 'stock_voucher.post', 'stock_voucher.view'], []);
    const hidden = (r: { statusCode: number; body: string; json: () => { lines: unknown[]; totalDebit: string } }) => { expect(r.statusCode, r.body).toBeLessThan(300); expect(r.json().lines).toEqual([]); expect(r.json().totalDebit).toBe('0'); };
    hidden(await t.call('POST', `/api/vouchers/${pnkId}/post`, {}, u));
    hidden(await t.call('POST', `/api/vouchers/${pnkId}/unpost`, {}, u));
    hidden(await t.call('POST', `/api/vouchers/${pnkId}/post`, {}, u));
    hidden(await t.call('POST', `/api/vouchers/${lrId}/post`, {}, u));
    hidden(await t.call('POST', `/api/vouchers/${lrId}/reverse`, { postingDate: '2026-01-10' }, u));
  });

  it('lần chạy sau chỉ phủ một phần kỳ: GV chân nhập của LR cũ theo giá trị lớp giá từng hàng, số dư từng hàng khớp', async () => {
    const t = await tenant();
    expect((await t.call('POST', '/api/catalogs/item', { code: 'C', name: 'Hàng C', base_uom_code: 'CAI', kind: 'goods', tracking: 'none', inventory_account_code: '156' })).statusCode).toBe(201);
    await t.pnk('2026-01-02', 'S', '1', '70');
    await t.lr({ mode: 'disassembly', postingDate: '2026-01-10', outputs: [{ itemCode: 'S', quantity: '1' }],
      components: [{ itemCode: 'A', quantity: '1', costRatio: '33.3333' }, { itemCode: 'B', quantity: '1', costRatio: '33.3333' }, { itemCode: 'C', quantity: '1', costRatio: '33.3334' }] });
    await t.pnk('2026-01-05', 'S', '1', '114'); // nhập lùi ngày: bình quân kỳ của S = 92, giá tạm của bộ 70
    await t.pxk('2026-01-20', 'A', '1');
    await t.runOk();
    const r = await t.call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-11', periodTo: '2026-01-31' });
    expect(r.statusCode, r.body).toBe(200);
    const rows = (await sql<{ item: string; layers: string; ledger: string }>`SELECT i.code AS item,
        (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.tenant_id = ${t.tenantId}::uuid AND c.item_id = i.id)::text AS layers,
        (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
          WHERE l.tenant_id = ${t.tenantId}::uuid AND l.item_id = i.id AND a.code IN ('155', '156') AND v.state IN ('posted','reversed'))::text AS ledger
      FROM item i WHERE i.tenant_id = ${t.tenantId}::uuid AND i.code IN ('A', 'B', 'C', 'S') ORDER BY i.code`.execute(ctx.t.admin)).rows;
    expect(rows.map((x) => [x.item, x.ledger]), JSON.stringify(rows)).toEqual(rows.map((x) => [x.item, x.layers]));
  });
});
