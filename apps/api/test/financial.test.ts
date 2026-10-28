import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { shiftYear } from '../src/modules/reporting/financial.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 }); // máy chủ DB có lúc bận: mỗi kiểm thử gọi nhiều API
let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, lines: object[], c = cookie) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: c }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines } });
const get = (url: string, c = cookie) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
const put = (code: string, regime: string, lines: object[], c = cookie) => ctx.app.inject({ method: 'PUT', url: `/api/report-defs/${code}`, headers: { cookie: c }, payload: { regime, lines } });
const post = (url: string, payload: object, c = cookie) => ctx.app.inject({ method: 'POST', url, headers: { cookie: c }, payload });
const ok = async (p: ReturnType<typeof pkt>) => { const r = await p; expect(r.statusCode, r.body).toBe(201); return r; };
type Row = { lineCode: string; current: string; previous: string | null };
const rowOf = (r: { json(): { rows: Row[] } }, c: string) => r.json().rows.find((x) => x.lineCode === c)!;

const MINI_B01 = [
  { lineCode: '100', label: 'A. Tài sản', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[111]+[131]' },
  { lineCode: '111', label: 'Tiền', parentLineCode: '100', source: 'balance', side: 'net_debit', formula: '111+112' },
  { lineCode: '131', label: 'Phải thu khách hàng', parentLineCode: '100', source: 'balance', side: 'debit', formula: '131' },
  { lineCode: '300', label: 'C. Nợ phải trả', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[312]+[331]' },
  { lineCode: '312', label: 'Người mua trả tiền trước', parentLineCode: '300', source: 'balance', side: 'credit', formula: '131' },
  { lineCode: '331', label: 'Phải trả người bán', parentLineCode: '300', source: 'balance', side: 'credit', formula: '331' },
  { lineCode: '400', label: 'D. Vốn chủ sở hữu', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[411]+[421]' },
  { lineCode: '411', label: 'Vốn góp', parentLineCode: '400', source: 'balance', side: 'net_credit', formula: '411' },
  { lineCode: '421', label: 'Lợi nhuận chưa phân phối', parentLineCode: '400', source: 'balance', side: 'net_credit', formula: '421+911+5+6', isBold: false },
  { lineCode: '440', label: 'Tổng cộng nguồn vốn', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[300]+[400]', isBold: true },
];
const MINI_B02 = [
  { lineCode: '01', label: 'Doanh thu', parentLineCode: null, source: 'movement', side: 'net_credit', formula: '511' },
  { lineCode: '11', label: 'Giá vốn / chi phí', parentLineCode: null, source: 'movement', side: 'net_debit', formula: '632+642' },
  { lineCode: '50', label: 'Lợi nhuận', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[01]-[11]' },
  { lineCode: '60', label: 'Kết chuyển (đối ứng)', parentLineCode: null, source: 'pair', side: 'net_debit', formula: 'N911/C642' },
  { lineCode: '70', label: 'Chi phí quản lý trừ 6421', parentLineCode: null, source: 'movement', side: 'net_debit', formula: '64(6421)' },
  { lineCode: '71', label: 'Chi phí quản lý', parentLineCode: null, source: 'movement', side: 'net_debit', formula: '64' },
];

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `FR${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'K1', is_customer: true } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH002', name: 'K2', is_customer: true } });
  // Thay mẫu hệ thống bằng định nghĩa nhỏ để số liệu kiểm thử dễ tính; B03 xóa đi để có báo cáo chưa định nghĩa.
  expect((await put('B01', 'TT133', MINI_B01)).statusCode).toBe(200);
  expect((await put('B02', 'TT133', MINI_B02)).statusCode).toBe(200);
  await ctx.t.admin.deleteFrom('report_def').where('tenant_id', '=', tenantId).where('report_code', '=', 'B03').execute();
  await ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie }, payload: { rows: [{ accountCode: '1111', currencyCode: 'VND', debit: '1000', credit: '0', debitCurrency: '0', creditCurrency: '0', partyCode: null }, { accountCode: '4111', currencyCode: 'VND', debit: '0', credit: '1000', debitCurrency: '0', creditCurrency: '0', partyCode: null }] } });
  await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
  await ok(pkt('2026-02-01', [{ accountCode: '131', debit: '500', partyCode: 'KH001' }, { accountCode: '5113', credit: '500' }]));
  await ok(pkt('2026-02-02', [{ accountCode: '1111', debit: '100' }, { accountCode: '131', credit: '100', partyCode: 'KH002' }]));
  await ok(pkt('2026-03-01', [{ accountCode: '6421', debit: '300' }, { accountCode: '1111', credit: '300' }]));
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('báo cáo tài chính theo dòng', () => {
  it('B01 trước kết chuyển: tổng tài sản = nợ phải trả + vốn (gồm P&L chưa kết chuyển); 131 tách dư hai bên', async () => {
    const r = await get('/api/reports/financial/B01?from=2026-01-01&to=2026-03-31');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ reportCode: 'B01', formNo: 'B01a-DNN', regime: 'TT133', period: { from: '2026-01-01', to: '2026-03-31' } });
    expect(rowOf(r, '111').current).toBe('800'); expect(rowOf(r, '131').current).toBe('500'); expect(rowOf(r, '312').current).toBe('100'); expect(rowOf(r, '100').current).toBe('1300');
    expect(rowOf(r, '421').current).toBe('200'); // 500 doanh thu − 300 chi phí
    expect(rowOf(r, '440').current).toBe('1300'); expect(rowOf(r, '111').previous).toBe('1000'); // số đầu năm = dư tại ngày trước ngày đầu năm (gồm DK kỳ 0)
    expect(rowOf(r, '131').previous).toBe('0');
  });
  it('B02 theo phát sinh không gồm kết chuyển; đối ứng nhìn thấy kết chuyển; so sánh năm trước rỗng', async () => {
    const kc = await post('/api/closing/run-all', { postingDate: '2026-03-31' }); expect(kc.statusCode, kc.body).toBeLessThan(300);
    const r = await get('/api/reports/financial/B02?from=2026-01-01&to=2026-03-31&comparePrevYear=true');
    expect(r.statusCode, r.body).toBe(200);
    expect(rowOf(r, '01').current).toBe('500'); expect(rowOf(r, '11').current).toBe('300'); expect(rowOf(r, '50').current).toBe('200'); expect(rowOf(r, '60').current).toBe('300');
    expect(rowOf(r, '01').previous).toBe('0');
    const no = await get('/api/reports/financial/B02?from=2026-01-01&to=2026-03-31');
    expect(rowOf(no, '01').previous).toBeNull();
  });
  it('so sánh năm trước dịch cả hai đầu khoảng lùi một năm', async () => {
    const r = await get('/api/reports/financial/B02?from=2027-01-01&to=2027-03-31&comparePrevYear=true');
    expect(r.statusCode, r.body).toBe(200); // 2027 chưa có kỳ: hệ lấy theo kỳ gần nhất trước đó
    expect(rowOf(r, '01').current).toBe('0'); expect(rowOf(r, '01').previous).toBe('500');
  });
  it('B01 sau kết chuyển vẫn khớp: lợi nhuận nằm ở 421 thay vì ở doanh thu/chi phí', async () => {
    const r = await get('/api/reports/financial/B01?from=2026-01-01&to=2026-03-31');
    expect(rowOf(r, '421').current).toBe('200'); expect(rowOf(r, '440').current).toBe('1300'); expect(rowOf(r, '100').current).toBe('1300');
  });
  it('truy ngược chỉ tiêu 131 ra từng đối tượng; công thức sai bị 400', async () => {
    const d = await get('/api/reports/financial/B01/lines/131?from=2026-01-01&to=2026-03-31');
    expect(d.json().accounts).toEqual([{ accountCode: '131', accountName: expect.any(String), partyCode: 'KH001', amount: '500' }]);
    const bad = await put('B01', 'TT133', [{ ...MINI_B01[0], formula: '[111] +' }]);
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('FORMULA_INVALID');
  });
  it('truy ngược theo phát sinh, đối ứng, tổng hợp; loại trừ trong công thức được tôn trọng', async () => {
    const mv = await get('/api/reports/financial/B02/lines/11?from=2026-01-01&to=2026-03-31');
    expect(mv.json().accounts).toEqual([{ accountCode: '6421', accountName: expect.any(String), partyCode: null, amount: '300' }]);
    const pr = await get('/api/reports/financial/B02/lines/60?from=2026-01-01&to=2026-03-31');
    expect(pr.json().accounts).toEqual([{ accountCode: '911', accountName: expect.any(String), counterAccountCode: '6421', partyCode: null, amount: '300' }]);
    expect((await get('/api/reports/financial/B02/lines/50?from=2026-01-01&to=2026-03-31')).json().accounts).toEqual([]); // dòng tổng hợp [01]-[11] không có tài khoản trực tiếp
    const all = await get('/api/reports/financial/B02?from=2026-01-01&to=2026-03-31');
    expect(rowOf(all, '71').current).toBe('300'); expect(rowOf(all, '70').current).toBe('0');
    expect((await get('/api/reports/financial/B02/lines/70?from=2026-01-01&to=2026-03-31')).json().accounts).toEqual([]);
    expect((await get('/api/reports/financial/B02/lines/71?from=2026-01-01&to=2026-03-31')).json().accounts).toHaveLength(1);
    const none = await get('/api/reports/financial/B02/lines/KHONGCO?from=2026-01-01&to=2026-03-31');
    expect([none.statusCode, none.json().error.code]).toEqual([404, 'REPORT_LINE_NOT_FOUND']);
  });
  it('lưu định nghĩa sai (dòng không tồn tại, vòng lặp, hệ không hợp lệ) bị từ chối và không đổi gì', async () => {
    const before = (await get('/api/report-defs/B01?regime=TT133')).json().lines;
    for (const lines of [[{ ...MINI_B01[0], formula: '[999]' }], [{ ...MINI_B01[0], formula: '[100]' }]]) {
      const r = await put('B01', 'TT133', lines);
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'FORMULA_INVALID']);
    }
    expect((await put('B01', 'TT999', MINI_B01)).statusCode).toBe(400);
    expect((await get('/api/report-defs/B01?regime=TT133')).json().lines).toEqual(before);
    expect(before).toHaveLength(MINI_B01.length);
    expect(before[0]).toMatchObject({ lineCode: '100', formula: '[111]+[131]', source: 'lines', side: 'net_debit', isBold: false, negate: false, noteRef: null });
  });
  it('báo cáo chưa định nghĩa: 404; khoảng ngày đảo ngược: 400; B01 ngoài mọi năm tài chính: 404', async () => {
    const r = await get('/api/reports/financial/B03?from=2026-01-01&to=2026-03-31');
    expect([r.statusCode, r.json().error.code]).toEqual([404, 'REPORT_NOT_FOUND']);
    expect((await get('/api/reports/financial/B02?from=2026-03-31&to=2026-01-01')).statusCode).toBe(400);
    const far = await get('/api/reports/financial/B01?from=2031-01-01&to=2031-03-31');
    expect([far.statusCode, far.json().error.code]).toEqual([404, 'PERIOD_NOT_FOUND']);
  });
  it('lưu định nghĩa sai cấu trúc bị 400 và không đổi gì: mã dòng trùng, thiếu dòng cha, dòng tự làm cha, vòng dòng cha', async () => {
    const before = (await get('/api/report-defs/B01?regime=TT133')).json().lines;
    const line = (lineCode: string, parentLineCode: string | null) => ({ lineCode, label: lineCode, parentLineCode, source: 'balance', side: 'net_debit', formula: '111' });
    const cases: [string, object[]][] = [
      ['trùng mã dòng', [line('A', null), line('A', null)]], ['thiếu dòng cha', [line('A', 'KHONGCO')]],
      ['tự làm cha', [line('A', 'A')]], ['vòng A -> B -> A', [line('A', 'B'), line('B', 'A')]], ['vòng không chứa dòng gốc', [line('R', 'A'), line('A', 'B'), line('B', 'A')]]];
    for (const [name, lines] of cases) {
      const r = await put('B01', 'TT133', lines);
      expect([r.statusCode, r.json().error.code], name).toEqual([400, 'VALIDATION']);
    }
    expect((await get('/api/report-defs/B01?regime=TT133')).json().lines).toEqual(before);
    expect((await put('B01', 'TT133', [line('A', null), line('B', 'A'), line('C', 'B')])).statusCode).toBe(200); // cây hợp lệ vẫn lưu được
    expect((await put('B01', 'TT133', MINI_B01)).statusCode).toBe(200); // trả lại định nghĩa cho các kiểm thử sau
  });
  it('mã báo cáo chỉ là B01, B02 hoặc B03', async () => {
    const q = 'from=2026-01-01&to=2026-03-31';
    expect((await get(`/api/reports/financial/B09?${q}`)).statusCode).toBe(400);
    expect((await get(`/api/reports/financial/B09/lines/1?${q}`)).statusCode).toBe(400);
    expect((await get('/api/report-defs/B09?regime=TT133')).statusCode).toBe(400);
    expect((await put('B09', 'TT133', MINI_B01)).statusCode).toBe(400);
    expect((await post('/api/report-defs/B09/reload', { regime: 'TT133' })).statusCode).toBe(400);
  });
  it('xem định nghĩa cần report_def.view, sửa và nạp lại cần report_def.update', async () => {
    const roles = (await get('/api/roles')).json() as { id: string; code: string }[];
    const setRole = (permissions: string[]) => ctx.app.inject({ method: 'PUT', url: `/api/roles/${roles.find((x) => x.code === 'xem')!.id}/permissions`, headers: { cookie }, payload: { permissions } });
    const username = `xemdef_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] } });
    const login = async () => `sid=${(await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } })).cookies.find((c) => c.name === 'sid')!.value}`;
    const calls = (c: string) => Promise.all([get('/api/report-defs/B01?regime=TT133', c), put('B01', 'TT133', MINI_B01, c), post('/api/report-defs/B01/reload', { regime: 'TT133' }, c)]).then((rs) => rs.map((r) => r.statusCode));
    await setRole(['report.view']);
    const c1 = await login();
    expect(await calls(c1)).toEqual([403, 403, 403]);
    expect((await get('/api/reports/financial/B01?from=2026-01-01&to=2026-03-31', c1)).statusCode).toBe(200); // xem báo cáo chỉ cần report.view
    await setRole(['report.view', 'report_def.view']);
    expect(await calls(await login())).toEqual([200, 403, 403]);
    await setRole(['report.view', 'report_def.view', 'report_def.update']);
    expect(await calls(await login())).toEqual([200, 200, 200]);
    expect((await put('B01', 'TT133', MINI_B01)).statusCode).toBe(200); // lần nạp lại ở trên đã đưa mẫu hệ thống về: trả lại định nghĩa nhỏ
    expect((await get('/api/report-defs/B01?regime=TT133')).json().lines).toHaveLength(MINI_B01.length);
  });
  it('danh sách báo cáo theo hệ hoặc theo năm', async () => {
    const byRegime = await get('/api/reports/financial?regime=TT133');
    expect(byRegime.json().map((x: { reportCode: string; formNo: string }) => [x.reportCode, x.formNo])).toEqual([['B01', 'B01a-DNN'], ['B02', 'B02-DNN']]);
    const byYear = await get('/api/reports/financial?year=2026');
    expect(byYear.json()).toHaveLength(2);
    expect((await get('/api/reports/financial?regime=TT200')).json()).toEqual([]);
    expect((await get('/api/reports/financial?year=1999')).json()).toEqual([]);
  });
  it('nạp lại mẫu hệ thống thay định nghĩa đã sửa của đúng báo cáo đó; hệ lạ bị 400', async () => {
    const r = await post('/api/report-defs/B01/reload', { regime: 'TT133' });
    expect([r.statusCode, r.json()]).toEqual([200, { lines: 47 }]);
    expect((await get('/api/report-defs/B01?regime=TT133')).json().lines).toHaveLength(47);
    expect((await put('B01', 'TT133', MINI_B01)).statusCode).toBe(200); // trả lại định nghĩa nhỏ cho các kiểm thử sau
    expect((await post('/api/report-defs/B01/reload', { regime: 'TT999' })).statusCode).toBe(400);
  });
  it('người thiếu cờ xem công nợ xem được báo cáo nhưng không truy ngược được 131 theo đối tượng', async () => {
    const username = `xemcn_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c2 = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await get('/api/reports/financial/B01?from=2026-01-01&to=2026-03-31', c2)).statusCode).toBe(200);
    expect((await get('/api/reports/financial/B01/lines/131?from=2026-01-01&to=2026-03-31', c2)).statusCode).toBe(403);
    expect((await get('/api/reports/financial/B01/lines/111?from=2026-01-01&to=2026-03-31', c2)).statusCode).toBe(200);
  });
});

describe('B03 tiền đầu kỳ', () => {
  it('dòng 60 là số dư đầu kỳ thật (kể cả khi kỳ báo cáo bắt đầu giữa năm), tiền chuyển giữa 111 và 112 triệt tiêu; 50 + 60 + 61 = 70', async () => {
    const { cookie: c } = await bootstrapTenant(ctx, { code: `B3${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    const row = (accountCode: string, debit: string, credit: string) => ({ accountCode, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', partyCode: null });
    await ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie: c }, payload: { rows: [row('1111', '1000', '0'), row('4111', '0', '1000')] } });
    await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie: c } });
    await ok(pkt('2026-02-01', [{ accountCode: '1111', debit: '500' }, { accountCode: '5113', credit: '500' }], c));
    await ok(pkt('2026-02-10', [{ accountCode: '1121', debit: '400' }, { accountCode: '1111', credit: '400' }], c)); // tiền sang tiền
    await ok(pkt('2026-03-01', [{ accountCode: '6422', debit: '300' }, { accountCode: '1121', credit: '300' }], c));
    const val = (r: { json(): { rows: Row[] } }, code: string) => rowOf(r, code).current;
    const full = await get('/api/reports/financial/B03?from=2026-01-01&to=2026-03-31', c);
    expect(full.statusCode, full.body).toBe(200);
    expect([val(full, '60'), val(full, '70'), val(full, '50'), val(full, '61')]).toEqual(['1000', '1200', '200', '0']);
    const mid = await get('/api/reports/financial/B03?from=2026-02-05&to=2026-03-31', c);
    expect([val(mid, '60'), val(mid, '70'), val(mid, '50')]).toEqual(['1500', '1200', '-300']);
  });
});

