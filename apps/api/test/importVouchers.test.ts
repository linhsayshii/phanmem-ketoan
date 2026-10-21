import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { sql } from 'kysely';
import { createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';
import { buildVoucherTemplate, type Kind } from '../src/modules/tools/importVouchers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Row = Record<string, string | number | null>;
// Mỗi kiểm thử một công ty riêng: năm 2026 TT133, đối tượng KH001, KH002, NCC001, tài khoản ngân hàng 9990001 (TK 1121).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `NC${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  await call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' });
  const ba = await call('POST', '/api/catalogs/bank_account', { account_no: '9990001', bank_code: 'VCB', currency_code: 'VND', gl_account_code: '1121' });
  if (ba.statusCode !== 201) throw new Error(`tạo tài khoản ngân hàng thất bại: ${ba.body}`);
  // Tệp: mẫu thật của hệ thống, dữ liệu từ dòng 4, ô đặt theo khóa ở dòng 2 (nên thứ tự cột do `order` quyết định).
  async function book(kind: Kind, rows: Row[], order?: (keys: string[]) => string[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await buildVoucherTemplate(kind) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Du_lieu')!;
    const keys = (ws.getRow(2).values as (string | undefined)[]).slice(1).map(String);
    const ord = order ? order(keys) : keys;
    if (order) ord.forEach((k, i) => { ws.getRow(2).getCell(i + 1).value = k; ws.getRow(1).getCell(i + 1).value = k; });
    for (const r of rows) ws.addRow(ord.map((k) => r[k] ?? null));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const upload = (kind: string, buf: Buffer, mode: string, extra = '', c = cookie) => {
    const fd = new FormData(); fd.append('file', buf, { filename: 'x.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return ctx.app.inject({ method: 'POST', url: `/api/import/vouchers/${kind}?mode=${mode}${extra}`, headers: { cookie: c, ...fd.getHeaders() }, payload: fd.getBuffer() });
  };
  const imported = async () => Number((await sql<{ c: string }>`SELECT count(*) AS c FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key LIKE 'import:%'`.execute(ctx.t.admin)).rows[0]!.c);
  const states = async () => (await sql<{ voucher_type: string; state: string }>`SELECT voucher_type, state FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key LIKE 'import:%' ORDER BY voucher_type, created_at`.execute(ctx.t.admin)).rows.map((r) => `${r.voucher_type}:${r.state}`);
  return { cookie, tenantId, call, book, upload, imported, states };
}

const pt = (group: string, o: Row = {}): Row => ({ group, type: 'PT', postingDate: '2026-03-10', debitAccount: '1111', creditAccount: '131', partyCode: 'KH001', amount: '1000000', description: 'Thu tiền', ...o });
const bk = (group: string | null, o: Row = {}): Row => ({ group, postingDate: '2026-03-10', serial: 'C26TAA', invoiceNo: '0000001', invoiceDate: '2026-03-10', partyCode: 'NCC001', accountCode: '6422', counterAccountCode: '331', amount: '10000000', taxCode: 'V10', taxAmount: '1000000', invoiceGroupCode: '01', ...o });

describe('mẫu và quyền', () => {
  it('tải mẫu rồi nhập nguyên trạng (không có dòng dữ liệu) → 400 IMPORT_EMPTY ở cả hai chế độ, không phải 500', async () => {
    const t = await tenant();
    for (const kind of ['thu-chi', 'bang-ke-mua', 'bang-ke-ban']) {
      const tpl = Buffer.from((await t.call('GET', `/api/import/vouchers/${kind}/template.xlsx`)).rawPayload);
      for (const mode of ['validate', 'commit']) {
        const r = await t.upload(kind, tpl, mode);
        expect(r.statusCode, r.body).toBe(400); expect(r.json().error).toMatchObject({ code: 'IMPORT_EMPTY', message: 'Tệp không có dòng dữ liệu' });
      }
    }
  });

  it('mẫu có nhãn tiếng Việt, dòng khóa ẩn và sheet hướng dẫn; mọi loại tải được; loại lạ 404; người chỉ xem bị 403', async () => {
    const t = await tenant();
    for (const kind of ['thu-chi', 'bang-ke-mua', 'bang-ke-ban']) {
      const r = await t.call('GET', `/api/import/vouchers/${kind}/template.xlsx`);
      expect(r.statusCode, kind).toBe(200); expect(r.headers['content-type']).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
      expect(wb.getWorksheet('Du_lieu')!.getRow(2).hidden).toBe(true); expect(wb.getWorksheet('Huong_dan')).toBeTruthy();
    }
    expect((await t.call('GET', '/api/import/vouchers/khac/template.xlsx')).statusCode).toBe(404);
    const username = `xem_nc_${Date.now()}`;
    await t.call('POST', '/api/users', { username, fullName: 'Xem', password: TEST_PASSWORD, roleCode: 'xem' });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const xem = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await t.call('GET', '/api/import/vouchers/thu-chi/template.xlsx', undefined, xem)).statusCode).toBe(403);
    expect((await t.upload('thu-chi', await t.book('thu-chi', [pt('A')]), 'commit', '', xem)).statusCode).toBe(403);
  });
});

describe('nhập phiếu thu chi', () => {
  it('kiểm tra không ghi gì; nhập thật tạo nháp, nhóm nhiều dòng thành một chứng từ; BC lấy tài khoản ngân hàng', async () => {
    const t = await tenant();
    const file = await t.book('thu-chi', [
      pt('A'), pt('A', { debitAccount: '1111', creditAccount: '131', amount: '500000' }), pt('B', { type: 'PC', debitAccount: '331', creditAccount: '1111', partyCode: 'NCC001' }),
      pt('C', { type: 'BC', debitAccount: '1121', bankAccountNo: '9990001', amount: '2500000' }),
    ]);
    const dry = await t.upload('thu-chi', file, 'validate');
    expect(dry.json(), dry.body).toMatchObject({ total: 3, rows: 4, created: 3, errors: [], errorCount: 0 });
    expect(await t.imported()).toBe(0);
    const ok = await t.upload('thu-chi', file, 'commit');
    expect(ok.json(), ok.body).toMatchObject({ total: 3, created: 3, existing: 0, posted: 0, errors: [] });
    expect(await t.states()).toEqual(['BC:draft', 'PC:draft', 'PT:draft']);
    const lines = (await sql<{ c: string }>`SELECT count(*) AS c FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${t.tenantId}::uuid AND v.voucher_type = 'PT'`.execute(ctx.t.admin)).rows[0]!.c;
    expect(Number(lines)).toBe(4); // nhóm A: hai bút toán Nợ/Có = bốn dòng sổ
  });

  it('ghi sổ ngay (autoPost) và cần quyền voucher.post; số tiền ghi sổ đúng', async () => {
    const t = await tenant();
    const r = await t.upload('thu-chi', await t.book('thu-chi', [pt('A'), pt('B', { type: 'PC', debitAccount: '331', creditAccount: '1111', partyCode: 'NCC001', amount: '300000' })]), 'commit', '&autoPost=true');
    expect(r.json(), r.body).toMatchObject({ created: 2, posted: 2, errors: [] });
    expect(await t.states()).toEqual(['PC:posted', 'PT:posted']);
    const cash = (await sql<{ net: string }>`SELECT sum(l.debit - l.credit)::text AS net FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.tenant_id = ${t.tenantId}::uuid AND a.code = '1111' AND v.state = 'posted'`.execute(ctx.t.admin)).rows[0]!.net;
    expect(cash).toBe('700000');
  });

  it('ngoại tệ: nguyên tệ có dấu theo Nợ/Có, thiếu tỷ giá báo đúng ô', async () => {
    const t = await tenant();
    const usd = pt('U', { debitAccount: '1112', currency: 'USD', fxRate: '25400', amountCurrency: '1000', amount: '25400000' });
    expect((await t.upload('thu-chi', await t.book('thu-chi', [usd]), 'commit', '&autoPost=true')).json()).toMatchObject({ created: 1, posted: 1, errors: [] });
    const bad = await t.upload('thu-chi', await t.book('thu-chi', [{ ...usd, group: 'V', fxRate: null }]), 'validate');
    expect(bad.json().errors).toMatchObject([{ row: 4, column: 'fxRate', columnLabel: 'Tỷ giá', message: expect.stringContaining('tỷ giá') }]);
  });

  it('ngoại tệ: số tiền VND lệch quá 1 đồng so với nguyên tệ x tỷ giá là lỗi ở cột amount; bỏ trống thì tự tính; nguyên tệ 0 là lỗi', async () => {
    const t = await tenant();
    const usd = pt('U', { debitAccount: '1112', currency: 'USD', fxRate: 25400.5, amountCurrency: 1000, amount: 25400500 });
    const r = await t.upload('thu-chi', await t.book('thu-chi', [
      usd, { ...usd, group: 'V', amount: 1 }, { ...usd, group: 'W', amount: 25400501 }, { ...usd, group: 'X', amount: 25400502 }, { ...usd, group: 'Y', amount: null }, { ...usd, group: 'Z', amountCurrency: 0, amount: null },
      pt('K', { fxRate: 25000 }),
    ]), 'validate');
    const by = Object.fromEntries((r.json().errors as { row: number; column: string; message: string }[]).map((e) => [e.row, e]));
    expect(Object.keys(by)).toEqual(['5', '7', '9', '10']); // dòng 4 đúng, 6 lệch đúng 1 đồng (cho phép), 8 để trống (tự tính)
    expect(by[5]).toMatchObject({ column: 'amount', message: expect.stringContaining('25400500') });
    expect(by[7]).toMatchObject({ column: 'amount', message: expect.stringContaining('lệch') });
    expect(by[9]).toMatchObject({ column: 'amountCurrency' });
    expect(by[10]).toMatchObject({ column: 'currency', message: expect.stringContaining('VND') });
    // sạch lỗi: số tiền để trống lấy theo nguyên tệ x tỷ giá làm tròn nửa lên
    const ok = await t.upload('thu-chi', await t.book('thu-chi', [{ ...usd, amount: null }]), 'commit');
    expect(ok.json()).toMatchObject({ created: 1, errors: [] });
    const dr = (await sql<{ d: string }>`SELECT l.debit::text AS d FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${t.tenantId}::uuid AND l.debit > 0`.execute(ctx.t.admin)).rows;
    expect(dr).toEqual([{ d: '25400500' }]);
  });

  it('ánh xạ cột theo dòng khóa: đổi thứ tự cột vẫn nhập đúng; thiếu cột khóa bắt buộc → 400 IMPORT_COLUMN_MISSING', async () => {
    const t = await tenant();
    const rows = [pt('A'), pt('B', { creditAccount: '5113', debitAccount: '1111', partyCode: null })];
    const rev = await t.upload('thu-chi', await t.book('thu-chi', rows, (k) => [...k].reverse()), 'commit', '&autoPost=true');
    expect(rev.json(), rev.body).toMatchObject({ created: 2, posted: 2, errors: [] });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await t.book('thu-chi', [pt('Z')]) as unknown as ArrayBuffer);
    wb.getWorksheet('Du_lieu')!.getRow(2).getCell(10).value = null; // creditAccount
    const miss = await t.upload('thu-chi', Buffer.from(await wb.xlsx.writeBuffer()), 'validate');
    expect(miss.statusCode).toBe(400); expect(miss.json().error).toMatchObject({ code: 'IMPORT_COLUMN_MISSING', message: expect.stringContaining('[creditAccount]') });
  });

  it('lỗi từng loại báo đúng dòng và cột bằng tiếng Việt; không chứng từ nào được ghi', async () => {
    const t = await tenant();
    const file = await t.book('thu-chi', [
      pt('A'), pt('B'), pt('C', { postingDate: '2026-13-45' }), pt('D', { amount: '12,5' }), pt('E', { type: 'XX' }),
      pt('F', { type: 'BC', debitAccount: '1121', bankAccountNo: null }), pt('G', { creditAccount: '131', partyCode: null }),
      pt('H'), pt('H', { postingDate: '2026-03-11' }),
    ]);
    const r = await t.upload('thu-chi', file, 'commit');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ created: 0 });
    const by = Object.fromEntries((j.errors as { row: number; column: string; message: string }[]).map((e) => [e.row, e]));
    expect(by[6]).toMatchObject({ column: 'postingDate' });
    expect(by[7]).toMatchObject({ column: 'amount' });
    expect(by[8]).toMatchObject({ column: 'type' });
    expect(by[12]).toMatchObject({ column: 'postingDate', message: expect.stringContaining('dòng 11') });
    for (const e of j.errors) expect(e.message).not.toMatch(/\[object|Required|Invalid|undefined/);
    expect(await t.imported()).toBe(0);
    // tầng dịch vụ: tài khoản không có, thiếu tài khoản ngân hàng, thiếu đối tượng 131
    const svc = await t.upload('thu-chi', await t.book('thu-chi', [pt('A'), pt('B', { debitAccount: '99999' }), pt('F', { type: 'BC', debitAccount: '1121', bankAccountNo: null }), pt('G', { partyCode: null })]), 'commit');
    const se = svc.json().errors as { row: number; column: string }[];
    expect(svc.json()).toMatchObject({ created: 0, errorCount: 3 });
    expect(se.map((e) => [e.row, e.column])).toEqual([[5, 'debitAccount'], [6, 'bankAccountNo'], [7, 'partyCode']]);
    expect(await t.imported()).toBe(0);
  });

  it('1.000 dòng PT/PC, một dòng sai: không chứng từ nào được tạo, lỗi nêu dòng và cột', async () => {
    const t = await tenant();
    const rows = Array.from({ length: 1000 }, (_, i) => pt(`G${i}`, i % 2 ? { type: 'PC', debitAccount: '331', creditAccount: '1111', partyCode: 'NCC001' } : {}));
    rows[612] = { ...rows[612]!, creditAccount: '131999' };
    const t0 = Date.now();
    const r = await t.upload('thu-chi', await t.book('thu-chi', rows), 'commit');
    expect(r.json()).toMatchObject({ total: 1000, created: 0, errorCount: 1, errors: [{ row: 616, column: 'creditAccount', message: expect.stringContaining('131999') }] });
    expect(await t.imported()).toBe(0);
    const ok = await t.upload('thu-chi', await t.book('thu-chi', rows.map((x, i) => (i === 612 ? { ...x, creditAccount: '131' } : x))), 'commit');
    expect(ok.json()).toMatchObject({ created: 1000, errors: [] });
    expect(await t.imported()).toBe(1000);
    console.log(`1.000 chứng từ x2 lần: ${Date.now() - t0} ms`);
  });

  it('nhập lại đúng tệp: created = 0, existing đủ; sửa một nhóm rồi nhập lại chỉ nhóm đó là mới; nhóm giống hệt nhưng khác số nhóm là hai chứng từ', async () => {
    const t = await tenant();
    const file = await t.book('thu-chi', [pt('A'), pt('B', { amount: '2000000' })]);
    expect((await t.upload('thu-chi', file, 'commit', '&autoPost=true')).json()).toMatchObject({ created: 2, existing: 0, posted: 2 });
    const again = await t.upload('thu-chi', file, 'commit', '&autoPost=true');
    expect(again.json()).toMatchObject({ total: 2, created: 0, existing: 2, posted: 0, errors: [], warnings: [] });
    expect(await t.imported()).toBe(2);
    // sửa nhóm B: A không đổi nên bỏ qua, B là chứng từ mới
    expect((await t.upload('thu-chi', await t.book('thu-chi', [pt('A'), pt('B', { amount: '2000001' })]), 'commit')).json()).toMatchObject({ created: 1, existing: 1 });
    expect(await t.imported()).toBe(3);
    // hai nhóm giống hệt nhau, khác số nhóm: hai chứng từ; nhập lại thì cả hai đã có
    const twin = await t.book('thu-chi', [pt('P1', { amount: '777000' }), pt('P2', { amount: '777000' })]);
    expect((await t.upload('thu-chi', twin, 'commit')).json()).toMatchObject({ created: 2, existing: 0 });
    expect((await t.upload('thu-chi', twin, 'commit')).json()).toMatchObject({ created: 0, existing: 2 });
    expect(await t.imported()).toBe(5);
  });

  it('nhóm đã nhập nay đã hủy hoặc đảo → lỗi dòng, không âm thầm coi là đã có; nhóm còn nháp + Ghi sổ ngay → cảnh báo, không tự ghi sổ', async () => {
    const t = await tenant();
    const file = await t.book('thu-chi', [pt('A'), pt('B', { amount: '2000000' }), pt('C', { amount: '3000000' })]);
    expect((await t.upload('thu-chi', file, 'commit')).json()).toMatchObject({ created: 3 });
    const ids = (await sql<{ id: string; amount: string }>`SELECT v.id, l.debit::text AS amount FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE v.tenant_id = ${t.tenantId}::uuid AND l.debit > 0 ORDER BY l.debit`.execute(ctx.t.admin)).rows;
    expect((await t.call('POST', `/api/vouchers/${ids[0]!.id}/discard`)).statusCode).toBe(200); // A bị hủy
    expect((await t.call('POST', `/api/vouchers/${ids[1]!.id}/post`)).statusCode).toBe(200);
    expect((await t.call('POST', `/api/vouchers/${ids[1]!.id}/reverse`, { postingDate: '2026-03-20' })).statusCode).toBe(201); // B đã ghi sổ rồi bị đảo
    const r = await t.upload('thu-chi', file, 'commit', '&autoPost=true');
    expect(r.json()).toMatchObject({ created: 0, posted: 0, errorCount: 2, errors: [
      { row: 4, column: 'group', message: expect.stringMatching(/Nhóm "A" đã nhập thành chứng từ .* nay đã hủy; đổi số nhóm hoặc nội dung để nhập lại/) },
      { row: 5, column: 'group', message: expect.stringMatching(/Nhóm "B" .* nay đã đảo;/) }] });
    // chỉ nhóm C (nháp) còn lại: có cảnh báo, không ghi sổ
    const only = await t.upload('thu-chi', await t.book('thu-chi', [pt('C', { amount: '3000000' })]), 'commit', '&autoPost=true');
    expect(only.json()).toMatchObject({ created: 0, existing: 1, posted: 0, errors: [], warnings: [{ row: 4, column: 'group', message: expect.stringContaining('bản nháp') }] });
    expect((await sql<{ state: string }>`SELECT state FROM voucher WHERE tenant_id = ${t.tenantId}::uuid AND id = ${ids[2]!.id}::uuid`.execute(ctx.t.admin)).rows[0]!.state).toBe('draft');
  });

  it('đổi thứ tự dòng trong nhóm không đổi khóa (không tạo trùng); hóa đơn không ghi nhóm đã hủy báo "đổi nội dung dòng", không nhắc số nhóm', async () => {
    const t = await tenant();
    const a = pt('M', { amount: '100' }); const b = pt('M', { amount: '200', description: 'dòng hai' });
    expect((await t.upload('thu-chi', await t.book('thu-chi', [a, b]), 'commit')).json()).toMatchObject({ created: 1, existing: 0 });
    expect((await t.upload('thu-chi', await t.book('thu-chi', [b, a]), 'commit')).json()).toMatchObject({ created: 0, existing: 1 });
    const file = await t.book('bang-ke-mua', [bk(null)]);
    expect((await t.upload('bang-ke-mua', file, 'commit')).json()).toMatchObject({ created: 1 });
    const id = (await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${t.tenantId}::uuid AND voucher_type <> 'PT' AND idempotency_key LIKE 'import:bang-ke-mua:%'`.execute(ctx.t.admin)).rows[0]!.id;
    expect((await t.call('POST', `/api/vouchers/${id}/discard`)).statusCode).toBe(200);
    const r = await t.upload('bang-ke-mua', file, 'commit');
    expect(r.json().errors[0].message).toMatch(/Dòng 4 đã nhập thành chứng từ .* nay đã hủy; đổi nội dung dòng để nhập lại/);
  });

  it('kiểm tra (validate) không bao giờ ghi sổ dù có autoPost; Tài khoản Nợ trùng Có và nhóm bắt đầu bằng # là lỗi', async () => {
    const t = await tenant();
    const v = await t.upload('thu-chi', await t.book('thu-chi', [pt('A')]), 'validate', '&autoPost=true');
    expect(v.json()).toMatchObject({ created: 1, posted: 0, errors: [] });
    expect(await t.imported()).toBe(0);
    const bad = await t.upload('thu-chi', await t.book('thu-chi', [pt('B', { creditAccount: '1111' }), pt('#C')]), 'validate');
    expect(bad.json().errors).toMatchObject([{ row: 4, column: 'creditAccount' }, { row: 5, column: 'group', message: expect.stringContaining('#') }]);
  });

  it('quá 2.000 chứng từ → 400 IMPORT_TOO_MANY_GROUPS; quá 20.000 dòng → 400 IMPORT_TOO_MANY_ROWS, trước khi ghi', async () => {
    const t = await tenant();
    const many = await t.upload('thu-chi', await t.book('thu-chi', Array.from({ length: 2001 }, (_, i) => pt(`G${i}`))), 'validate');
    expect(many.statusCode).toBe(400); expect(many.json().error.code).toBe('IMPORT_TOO_MANY_GROUPS');
    const big = await t.upload('thu-chi', await t.book('thu-chi', Array.from({ length: 20_001 }, (_, i) => pt(`G${i % 4000}`))), 'validate');
    expect(big.statusCode).toBe(400); expect(big.json().error.code).toBe('IMPORT_TOO_MANY_ROWS');
    expect(await t.imported()).toBe(0);
  });
});

describe('nhập bảng kê hóa đơn', () => {
  it('bảng kê mua: hai mức thuế cùng nhóm thành một hóa đơn, thuế ghi trên hóa đơn dồn vào dòng thuế; ghi sổ ngay', async () => {
    const t = await tenant();
    const file = await t.book('bang-ke-mua', [
      bk('M1', { amount: '10000000', taxCode: 'V10', taxAmount: '1000001' }), bk('M1', { amount: '5000000', taxCode: 'V8', taxAmount: '400000' }),
      bk(null, { invoiceNo: '0000002', amount: '2000000', taxCode: 'V10', taxAmount: '200000' }),
    ]);
    const r = await t.upload('bang-ke-mua', file, 'commit', '&autoPost=true');
    expect(r.json(), r.body).toMatchObject({ total: 2, rows: 3, created: 2, posted: 2, errors: [] });
    expect(await t.states()).toEqual(['HDM:posted', 'HDM:posted']);
    const tax = (await sql<{ no: string; base: string; tax: string }>`SELECT i.invoice_no AS no, sum(i.base_amount)::text AS base, sum(i.tax_amount)::text AS tax FROM voucher_invoice i JOIN voucher v ON v.id = i.voucher_id WHERE v.tenant_id = ${t.tenantId}::uuid GROUP BY i.invoice_no ORDER BY 1`.execute(ctx.t.admin)).rows;
    expect(tax).toEqual([{ no: '0000001', base: '15000000', tax: '1400001' }, { no: '0000002', base: '2000000', tax: '200000' }]);
  });

  it('bảng kê mua: trùng trong tệp và trùng với hóa đơn đã có đều báo lỗi, không ghi gì', async () => {
    const t = await tenant();
    const inFile = await t.upload('bang-ke-mua', await t.book('bang-ke-mua', [bk('A'), bk('B')]), 'commit');
    expect(inFile.json()).toMatchObject({ created: 0, errors: [{ row: 5, column: 'invoiceNo', message: expect.stringContaining('dòng 4') }] });
    expect(await t.imported()).toBe(0);
    expect((await t.upload('bang-ke-mua', await t.book('bang-ke-mua', [bk('A')]), 'commit', '&autoPost=true')).json()).toMatchObject({ created: 1 });
    const dupe = await t.upload('bang-ke-mua', await t.book('bang-ke-mua', [bk('X', { invoiceNo: '0000009' }), bk('Y', { description: 'khác tệp' })]), 'commit');
    expect(dupe.json()).toMatchObject({ created: 0, errorCount: 1, errors: [{ row: 5, column: 'invoiceNo' }] });
    expect(await t.imported()).toBe(1);
  });

  it('thông tin tiêu đề trong nhóm không thống nhất → lỗi đúng dòng và cột; tiền thuế thiếu mã thuế → lỗi', async () => {
    const t = await tenant();
    const r = await t.upload('bang-ke-mua', await t.book('bang-ke-mua', [bk('A'), bk('A', { taxCode: 'V8', invoiceDate: '2026-03-11' }), bk('B', { invoiceNo: '2', taxCode: null })]), 'validate');
    expect(r.json().errors).toEqual(expect.arrayContaining([expect.objectContaining({ row: 5, column: 'invoiceDate', message: expect.stringContaining('dòng 4') }), expect.objectContaining({ row: 6, column: 'taxCode', message: expect.stringContaining('mã thuế') })]));
    // cùng mã thuế: một dòng ghi tiền thuế, dòng kia bỏ trống → lỗi ở dòng bỏ trống
    const mix = await t.upload('bang-ke-mua', await t.book('bang-ke-mua', [bk('A'), bk('A', { taxAmount: null })]), 'validate');
    expect(mix.json().errors).toMatchObject([{ row: 5, column: 'taxAmount', message: expect.stringContaining('V10') }]);
  });

  it('bảng kê bán: hóa đơn bán dịch vụ ghi sổ Nợ 131, Có 5113 và 33311; nhóm hóa đơn sai báo ở cột invoiceGroupCode', async () => {
    const t = await tenant();
    const sale = { partyCode: 'KH001', accountCode: '5113', counterAccountCode: '131', invoiceGroupCode: '10', serial: 'C26TBB' };
    const r = await t.upload('bang-ke-ban', await t.book('bang-ke-ban', [bk('S1', { ...sale, amount: '10000000', taxAmount: '1000000' })]), 'commit', '&autoPost=true');
    expect(r.json(), r.body).toMatchObject({ created: 1, posted: 1 });
    const l = (await sql<{ code: string; d: string; c: string }>`SELECT a.code, l.debit::text AS d, l.credit::text AS c FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.tenant_id = ${t.tenantId}::uuid ORDER BY l.line_no`.execute(ctx.t.admin)).rows;
    expect(l).toEqual([{ code: '5113', d: '0', c: '10000000' }, { code: '33311', d: '0', c: '1000000' }, { code: '131', d: '11000000', c: '0' }]);
    // hóa đơn bán trùng (cùng ký hiệu, số hóa đơn dù khác cách viết) với hóa đơn đã có, tệp khác nội dung: lỗi; hóa đơn khác thì được
    const dup = await t.upload('bang-ke-ban', await t.book('bang-ke-ban', [bk('S9', { ...sale, serial: 'c26 tbb', description: 'tệp khác' }), bk('S8', { ...sale, invoiceNo: '2' })]), 'commit');
    expect(dup.json()).toMatchObject({ created: 0, errorCount: 1, errors: [{ row: 4, column: 'invoiceNo', message: expect.stringContaining('đã nhập ở chứng từ') }] });
    expect((await t.upload('bang-ke-ban', await t.book('bang-ke-ban', [bk('S8', { ...sale, invoiceNo: '2' })]), 'commit')).json()).toMatchObject({ created: 1, errors: [] });
    const bad = await t.upload('bang-ke-ban', await t.book('bang-ke-ban', [bk('S2', { ...sale, invoiceNo: '77', invoiceGroupCode: '01' })]), 'commit');
    expect(bad.json()).toMatchObject({ created: 0, errors: [{ row: 4, column: 'invoiceGroupCode' }] });
  });
});
