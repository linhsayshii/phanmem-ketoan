import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let cookie: string;
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const stock = (type: 'PNK' | 'PXK' | 'CK', stockKind: string, date: string, items: object[], extra: object = {}) =>
  call('POST', '/api/stock-vouchers', { voucherType: type, stockKind, postingDate: date, warehouseCode: 'K1', ...(stockKind === 'purchase' && { partyCode: 'NCC1' }), description: 'Phiếu kho', items, ...extra });
const post = async (id: string) => { const r = await call('POST', `/api/vouchers/${id}/post`, {}); expect(r.statusCode, r.body).toBe(200); };
const moves = async (voucherId: string) => (await sql<{ direction: string; quantity: string; transfer_id: string | null; code: string }>`
  SELECT m.direction, m.quantity::text, m.transfer_id::text, i.code FROM stock_move m JOIN item i ON i.id = m.item_id WHERE m.voucher_id = ${voucherId}::uuid ORDER BY m.id`.execute(ctx.t.admin)).rows;
const sums = (v: { ledgerLines: { accountCode: string; debit: string; credit: string }[] }) => v.ledgerLines.map((l) => `${l.accountCode}:${l.debit}:${l.credit}`).sort();

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `PK${Date.now()}` }));
  await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  for (const [code, name] of [['CAI', 'Cái'], ['CHAI', 'Chai'], ['THUNG', 'Thùng'], ['GIO', 'Giờ']]) await call('POST', '/api/catalogs/uom', { code, name }); // vài ĐVT đã có sẵn khi tạo công ty
  await cat('party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  await cat('item', { code: 'SP1', name: 'Hàng một', base_uom_code: 'CAI', kind: 'goods' });
  await cat('item', { code: 'NUOC', name: 'Nước', base_uom_code: 'CHAI', kind: 'goods' });
  await cat('item_uom', { item_code: 'NUOC', uom_code: 'THUNG', factor: '24' });
  await cat('item', { code: 'LO1', name: 'Hàng theo lô', base_uom_code: 'CAI', kind: 'goods', tracking: 'lot_expiry' });
  await cat('item', { code: 'DV1', name: 'Dịch vụ', base_uom_code: 'GIO', kind: 'service' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  await cat('warehouse', { code: 'K157', name: 'Kho gửi bán', kind: 'consignment_out', inventory_account_code: '157', costing_method: 'avg_moving' });
});
afterAll(async () => { await ctx.close(); });

describe('phiếu kho', () => {
  it('nhập mua 100 cái giá 10: Nợ 156 / Có 331 1.000, stock_move in 100 sau ghi sổ', async () => {
    const r = await stock('PNK', 'purchase', '2026-02-01', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '100', unitPrice: '10' }]);
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json();
    expect(sums(v)).toEqual(['156:1000:0', '331:0:1000']);
    expect(await moves(v.id)).toEqual([]);
    await post(v.id);
    expect(await moves(v.id)).toEqual([{ direction: 'in', quantity: '100.0000', transfer_id: null, code: 'SP1' }]);
    const g = (await call('GET', `/api/stock-vouchers/${v.id}`)).json();
    expect(g.items[0]).toMatchObject({ itemCode: 'SP1', amount: '1000', baseQuantity: '100.0000' });
    expect(g.ledgerLines[0]).toMatchObject({ itemCode: 'SP1', warehouseCode: 'K1' });
  });

  it('nhập 12 THUNG (1 = 24 CHAI): base 288, thành tiền theo số lượng nhập', async () => {
    const r = await stock('PNK', 'purchase', '2026-02-02', [{ itemCode: 'NUOC', uomCode: 'THUNG', quantity: '12', unitPrice: '1000' }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().items[0]).toMatchObject({ baseQuantity: '288.0000', amount: '12000' });
    await post(r.json().id);
    expect((await moves(r.json().id))[0]).toMatchObject({ direction: 'in', quantity: '288.0000' });
  });

  it('hàng theo lô thiếu lô → LOT_REQUIRED; hạn dùng trước ngày sản xuất → 400', async () => {
    const a = await stock('PNK', 'purchase', '2026-02-03', [{ itemCode: 'LO1', uomCode: 'CAI', quantity: '1', unitPrice: '5' }]);
    expect(a.statusCode).toBe(400); expect(a.json().error.code).toBe('LOT_REQUIRED');
    const b = await stock('PNK', 'purchase', '2026-02-03', [{ itemCode: 'LO1', uomCode: 'CAI', quantity: '1', unitPrice: '5', lotNo: 'L1', mfgDate: '2026-02-01', expiryDate: '2026-01-01' }]);
    expect(b.statusCode).toBe(400);
    const c = await stock('PNK', 'purchase', '2026-02-03', [{ itemCode: 'LO1', uomCode: 'CAI', quantity: '1', unitPrice: '5', lotNo: 'L1', expiryDate: '2027-01-01' }]);
    expect(c.statusCode, c.body).toBe(201);
  });

  it('xuất bán 60 sau khi tồn 100 giá 10: Nợ 632 / Có 156 600', async () => {
    const r = await stock('PXK', 'sale', '2026-02-10', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '60' }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(sums(r.json())).toEqual(['156:0:600', '632:600:0']);
    expect(r.json().warnings).toEqual([]);
    await post(r.json().id);
    expect(await moves(r.json().id)).toEqual([{ direction: 'out', quantity: '60.0000', transfer_id: null, code: 'SP1' }]);
    const onHand = await call('GET', '/api/inventory/on-hand?itemCode=SP1&warehouseCode=K1&date=2026-02-28');
    expect(onHand.json()).toMatchObject({ quantity: '40.0000' });
  });

  it('chuyển kho 156 → 157: Nợ 157 / Có 156; hai move cùng transfer_id', async () => {
    const r = await stock('CK', 'transfer', '2026-02-15', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '10' }], { destWarehouseCode: 'K157' });
    expect(r.statusCode, r.body).toBe(201);
    expect(sums(r.json())).toEqual(['156:0:100', '157:100:0']);
    await post(r.json().id);
    const m = await moves(r.json().id);
    expect(m.map((x) => x.direction).sort()).toEqual(['in', 'out']);
    expect(m[0]!.transfer_id).toBeTruthy(); expect(m[0]!.transfer_id).toBe(m[1]!.transfer_id);
  });

  it('TK đối ứng không có trong hệ thống tài khoản → ACCOUNT_NOT_FOUND 404', async () => {
    const r = await stock('PNK', 'purchase', '2026-02-20', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '1', unitPrice: '1', creditAccountCode: '9999' }]);
    expect(r.statusCode).toBe(404); expect(r.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('hàng dịch vụ trong phiếu kho không sinh stock_move', async () => {
    const r = await stock('PNK', 'purchase', '2026-02-21', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '5', unitPrice: '10' }, { itemCode: 'DV1', uomCode: 'GIO', quantity: '2', unitPrice: '100' }]);
    expect(r.statusCode, r.body).toBe(201);
    await post(r.json().id);
    expect((await moves(r.json().id)).map((m) => m.code)).toEqual(['SP1']);
  });

  it('thiếu quyền stock_voucher.create → 403; PNK qua /api/vouchers → VOUCHER_TYPE_USE_STOCK 409; thiếu view_cost → 403', async () => {
    const mk = async (flags: string[]) => {
      const username = `kho_${flags.length}_${Date.now()}`;
      expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
      return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    };
    const c = await mk([]);
    const body = { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-02-22', warehouseCode: 'K1', partyCode: 'NCC1', description: 'x', items: [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '1', unitPrice: '1' }] };
    expect((await call('POST', '/api/stock-vouchers', body, c)).statusCode).toBe(403);
    const generic = await call('POST', '/api/vouchers', { voucherType: 'PNK', postingDate: '2026-02-22', documentDate: '2026-02-22', description: 'x', lines: [{ accountCode: '156', debit: '1', credit: '0' }, { accountCode: '331', debit: '0', credit: '1' }] });
    expect(generic.statusCode).toBe(409); expect(generic.json().error.code).toBe('VOUCHER_TYPE_USE_STOCK');
    const made = (await stock('PNK', 'purchase', '2026-02-22', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '1', unitPrice: '1' }])).json();
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['stock_voucher.view', 'stock_voucher.create'] });
    expect((await call('GET', `/api/stock-vouchers/${made.id}`, undefined, c)).statusCode).toBe(403);
    expect((await call('POST', '/api/stock-vouchers', body, c)).statusCode).toBe(403);
  });

  it('phiếu toàn giá trị 0 → 409 STOCK_VALUE_ZERO; thành tiền quá 16 chữ số → 400 AMOUNT_TOO_LARGE', async () => {
    const z = await stock('PNK', 'purchase', '2026-03-01', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '1' }]);
    expect(z.statusCode).toBe(409); expect(z.json().error.code).toBe('STOCK_VALUE_ZERO');
    const big = await stock('PNK', 'purchase', '2026-03-01', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '9999999999', unitPrice: '9999999999' }]);
    expect(big.statusCode).toBe(400); expect(big.json().error.code).toBe('AMOUNT_TOO_LARGE');
  });

  it('phiếu xuất lẫn hàng có giá vốn và hàng chưa có: cảnh báo COST_UNKNOWN một dòng, ghi sổ vẫn sinh stock_move cho cả hai', async () => {
    await cat('item', { code: 'SP2', name: 'Hàng chưa có tồn', base_uom_code: 'CAI', kind: 'goods' });
    // SP2 nhập giá 0 (cùng phiếu với SP1 có giá) nên có tồn mà chưa có giá vốn
    const pn = (await stock('PNK', 'purchase', '2026-03-02', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '5', unitPrice: '10' }, { itemCode: 'SP2', uomCode: 'CAI', quantity: '5' }])).json(); await post(pn.id);
    const r = await stock('PXK', 'sale', '2026-03-02', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '1' }, { itemCode: 'SP2', uomCode: 'CAI', quantity: '1' }]);
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json();
    expect(v.warnings).toHaveLength(1); expect(v.warnings[0]).toMatchObject({ code: 'COST_UNKNOWN', lineNo: 2 });
    await post(v.id);
    expect((await moves(v.id)).map((m) => `${m.code}:${m.direction}`)).toEqual(['SP1:out', 'SP2:out']);
  });

  it('route chung: thiếu view_cost → GET phiếu kho 403 và tổng tiền danh sách là null; thiếu stock_voucher.post → ghi sổ chung 403; in phiếu kho cần stock_voucher.view', async () => {
    const made = (await stock('PXK', 'sale', '2026-03-03', [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '1' }])).json();
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['voucher.view', 'voucher.post', 'stock_voucher.view'] });
    const username = `kho_g_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await call('GET', `/api/vouchers/${made.id}`, undefined, c)).statusCode).toBe(403);
    expect((await call('GET', `/api/vouchers/${made.id}`)).statusCode).toBe(200);
    const list = (await call('GET', '/api/vouchers?type=PXK&from=2026-03-03&to=2026-03-03', undefined, c)).json().rows as { totalDebit: string | null }[];
    expect(list.length).toBeGreaterThan(0); expect(list.every((x) => x.totalDebit === null)).toBe(true);
    expect((await call('POST', `/api/vouchers/${made.id}/post`, {}, c)).statusCode).toBe(403);
    expect((await call('GET', `/api/vouchers/${made.id}/print`)).statusCode).toBe(200);
  });

  it('tồn khả dụng: mã kho hoặc hàng lạ → 404', async () => {
    expect((await call('GET', '/api/inventory/on-hand?itemCode=SP1&warehouseCode=KLA&date=2026-03-01')).json().error.code).toBe('WAREHOUSE_NOT_FOUND');
    expect((await call('GET', '/api/inventory/on-hand?itemCode=LA&warehouseCode=K1&date=2026-03-01')).json().error.code).toBe('ITEM_NOT_FOUND');
  });
});
