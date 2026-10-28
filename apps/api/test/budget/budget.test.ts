import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { computeRatios } from '../../src/modules/budget/analytics.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const months = (m: Record<number, string>) => Array.from({ length: 12 }, (_, i) => m[i + 1] ?? '0');
const pkt = (date: string, lines: object[], autoPost = true) => call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost, lines });
const chi = (date: string, amount: string, extra: object = {}) => pkt(date, [{ accountCode: '6422', debit: amount, ...extra }, { accountCode: '1111', credit: amount }]);
let budgetId: number;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await setupLedgerTenant(ctx, `NS${Date.now()}`, 'TT133'));
  for (const [t, p] of [['department', { code: 'KD', name: 'Kinh doanh' }], ['cost_item', { code: 'CP_VP', name: 'Văn phòng phẩm' }]] as const) expect((await call('POST', `/api/catalogs/${t}`, p)).statusCode).toBe(201);
  // Thực tế 2026: tháng 1 chi 6422 = 1.000, bán hàng 5113 = 5.000; tháng 2 chi 6422 = 500 (bộ phận KD); giá vốn 632 = 700.
  expect((await pkt('2026-01-10', [{ accountCode: '1111', debit: '5000' }, { accountCode: '5113', credit: '5000' }])).statusCode).toBe(201);
  expect((await chi('2026-01-15', '1000')).statusCode).toBe(201);
  expect((await chi('2026-02-10', '500', { departmentCode: 'KD' })).statusCode).toBe(201);
  expect((await pkt('2026-02-12', [{ accountCode: '632', debit: '700' }, { accountCode: '1111', credit: '700' }])).statusCode).toBe(201);
}, 90_000);
afterAll(async () => { await ctx.close(); });

