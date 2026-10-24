import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

// GĐ6 Task 5b (D3): đối tượng tập hợp chi phí, chiều cost_object_id trên dòng chứng từ, dòng TK 154 không có vật tư.
let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `DT${Date.now()}` }));
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  for (const [name, body] of [['project', { code: 'VV1', name: 'Công trình 1' }], ['item', { code: 'TP1', name: 'Thành phẩm 1', base_uom_code: 'CAI', kind: 'finished' }],
    ['item', { code: 'HH1', name: 'Hàng 1', base_uom_code: 'CAI', kind: 'goods' }]] as const)
    expect((await call('POST', `/api/catalogs/${name}`, body)).statusCode).toBe(201);
}, 60_000);
afterAll(async () => { await ctx.close(); });

const pkt = (lines: object[]) => ({ voucherType: 'PKT', postingDate: '2026-01-10', documentDate: '2026-01-10', description: 'Chi phí sản xuất', lines });
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
const create = async (lines: object[], autoPost = true) => call('POST', '/api/vouchers', { ...pkt(lines), autoPost });
type Obj = { id: number; code: string; kind: string; itemCode: string | null; projectCode: string | null; method: string | null; unit: string | null; isActive: boolean };

describe('đối tượng tập hợp chi phí', () => {
  it('thêm, xem, sửa, tra F4; đúng một tham chiếu theo loại; mã trùng 409', async () => {
    const sp = await call('POST', '/api/costing/objects', { code: 'DT-SP', name: 'Sản phẩm TP1', kind: 'product', itemCode: 'TP1', method: 'simple', unit: 'cái' });
    expect(sp.statusCode, sp.body).toBe(201);
    expect(sp.json()).toMatchObject({ code: 'DT-SP', kind: 'product', itemCode: 'TP1', projectCode: null, method: 'simple', unit: 'cái', isActive: true });
    expect((await call('POST', '/api/costing/objects', { code: 'DT-VV', name: 'Công trình 1', kind: 'project', projectCode: 'VV1' })).statusCode).toBe(201);
    // thiếu tham chiếu, thừa tham chiếu, sai mã
    expect((await call('POST', '/api/costing/objects', { code: 'X1', name: 'x', kind: 'product' })).json().error.code).toBe('VALIDATION');
    expect((await call('POST', '/api/costing/objects', { code: 'X2', name: 'x', kind: 'project', projectCode: 'VV1', itemCode: 'TP1' })).json().error.code).toBe('VALIDATION');
    const bad = await call('POST', '/api/costing/objects', { code: 'X3', name: 'x', kind: 'product', itemCode: 'KHONGCO' });
    expect(bad.statusCode).toBe(404); expect(bad.json().error.code).toBe('LOOKUP_NOT_FOUND');
    const dup = await call('POST', '/api/costing/objects', { code: 'DT-SP', name: 'trùng', kind: 'product', itemCode: 'TP1' });
    expect(dup.statusCode).toBe(409); expect(dup.json().error.code).toBe('DUPLICATE');

    const id = (sp.json() as Obj).id;
    const put = await call('PUT', `/api/costing/objects/${id}`, { code: 'DT-SP', name: 'Sản phẩm TP1 (sửa)', kind: 'product', itemCode: 'TP1', method: 'coefficient', unit: null, isActive: true });
    expect(put.statusCode, put.body).toBe(200); expect(put.json()).toMatchObject({ name: 'Sản phẩm TP1 (sửa)', method: 'coefficient', unit: null });
    expect((await call('GET', `/api/costing/objects/${id}`)).json()).toMatchObject({ code: 'DT-SP', itemCode: 'TP1' });
    expect((await call('GET', '/api/costing/objects/999999999')).statusCode).toBe(404);
    const list = (await call('GET', '/api/costing/objects?q=DT-')).json() as { rows: Obj[]; total: number };
    expect(list.rows.map((r) => r.code)).toEqual(['DT-SP', 'DT-VV']); expect(list.total).toBe(2);
    expect(((await call('GET', '/api/costing/objects?kind=project')).json() as { rows: Obj[] }).rows.map((r) => r.code)).toEqual(['DT-VV']);
    const f4 = (await call('GET', '/api/lookups/cost-objects?q=vv')).json() as { code: string; name: string }[];
    expect(f4.map((r) => r.code)).toEqual(['DT-VV']);
  });

  it('quyền costing_obj.*: chỉ xem thì không thêm được (403)', async () => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['costing_obj.view'] })).statusCode).toBe(200);
    const username = `dtxem_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem' })).statusCode).toBe(201);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${r.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await call('GET', '/api/costing/objects', undefined, c)).statusCode).toBe(200);
    expect((await call('POST', '/api/costing/objects', { code: 'Y1', name: 'y', kind: 'project', projectCode: 'VV1' }, c)).statusCode).toBe(403);
  });

  it('dòng 154 chỉ có đối tượng tập hợp chi phí (hoặc vụ việc) ghi sổ được; 154 trống, 155, 156 thiếu vật tư vẫn bị chặn', async () => {
    const ok = await create([L('154', '1000', '0', { costObjectCode: 'DT-SP' }), L('1111', '0', '1000')]);
    expect(ok.statusCode, ok.body).toBe(201); expect(ok.json()).toMatchObject({ state: 'posted' });
    expect(ok.json().lines[0]).toMatchObject({ accountCode: '154', costObjectCode: 'DT-SP' });
    expect((await create([L('154', '500', '0', { projectCode: 'VV1' }), L('1111', '0', '500')])).statusCode).toBe(201);
    for (const lines of [[L('154', '10', '0'), L('1111', '0', '10')], [L('155', '10', '0', { costObjectCode: 'DT-SP' }), L('1111', '0', '10')],
      [L('156', '10', '0', { projectCode: 'VV1' }), L('1111', '0', '10')]]) {
      const r = await create(lines); expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('LINE_ITEM_REQUIRED');
    }
    // dòng có vật tư vẫn như cũ
    expect((await create([L('156', '10', '0', { itemCode: 'HH1' }), L('1111', '0', '10')], false)).statusCode).toBe(201);
  });

  it('sau ghi sổ: đổi đối tượng tại chỗ (không vào chuỗi băm), không bỏ trống được cả đối tượng lẫn vụ việc; đảo và nhân bản mang theo đối tượng', async () => {
    const v = (await create([L('154', '2000', '0', { costObjectCode: 'DT-SP' }), L('1111', '0', '2000')])).json() as { id: string; version: number };
    const canon = async () => (await sql<{ c: string }>`SELECT fn_voucher_canonical(${v.id}::uuid) AS c`.execute(ctx.t.admin)).rows[0]!.c;
    const before = await canon();
    const meta = await call('PUT', `/api/vouchers/${v.id}`, { version: v.version, lines: [{ lineNo: 1, costObjectCode: 'DT-VV' }] });
    expect(meta.statusCode, meta.body).toBe(200); expect(meta.json().lines[0]).toMatchObject({ costObjectCode: 'DT-VV' });
    expect(await canon()).toBe(before);
    const clear = await call('PUT', `/api/vouchers/${v.id}`, { version: meta.json().version, lines: [{ lineNo: 1, costObjectCode: null }] });
    expect(clear.statusCode).toBe(409); expect(clear.json().error.code).toBe('LINE_ITEM_REQUIRED');
    // đổi sang vụ việc cùng lúc bỏ đối tượng thì được
    expect((await call('PUT', `/api/vouchers/${v.id}`, { version: meta.json().version, lines: [{ lineNo: 1, costObjectCode: null, projectCode: 'VV1' }] })).statusCode).toBe(200);
    const audit = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'voucher_line' AND before ->> 'cost_object_id' IS NOT NULL`.execute(ctx.t.admin);
    expect(audit.rows[0]!.n).toBeGreaterThan(0);

    const w = (await create([L('154', '300', '0', { costObjectCode: 'DT-SP' }), L('1111', '0', '300')])).json() as { id: string };
    const rev = await call('POST', `/api/vouchers/${w.id}/reverse`, { postingDate: '2026-01-20' });
    expect(rev.statusCode, rev.body).toBe(201); expect(rev.json().lines[0]).toMatchObject({ accountCode: '154', credit: '300', costObjectCode: 'DT-SP' });
    const dup = await call('POST', `/api/vouchers/${w.id}/duplicate`, { postingDate: '2026-01-21' });
    expect(dup.statusCode, dup.body).toBe(201); expect(dup.json().lines[0]).toMatchObject({ costObjectCode: 'DT-SP' });
  });

  it('xóa đối tượng đã dùng trên sổ cái bị chặn 409; chưa dùng thì xóa được', async () => {
    const used = ((await call('GET', '/api/costing/objects?q=DT-SP')).json() as { rows: Obj[] }).rows[0]!;
    const del = await call('DELETE', `/api/costing/objects/${used.id}`);
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('REFERENCED');
    const fresh = (await call('POST', '/api/costing/objects', { code: 'DT-XOA', name: 'Xóa', kind: 'project', projectCode: 'VV1' })).json() as Obj;
    expect((await call('DELETE', `/api/costing/objects/${fresh.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/costing/objects/${fresh.id}`)).statusCode).toBe(404);
  });
});