describe('shiftYear', () => {
  it('lùi/tiến năm giữ tháng ngày; 29/2 về 28/2 ở năm không nhuận, giữ 29/2 ở năm nhuận', () => {
    expect(shiftYear('2024-02-29', -1)).toBe('2023-02-28'); expect(shiftYear('2024-02-29', 1)).toBe('2025-02-28'); expect(shiftYear('2024-02-29', 4)).toBe('2028-02-29');
    expect(shiftYear('2026-03-31', -1)).toBe('2025-03-31'); expect(shiftYear('2026-01-01', -1)).toBe('2025-01-01'); expect(shiftYear('2024-12-31', 1)).toBe('2025-12-31');
  });
});

describe('mẫu hệ thống sao chép vào công ty', () => {
  const tpl = (regime: string, code: string, lines: [string, string, string, string][]) => lines.map(([line_code, label, source, formula], i) => ({ regime, report_code: code, line_code, label, parent_line_code: null, source, side: 'net_debit', formula, sort_order: i + 1, is_bold: false, negate: false, note_ref: null }));
  it('tạo năm tài chính sao chép mẫu; nạp lại chỉ một báo cáo, báo cáo khác đã sửa được giữ', async () => {
    // Mẫu thật còn chờ văn bản nên bảng mẫu rỗng: dựng mẫu tạm bằng quyền quản trị và dọn lại.
    const rows = [...tpl('TT200', 'B01', [['10', 'Tiền', 'balance', '111'], ['20', 'Cộng', 'lines', '[10]']]), ...tpl('TT200', 'B02', [['01', 'Doanh thu', 'movement', '511'], ['02', 'Giá vốn', 'movement', '632']])];
    await ctx.t.admin.insertInto('report_template').values(rows).execute();
    try {
      const { cookie: c } = await bootstrapTenant(ctx, { code: `FT${Date.now()}` });
      expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT200' } })).statusCode).toBe(201);
      const list = await get('/api/reports/financial?regime=TT200', c);
      expect(list.json().map((x: { reportCode: string; formNo: string; name: string }) => [x.reportCode, x.formNo])).toEqual([['B01', ''], ['B02', '']]); // TT200 chưa có văn bản gốc: không có số mẫu
      expect(list.json()[0].name).toBe('Bảng cân đối kế toán');
      expect((await get('/api/report-defs/B02?regime=TT200', c)).json().lines.map((l: { lineCode: string }) => l.lineCode)).toEqual(['01', '02']);
      // Sửa cả hai báo cáo rồi nạp lại B02: B02 về mẫu, B01 giữ bản đã sửa.
      expect((await put('B01', 'TT200', [{ lineCode: 'X', label: 'Đã sửa', parentLineCode: null, source: 'balance', side: 'net_debit', formula: '112' }], c)).statusCode).toBe(200);
      expect((await put('B02', 'TT200', [{ lineCode: 'Y', label: 'Đã sửa', parentLineCode: null, source: 'movement', side: 'net_debit', formula: '641' }], c)).statusCode).toBe(200);
      expect((await post('/api/report-defs/B02/reload', { regime: 'TT200' }, c)).json()).toEqual({ lines: 2 });
      expect((await get('/api/report-defs/B02?regime=TT200', c)).json().lines.map((l: { lineCode: string }) => l.lineCode)).toEqual(['01', '02']);
      expect((await get('/api/report-defs/B01?regime=TT200', c)).json().lines.map((l: { lineCode: string }) => l.lineCode)).toEqual(['X']);
      // Năm tài chính sau không ghi đè định nghĩa đã có của hệ đó.
      expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT200' } })).statusCode).toBe(201);
      expect((await get('/api/report-defs/B01?regime=TT200', c)).json().lines.map((l: { lineCode: string }) => l.lineCode)).toEqual(['X']);
    } finally { await sql`DELETE FROM report_template WHERE regime = 'TT200'`.execute(ctx.t.admin); }
  });
});

