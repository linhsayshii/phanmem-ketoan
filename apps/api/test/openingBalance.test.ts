import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const R = (accountCode: string, debit = '0', credit = '0', partyCode: string | null = null, more: object = {}) =>
  ({ accountCode, partyCode, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', ...more });
const put = (rows: object[], year = 2026, c = cookie) => ctx.app.inject({ method: 'PUT', url: `/api/opening-balance/${year}`, headers: { cookie: c }, payload: { rows } });
const check = (year = 2026, c = cookie) => ctx.app.inject({ method: 'GET', url: `/api/opening-balance/${year}/check`, headers: { cookie: c } });
const post = (year = 2026, c = cookie) => ctx.app.inject({ method: 'POST', url: `/api/opening-balance/${year}/post`, headers: { cookie: c } });
const list = (year = 2026, c = cookie) => ctx.app.inject({ method: 'GET', url: `/api/opening-balance/${year}`, headers: { cookie: c } });

// Mẫu Excel đã bỏ dòng ví dụ (dòng 3): dữ liệu thêm vào từ dòng 3.
async function sheet() {
  const tpl = await ctx.app.inject({ method: 'GET', url: '/api/opening-balance/template.xlsx', headers: { cookie } });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Du_lieu')!; ws.spliceRows(3, 1);
  return { wb, ws };
}
async function upload(wb: ExcelJS.Workbook, mode: string, year = 2026, c = cookie) {
  const fd = new FormData(); fd.append('file', Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'sd.xlsx' });
  return ctx.app.inject({ method: 'POST', url: `/api/opening-balance/${year}/import?mode=${mode}`, headers: { cookie: c, ...fd.getHeaders() }, payload: fd.getBuffer() });
}

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `OB${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  for (const [code, name] of [['KH001', 'Khách 1'], ['KH002', 'Khách 2']]) await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code, name, is_customer: true } });
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('số dư đầu kỳ', () => {
  it('số tiền VND tối đa 16 chữ số: 10^16-1 được nhận, 10^16 bị 400 kèm thông điệp', async () => {
    expect((await put([R('1111', '9999999999999999'), R('4111', '0', '9999999999999999')])).statusCode).toBe(200);
    const big = await put([R('1111', '10000000000000000'), R('4111', '0', '10000000000000000')]);
    expect(big.statusCode).toBe(400); expect(big.body).toContain('Số tiền VND phải là số nguyên tối đa 16 chữ số');
    await put([]); // trả về trạng thái trống cho các kiểm thử sau
  });
  it('kiểm tra báo lệch, tài khoản tổng hợp, sai loại dư, thiếu đối tượng, tài khoản loại 5–9', async () => {
    await put([R('1111', '100000000'), R('111', '1'), R('331', '5', '0', null), R('5113', '0', '7'), R('1121', '0', '1'), R('4111', '0', '90000000')]);
    const c = await check();
    const codes = (c.json() as { code: string }[]).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['UNBALANCED', 'ACCOUNT_GROUP', 'PARTY_REQUIRED', 'ACCOUNT_PNL', 'WRONG_SIDE']));
    const p = await post();
    expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_INVALID');
    expect((p.json().error.details as { code: string }[]).map((i) => i.code)).toEqual(expect.arrayContaining(['UNBALANCED', 'PARTY_REQUIRED']));
  }, 30_000);

  it('ghi sổ tạo chứng từ DK ở kỳ 0; 131 lưỡng tính theo đối tượng; ghi lại thay thế chứng từ cũ', async () => {
    await put([R('1111', '100000000'), R('1121', '400000000'), R('131', '30000000', '0', 'KH001'), R('131', '0', '10000000', 'KH002'), R('4111', '0', '520000000')]);
    expect((await check()).json()).toEqual([]);
    const p = await post();
    expect(p.statusCode, p.body).toBe(200);
    const sourceDocId = (await sql<{ id: string }>`SELECT md5(${`${tenantId}:opening:2026`})::uuid AS id`.execute(ctx.t.admin)).rows[0]!.id; // uuid xác định theo (công ty, năm)
    expect(p.json()).toMatchObject({ voucherType: 'DK', state: 'posted', postingDate: '2025-12-31', totalDebit: '530000000', sourceDocType: 'opening_balance', sourceDocId });
    expect(p.json().lines).toHaveLength(5);
    await put([R('1111', '120000000'), R('1121', '400000000'), R('131', '30000000', '0', 'KH001'), R('131', '0', '10000000', 'KH002'), R('4111', '0', '540000000')]);
    const p2 = await post();
    expect(p2.json()).toMatchObject({ id: p.json().id, voucherNo: p.json().voucherNo, totalDebit: '550000000', sourceDocId });
    // ghi lại: dòng cũ được lưu vào lịch sử trước khi thay
    const hist = await sql<{ n: number; first: string }>`SELECT jsonb_array_length(lines) AS n, lines->0->>'debit' AS first FROM voucher_line_history WHERE voucher_id = ${p.json().id}::uuid ORDER BY id`.execute(ctx.t.admin);
    expect(hist.rows).toEqual([{ n: 5, first: '100000000' }]);
    const n = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'DK' AND state <> 'cancelled'`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe(1);
    const period0 = await sql<{ period_no: number; fiscal_year: number }>`SELECT period_no, fiscal_year FROM voucher WHERE id = ${p.json().id}::uuid`.execute(ctx.t.admin);
    expect(period0.rows[0]).toEqual({ period_no: 0, fiscal_year: 2026 });
    const rows = (await list()).json() as { accountCode: string; accountName: string; partyCode: string | null; partyName: string | null }[];
    expect(rows.find((r) => r.partyCode === 'KH001')).toMatchObject({ accountCode: '131', accountName: expect.any(String), partyName: 'Khách 1' });
  }, 30_000);

  it('nhập Excel số dư đầu kỳ báo lỗi theo dòng và ghi khi hợp lệ', async () => {
    const tpl = await ctx.app.inject({ method: 'GET', url: '/api/opening-balance/template.xlsx', headers: { cookie } });
    expect(tpl.statusCode).toBe(200); expect(tpl.headers['content-type']).toContain('spreadsheetml');
    const { wb, ws } = await sheet();
    ws.addRow(['1111', null, 'VND', 50000000, 0, 0, 0]); ws.addRow(['4111', null, 'VND', 0, 50000000, 0, 0]); ws.addRow(['9999', null, 'VND', 1, 0, 0, 0]);
    const v = await upload(wb, 'validate'); expect(v.json().errors).toEqual([{ row: 5, column: 'account_code', message: expect.stringContaining('9999') }]);
    ws.spliceRows(5, 1);
    const c = await upload(wb, 'commit'); expect(c.json()).toMatchObject({ inserted: 2 });
    expect((await list()).json()).toHaveLength(2);
  }, 30_000);

  it('Excel: ô số giữ nguyên phần thập phân nguyên tệ, ô công thức lấy kết quả, ô chữ theo định dạng Việt Nam', async () => {
    const { wb, ws } = await sheet();
    ws.addRow(['1111', null, 'VND', 10000000, 0, 0, 0]);
    ws.addRow(['1122', null, 'USD', { formula: '25000000+6250', result: 25006250 }, 0, 1000.25, 0]);
    ws.addRow(['4111', null, 'VND', 0, '35.006.250', 0, 0]);
    const r = await upload(wb, 'commit'); expect(r.statusCode, r.body).toBe(200); expect(r.json()).toMatchObject({ total: 3, inserted: 3, errors: [] });
    const rows = (await list()).json() as { accountCode: string; currencyCode: string; debit: string; credit: string; debitCurrency: string }[];
    expect(rows.find((x) => x.accountCode === '1122')).toMatchObject({ currencyCode: 'USD', debit: '25006250', debitCurrency: '1000.2500' });
    expect(rows.find((x) => x.accountCode === '4111')).toMatchObject({ credit: '35006250' });
  }, 30_000);

  it('Excel: ô chữ sai, số âm, trùng dòng, đối tượng và loại tiền không có đều báo đúng dòng và cột', async () => {
    const { wb, ws } = await sheet();
    ws.addRow(['1111', null, 'VND', 'abc', '1.5', 0, 0]);          // dòng 3: Nợ chữ, Có "1.5" mơ hồ
    ws.addRow(['1111', null, 'VND', -5, 0, 0, 0]);                  // dòng 4: số âm
    ws.addRow(['131', 'KH001', 'VND', 5, 0, 0, 0]);                 // dòng 5
    ws.addRow(['131', 'KH001', 'VND', 6, 0, 0, 0]);                 // dòng 6: trùng dòng 5
    ws.addRow(['131', 'KHX', 'VND', 6, 0, 0, 0]);                   // dòng 7: đối tượng không có
    ws.addRow(['1122', null, 'EUR', 6, 0, 1, 0]);                   // dòng 8: loại tiền không có
    ws.addRow(['1122', null, 'USD', 6, 0, 0, 0]);                   // dòng 9: dòng ngoại tệ thiếu nguyên tệ
    const r = await upload(wb, 'validate'); expect(r.statusCode, r.body).toBe(200);
    const errs = r.json().errors as { row: number; column: string; message: string }[];
    expect(errs.map((e) => `${e.row}:${e.column}`).sort()).toEqual(['3:credit', '3:debit', '4:debit', '6:account_code', '7:party_code', '8:currency_code', '9:debit_currency']);
    expect(r.json().inserted).toBe(0);
  }, 30_000);

  it('nhập Excel không có dòng nào (hoặc toàn số 0) bị 400 IMPORT_EMPTY và không xóa số dư đã lưu', async () => {
    const before = (await list()).json().length; expect(before).toBeGreaterThan(0);
    const empty = await sheet(); const zero = await sheet(); zero.ws.addRow(['1111', null, 'VND', 0, 0, 0, 0]);
    for (const wb of [empty.wb, zero.wb]) for (const mode of ['validate', 'commit']) {
      const r = await upload(wb, mode); expect(r.statusCode, r.body).toBe(400); expect(r.json().error.code).toBe('IMPORT_EMPTY');
    }
    expect((await list()).json()).toHaveLength(before);
  }, 30_000);

  it('PUT bỏ qua dòng toàn số 0; số tiền sai định dạng hoặc sai bên bị từ chối 400', async () => {
    const ok = await put([R('1111', '100'), R('4111', '0', '100'), R('1121', '0', '0')]);
    expect(ok.json()).toEqual({ count: 2 }); expect((await list()).json()).toHaveLength(2);
    const bad = async (row: object) => { const r = await put([row]); expect(r.statusCode, r.body).toBe(400); expect(r.json().error.code).toBe('VALIDATION'); return r; };
    await bad(R('1111', '100.5'));                                                                       // VND là đồng nguyên
    await bad(R('1122', '100', '0', null, { currencyCode: 'USD', debitCurrency: '1.23456' }));           // nguyên tệ tối đa 4 số lẻ
    await bad(R('1122', '100', '0', null, { currencyCode: 'USD', debitCurrency: '-1' }));
    await bad(R('1111', '100', '50'));                                                                   // hai bên Nợ Có
    await bad(R('1122', '0', '100', null, { currencyCode: 'USD', debitCurrency: '1' }));                 // nguyên tệ khác bên với VND
    await bad(R('1111', '100', '0', null, { debitCurrency: '1' }));                                      // dòng VND không có nguyên tệ
    await bad(R('1122', '100', '0', null, { currencyCode: 'USD' }));                                     // dòng ngoại tệ phải có nguyên tệ cùng bên
    await bad(R('1122', '0', '100', null, { currencyCode: 'USD', debitCurrency: '0', creditCurrency: '0' }));
    await bad(R('1122', '0', '0', null, { currencyCode: 'USD', debitCurrency: '1' }));                   // dòng ngoại tệ phải có số VND quy đổi
    expect((await list()).json()).toHaveLength(2); // lần ghi lỗi không làm mất dữ liệu cũ
    const missing = await put([R('1111', '1', '0', 'KHONGCO')]);
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe('LOOKUP_NOT_FOUND');
    const dup = await put([R('131', '1', '0', 'KH001'), R('131', '2', '0', 'KH001')]);
    expect(dup.statusCode).toBe(409); expect(dup.json().error.code).toBe('DUPLICATE');
  }, 30_000);

  it('ghi sổ khi không còn dòng nào: 409 OPENING_EMPTY và chứng từ DK cũ vẫn ghi sổ nguyên vẹn', async () => {
    expect((await put([])).json()).toEqual({ count: 0 });
    const p = await post(); expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_EMPTY');
    const dk = await sql<{ state: string; n: number }>`SELECT v.state, (SELECT count(*) FROM voucher_line l WHERE l.voucher_id = v.id) AS n FROM voucher v WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'DK'`.execute(ctx.t.admin);
    expect(dk.rows).toEqual([{ state: 'posted', n: 5 }]); // không động tới chứng từ cũ
  }, 30_000);

  it('kiểm tra báo tài khoản đã ngừng dùng và tài khoản theo dõi vật tư/tài sản; ghi sổ không rơi xuống lỗi trigger', async () => {
    const setActive = (active: boolean) => ctx.t.admin.updateTable('account').set({ is_active: active }).where('tenant_id', '=', tenantId).where('regime', '=', 'TT133').where('code', '=', '1121').execute();
    await setActive(false);
    try {
      await put([R('1121', '5'), R('156', '10'), R('4111', '0', '15')]);
      expect((await check()).json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'ACCOUNT_INACTIVE', accountCode: '1121' }), expect.objectContaining({ code: 'SUBLEDGER_MODULE_REQUIRED', accountCode: '156' })]));
      const p = await post(); expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_INVALID');
    } finally { await setActive(true); }
  }, 30_000);

  it('ghi sổ số dư có tài khoản ngoại tệ: chứng từ DK hỗn hợp VND và USD cân theo VND; PKT toàn USD lệch nguyên tệ vẫn bị từ chối', async () => {
    await ctx.t.admin.updateTable('account').set({ track_currency: true }).where('tenant_id', '=', tenantId).where('regime', '=', 'TT133').where('code', '=', '3388').execute();
    await put([R('1111', '100000000'), R('1122', '25000000', '0', null, { currencyCode: 'USD', debitCurrency: '1000' }),
      R('3388', '0', '12700000', null, { currencyCode: 'USD', creditCurrency: '500' }), R('4111', '0', '112300000')]);
    expect((await check()).json()).toEqual([]);
    const p = await post(); expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ voucherType: 'DK', state: 'posted', totalDebit: '125000000' });
    const line = (code: string) => (p.json().lines as { accountCode: string; debit: string; credit: string; amountCurrency: string }[]).find((l) => l.accountCode === code)!;
    expect(line('1122')).toMatchObject({ debit: '25000000', amountCurrency: '1000.0000' });
    expect(line('3388')).toMatchObject({ credit: '12700000', amountCurrency: '-500.0000' });

    const usd = (lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: {
      voucherType: 'PKT', postingDate: '2026-06-05', documentDate: '2026-06-05', currencyCode: 'USD', fxRate: '25000', lines } });
    const lech = await usd([{ accountCode: '1122', debit: '2500000', credit: '0', amountCurrency: '100' }, { accountCode: '1122', debit: '0', credit: '2500000', amountCurrency: '-90' }]);
    expect(lech.statusCode).toBe(409); expect(lech.json().error.code).toBe('VOUCHER_UNBALANCED_CURRENCY');
    const dung = await usd([{ accountCode: '1122', debit: '2500000', credit: '0', amountCurrency: '100' }, { accountCode: '1122', debit: '0', credit: '2500000', amountCurrency: '-100' }]);
    expect(dung.statusCode, dung.body).toBe(201);
  }, 30_000);

  it('quyền: chỉ opening_balance.view thì xem được nhưng không sửa, không ghi sổ, không nhập Excel', async () => {
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie } })).json() as { id: string; code: string }[];
    const role = roles.find((r) => r.code === 'xem')!;
    await ctx.app.inject({ method: 'PUT', url: `/api/roles/${role.id}/permissions`, headers: { cookie }, payload: { permissions: ['opening_balance.view'] } });
    const username = `ob_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'Chỉ xem', password: 'Matkhau1!', roleCode: role.code } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const viewer = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await list(2026, viewer)).statusCode).toBe(200);
    expect((await check(2026, viewer)).statusCode).toBe(200);
    expect((await put([], 2026, viewer)).statusCode).toBe(403);
    expect((await post(2026, viewer)).statusCode).toBe(403);
    const { wb } = await sheet(); expect((await upload(wb, 'commit', 2026, viewer)).statusCode).toBe(403);
  }, 30_000);
});

describe('số dư đầu kỳ nhiều hệ tài khoản và nhiều năm', () => {
  let c2: string; let t2: string;
  beforeAll(async () => {
    ({ cookie: c2, tenantId: t2 } = await bootstrapTenant(ctx, { code: `OC${Date.now()}` }));
    for (const [fiscalYear, dateFrom, regime] of [[2026, '2026-01-01', 'TT133'], [2027, '2027-01-01', 'TT200']] as const)
      expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c2 }, payload: { fiscalYear, dateFrom, months: 12, regime } })).statusCode).toBe(201);
  }, 60_000);

  it('tra tài khoản theo hệ của năm: mã chỉ có ở TT200 bị từ chối ở năm TT133; checkOpening và ghi sổ bỏ qua dòng thuộc hệ khác', async () => {
    const wrong = await put([R('1113', '5')], 2026, c2);
    expect(wrong.statusCode).toBe(404); expect(wrong.json().error.code).toBe('LOOKUP_NOT_FOUND');
    expect((await put([R('1111', '100000000'), R('4111', '0', '100000000')], 2026, c2)).statusCode).toBe(200);
    // 4111 là tài khoản chi tiết ở TT133 nhưng tổng hợp ở TT200: nếu tra nhầm hệ sẽ báo ACCOUNT_GROUP.
    expect((await check(2026, c2)).json()).toEqual([]);
    // dòng lạc hệ (chèn thẳng bằng quyền quản trị) không lọt vào kiểm tra và chứng từ
    await sql`INSERT INTO opening_balance(tenant_id, fiscal_year, account_id, debit) SELECT ${t2}::uuid, 2026, id, 999 FROM account WHERE tenant_id = ${t2}::uuid AND regime = 'TT200' AND code = '1113'`.execute(ctx.t.admin);
    expect((await check(2026, c2)).json()).toEqual([]);
    const p = await post(2026, c2); expect(p.statusCode, p.body).toBe(200); expect(p.json().lines).toHaveLength(2);

    const { wb, ws } = await sheet(); ws.addRow(['1113', null, 'VND', 5, 0, 0, 0]);
    expect((await upload(wb, 'validate', 2026, c2)).json().errors).toEqual([{ row: 3, column: 'account_code', message: expect.stringContaining('1113') }]);
    expect((await upload(wb, 'validate', 2027, c2)).json().errors).toEqual([]);
  }, 30_000);

  it('chỉ nhập số dư đầu kỳ cho năm tài chính đầu tiên: năm sau đã có năm trước bị 409 OPENING_PRIOR_YEAR_EXISTS', async () => {
    expect((await put([R('1111', '100000000'), R('41111', '0', '100000000')], 2027, c2)).statusCode).toBe(200);
    expect((await check(2027, c2)).json()).toEqual([]);
    const p = await post(2027, c2);
    expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_PRIOR_YEAR_EXISTS');
    const n = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${t2}::uuid AND voucher_type = 'DK' AND fiscal_year = 2027`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe(0);
  }, 30_000);
});