describe('ngân sách: lập, sửa, duyệt', () => {
  it('lập ngân sách nháp; tiền tố không có tài khoản, mã bộ phận lạ, số tiền lẻ bị từ chối', async () => {
    const base = { fiscalYear: 2026, name: 'Ngân sách 2026', lines: [{ accountPrefix: '642', months: months({ 1: '1200', 2: '800' }) }, { accountPrefix: '6422', departmentCode: 'KD', months: months({ 2: '400' }) }, { accountPrefix: '511', months: months({ 1: '4000' }) }] };
    const bad = (lines: object[]) => call('POST', '/api/budgets', { ...base, lines });
    expect((await bad([{ accountPrefix: '999', months: months({}) }])).json().error.code).toBe('BUDGET_ACCOUNT_INVALID');
    expect((await bad([{ accountPrefix: '642', departmentCode: 'ZZZ', months: months({}) }])).json().error.code).toBe('BUDGET_DIM_INVALID');
    expect((await bad([{ accountPrefix: '642', months: months({ 1: '10.5' }) }])).statusCode).toBe(400);
    expect((await call('POST', '/api/budgets', { ...base, fiscalYear: 2030 })).json().error.code).toBe('FISCAL_YEAR_NOT_FOUND');
    const r = await call('POST', '/api/budgets', base); expect(r.statusCode, r.body).toBe(201);
    budgetId = r.json().id;
    expect(r.json()).toMatchObject({ version: 1, status: 'draft', lines: [{ accountPrefix: '642', total: '2000' }, { departmentCode: 'KD' }, { accountPrefix: '511' }] });
  });

  it('báo cáo thực hiện: tháng, lũy kế, cả năm, chênh lệch và % từ sổ cái; bút toán đảo triệt tiêu', async () => {
    const r = await call('GET', `/api/budgets/${budgetId}/report?month=2`); expect(r.statusCode, r.body).toBe(200);
    const [l642, l6422, l511] = r.json().lines;
    expect(l642.month).toEqual({ budget: '800', actual: '500', diff: '-300', pct: '62.5' });
    expect(l642.ytd).toEqual({ budget: '2000', actual: '1500', diff: '-500', pct: '75' });
    expect(l642.year.budget).toBe('2000');
    expect(l6422.month.actual).toBe('500'); expect(l6422.ytd.actual).toBe('500'); // chỉ bộ phận KD
    expect(l511.ytd).toEqual({ budget: '4000', actual: '5000', diff: '1000', pct: '125' });
    expect(r.json().totals.expense.ytd.actual).toBe('2000');
    const rev = await chi('2026-03-05', '300'); const reverse = await call('POST', `/api/vouchers/${rev.json().id}/reverse`, { postingDate: '2026-03-06' });
    expect(reverse.statusCode, reverse.body).toBeLessThan(300);
    expect((await call('GET', `/api/budgets/${budgetId}/report?month=3`)).json().lines[0].ytd.actual).toBe('1500');
  });

  it('truy ngược dòng ngân sách tới dòng chứng từ', async () => {
    const r = await call('GET', `/api/budgets/${budgetId}/lines/${(await call('GET', `/api/budgets/${budgetId}`)).json().lines[0].id}/entries?month=1`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rows).toMatchObject([{ accountCode: '6422', amount: '1000', postingDate: '2026-01-15' }]);
  });

  it('cờ nhạy cảm: người dùng không có view_cost bị chặn khi xem thực hiện dòng 632; có thể xem dòng khác', async () => {
    const mk = async (flags: string[]) => {
      const username = `ns_${flags.length}_${Date.now()}`;
      expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: flags })).statusCode).toBe(201);
      return `sid=${(await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } })).cookies.find((x) => x.name === 'sid')!.value}`;
    };
    const none = await mk([]);
    const cost = await call('POST', '/api/budgets', { fiscalYear: 2026, name: 'Giá vốn', lines: [{ accountPrefix: '632', months: months({ 2: '1000' }) }] });
    const id = cost.json().id;
    const denied = await call('GET', `/api/budgets/${id}/report?month=2`, undefined, none);
    expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'FORBIDDEN']);
    expect((await call('GET', `/api/budgets/${id}/report?month=2`, undefined, none)).statusCode).toBe(403);
    expect((await call('GET', `/api/budgets/${id}/report?month=2`)).statusCode).toBe(200);
    expect((await call('GET', `/api/budgets/${budgetId}/report?month=2`, undefined, none)).statusCode).toBe(200);
    expect((await call('GET', `/api/analytics/overview?year=2026&month=2`, undefined, none)).json()).toMatchObject({ hidden: ['view_cost', 'view_receivable', 'view_payable'], ratios: null });
    expect((await call('DELETE', `/api/budgets/${id}`)).statusCode).toBe(204);
  });

  it('duyệt: chỉ một bản đã duyệt mỗi năm, bản cũ thành superseded; bản đã duyệt không sửa được, tạo phiên bản mới', async () => {
    const a = await call('POST', `/api/budgets/${budgetId}/approve`); expect(a.statusCode, a.body).toBe(200); expect(a.json().status).toBe('approved');
    expect((await call('PUT', `/api/budgets/${budgetId}`, { name: 'x', lines: [] })).json().error.code).toBe('BUDGET_NOT_DRAFT');
    expect((await call('DELETE', `/api/budgets/${budgetId}`)).statusCode).toBe(409);
    const v2 = await call('POST', `/api/budgets/${budgetId}/new-version`); expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, status: 'draft' }); expect(v2.json().lines).toHaveLength(3);
    expect((await call('POST', `/api/budgets/${v2.json().id}/approve`)).statusCode).toBe(200);
    const list = (await call('GET', '/api/budgets?year=2026')).json() as { id: number; status: string }[];
    expect(list.find((x) => x.id === budgetId)!.status).toBe('superseded');
    expect(list.filter((x) => x.status === 'approved')).toHaveLength(1);
    budgetId = v2.json().id;
  });
});