describe('một công ty giữ nhiều hệ tài khoản', () => {
  it('báo cáo của năm TT133 không lẫn tài khoản TT200 của năm sau, kể cả khi khoảng ngày vắt sang năm sau', async () => {
    const { cookie: c } = await bootstrapTenant(ctx, { code: `FM${Date.now()}` });
    const fy = (fiscalYear: number, regime: string) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime } });
    expect((await fy(2026, 'TT133')).statusCode).toBe(201); expect((await fy(2027, 'TT200')).statusCode).toBe(201);
    // Cùng mã tài khoản (1111, 5113, 911, 131...) tồn tại ở cả hai hệ: tiền tố không được quét sang hệ khác.
    await ok(pkt('2026-05-01', [{ accountCode: '1111', debit: '100' }, { accountCode: '5113', credit: '100' }], c));
    await ok(pkt('2027-05-01', [{ accountCode: '1111', debit: '40' }, { accountCode: '5113', credit: '40' }], c));
    expect((await put('B01', 'TT133', [{ lineCode: '10', label: 'Tiền', parentLineCode: null, source: 'balance', side: 'net_debit', formula: '111' }], c)).statusCode).toBe(200);
    expect((await put('B02', 'TT133', [{ lineCode: '01', label: 'Doanh thu', parentLineCode: null, source: 'movement', side: 'net_credit', formula: '511' }, { lineCode: '02', label: 'Đối ứng', parentLineCode: null, source: 'pair', side: 'net_debit', formula: 'N1111/C5113' }], c)).statusCode).toBe(200);
    const b01 = await get('/api/reports/financial/B01?from=2026-01-01&to=2027-12-31', c);
    expect(b01.statusCode, b01.body).toBe(200); expect(b01.json().regime).toBe('TT133');
    expect(rowOf(b01, '10').current).toBe('100');
    const b02 = await get('/api/reports/financial/B02?from=2026-01-01&to=2027-12-31', c);
    expect(rowOf(b02, '01').current).toBe('100'); expect(rowOf(b02, '02').current).toBe('100');
    const drill = await get('/api/reports/financial/B01/lines/10?from=2026-01-01&to=2027-12-31', c);
    expect(drill.json().accounts).toEqual([{ accountCode: '1111', accountName: expect.any(String), partyCode: null, amount: '100' }]);
    // Báo cáo TT200 của năm 2027 chỉ thấy số của hệ TT200.
    expect((await put('B02', 'TT200', [{ lineCode: '01', label: 'Doanh thu', parentLineCode: null, source: 'movement', side: 'net_credit', formula: '511' }], c)).statusCode).toBe(200);
    expect(rowOf(await get('/api/reports/financial/B02?from=2027-01-01&to=2027-12-31', c), '01').current).toBe('40');
  });
  it('cột so sánh để trống (previous null, previousNote REGIME_CHANGED) khi ngày so sánh thuộc kỳ của chế độ khác', async () => {
    const { cookie: c } = await bootstrapTenant(ctx, { code: `FN${Date.now()}` });
    const fy = (fiscalYear: number, regime: string) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime } });
    expect((await fy(2026, 'TT133')).statusCode).toBe(201); expect((await fy(2027, 'TT200')).statusCode).toBe(201);
    await ok(pkt('2026-05-01', [{ accountCode: '1111', debit: '100' }, { accountCode: '5113', credit: '100' }], c));
    await ok(pkt('2027-05-01', [{ accountCode: '1111', debit: '40' }, { accountCode: '5113', credit: '40' }], c));
    const b01 = [{ lineCode: '10', label: 'Tiền', parentLineCode: null, source: 'balance', side: 'net_debit', formula: '111' }, { lineCode: '20', label: 'Cộng', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[10]' }];
    const b02 = [{ lineCode: '01', label: 'Doanh thu', parentLineCode: null, source: 'movement', side: 'net_credit', formula: '511' }];
    for (const regime of ['TT133', 'TT200']) { expect((await put('B01', regime, b01, c)).statusCode).toBe(200); expect((await put('B02', regime, b02, c)).statusCode).toBe(200); }

    // B01 năm 2027 (TT200): số đầu năm là dư ngày 31/12/2026 của hệ TT133 -> để trống, không phải 0.
    const r = await get('/api/reports/financial/B01?from=2027-01-01&to=2027-12-31', c);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ regime: 'TT200', previousNote: 'REGIME_CHANGED' });
    expect(r.json().rows.map((x: Row) => [x.lineCode, x.current, x.previous])).toEqual([['10', '40', null], ['20', '40', null]]);
    // B02 năm 2027 so sánh năm trước: cùng kỳ năm 2026 thuộc TT133 -> để trống; không so sánh thì không có ghi chú.
    const b = await get('/api/reports/financial/B02?from=2027-01-01&to=2027-12-31&comparePrevYear=true', c);
    expect(b.json()).toMatchObject({ regime: 'TT200', previousNote: 'REGIME_CHANGED' }); expect(rowOf(b, '01')).toMatchObject({ current: '40', previous: null });
    const nb = await get('/api/reports/financial/B02?from=2027-01-01&to=2027-12-31', c);
    expect(nb.json().previousNote).toBeUndefined(); expect(rowOf(nb, '01').previous).toBeNull();
    // Cùng chế độ thì vẫn có số so sánh: năm đầu tiên (kỳ 0 cùng chế độ) và B01 TT133 có khoảng ngày vắt sang năm sau.
    const first = await get('/api/reports/financial/B01?from=2026-01-01&to=2026-12-31', c);
    expect(first.json().previousNote).toBeUndefined(); expect(rowOf(first, '10')).toMatchObject({ current: '100', previous: '0' });
    const span = await get('/api/reports/financial/B01?from=2026-01-01&to=2027-12-31', c);
    expect(span.json()).toMatchObject({ regime: 'TT133' }); expect(span.json().previousNote).toBeUndefined(); expect(rowOf(span, '10')).toMatchObject({ current: '100', previous: '100' });
    // Bản in dùng cùng dữ liệu: cột so sánh in trống (ô số rỗng), không in 0.
    const html = await get('/api/reports/financial/B01?from=2027-01-01&to=2027-12-31&format=html', c);
    expect(html.statusCode, html.body).toBe(200); expect(html.body.match(/<td class="num"><\/td>/g)).toHaveLength(2);
  });
});

