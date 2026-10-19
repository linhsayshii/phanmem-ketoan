import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';
import { buildTemplate, parseWorkbook } from '../src/modules/master/importExcel.js';
import { catalogByName } from '../src/modules/master/catalogs.js';

let ctx: TestApp; let cookie: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `IM${Date.now()}` })); });
afterAll(async () => { await ctx.close(); });

async function workbookWith(rows: (string | number | boolean | null)[][]): Promise<Buffer> {
  const tpl = await buildTemplate(catalogByName('party')!);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Du_lieu')!;
  ws.spliceRows(3, 1);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function upload(name: string, buf: Buffer, mode: string, headers: Record<string, string> = { cookie }) {
  const fd = new FormData(); fd.append('file', buf, { filename: 'x.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}/import?mode=${mode}`, headers: { ...headers, ...fd.getHeaders() }, payload: fd.getBuffer() });
}

describe('nhập Excel', () => {
  it('mẫu tải về có nhãn cột tiếng Việt và sheet hướng dẫn', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party/template.xlsx', headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Du_lieu')!.getRow(1).getCell(2).value).toBe('Tên đối tượng (*)');
    expect(wb.getWorksheet('Huong_dan')).toBeTruthy();
  });

  it('parseWorkbook báo lỗi đúng dòng và cột', async () => {
    const buf = await workbookWith([['KH100', 'Công ty X', true, false, false, null, '0101234567'], ['', 'Thiếu mã', true, false, false, null, 'MST_SAI']]);
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, buf);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual(expect.arrayContaining([
      { row: 4, column: 'code', message: expect.any(String) }, { row: 4, column: 'tax_code', message: expect.any(String) }]));
  });

  it('ô rich text và liên kết email được đọc thành chuỗi, không thành "[object Object]"', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await buildTemplate(catalogByName('party')!) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Du_lieu')!; ws.spliceRows(3, 1);
    const row = ws.addRow(['KH200', { richText: [{ text: 'Công ty ' }, { text: 'Rich', font: { bold: true } }] }]);
    row.getCell(13).value = { text: 'ketoan@abc.vn', hyperlink: 'mailto:ketoan@abc.vn' };
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, Buffer.from(await wb.xlsx.writeBuffer()));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ code: 'KH200', name: 'Công ty Rich', email: 'ketoan@abc.vn' });
  });

  it('mode=validate không ghi; mode=commit ghi toàn bộ hoặc không gì; 500 dòng dưới 5 giây', async () => {
    const many = Array.from({ length: 500 }, (_, i) => [`KHX${String(i).padStart(4, '0')}`, `Khách hàng số ${i}`, true, false, false, null, null]);
    const v = await upload('party', await workbookWith(many), 'validate');
    expect(v.json()).toMatchObject({ total: 500, inserted: 0, errors: [] });
    let list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHX', headers: { cookie } });
    expect(list.json().total).toBe(0);
    const t0 = Date.now();
    const c = await upload('party', await workbookWith(many), 'commit');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.json()).toMatchObject({ total: 500, inserted: 500 });
    list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHX', headers: { cookie } });
    expect(list.json().total).toBe(500);
    const bad = await upload('party', await workbookWith([['KHY1', 'Đúng', true, false, false, null, null], ['KHY1', 'Trùng mã trong file', true, false, false, null, null]]), 'commit');
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('IMPORT_ERRORS');
    list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHY1', headers: { cookie } });
    expect(list.json().total).toBe(0);
  });

  it('commit tra cứu mã nhóm; mã nhóm sai thì không ghi gì và báo đúng dòng, cột', async () => {
    const g = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party_group', headers: { cookie }, payload: { code: 'NHOM_IM', name: 'Nhóm nhập' } });
    expect(g.statusCode, g.body).toBe(201);
    const ok = await upload('party', await workbookWith([['KHZ1', 'Có nhóm', true, false, false, 'NHOM_IM', null]]), 'commit');
    expect(ok.json()).toMatchObject({ total: 1, inserted: 1, errors: [] });
    const one = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHZ1', headers: { cookie } });
    expect(one.json().rows[0]).toMatchObject({ code: 'KHZ1', group_code: 'NHOM_IM' });
    const bad = await upload('party', await workbookWith([['KHZ2', 'Đúng', true, false, false, null, null], ['KHZ3', 'Sai nhóm', true, false, false, 'KHONG_CO', null]]), 'commit');
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toMatchObject({ code: 'IMPORT_ERRORS', details: [{ row: 4, column: 'group_code', message: expect.stringContaining('KHONG_CO') }] });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHZ2', headers: { cookie } })).json().total).toBe(0);
  });

  it('người chỉ xem tải được mẫu nhưng nhập bị 403', async () => {
    const admin = await bootstrapTenant(ctx, { code: `IX${Date.now()}` });
    const username = `xem_im_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie }, payload: { username, fullName: 'Xem', password: TEST_PASSWORD, roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party/template.xlsx', headers })).statusCode).toBe(200);
    for (const mode of ['validate', 'commit']) {
      const r = await upload('party', await workbookWith([['KHW1', 'Không quyền', true, false, false, null, null]]), mode, headers);
      expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('FORBIDDEN');
    }
  });
});
