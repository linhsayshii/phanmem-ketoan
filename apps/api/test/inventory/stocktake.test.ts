import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

// Kho K1, hàng A (không lô), hàng L (theo lô); nhập A 100 giá 1.000, L lô X1 10 giá 500 và lô X2 5 giá 500.
async function tenant() {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `KK${Date.now()}${n++}` });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, as = cookie) => ctx.app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('warehouse', { code: 'K1', name: 'Kho một', costing_method: 'avg_period' });
  await cat('item', { code: 'A', name: 'Hàng A', base_uom_code: 'CAI', kind: 'goods', tracking: 'none', inventory_account_code: '156' });
  await cat('item', { code: 'L', name: 'Hàng L', base_uom_code: 'CAI', kind: 'goods', tracking: 'lot', inventory_account_code: '156' });
  const pnk = async (itemCode: string, quantity: string, unitPrice: string, lotNo?: string) => {
    const r = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-05-02', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode, uomCode: 'CAI', quantity, unitPrice, ...(lotNo ? { lotNo } : {}) }] });
    expect(r.statusCode, r.body).toBe(201); expect((await call('POST', `/api/vouchers/${r.json().id}/post`, {})).statusCode).toBe(200);
  };
  await pnk('A', '100', '1000'); await pnk('L', '10', '500', 'X1'); await pnk('L', '5', '500', 'X2');
  const make = async (body: object = {}) => { const r = await call('POST', '/api/stocktakes', { docDate: '2026-05-10', warehouseCode: 'K1', ...body }); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; lines: { itemCode: string; lotNo: string | null; bookQty: string; countedQty: string | null; diffQty: string | null }[] }; };
  const count = (id: string, lines: object[]) => call('PUT', `/api/stocktakes/${id}`, { lines });
  const vouchers = async (ids: string[]) => (await sql<{ voucher_type: string; state: string; qty: string; dr: string }>`SELECT v.voucher_type, v.state, (SELECT sum(quantity) FROM stock_move m WHERE m.voucher_id = v.id)::text AS qty,
      (SELECT string_agg(a.code, ',' ORDER BY a.code) FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = v.id AND l.debit > 0) AS dr FROM voucher v WHERE v.id = ANY(${ids}::uuid[]) ORDER BY v.voucher_type`.execute(ctx.t.admin)).rows;
  return { call, make, count, vouchers, tenantId };
}

describe('Kiểm kê kho (T16)', () => {
  it('tồn sổ theo lô tại ngày kiểm kê; đếm thiếu 3 sinh PXK 3, đếm thừa 2 sinh PNK 2; điều chỉnh hai lần 409', async () => {
    const t = await tenant();
    const s = await t.make();
    expect(s.lines.map((l) => `${l.itemCode}/${l.lotNo ?? ''}=${l.bookQty}`)).toEqual(['A/=100.0000', 'L/X1=10.0000', 'L/X2=5.0000']);
    expect((await t.count(s.id, [{ itemCode: 'A', countedQty: '97' }, { itemCode: 'L', lotNo: 'X1', countedQty: '12', reason: 'income' }, { itemCode: 'L', lotNo: 'X2', countedQty: '5' }])).statusCode).toBe(200);
    const r = await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {});
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { status: string; adjustVoucherIds: string[]; lines: { diffQty: string }[] };
    expect(body.status).toBe('adjusted');
    const vs = await t.vouchers(body.adjustVoucherIds);
    expect(vs).toEqual([{ voucher_type: 'PNK', state: 'posted', qty: '2.0000', dr: '156' }, { voucher_type: 'PXK', state: 'posted', qty: '3.0000', dr: '1381' }]);
    const again = await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {});
    expect(again.statusCode).toBe(409); expect(again.json().error.code).toBe('STOCKTAKE_ADJUSTED');
    expect((await t.call('PUT', `/api/stocktakes/${s.id}`, { lines: [] })).statusCode).toBe(409);
    expect((await t.call('DELETE', `/api/stocktakes/${s.id}`)).statusCode).toBe(409);
    // PNK thừa ghi Có 711 theo lý do income
    const cr = await sql<{ c: string }>`SELECT string_agg(DISTINCT a.code, ',') AS c FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN voucher v ON v.id = l.voucher_id WHERE v.id = ANY(${body.adjustVoucherIds}::uuid[]) AND v.voucher_type = 'PNK' AND l.credit > 0`.execute(ctx.t.admin);
    expect(cr.rows[0]!.c).toBe('711');
  });

  it('lý do sai chiều và chưa đếm dòng nào bị từ chối; dòng chưa đếm bị bỏ qua', async () => {
    const t = await tenant();
    const s = await t.make();
    const none = await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {});
    expect(none.statusCode).toBe(400); expect(none.json().error.code).toBe('STOCKTAKE_NO_DIFFERENCE');
    await t.count(s.id, [{ itemCode: 'A', countedQty: '97', reason: 'income' }]);
    const bad = await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {});
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('STOCKTAKE_REASON_INVALID');
    await t.count(s.id, [{ itemCode: 'A', countedQty: '97', reason: 'loss' }]);
    const ok = await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await t.vouchers(ok.json().adjustVoucherIds)).toEqual([{ voucher_type: 'PXK', state: 'posted', qty: '3.0000', dr: '811' }]);
  });

  it('kỳ khóa cứng: 409; giao dịch hoàn tác, kiểm kê vẫn nháp', async () => {
    const t = await tenant();
    const s = await t.make();
    await t.count(s.id, [{ itemCode: 'A', countedQty: '90' }]);
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${t.tenantId}::uuid AND fiscal_year = 2026 AND period_no = 5`.execute(ctx.t.admin);
    const r = await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {});
    expect(r.statusCode).toBe(409);
    expect(((await t.call('GET', `/api/stocktakes/${s.id}`)).json() as { status: string }).status).toBe('draft');
  });

  it('in biên bản: có mẫu 05-VT theo văn bản gốc, không có giá trị tiền', async () => {
    const t = await tenant();
    const s = await t.make();
    await t.count(s.id, [{ itemCode: 'A', countedQty: '97' }]);
    const p = await t.call('GET', `/api/stocktakes/${s.id}/print`);
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain('Mẫu số 05-VT'); expect(p.body).toContain('BIÊN BẢN KIỂM KÊ'); expect(p.body).not.toContain('100.000');
  });

  it('người không có view_cost không điều chỉnh được (403), vẫn xem được kiểm kê', async () => {
    const t = await tenant();
    const roles = (await t.call('GET', '/api/roles')).json() as { id: string; code: string }[];
    await t.call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['stocktake.view', 'stocktake.update', 'stock_voucher.create', 'stock_voucher.post', 'voucher.create'] });
    const username = `kk_${n++}_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const as = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    const s = await t.make();
    await t.count(s.id, [{ itemCode: 'A', countedQty: '97' }]);
    expect((await t.call('GET', `/api/stocktakes/${s.id}`, undefined, as)).statusCode).toBe(200);
    expect((await t.call('POST', `/api/stocktakes/${s.id}/adjust`, {}, as)).statusCode).toBe(403);
  });
});
