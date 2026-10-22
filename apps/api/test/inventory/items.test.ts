import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { buildTemplate } from '../../src/modules/master/importExcel.js';
import { catalogByName } from '../../src/modules/master/catalogs.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `VT${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  for (const [code, name] of [['THUNG', 'Thùng'], ['HOP', 'Hộp']]) await call('POST', 'uom', { code, name });
});
afterAll(async () => { await ctx.close(); });

const call = (method: 'POST' | 'PUT' | 'GET' | 'DELETE', name: string, payload?: object, id = '') => ctx.app.inject({ method, url: `/api/catalogs/${name}${id ? '/' + id : ''}`, headers: { cookie }, ...(payload && { payload }) });
const uoms = async (id: string) => (await ctx.app.inject({ method: 'GET', url: `/api/items/${id}/uoms`, headers: { cookie } })).json() as { uomCode: string; factor: string; isBase: boolean }[];
async function newItem(code: string, extra: object = {}) {
  const r = await call('POST', 'item', { code, name: `Hàng ${code}`, base_uom_code: 'CAI', ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
// Gắn hàng vào một dòng chứng từ nháp (dòng chứng từ chưa có API ghi hàng/kho; Task 5 thêm stock_move).
async function useItem(id: string) {
  const v = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Dùng hàng',
    lines: [{ accountCode: '1111', debit: '100', credit: '0' }, { accountCode: '5113', debit: '0', credit: '100' }] } });
  expect(v.statusCode, v.body).toBe(201);
  await sql`UPDATE voucher_line SET item_id = ${id}::bigint WHERE voucher_id = ${v.json().id}::uuid AND line_no = 1`.execute(ctx.t.admin);
}

