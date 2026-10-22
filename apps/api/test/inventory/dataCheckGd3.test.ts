import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Hit = { ruleCode: string; voucherId: string | null; voucherNo: string | null; ref: string | null; detail: string | null; message: string };
type Reply = { results: Hit[]; ran: number; skipped: { code: string; reason: string }[] };
type Line = { itemCode: string; quantity: string; unitPrice?: string; fixedUnitCost?: string };
const RANGE = { from: '2026-01-01', to: '2026-01-31' };

// Mỗi kiểm thử một công ty: năm 2026 TT133, ĐVT CAI, nhà cung cấp NCC1, kho K1 (TK 156), hàng H1.
async function tenant() {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `KS${Date.now()}${n++}` });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('warehouse', { code: 'K1', name: 'Kho K1', inventory_account_code: '156', costing_method: 'avg_period' });
  await cat('item', { code: 'H1', name: 'Hàng H1', base_uom_code: 'CAI', kind: 'goods', tracking: 'none' });
  const stock = async (body: object) => {
    const r = await call('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); expect(r.statusCode, r.body).toBe(201);
    const p = await call('POST', `/api/vouchers/${r.json().id}/post`, {}); expect(p.statusCode, p.body).toBe(200); return p.json() as { id: string; voucherNo: string };
  };
  const items = (ls: Line[]) => ls.map((l) => ({ uomCode: 'CAI', ...l }));
  const pnk = (date: string, ls: Line[]) => stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC1', items: items(ls) });
  const pxk = (date: string, ls: Line[]) => stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: date, warehouseCode: 'K1', items: items(ls) });
  const costing = async () => { const r = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-01', periodTo: '2026-01-31' }); expect(r.statusCode, r.body).toBe(200); };
  const run = async (codes: string[], c = cookie): Promise<Reply> => {
    const r = await call('POST', '/api/data-check/run', { ...RANGE, codes }, c); expect(r.statusCode, r.body).toBe(200); return r.json();
  };
  const hits = async (code: string) => { const r = await run([code]); expect(r.results.every((x) => !/Quy tắc lỗi/.test(x.message)), JSON.stringify(r.results)).toBe(true); return r.results; };
  // Ép trạng thái chỉ có thể lọt qua dữ liệu cũ: chủ cơ sở dữ liệu, tắt trigger người dùng trong giao dịch.
  const force = (q: ReturnType<typeof sql>) => ctx.t.admin.transaction().execute(async (trx) => { await sql`SET LOCAL session_replication_role = replica`.execute(trx); await q.execute(trx); });
  const login = async (flags: string[]) => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['stock_voucher.view', 'data_check.run'] })).statusCode).toBe(200);
    const username = `ks_${n++}_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${r.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  return { tenantId, call, pnk, pxk, costing, run, hits, force, login };
}

describe('soát lỗi kho', () => {
  it('KHO_XUAT_CHUA_GIA_VON: ghi lùi sau lần tính giá vốn thì phiếu xuất sau đó bị báo', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    const out = await t.pxk('2026-01-20', [{ itemCode: 'H1', quantity: '60' }]);
    await t.costing();
    expect(await t.hits('KHO_XUAT_CHUA_GIA_VON')).toEqual([]);
    await t.pnk('2026-01-05', [{ itemCode: 'H1', quantity: '10', unitPrice: '20' }]);
    expect((await t.hits('KHO_XUAT_CHUA_GIA_VON')).map((x) => x.voucherNo)).toEqual([out.voucherNo]);
  });

  it('KHO_LECH_SO_CAI: khớp thì không báo; lớp giá lệch sổ cái thì báo TK kho / kho', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    await t.pxk('2026-01-20', [{ itemCode: 'H1', quantity: '60' }]);
    await t.costing();
    expect(await t.hits('KHO_LECH_SO_CAI')).toEqual([]);
    await t.force(sql`UPDATE stock_cost_layer SET value = value + 500 WHERE tenant_id = ${t.tenantId}::uuid`);
    const h = await t.hits('KHO_LECH_SO_CAI');
    expect(h.map((x) => x.ref)).toEqual(['156 / K1']); expect(h[0]!.detail).toBe('Lớp giá 900 / sổ cái 400');
  });

  it('KHO_SAI_DVT: số lượng cơ sở khác số lượng × hệ số thì báo đúng chứng từ', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    const bad = await t.pnk('2026-01-03', [{ itemCode: 'H1', quantity: '5', unitPrice: '10' }]);
    expect(await t.hits('KHO_SAI_DVT')).toEqual([]);
    await t.force(sql`UPDATE voucher_item_line SET base_quantity = 7 WHERE voucher_id = ${bad.id}::uuid`);
    expect((await t.hits('KHO_SAI_DVT')).map((x) => x.voucherNo)).toEqual([bad.voucherNo]);
  });

  it('KHO_TON_AM: xuất thiếu (cho phép tồn âm) báo ngày âm; nhập và xuất cùng ngày không âm cuối ngày thì không báo', async () => {
    const t = await tenant();
    await t.force(sql`INSERT INTO tenant_setting(tenant_id, key, value) VALUES (${t.tenantId}::uuid, 'stock_negative', '"allow"'::jsonb) ON CONFLICT (tenant_id, key) DO UPDATE SET value = '"allow"'::jsonb`);
    await t.pnk('2026-01-02', [{ itemCode: 'H1', quantity: '3', unitPrice: '10' }]);
    const out = await t.pxk('2026-01-10', [{ itemCode: 'H1', quantity: '5' }]);
    const h = await t.hits('KHO_TON_AM');
    expect(h.map((x) => x.voucherNo)).toEqual([out.voucherNo]); expect(h[0]!.detail).toContain('-2');
    await t.pnk('2026-01-10', [{ itemCode: 'H1', quantity: '10', unitPrice: '10' }]); // nhập ghi sau xuất cùng ngày: cuối ngày +8
    expect(await t.hits('KHO_TON_AM')).toEqual([]);
  });

  it('KHO_HANG_THIEU_KHO: dòng TK 156 không ghi kho thì báo', async () => {
    const t = await tenant();
    const v = await t.pnk('2026-01-02', [{ itemCode: 'H1', quantity: '100', unitPrice: '10' }]);
    expect(await t.hits('KHO_HANG_THIEU_KHO')).toEqual([]);
    await t.force(sql`UPDATE voucher_line SET warehouse_id = NULL WHERE voucher_id = ${v.id}::uuid AND debit > 0`);
    expect((await t.hits('KHO_HANG_THIEU_KHO')).map((x) => x.voucherNo)).toEqual([v.voucherNo]);
  });

  it('KHO_TON_0_CON_GIA_TRI: xuất hết nhưng cố định giá thấp hơn thì còn giá trị', async () => {
    const t = await tenant();
    await t.pnk('2026-01-02', [{ itemCode: 'H1', quantity: '10', unitPrice: '10' }]);
    await t.pxk('2026-01-20', [{ itemCode: 'H1', quantity: '10', fixedUnitCost: '8' }]);
    await t.costing();
    const h = await t.hits('KHO_TON_0_CON_GIA_TRI');
    expect(h.map((x) => x.ref)).toEqual(['H1 / K1']); expect(h[0]!.detail).toBe('Tồn 0, giá trị còn 20');
  });

  it('thiếu view_cost: ba quy tắc giá bị bỏ qua, quy tắc số lượng vẫn chạy', async () => {
    const t = await tenant();
    const cookie = await t.login([]);
    const r = await t.run([], cookie);
    const kho = ['KHO_LECH_SO_CAI', 'KHO_TON_0_CON_GIA_TRI', 'KHO_XUAT_CHUA_GIA_VON'];
    expect(r.skipped.map((x) => x.code).filter((c) => c.startsWith('KHO_'))).toEqual(kho);
    expect(await t.run(['KHO_TON_AM', 'KHO_SAI_DVT', 'KHO_HANG_THIEU_KHO'], cookie)).toMatchObject({ ran: 3, skipped: [] });
    const full = await t.run([], await t.login(['view_cost']));
    expect(full.skipped.map((x) => x.code).filter((c) => c.startsWith('KHO_'))).toEqual([]);
  });
});
