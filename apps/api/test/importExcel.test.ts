import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';
import { buildTemplate, parseWorkbook } from '../src/modules/master/importExcel.js';
import { catalogByName } from '../src/modules/master/catalogs.js';

let ctx: TestApp; let cookie: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `IM${Date.now()}` })); });
afterAll(async () => { await ctx.close(); });

type Cell = ExcelJS.CellValue;
async function loadTemplate(catalog: string) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await buildTemplate(catalogByName(catalog)!) as unknown as ArrayBuffer);
  return { wb, ws: wb.getWorksheet('Du_lieu')! };
}
const save = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
// Dòng 3 là dòng ví dụ (giữ nguyên); dữ liệu thêm vào từ dòng 4.
async function workbookWith(rows: Cell[][], catalog = 'party'): Promise<Buffer> {
  const { wb, ws } = await loadTemplate(catalog);
  for (const r of rows) ws.addRow(r);
  return save(wb);
}
function upload(name: string, buf: Buffer, mode: string, headers: Record<string, string> = { cookie }) {
  const fd = new FormData(); fd.append('file', buf, { filename: 'x.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}/import?mode=${mode}`, headers: { ...headers, ...fd.getHeaders() }, payload: fd.getBuffer() });
}
const count = async (name: string, q: string) => (await ctx.app.inject({ method: 'GET', url: `/api/catalogs/${name}?q=${q}`, headers: { cookie } })).json().total as number;
const party = (code: string, name = `Khách ${code}`, group: string | null = null): Cell[] => [code, name, true, false, false, group, null];

describe('nhập Excel', () => {
  it('mẫu tải về có nhãn cột tiếng Việt và sheet hướng dẫn', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party/template.xlsx', headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Du_lieu')!.getRow(1).getCell(2).value).toBe('Tên đối tượng (*)');
    expect(wb.getWorksheet('Huong_dan')).toBeTruthy();
  });

  it('cột chữ của mẫu định dạng văn bản (@) để giữ số 0 đầu; cột số thì không', async () => {
    const { ws } = await loadTemplate('party');
    expect(ws.getColumn(12).numFmt).toBe('@'); // phone
    expect(ws.getColumn(14).numFmt).not.toBe('@'); // payment_term_days
  });

  it('mẫu chưa nhập gì (dòng ví dụ còn nguyên) cho 0 dòng, không lỗi, ở mọi danh mục', async () => {
    for (const name of ['party', 'invoice_group', 'exchange_rate', 'party_bank_account']) {
      const buf = await buildTemplate(catalogByName(name)!);
      expect(await parseWorkbook(catalogByName(name)!, buf), name).toEqual({ rows: [], errors: [] });
      const v = await upload(name, buf, 'validate');
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json(), name).toMatchObject({ total: 0, inserted: 0, errors: [], errorCount: 0 });
    }
  });

  it('parseWorkbook báo lỗi đúng dòng và cột (dữ liệu từ dòng 4)', async () => {
    const buf = await workbookWith([['KH100', 'Công ty X', true, false, false, null, '0101234567'], ['', 'Thiếu mã', true, false, false, null, 'MST_SAI']]);
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, buf);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual(expect.arrayContaining([
      { row: 5, column: 'code', message: expect.any(String) }, { row: 5, column: 'tax_code', message: expect.any(String) }]));
  });

  it('ô rich text và liên kết email được đọc thành chuỗi, không thành "[object Object]"', async () => {
    const { wb, ws } = await loadTemplate('party');
    const row = ws.addRow(['KH200', { richText: [{ text: 'Công ty ' }, { text: 'Rich', font: { bold: true } }] }]);
    row.getCell(13).value = { text: 'ketoan@abc.vn', hyperlink: 'mailto:ketoan@abc.vn' };
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, await save(wb));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ code: 'KH200', name: 'Công ty Rich', email: 'ketoan@abc.vn' });
  });

  it('ánh xạ cột theo khóa ở dòng 2: đổi thứ tự cột vẫn đọc đúng', async () => {
    const { wb, ws } = await loadTemplate('party');
    for (const n of [1, 2, 3]) { const r = ws.getRow(n); const a = r.getCell(1).value; r.getCell(1).value = r.getCell(2).value; r.getCell(2).value = a; } // đổi cột 1 và 2
    ws.addRow(['Tên đứng trước', 'KH300']);
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, await save(wb));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ code: 'KH300', name: 'Tên đứng trước' });
  });

  it('file sai mẫu danh mục → 400 IMPORT_BAD_TEMPLATE; file không phải xlsx → 400 IMPORT_BAD_FILE', async () => {
    const wrong = await upload('department', await buildTemplate(catalogByName('party')!), 'validate');
    expect(wrong.statusCode).toBe(400); expect(wrong.json().error.code).toBe('IMPORT_BAD_TEMPLATE');
    const text = await upload('party', Buffer.from('đây không phải là file Excel'), 'validate');
    expect(text.statusCode).toBe(400); expect(text.json().error.code).toBe('IMPORT_BAD_FILE');
  });

  it('phân tích ô: ngày hỏng báo lỗi dòng (không 500), số ngày Excel, số kiểu Việt Nam, số mơ hồ, ô lỗi', async () => {
    const bad = await upload('exchange_rate', await workbookWith([['USD', 'abc', 'buy', '25000']], 'exchange_rate'), 'validate');
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json()).toMatchObject({ inserted: 0, errorCount: 1, errors: [{ row: 4, column: 'rate_date', message: 'Ngày không hợp lệ' }] });

    const d = new Date(Date.UTC(2026, 1, 3));
    const { rows, errors } = await parseWorkbook(catalogByName('exchange_rate')!, await workbookWith([
      ['USD', 46023, 'buy', '25.123,45'], ['USD', '31/01/2026', 'sell', 25400.5], ['USD', d, 'buy', 1000], ['USD', '30/02/2026', 'buy', '8.5'], ['USD', 1e15, 'buy', '1.5e3'],
    ], 'exchange_rate'));
    expect(rows).toMatchObject([{ rate_date: '2026-01-01', rate: '25123.45' }, { rate_date: '2026-01-31', rate: '25400.5' }, { rate_date: '2026-02-03', rate: '1000' }]);
    expect(errors).toEqual([
      { row: 7, column: 'rate_date', message: 'Ngày không hợp lệ' }, { row: 7, column: 'rate', message: 'Số không hợp lệ' },
      { row: 8, column: 'rate_date', message: 'Ngày không hợp lệ' }, { row: 8, column: 'rate', message: 'Số không hợp lệ' }]);

    const cells = await loadTemplate('party');
    cells.ws.addRow(['KH400', { error: '#N/A' }]);
    expect((await parseWorkbook(catalogByName('party')!, await save(cells.wb))).errors).toEqual([{ row: 4, column: 'name', message: 'Ô lỗi' }]);
  });

  it('cột chữ: ô số giữ số 0 đầu theo định dạng, ô chữ giữ nguyên số 0 đầu, ô số thường thành chuỗi', async () => {
    const { wb, ws } = await loadTemplate('party');
    const a = ws.addRow(party('KH500')); a.getCell(12).value = 912345678; a.getCell(12).numFmt = '0000000000';
    const b = ws.addRow(party('KH501')); b.getCell(12).value = '0912345678';
    const c = ws.addRow(party('KH502')); c.getCell(12).value = 912345678; c.getCell(14).value = '30';
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, await save(wb));
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.phone)).toEqual(['0912345678', '0912345678', '912345678']);
    expect(rows[2]).toMatchObject({ payment_term_days: 30 });
  });

  it('mode=validate không ghi; mode=commit ghi toàn bộ hoặc không gì; 500 dòng dưới 5 giây', async () => {
    const many = Array.from({ length: 500 }, (_, i) => [`KHX${String(i).padStart(4, '0')}`, `Khách hàng số ${i}`, true, false, false, null, null]);
    const v = await upload('party', await workbookWith(many), 'validate');
    expect(v.json()).toMatchObject({ total: 500, inserted: 0, errors: [] });
    expect(await count('party', 'KHX')).toBe(0);
    const t0 = Date.now();
    const c = await upload('party', await workbookWith(many), 'commit');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.json()).toMatchObject({ total: 500, inserted: 500 });
    expect(await count('party', 'KHX')).toBe(500);
    const bad = await upload('party', await workbookWith([party('KHY1', 'Đúng'), party('KHY1', 'Trùng mã trong file')]), 'commit');
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('IMPORT_ERRORS');
    expect(await count('party', 'KHY1')).toBe(0);
  });

  it('nhập lại file đã nhập → 409 IMPORT_ERRORS nêu từng dòng trùng mã trong hệ thống', async () => {
    const buf = await workbookWith([party('KHR1'), party('KHR2'), party('KHR3')]);
    expect((await upload('party', buf, 'commit')).statusCode).toBe(200);
    const again = await upload('party', buf, 'commit');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'IMPORT_ERRORS', details: [4, 5, 6].map((row) => ({ row, column: 'code', message: 'Mã đã tồn tại trong hệ thống' })) });
    const dry = await upload('party', buf, 'validate');
    expect(dry.json()).toMatchObject({ inserted: 0, errorCount: 3 });
  });

  it('dòng cha ở trên, dòng con tham chiếu cha trong cùng file → nhập được', async () => {
    const buf = await workbookWith([['PB_CHA', 'Phòng cha', null, true], ['PB_CON', 'Phòng con', 'PB_CHA', false]], 'department');
    const r = await upload('department', buf, 'commit');
    expect(r.json(), r.body).toMatchObject({ total: 2, inserted: 2, errors: [] });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/department?q=PB_CON', headers: { cookie } })).json().rows[0]).toMatchObject({ code: 'PB_CON', parent_code: 'PB_CHA' });
  });

  it('commit tra cứu mã nhóm; validate cũng báo mã nhóm sai và không ghi gì', async () => {
    const g = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party_group', headers: { cookie }, payload: { code: 'NHOM_IM', name: 'Nhóm nhập' } });
    expect(g.statusCode, g.body).toBe(201);
    const ok = await upload('party', await workbookWith([party('KHL1', 'Có nhóm', 'NHOM_IM')]), 'commit');
    expect(ok.json()).toMatchObject({ total: 1, inserted: 1, errors: [] });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHL1', headers: { cookie } })).json().rows[0]).toMatchObject({ code: 'KHL1', group_code: 'NHOM_IM' });
    const file = await workbookWith([party('KHL2', 'Đúng'), party('KHL3', 'Sai nhóm', 'KHONG_CO')]);
    const dry = await upload('party', file, 'validate');
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ total: 2, inserted: 0, errorCount: 1, errors: [{ row: 5, column: 'group_code', message: expect.stringContaining('KHONG_CO') }] });
    const bad = await upload('party', file, 'commit');
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toMatchObject({ code: 'IMPORT_ERRORS', details: [{ row: 5, column: 'group_code', message: expect.stringContaining('KHONG_CO') }] });
    expect(await count('party', 'KHL2')).toBe(0);
  });

  it('dòng cuối trùng mã có sẵn → 409 nêu đúng dòng và hoàn tác cả các dòng đã ghi trước đó', async () => {
    const pre = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KHZ9', name: 'Có sẵn' } });
    expect(pre.statusCode, pre.body).toBe(201);
    const rows = [...Array.from({ length: 449 }, (_, i) => party(`KHQ${String(i).padStart(4, '0')}`)), party('KHZ9', 'Trùng với hệ thống')];
    const r = await upload('party', await workbookWith(rows), 'commit');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'IMPORT_ERRORS', details: [{ row: 453, column: 'code', message: 'Mã đã tồn tại trong hệ thống' }] });
    expect(await count('party', 'KHZ')).toBe(1);
    expect(await count('party', 'KHQ')).toBe(0);
  });

  it('quá 20.000 dòng → 400 IMPORT_TOO_LARGE; báo lỗi tối đa 500 dòng kèm errorCount', async () => {
    const { wb, ws } = await loadTemplate('party');
    ws.getCell('A20005').numFmt = '@';
    const big = await upload('party', await save(wb), 'validate');
    expect(big.statusCode).toBe(400); expect(big.json().error.code).toBe('IMPORT_TOO_LARGE');
    const r = await upload('party', await workbookWith(Array.from({ length: 600 }, (_, i) => [`CAP${i}`, null])), 'validate');
    expect(r.statusCode).toBe(200);
    expect(r.json().errors).toHaveLength(500); expect(r.json().errorCount).toBe(600);
  });

  it('người chỉ xem tải được mẫu nhưng nhập bị 403', async () => {
    const admin = await bootstrapTenant(ctx, { code: `IX${Date.now()}` });
    const username = `xem_im_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie }, payload: { username, fullName: 'Xem', password: TEST_PASSWORD, roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party/template.xlsx', headers })).statusCode).toBe(200);
    for (const mode of ['validate', 'commit']) {
      const r = await upload('party', await workbookWith([party('KHW1', 'Không quyền')]), mode, headers);
      expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('FORBIDDEN');
    }
  });
});
