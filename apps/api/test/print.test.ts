import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { moneyCell, renderReportXlsx } from '../src/modules/reporting/print/excel.js';
import { assertPrintable, MAX_PRINT_ROWS, renderReportBody, type ReportDoc } from '../src/modules/reporting/print/html.js';
import { closePdfBrowser, limitConcurrency, renderPdf } from '../src/modules/reporting/print/pdf.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // PDF dựng bằng Chromium và nhiều lần gọi DB
let ctx: TestApp; let cookie: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `PR${Date.now()}` }));
  await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: { name: 'Công ty TNHH In Thử', address: '1 Tràng Tiền', legalRep: 'Lê Văn C', chiefAccountant: 'Phạm Thị D' } });
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Mua giấy', autoPost: true, lines: [{ accountCode: '6422', debit: '2500000' }, { accountCode: '1111', credit: '2500000' }] } });
});
afterAll(async () => { await ctx.close(); });

describe('in sổ', () => {
  it('Nhật ký chung HTML không có số mẫu chưa đối chiếu (S03a-DNN), có tên công ty, số tiền; PDF hợp lệ', async () => {
    const h = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-01-31&format=html', headers: { cookie } });
    expect(h.body).not.toContain('<td class="num">0</td>'); // dòng dữ liệu: số 0 để trống như sổ giấy; dòng cộng giữ nguyên
    expect(h.body).not.toContain('S03a-DNN'); expect(h.body).not.toContain('Mẫu số'); expect(h.body).toContain('Công ty TNHH In Thử'); expect(h.body).toContain('SỔ NHẬT KÝ CHUNG'); expect(h.body).toContain('2.500.000'); expect(h.body).toContain('Phạm Thị D');
    const p = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-01-31&format=pdf', headers: { cookie } });
    expect(p.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(p.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('nhat-ky-chung-2026-01-01-2026-01-31.pdf')}`);
  });
  it('Bảng cân đối số phát sinh xuất Excel đọc lại được với số dạng số', async () => {
    const x = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-01-31&format=xlsx', headers: { cookie } });
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!; expect(ws.name).toContain('S06');
    let found = false; ws.eachRow((row) => { row.eachCell((c) => { if (typeof c.value === 'number' && c.value === 2500000) { found = true; expect(c.numFmt).toContain('#,##0'); } }); }); expect(found).toBe(true);
  });
  it('PDF: bảng cân đối số phát sinh in khổ ngang, Nhật ký chung in khổ dọc, trong cùng một bộ sổ mỗi sổ một khổ', async () => {
    const mediaBoxes = (b: Buffer) => [...b.toString('latin1').matchAll(/\/MediaBox \[0 0 (\d+)\.\d+ (\d+)\.\d+\]/g)].map((m) => (Number(m[1]) > Number(m[2]) ? 'ngang' : 'dọc'));
    const one = (path: string) => ctx.app.inject({ method: 'GET', url: `/api/reports/ledgers/${path}&format=pdf`, headers: { cookie } });
    expect(mediaBoxes((await one('trial-balance?from=2026-01-01&to=2026-01-31')).rawPayload)).toEqual(['ngang']);
    expect(mediaBoxes((await one('general-journal?from=2026-01-01&to=2026-01-31')).rawPayload)).toEqual(['dọc']);
    const set = await ctx.app.inject({ method: 'POST', url: '/api/print/book-set', headers: { cookie }, payload: { fiscalYear: 2026, include: ['journal', 'trial'], format: 'pdf' } });
    expect(mediaBoxes(set.rawPayload)).toEqual(['dọc', 'ngang']);
  });
  it('in liên tục cả bộ sổ năm ra một PDF và một XLSX nhiều sheet', async () => {
    const p = await ctx.app.inject({ method: 'POST', url: '/api/print/book-set', headers: { cookie }, payload: { fiscalYear: 2026, include: ['journal', 'ledgers', 'trial'], format: 'pdf' } });
    expect(p.statusCode, p.body).toBe(200); expect(p.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const x = await ctx.app.inject({ method: 'POST', url: '/api/print/book-set', headers: { cookie }, payload: { fiscalYear: 2026, include: ['journal', 'ledgers', 'trial'], format: 'xlsx' } });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(4); // NKC + Sổ cái 1111 + Sổ cái 6422 + BCĐPS
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['S03a NKC', 'S03b 1111', 'S03b 6422', 'S06 BCĐPS']));
  });
});

describe('in sổ: nội dung, hệ tài khoản, quyền', () => {
  const MINI_B01 = [
    { lineCode: '100', label: 'A. Tài sản', parentLineCode: null, source: 'lines', side: 'net_debit', formula: null, isBold: true },
    { lineCode: '111', label: 'Tiền', parentLineCode: '100', source: 'balance', side: 'net_debit', formula: '111+112' },
    { lineCode: '1111', label: 'Tiền mặt', parentLineCode: '111', source: 'balance', side: 'net_debit', formula: '1111' },
  ];
  let c2: string; let tenant2: string; let restricted: string;
  const get = (url: string, c = c2) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
  const post = (url: string, payload: object, c = c2) => ctx.app.inject({ method: 'POST', url, headers: { cookie: c }, payload });
  const pkt = (date: string, description: string, lines: object[]) => post('/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description, autoPost: true, lines });
  const userCookie = async (roleCode: string, sensitiveFlags: string[]) => {
    const username = `in_${roleCode}_${Date.now()}`;
    const made = await post('/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
    expect(made.statusCode, made.body).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };

  beforeAll(async () => {
    ({ cookie: c2, tenantId: tenant2 } = await bootstrapTenant(ctx, { code: `PS${Date.now()}` }));
    await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie: c2 }, payload: { name: 'Công ty Hai Hệ', address: '2 Hàng Bài', legalRep: 'Lê Văn C', chiefAccountant: 'Phạm Thị D' } });
    // Hai hệ tài khoản trong một công ty: 6421 là "Chi phí bán hàng" ở TT133 nhưng là "Chi phí nhân viên quản lí" ở TT200.
    expect((await post('/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
    expect((await post('/api/fiscal-years', { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT200', confirmRegimeOverride: true })).statusCode).toBe(201);
    expect((await post('/api/catalogs/party', { code: 'KH001', name: 'Khách một', is_customer: true })).statusCode).toBe(201);
    expect((await pkt('2026-01-05', '<script>alert(1)</script>', [{ accountCode: '6421', debit: '100000' }, { accountCode: '1111', credit: '100000' }])).statusCode).toBe(201);
    expect((await pkt('2026-01-06', 'Bán chịu', [{ accountCode: '131', debit: '500000', partyCode: 'KH001' }, { accountCode: '5113', credit: '500000' }])).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/report-defs/B01', headers: { cookie: c2 }, payload: { regime: 'TT133', lines: MINI_B01 } })).statusCode).toBe(200);
    await ctx.t.admin.deleteFrom('report_def').where('tenant_id', '=', tenant2).where('report_code', 'in', ['B02', 'B03']).execute(); // mẫu hệ thống đã sao chép khi tạo năm: bỏ để có báo cáo chưa định nghĩa
    restricted = await userCookie('ketoan_truong', []);
  });

  it('Sổ Cái: tên tài khoản theo đúng hệ của kỳ, diễn giải được thoát ký tự, không in số mẫu chưa đối chiếu', async () => {
    const r = await get('/api/reports/ledgers/account?accountCode=6421&from=2026-01-01&to=2026-01-31&format=html');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain('S03b-DNN'); expect(r.body).toContain('SỔ CÁI – TÀI KHOẢN 6421 – CHI PHÍ BÁN HÀNG'); expect(r.body).not.toContain('NHÂN VIÊN QUẢN LÍ');
    expect(r.body).toContain('&lt;script&gt;'); expect(r.body).not.toContain('<script>alert');
    expect(r.body).toContain('Số dư đầu kỳ'); expect(r.body).toContain('Số dư cuối kỳ'); expect(r.body).toContain('100.000');
    // Tên tài khoản ở TT133 và TT200 khác nhau: trong năm 2027 (TT200) cùng mã in tên của hệ TT200.
    const y = await get('/api/reports/ledgers/account?accountCode=6421&from=2027-01-01&to=2027-01-31&format=html');
    expect(y.body).toContain('CHI PHÍ NHÂN VIÊN QUẢN LÍ'); expect(y.body).not.toContain('S03b-DN');
  });

  it('Sổ chi tiết theo đối tượng không in số mẫu chưa đối chiếu (S20-DNN); mã đối tượng sai báo 404', async () => {
    const r = await get('/api/reports/ledgers/detail?accountCode=131&partyCode=KH001&from=2026-01-01&to=2026-01-31&format=html');
    expect(r.statusCode, r.body).toBe(200); expect(r.body).not.toContain('S20-DNN'); expect(r.body).toContain('Đối tượng KH001'); expect(r.body).toContain('500.000');
    const bad = await get('/api/reports/ledgers/detail?accountCode=131&partyCode=KHONGCO&from=2026-01-01&to=2026-01-31&format=html');
    expect([bad.statusCode, bad.json().error.code]).toEqual([404, 'LOOKUP_NOT_FOUND']);
  });

  it('BCTC: in theo định nghĩa của công ty (thụt lề, số đầu năm), báo cáo chưa định nghĩa báo 404', async () => {
    const r = await get('/api/reports/financial/B01?from=2026-01-01&to=2026-01-31&format=html');
    expect(r.statusCode, r.body).toBe(200); expect(r.body).toContain('Cách lấy số gần đúng'); // GĐ7 gói 2: chú thích dòng gần đúng của B01 TT133
    expect(r.body).toContain('B01a-DNN'); expect(r.body).toContain('BÁO CÁO TÌNH HÌNH TÀI CHÍNH'); expect(r.body).toContain('Tại ngày 31/01/2026'); expect(r.body).toContain('Số đầu năm');
    expect(r.body).toContain('        Tiền mặt'); // dòng cấp 3 thụt hai bậc; khoảng trắng thường sẽ bị trình duyệt gộp mất
    expect(r.body).toContain('(100.000)'); // 1111 dư Có vì chưa có số dư đầu: số âm in trong ngoặc, khớp màn hình
    const x = await get('/api/reports/financial/B01?from=2026-01-01&to=2026-01-31&format=xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.name).toBe('B01a-DNN');
    const missing = await get('/api/reports/financial/B02?from=2026-01-01&to=2026-01-31&format=pdf');
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'REPORT_NOT_FOUND']);
  });

  it('format lạ bị từ chối; năm tài chính không có bị 404; chỉ chọn báo cáo chưa định nghĩa thì báo không có gì để in', async () => {
    expect((await get('/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-01-31&format=docx')).statusCode).toBe(400);
    expect((await post('/api/print/book-set', { fiscalYear: 1999, include: ['trial'], format: 'xlsx' })).json().error.code).toBe('PERIOD_NOT_FOUND');
    const none = await post('/api/print/book-set', { fiscalYear: 2026, include: ['B02'], format: 'xlsx' });
    expect([none.statusCode, none.json().error.code]).toEqual([404, 'NOTHING_TO_PRINT']);
    const some = await post('/api/print/book-set', { fiscalYear: 2026, include: ['B01', 'B02', 'trial'], format: 'xlsx' }); // B02 chưa định nghĩa: bỏ qua, các phần còn lại vẫn in
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(some.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['S06 BCĐPS', 'B01a-DNN']);
  });

  it('người thiếu quyền report.print xem được JSON nhưng không in được', async () => {
    const c = await userCookie('xem', ['view_receivable', 'view_payable', 'view_cost', 'view_salary']);
    await ctx.t.admin.deleteFrom('role_permission').where('tenant_id', '=', tenant2).where('permission_code', '=', 'report.print').where('role_id', 'in', ctx.t.admin.selectFrom('role').select('id').where('tenant_id', '=', tenant2).where('code', '=', 'xem')).execute();
    const url = '/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-01-31';
    expect((await get(url, c)).statusCode).toBe(200);
    expect((await get(`${url}&format=html`, c)).statusCode).toBe(403);
    expect((await post('/api/print/book-set', { fiscalYear: 2026, include: ['trial'], format: 'xlsx' }, c)).statusCode).toBe(403);
  });

  it('bộ sổ năm cần cả report.view lẫn report.print', async () => {
    const c = await userCookie('ketoan_vien', ['view_receivable', 'view_payable', 'view_cost', 'view_salary']);
    const body = { fiscalYear: 2026, include: ['trial'], format: 'xlsx' };
    expect((await post('/api/print/book-set', body, c)).statusCode).toBe(200);
    await ctx.t.admin.deleteFrom('role_permission').where('tenant_id', '=', tenant2).where('permission_code', '=', 'report.view').where('role_id', 'in', ctx.t.admin.selectFrom('role').select('id').where('tenant_id', '=', tenant2).where('code', '=', 'ketoan_vien')).execute();
    expect((await post('/api/print/book-set', body, c)).statusCode).toBe(403); // còn report.print nhưng không còn report.view
  });

  it('người thiếu cờ công nợ/giá vốn: sổ 131 và 632 không in được, bộ sổ có Sổ Cái hoặc Nhật ký chung bị 403', async () => {
    expect((await get('/api/reports/ledgers/account?accountCode=131&from=2026-01-01&to=2026-01-31&format=html', restricted)).statusCode).toBe(403);
    expect((await get('/api/reports/ledgers/detail?accountCode=632&from=2026-01-01&to=2026-01-31&format=html', restricted)).statusCode).toBe(403);
    expect((await get('/api/reports/ledgers/account?accountCode=1111&from=2026-01-01&to=2026-01-31&format=html', restricted)).statusCode).toBe(200);
    for (const include of [['ledgers'], ['journal'], ['trial'], ['trial', 'ledgers']]) expect((await post('/api/print/book-set', { fiscalYear: 2026, include, format: 'xlsx' }, restricted)).statusCode, include.join()).toBe(403);
    expect((await post('/api/print/book-set', { fiscalYear: 2026, include: ['B01'], format: 'xlsx' }, restricted)).statusCode).toBe(200); // báo cáo tài chính không bị che
    expect((await post('/api/print/book-set', { fiscalYear: 2026, include: ['ledgers'], format: 'xlsx' })).statusCode).toBe(200); // chủ công ty có đủ cờ
  });
});

describe('Excel: ô tiền', () => {
  const doc = (v: unknown): ReportDoc => ({ title: 'T', formNo: 'X', issuedBy: '', company: { name: 'C', address: null, taxCode: null, legalRep: null, chiefAccountant: null, formNo: 'X', issuedBy: '' }, subtitle: '', sheetName: 'X',
    columns: [{ key: 'm', label: 'Tiền', type: 'number' }], rows: [{ m: v }] });
  const read = async (v: unknown) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await renderReportXlsx([doc(v)])) as unknown as ArrayBuffer); let out: ExcelJS.CellValue = null; wb.worksheets[0]!.getRow(7).eachCell((c) => { out = c.value; }); return out; };
  it('chỉ ghi số khi chuỗi thập phân khứ hồi đúng; tiền quá 2^53 hoặc có phần lẻ ghi dạng chuỗi, không làm tròn', async () => {
    expect(await read('2500000')).toBe(2500000);
    expect(await read('-1500')).toBe(-1500);
    expect(await read('1500000.0000')).toBe(1500000); // NUMERIC(20,4) nguyên
    expect(await read('0')).toBe(0);
    expect(await read('12345678901234567')).toBe('12345678901234567');
    expect(await read('9007199254740993')).toBe('9007199254740993'); // 2^53 + 1: Number() sẽ làm tròn thành ...992
    expect(await read('1234.5')).toBe('1234.5');
    expect(await read(null)).toBeNull();
  });
});

describe('Excel: ô tiền có phần lẻ (nguyên tệ)', () => {
  it('cột có scale ghi số khi khứ hồi đúng và tối đa 15 chữ số có nghĩa; dài hơn hoặc quá lớn ghi chuỗi, không làm tròn lặng lẽ', () => {
    expect(moneyCell('1200.5000', 4)).toBe(1200.5);
    expect(moneyCell('0.0001', 4)).toBe(0.0001);
    expect(moneyCell('-30492700.0000', 4)).toBe(-30492700);
    expect(moneyCell('123456789012.3456', 4)).toBe('123456789012.3456'); // 16 chữ số: quá 15, ghi chuỗi
    expect(moneyCell('12345678901.2345', 4)).toBe(12345678901.2345); // 15 chữ số
    expect(moneyCell('1234567890123456.1234', 4)).toBe('1234567890123456.1234');
    expect(moneyCell('99999999999999999999.9999', 4)).toBe('99999999999999999999.9999');
    expect(moneyCell('1200.5000')).toBe('1200.5'); // không scale: giữ quy tắc cũ, có phần lẻ ghi chuỗi
    expect(moneyCell('', 4)).toBeNull();
  });
});

describe('in sổ: nội dung ô, kích thước, PDF', () => {
  const company = { name: 'C', address: null, taxCode: null, legalRep: null, chiefAccountant: null, formNo: 'X', issuedBy: '' };
  const doc = (over: Partial<ReportDoc>): ReportDoc => ({ title: 'T', formNo: 'X', issuedBy: '', company, subtitle: '', columns: [{ key: 'd', label: 'Ngày', type: 'date' }, { key: 'm', label: 'Tiền', type: 'number' }], rows: [], ...over });

  it('số 0 để trống ở dòng dữ liệu, giữ ở dòng đậm (số dư, cộng) và dòng cộng cuối bảng; ô ngày được thoát ký tự', () => {
    const html = renderReportBody(doc({ rows: [{ d: '2026-01-05', m: '0' }, { d: '2026-01-06', m: '0.0000' }, { d: '<b>x</b>', m: '1500' }, { m: '0', isBold: true }], footer: { m: '0' } }));
    const cells = [...html.matchAll(/<td class="num">([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(['', '', '1.500', '0', '0']);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;'); expect(html).not.toContain('<b>x</b>');
  });

  it('PDF/HTML quá 40.000 dòng bị chặn 413 PRINT_TOO_LARGE, đúng ngưỡng thì cho qua', () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({}));
    expect(() => assertPrintable([doc({ rows: rows(MAX_PRINT_ROWS - 10) }), doc({ rows: rows(10) })])).not.toThrow();
    expect(() => assertPrintable([doc({ rows: rows(MAX_PRINT_ROWS) }), doc({ rows: rows(1) })])).toThrow(expect.objectContaining({ code: 'PRINT_TOO_LARGE', status: 413, message: 'Sổ quá lớn để in PDF một lần; hãy xuất Excel hoặc in theo từng sổ/khoảng ngày' }));
  });

  it('Excel: cột rộng theo ô dài nhất, tối đa 60', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderReportXlsx([doc({ sheetName: 'W', columns: [{ key: 'tk', label: 'TK' }, { key: 'description', label: 'Diễn giải' }, { key: 'm', label: 'Tiền', type: 'number' }],
      rows: [{ tk: '1111', description: 'x'.repeat(100), m: '2500000' }, { tk: '6422', description: 'ngắn', m: '3' }] })])) as unknown as ArrayBuffer);
    const w = (i: number) => wb.worksheets[0]!.getColumn(i).width;
    expect([w(1), w(2), w(3)]).toEqual([10, 60, 11]); // TK: tối thiểu 10; Diễn giải: bị chặn ở 60; Tiền: "2,500,000" + 2
  });

  it('semaphore: tối đa 2 tác vụ chạy cùng lúc, tác vụ lỗi vẫn trả chỗ cho người chờ', async () => {
    const run = limitConcurrency(2); let live = 0; let peak = 0; const done: number[] = [];
    const task = (i: number, fail = false) => run(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; done.push(i); if (fail) throw new Error('lỗi'); return i; });
    const results = await Promise.allSettled([task(0), task(1, true), task(2), task(3), task(4, true), task(5)]);
    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
    expect(done).toHaveLength(6);
  });

  it('Chromium không chạy được: renderPdf báo PDF_RENDER_FAILED (500) với thông báo chung, lần sau vẫn dựng được', async () => {
    const saved = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await closePdfBrowser(); process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '/khong/co/chromium';
    try { await expect(renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'PDF_RENDER_FAILED', status: 500, message: 'Không tạo được tệp PDF; hãy thử in theo từng phần hoặc xuất Excel' }); }
    finally { if (saved === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = saved; err.mockRestore(); }
    expect((await renderPdf('<p>x</p>')).subarray(0, 4).toString()).toBe('%PDF');
  });
});