describe('số dư theo đối tượng gộp nhiều loại tiền', () => {
  it('dư Nợ/Có của một đối tượng là dư ròng gộp loại tiền, không cộng riêng từng loại tiền', async () => {
    const { cookie: c } = await bootstrapTenant(ctx, { code: `FX${Date.now()}` });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).statusCode).toBe(201);
    await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie: c }, payload: { code: 'KH003', name: 'K3', is_customer: true } });
    // KH003 mua chịu 1.000 USD (25.400.000 đồng) rồi trả 10.000.000 đồng: dư ròng Nợ 15.400.000 đồng. Theo từng loại tiền sẽ ra Nợ 25.400.000 và Có 10.000.000.
    const usd = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: c }, payload: { voucherType: 'PKT', postingDate: '2026-02-01', documentDate: '2026-02-01', description: 'USD', autoPost: true, currencyCode: 'USD', fxRate: '25400',
      lines: [{ accountCode: '131', debit: '25400000', amountCurrency: '1000', partyCode: 'KH003' }, { accountCode: '5113', credit: '25400000', amountCurrency: '-1000' }] } });
    expect(usd.statusCode, usd.body).toBe(201);
    await ok(pkt('2026-02-02', [{ accountCode: '1111', debit: '10000000' }, { accountCode: '131', credit: '10000000', partyCode: 'KH003' }], c));
    const lines = [{ lineCode: 'D', label: 'Dư Nợ 131', parentLineCode: null, source: 'balance', side: 'debit', formula: '131' }, { lineCode: 'C', label: 'Dư Có 131', parentLineCode: null, source: 'balance', side: 'credit', formula: '131' },
      { lineCode: 'N', label: 'Ròng 131', parentLineCode: null, source: 'balance', side: 'net_debit', formula: '131' }];
    expect((await put('B01', 'TT133', lines, c)).statusCode).toBe(200);
    const r = await get('/api/reports/financial/B01?from=2026-01-01&to=2026-12-31', c);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rows.map((x: Row) => [x.lineCode, x.current])).toEqual([['D', '15400000'], ['C', '0'], ['N', '15400000']]);
    const d = await get('/api/reports/financial/B01/lines/D?from=2026-01-01&to=2026-12-31', c);
    expect(d.json().accounts).toEqual([{ accountCode: '131', accountName: expect.any(String), partyCode: 'KH003', amount: '15400000' }]);
  });
});