describe('danh mục VTHH', () => {
  it('tạo hàng tự sinh ĐVT cơ sở factor 1; thêm THUNG factor 24', async () => {
    const id = await newItem('SP1', { kind: 'goods', default_tax_code: 'V10' });
    expect(await uoms(id)).toEqual([expect.objectContaining({ uomCode: 'CAI', factor: '1.000000', isBase: true })]);
    expect((await call('POST', 'item_uom', { item_code: 'SP1', uom_code: 'THUNG', factor: '24' })).statusCode).toBe(201);
    expect(await uoms(id)).toEqual([expect.objectContaining({ uomCode: 'CAI', isBase: true }), expect.objectContaining({ uomCode: 'THUNG', factor: '24.000000', isBase: false })]);
    const del = await call('DELETE', 'item_uom', undefined, String((await ctx.t.admin.selectFrom('item_uom' as never).select('id' as never).where('item_id' as never, '=', id as never).where('factor' as never, '=', '1' as never).executeTakeFirstOrThrow() as { id: number }).id));
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('ITEM_UOM_BASE');
    const look = await ctx.app.inject({ method: 'GET', url: '/api/lookups/items?q=sp1', headers: { cookie } });
    expect(look.json()).toEqual([{ id: Number(id), code: 'SP1', name: 'Hàng SP1', baseUom: 'CAI', defaultTaxCode: 'V10', tracking: 'none' }]);
  });

  it('tra cứu TK kho theo mã; mã TK sai báo cột', async () => {
    const id = await newItem('SP2', { inventory_account_code: '156', cogs_account_code: '632' });
    expect((await call('GET', 'item', undefined, id)).json()).toMatchObject({ inventory_account_code: '156', cogs_account_code: '632', item_group_code: null, base_uom_code: 'CAI' });
    const bad = await call('POST', 'item', { code: 'SP2X', name: 'x', base_uom_code: 'CAI', inventory_account_code: '9999' });
    expect(bad.statusCode).toBe(404); expect(bad.json().error.message).toContain('inventory_account_code');
  });

  it('sửa ĐVT cơ sở khi đã dùng → ITEM_UOM_LOCKED; đổi theo dõi lô → ITEM_TRACKING_LOCKED; xóa → ITEM_IN_USE; ngưng dùng được', async () => {
    const id = await newItem('SP3');
    expect((await call('PUT', 'item', { tracking: 'lot' }, id)).statusCode).toBe(200); // chưa dùng: đổi được
    await useItem(id);
    const uom = await call('PUT', 'item', { base_uom_code: 'BO' }, id);
    expect(uom.statusCode).toBe(409); expect(uom.json().error.code).toBe('ITEM_UOM_LOCKED');
    const trk = await call('PUT', 'item', { tracking: 'none' }, id);
    expect(trk.statusCode).toBe(409); expect(trk.json().error.code).toBe('ITEM_TRACKING_LOCKED');
    const del = await call('DELETE', 'item', undefined, id);
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('ITEM_IN_USE');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/catalogs/item/${id}/deactivate`, headers: { cookie }, payload: {} })).statusCode).toBe(200);
  });

  it('dòng chứng từ không tham chiếu được hàng của công ty khác (khóa ngoại tổng hợp)', async () => {
    const other = await bootstrapTenant(ctx, { code: `VU${Date.now()}` });
    const o = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/item', headers: { cookie: other.cookie }, payload: { code: 'KHAC', name: 'Hàng công ty khác', base_uom_code: 'CAI' } });
    expect(o.statusCode, o.body).toBe(201);
    const v = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'x',
      lines: [{ accountCode: '1111', debit: '100', credit: '0' }, { accountCode: '5113', debit: '0', credit: '100' }] } });
    await expect(sql`UPDATE voucher_line SET item_id = ${o.json().id}::bigint WHERE voucher_id = ${v.json().id}::uuid AND line_no = 1`.execute(ctx.t.admin)).rejects.toThrow(/foreign key/);
    expect(tenantId).not.toBe(other.tenantId);
  });

  it('quyền riêng: người chỉ có catalog.* không sửa được hàng', async () => {
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie } })).json() as { id: string; code: string }[];
    await ctx.app.inject({ method: 'PUT', url: `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, headers: { cookie }, payload: { permissions: ['catalog.view', 'catalog.create'] } });
    const username = `qh_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'Thử', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'POST', url: '/api/catalogs/item', headers: { cookie: c }, payload: { code: 'Q', name: 'q', base_uom_code: 'CAI' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party_group', headers: { cookie: c }, payload: { code: 'Q', name: 'q' } })).statusCode).toBe(201);
  });

  it('kho: loại kho gửi bán, phương pháp tính giá, tra cứu TK kho', async () => {
    const r = await call('POST', 'warehouse', { code: 'K157', name: 'Kho gửi bán', kind: 'consignment_out', inventory_account_code: '157', costing_method: 'fifo' });
    expect(r.statusCode, r.body).toBe(201);
    expect((await call('GET', 'warehouse', undefined, r.json().id)).json()).toMatchObject({ kind: 'consignment_out', inventory_account_code: '157', costing_method: 'fifo' });
    expect((await call('POST', 'warehouse', { code: 'KX', name: 'x', kind: 'khac' })).statusCode).toBe(400);
  });

  it('nhóm hàng dạng cây', async () => {
    await call('POST', 'item_group', { code: 'G1', name: 'Nhóm 1' });
    const c = await call('POST', 'item_group', { code: 'G11', name: 'Nhóm con', parent_code: 'G1' });
    expect((await call('GET', 'item_group', undefined, c.json().id)).json()).toMatchObject({ parent_code: 'G1' });
  });

  it('nhập Excel: ĐVT quy đổi THUNG=24;HOP=6 ghi đủ; dòng sai báo "Dòng N, cột ĐVT quy đổi"', async () => {
    const mk = async (rows: unknown[][]) => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await buildTemplate(catalogByName('item')!) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Du_lieu')!; for (const r of rows) ws.addRow(r);
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const keys = catalogByName('item')!.columns.map((c) => c.key);
    const row = (code: string, conv: string | null) => keys.map((k) => (k === 'code' ? code : k === 'name' ? `Hàng ${code}` : k === 'base_uom_code' ? 'CAI' : k === 'uom_conversions' ? conv : null));
    const up = (buf: Buffer, mode: string) => { const fd = new FormData(); fd.append('file', buf, { filename: 'x.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); return ctx.app.inject({ method: 'POST', url: `/api/catalogs/item/import?mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() }); };
    const bad = await up(await mk([row('X1', 'THUNG=24'), row('X2', null), row('X3', 'THUNG=24;LAM=6')]), 'commit');
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.details).toEqual([{ row: 6, column: 'uom_conversions', message: expect.stringMatching(/^Dòng 6, cột ĐVT quy đổi: ĐVT "LAM"/) }]);
    expect((await call('GET', 'item?q=X1')).json().total).toBe(0);
    const ok = await up(await mk([row('X1', 'THUNG=24;HOP=6'), row('X2', null)]), 'commit');
    expect(ok.json()).toMatchObject({ inserted: 2, errors: [] });
    const id = (await call('GET', 'item?q=X1')).json().rows[0].id as string;
    expect((await uoms(id)).map((u) => `${u.uomCode}=${Number(u.factor)}`)).toEqual(['CAI=1', 'HOP=6', 'THUNG=24']);
  });
});