describe('chứng từ DK: không lập tay, không bị chiếm, số dư lớn', () => {
  let c3: string; let t3: string; let u3: string;
  const jobs = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM pgboss.job WHERE name = 'balance.recompute' AND data->>'tenantId' = ${t3}`.execute(ctx.t.admin)).rows[0]!.n;
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c3 }, payload });
  const pkt = (voucherType: string) => ({ voucherType, postingDate: '2026-02-05', documentDate: '2026-02-05', lines: [{ accountCode: '1111', debit: '5', credit: '0' }, { accountCode: '4111', debit: '0', credit: '5' }] });
  beforeAll(async () => {
    ({ cookie: c3, tenantId: t3, userId: u3 } = await bootstrapTenant(ctx, { code: `OD${Date.now()}` }));
    expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c3 }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).statusCode).toBe(201);
  }, 60_000);

  it('DK lập tay trong năm: ghi sổ số dư bị 409 OPENING_DK_FOREIGN và chứng từ lập tay còn nguyên; hủy rồi thì ghi sổ được', async () => {
    const v = await sql<{ id: string }>`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, created_by, description) VALUES (${t3}::uuid, 'DK', DATE '2025-12-31', DATE '2025-12-31', ${u3}::uuid, 'DK lập tay') RETURNING id`.execute(ctx.t.admin);
    const manual = v.rows[0]!.id;
    await sql`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit) SELECT ${t3}::uuid, ${manual}::uuid, x.n, a.id, DATE '2025-12-31', x.d, x.c
      FROM (VALUES (1, '1111', 5, 0), (2, '4111', 0, 5)) AS x(n, code, d, c) JOIN account a ON a.tenant_id = ${t3}::uuid AND a.regime = 'TT133' AND a.code = x.code`.execute(ctx.t.admin);
    const rows = [R('1111', '100'), R('4111', '0', '100')];
    expect((await api('PUT', '/api/opening-balance/2026', { rows })).statusCode).toBe(200);
    const p = await api('POST', '/api/opening-balance/2026/post');
    expect(p.statusCode, p.body).toBe(409); expect(p.json().error.code).toBe('OPENING_DK_FOREIGN');
    const dk = () => sql<{ id: string; state: string; n: number }>`SELECT v.id, v.state, (SELECT count(*) FROM voucher_line l WHERE l.voucher_id = v.id) AS n FROM voucher v WHERE v.tenant_id = ${t3}::uuid AND v.voucher_type = 'DK' ORDER BY v.created_at`.execute(ctx.t.admin);
    expect((await dk()).rows).toEqual([{ id: manual, state: 'draft', n: 2 }]);
    expect(await jobs()).toBe(0); // ghi sổ lỗi thì không báo worker
    expect((await api('POST', `/api/vouchers/${manual}/discard`)).statusCode).toBe(200);
    const ok = await api('POST', '/api/opening-balance/2026/post'); expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'posted', totalDebit: '100' }); expect(ok.json().id).not.toBe(manual);
    await expect.poll(jobs, { timeout: 5000 }).toBeGreaterThan(0); // ghi sổ số dư gửi việc tính lại số dư vào hàng đợi
  }, 30_000);

  it('API chứng từ không lập, sửa sang hoặc nhân bản loại DK: 409 VOUCHER_TYPE_SYSTEM', async () => {
    const create = await api('POST', '/api/vouchers', { ...pkt('DK'), postingDate: '2025-12-31', documentDate: '2025-12-31' });
    expect(create.statusCode, create.body).toBe(409); expect(create.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
    const draft = (await api('POST', '/api/vouchers', pkt('PKT'))).json();
    const edit = await api('PUT', `/api/vouchers/${draft.id}`, { ...pkt('DK'), postingDate: '2025-12-31', documentDate: '2025-12-31', version: draft.version });
    expect(edit.statusCode, edit.body).toBe(409); expect(edit.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
    const dkId = (await api('GET', '/api/vouchers?type=DK&state=posted')).json().rows[0].id as string;
    const dup = await api('POST', `/api/vouchers/${dkId}/duplicate`, { postingDate: '2026-01-05' });
    expect(dup.statusCode, dup.body).toBe(409); expect(dup.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
  }, 30_000);

  it('DK do màn hình Số dư đầu kỳ sinh: bỏ ghi sổ/hủy/xóa/sửa dòng ở màn hình chứng từ và SQL trực tiếp đều bị chặn; ghi sổ lại từ màn hình số dư vẫn chạy', async () => {
    const dkId = (await api('GET', '/api/vouchers?type=DK&state=posted')).json().rows[0].id as string;
    const MSG = 'Chứng từ số dư đầu kỳ chỉ sửa ở màn hình Số dư đầu kỳ';
    const refused = (r: { statusCode: number; json(): { error: { code: string; message: string } } }, what: string) => expect([what, r.statusCode, r.json().error.code, r.json().error.message]).toEqual([what, 409, 'VOUCHER_SYSTEM_GENERATED', MSG]);
    refused(await api('POST', `/api/vouchers/${dkId}/unpost`), 'unpost');
    refused(await api('POST', `/api/vouchers/${dkId}/discard`), 'discard');
    refused(await ctx.app.inject({ method: 'DELETE', url: `/api/vouchers/${dkId}`, headers: { cookie: c3 } }), 'delete');
    const dk = (await api('GET', `/api/vouchers/${dkId}`)).json();
    refused(await api('PUT', `/api/vouchers/${dkId}`, { version: dk.version, lines: [{ lineNo: 1, description: 'sửa dòng' }] }), 'sửa dòng');
    expect((await api('PUT', `/api/vouchers/${dkId}`, { version: dk.version, description: 'Số dư đầu kỳ (đã chú thích)' })).statusCode).toBe(200); // diễn giải ở đầu chứng từ vẫn sửa được
    const direct = withTenant(ctx.t.db, { tenantId: t3, userId: u3 }, (trx) => sql`SELECT unpost_voucher(${dkId}::uuid)`.execute(trx));
    await expect(direct).rejects.toMatchObject({ code: 'P0001', message: `VOUCHER_SYSTEM_GENERATED: ${MSG}` });
    const again = await api('POST', '/api/opening-balance/2026/post');
    expect(again.statusCode, again.body).toBe(200); expect(again.json()).toMatchObject({ id: dkId, state: 'posted' });
    // cờ cho phép bỏ ghi sổ chỉ sống trong giao dịch của postOpening: sau đó SQL trực tiếp lại bị chặn
    await expect(withTenant(ctx.t.db, { tenantId: t3, userId: u3 }, (trx) => sql`SELECT unpost_voucher(${dkId}::uuid)`.execute(trx))).rejects.toMatchObject({ message: `VOUCHER_SYSTEM_GENERATED: ${MSG}` });
  }, 30_000);

  it('ghi sổ 6001 dòng: chia lô khi ghi dòng chứng từ (không vượt giới hạn tham số bind)', async () => {
    const { tenantId: t4, cookie: c4 } = await bootstrapTenant(ctx, { code: `OE${Date.now()}` });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c4 }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).statusCode).toBe(201);
    await sql`INSERT INTO party(tenant_id, code, name, is_customer) SELECT ${t4}::uuid, 'P' || g, 'P' || g, true FROM generate_series(1, 6001) g`.execute(ctx.t.admin);
    await sql`INSERT INTO opening_balance(tenant_id, fiscal_year, account_id, party_id, debit) SELECT ${t4}::uuid, 2026, a.id, p.id, 1 FROM party p JOIN account a ON a.tenant_id = ${t4}::uuid AND a.regime = 'TT133' AND a.code = '131' WHERE p.tenant_id = ${t4}::uuid`.execute(ctx.t.admin);
    await sql`INSERT INTO opening_balance(tenant_id, fiscal_year, account_id, credit) SELECT ${t4}::uuid, 2026, id, 6001 FROM account WHERE tenant_id = ${t4}::uuid AND regime = 'TT133' AND code = '4111'`.execute(ctx.t.admin);
    const p = await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie: c4 } });
    expect(p.statusCode, p.body.slice(0, 300)).toBe(200);
    expect(p.json()).toMatchObject({ state: 'posted', totalDebit: '6001' }); expect(p.json().lines).toHaveLength(6002);
  }, 120_000);
});