describe('Excel và sao chép từ thực tế', () => {
  it('xuất rồi nhập lại cho ra cùng dòng; lỗi theo dòng/cột; ngân sách đã duyệt không nhập được', async () => {
    const d = await call('POST', '/api/budgets', { fiscalYear: 2026, name: 'Nháp Excel', lines: [] }); const id = d.json().id;
    const book = new ExcelJS.Workbook(); const ws = book.addWorksheet('Du_lieu');
    const keys = ['accountPrefix', 'costItemCode', 'departmentCode', 'projectCode', ...Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`), 'note'];
    ws.addRow(keys); ws.addRow(keys); ws.addRow(['642']);
    ws.addRow(['6422', 'CP_VP', 'KD', '', 100, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 'ghi chú']);
    const upload = async (buf: Buffer, url: string) => {
      const boundary = '----kt'; const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      return ctx.app.inject({ method: 'POST', url, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([head, buf, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    };
    const buf = Buffer.from(await book.xlsx.writeBuffer());
    expect((await upload(buf, `/api/budgets/${id}/import-lines?mode=validate`)).json()).toEqual({ mode: 'validate', lines: 1 });
    expect((await call('GET', `/api/budgets/${id}`)).json().lines).toHaveLength(0); // validate không ghi
    expect((await upload(buf, `/api/budgets/${id}/import-lines?mode=commit`)).statusCode).toBe(200);
    const got = (await call('GET', `/api/budgets/${id}`)).json();
    expect(got.lines[0]).toMatchObject({ accountPrefix: '6422', costItemCode: 'CP_VP', departmentCode: 'KD', total: '600', note: 'ghi chú' }); expect(got.lines[0].months[11]).toBe('300');
    const exp = await call('GET', `/api/budgets/${id}/export.xlsx`); expect(exp.statusCode).toBe(200);
    const re = await upload(exp.rawPayload, `/api/budgets/${id}/import-lines?mode=commit`); expect(re.statusCode, re.body).toBe(200);
    expect((await call('GET', `/api/budgets/${id}`)).json().lines[0]).toMatchObject({ accountPrefix: '6422', total: '600' });
    ws.addRow(['6422', '', '', '', -5]);
    const bad = await upload(Buffer.from(await book.xlsx.writeBuffer()), `/api/budgets/${id}/import-lines?mode=validate`);
    expect(bad.statusCode).toBe(400); expect(bad.json().error.details[0]).toMatchObject({ row: 5, column: 'm01' });
    expect((await upload(buf, `/api/budgets/${budgetId}/import-lines?mode=commit`)).json().error.code).toBe('BUDGET_NOT_DRAFT');
    expect((await call('GET', '/api/budgets/template.xlsx')).statusCode).toBe(200);
    expect((await call('DELETE', `/api/budgets/${id}`)).statusCode).toBe(204);
  });

  it('sao chép từ thực tế năm trước × hệ số (làm tròn), bỏ số âm', async () => {
    // Cần năm nguồn: dùng chính 2026 làm nguồn cho ngân sách 2026 (nháp) để kiểm số học; 632 hiện cho người có view_cost.
    const r = await call('POST', '/api/budgets/copy-actual', { fiscalYear: 2026, sourceYear: 2026, name: 'Sao chép 1,25', factor: '1.25' }); expect(r.statusCode, r.body).toBe(201);
    const by = Object.fromEntries((r.json().budget.lines as { accountPrefix: string; months: string[] }[]).map((l) => [l.accountPrefix, l.months]));
    expect(by['6422']![0]).toBe('1250'); expect(by['6422']![1]).toBe('625'); expect(by['632']![1]).toBe('875'); expect(by['5113']![0]).toBe('6250');
    expect(r.json().skipped).toEqual([]);
    await call('DELETE', `/api/budgets/${r.json().budget.id}`);
  });
});

describe('cảnh báo vượt ngân sách khi ghi sổ', () => {
  // Ngân sách đã duyệt (v2): 642 lũy kế đến tháng 3 = 2.000, đã thực hiện 1.500 (75%); 6422/KD tháng 2 = 400, thực tế 500 (125%).
  const put = (s: object) => call('PUT', '/api/budget-settings', s);
  it('tắt mặc định: ghi sổ không cảnh báo', async () => {
    expect((await call('GET', '/api/budget-settings')).json()).toEqual({ enabled: false, warnPct: 90, blockPct: null });
    const r = await chi('2026-03-10', '400'); expect(r.statusCode).toBe(201); expect(r.json().warnings).toBeUndefined();
  });
  it('cấu hình sai bị từ chối; mức mềm 90%: ghi sổ vẫn được, phản hồi có cảnh báo', async () => {
    expect((await put({ enabled: true, warnPct: 90, blockPct: 80 })).statusCode).toBe(400);
    expect((await put({ enabled: true, warnPct: 90, blockPct: null })).statusCode).toBe(200);
    // 1.500 + 400 (đã ghi ở trên) = 1.900 → 95%; thêm 10 vẫn cảnh báo.
    const r = await chi('2026-03-11', '10'); expect(r.statusCode, r.body).toBe(201);
    expect(r.json().state).toBe('posted'); expect(r.json().warnings).toMatchObject([{ code: 'BUDGET_WARNING', accountPrefix: '642', pct: '95.5' }]);
    expect(r.json().warnings[0].message).not.toMatch(/\d{4}/); // không nêu số tiền
  });
  it('mức cứng 100%: vượt thì 409 BUDGET_EXCEEDED và chứng từ không được ghi sổ (nháp còn nguyên)', async () => {
    expect((await put({ enabled: true, warnPct: 90, blockPct: 100 })).statusCode).toBe(200);
    const blocked = await chi('2026-03-12', '200'); // 1.910 + 200 = 2.110 > 2.000
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('BUDGET_EXCEEDED');
    const d = await pkt('2026-03-12', [{ accountCode: '6422', debit: '200' }, { accountCode: '1111', credit: '200' }], false); expect(d.statusCode).toBe(201);
    const post = await call('POST', `/api/vouchers/${d.json().id}/post`); expect(post.statusCode).toBe(409); expect(post.json().error.code).toBe('BUDGET_EXCEEDED');
    expect((await call('GET', `/api/vouchers/${d.json().id}`)).json().state).toBe('draft');
    expect((await call('GET', `/api/budgets/${budgetId}/report?month=3`)).json().lines[0].ytd.actual).toBe('1910');
  });
  it('chứng từ không chạm dòng chi phí có ngân sách hoặc không làm tăng chi phí không bị kiểm tra', async () => {
    expect((await pkt('2026-03-13', [{ accountCode: '1111', debit: '50' }, { accountCode: '5113', credit: '50' }])).statusCode).toBe(201);
    expect((await put({ enabled: false, warnPct: 90, blockPct: null })).statusCode).toBe(200);
  });
});

describe('phân tích tài chính', () => {
  it('tổng quan năm: doanh thu, chi phí, lợi nhuận theo tháng; tiền cuối tháng; ngân sách so thực tế', async () => {
    const r = await call('GET', '/api/analytics/overview?year=2026&month=2'); expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j.hidden).toEqual([]); expect(j.months).toHaveLength(12);
    expect(j.months[0]).toMatchObject({ month: 1, revenue: '5000', expense: '1000', profit: '4000', cash: '4000' });
    expect(j.months[1]).toMatchObject({ month: 2, revenue: '0', expense: '1200', profit: '-1200', cash: '2800' });
    expect(j.summary).toMatchObject({ revenue: '5000', expense: '2200', profit: '2800' });
    expect(j.budget.expense[1]).toMatchObject({ month: 2, budget: '1200' });
  });
  it('hệ số: chỉ tính khi định nghĩa có đúng mã dòng và nhãn; thiếu thì bỏ', () => {
    const b02 = [{ lineCode: '10', label: '3. Doanh thu thuần về bán hàng', current: '1000' }, { lineCode: '20', label: '5. Lợi nhuận gộp', current: '250' }, { lineCode: '60', label: '15. Lợi nhuận sau thuế thu nhập doanh nghiệp', current: '100' }];
    const tt99 = [{ lineCode: '100', label: 'A - TÀI SẢN NGẮN HẠN', current: '600' }, { lineCode: '310', label: 'I. Nợ ngắn hạn', current: '300' }, { lineCode: '140', label: 'IV. Hàng tồn kho', current: '200' },
      { lineCode: '280', label: 'TỔNG CỘNG TÀI SẢN (280 = 100 + 200)', current: '1000' }, { lineCode: '300', label: 'C - NỢ PHẢI TRẢ', current: '400' }, { lineCode: '400', label: 'D - VỐN CHỦ SỞ HỮU', current: '600' }];
    const r = Object.fromEntries(computeRatios({ B01: tt99, B02: b02 }).map((x) => [x.code, x.value]));
    expect(r).toMatchObject({ current: '2', quick: '1.33', debt_assets: '40', debt_equity: '0.67', gross_margin: '25', net_margin: '10', roa: '10', roe: '16.67' });
    expect(r['inventory_turnover']).toBeUndefined(); // không có dòng giá vốn (11) trong B02 mẫu này
    // TT133: không có tài sản ngắn hạn / nợ ngắn hạn → bỏ hệ số thanh toán; mã 200 trùng nhãn khác thì không bị dùng sai.
    const tt133 = [{ lineCode: '200', label: 'TỔNG CỘNG TÀI SẢN', current: '1000' }, { lineCode: '300', label: 'I. Nợ phải trả', current: '250' }];
    expect(computeRatios({ B01: tt133, B02: [] }).map((x) => x.code)).toEqual(['debt_assets']);
    expect(computeRatios({ B01: [{ lineCode: '200', label: 'B - TÀI SẢN DÀI HẠN', current: '1' }, { lineCode: '300', label: 'C - NỢ PHẢI TRẢ', current: '5' }], B02: [] })).toEqual([]);
  });
  it('hệ số của công ty TT133 qua API là mảng (có thể rỗng), không lỗi', async () => {
    const j = (await call('GET', '/api/analytics/overview?year=2026&month=12')).json();
    expect(Array.isArray(j.ratios)).toBe(true);
  });
});
