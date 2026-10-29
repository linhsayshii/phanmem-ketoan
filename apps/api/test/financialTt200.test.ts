import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
// B01-DN, B02-DN, B03-DN của TT 200/2014/TT-BTC (mẫu hệ thống packages/coa-data/data/reports/tt200) chạy trên sổ cái thật của công ty TT200 năm 2025.
let ctx: TestApp; let cookie: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines } });
const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });
const ok = async (p: ReturnType<typeof pkt>) => { const r = await p; expect(r.statusCode, r.body).toBe(201); return r; };
type Row = { lineCode: string; current: string };
const val = (r: { json(): { rows: Row[] } }, c: string) => r.json().rows.find((x) => x.lineCode === c)?.current;
const report = async (code: string) => { const r = await get(`/api/reports/financial/${code}?from=2025-01-01&to=2025-12-31`); expect(r.statusCode, r.body).toBe(200); return r; };

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `T2${Date.now()}` }));
  const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2025, dateFrom: '2025-01-01', months: 12, regime: 'TT200' } });
  expect(fy.statusCode, fy.body).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'K1', is_customer: true } });
  await ok(pkt('2025-01-05', [{ accountCode: '1111', debit: '1000000' }, { accountCode: '41111', credit: '1000000' }]));
  await ok(pkt('2025-02-01', [{ accountCode: '131', debit: '500000', partyCode: 'KH001' }, { accountCode: '5111', credit: '500000' }]));
  await ok(pkt('2025-02-02', [{ accountCode: '632', debit: '100000' }, { accountCode: '1111', credit: '100000' }]));
  await ok(pkt('2025-02-03', [{ accountCode: '6421', debit: '50000' }, { accountCode: '1111', credit: '50000' }]));
  await ok(pkt('2025-02-04', [{ accountCode: '1111', debit: '100000' }, { accountCode: '131', credit: '100000', partyCode: 'KH001' }]));
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('báo cáo tài chính TT 200/2014 (B01-DN, B02-DN, B03-DN)', () => {
  it('công ty TT200 có đủ ba báo cáo với số mẫu và chú thích của Phụ lục 2', async () => {
    const list = await get('/api/reports/financial?regime=TT200');
    expect(list.json().map((x: { reportCode: string; formNo: string; name: string }) => [x.reportCode, x.formNo, x.name])).toEqual([
      ['B01', 'B01-DN', 'Bảng cân đối kế toán'], ['B02', 'B02-DN', 'Báo cáo kết quả hoạt động kinh doanh'], ['B03', 'B03-DN', 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)']]);
    expect((await report('B01')).json()).toMatchObject({ formNo: 'B01-DN', issuedBy: 'Ban hành theo Thông tư số 200/2014/TT-BTC ngày 22/12/2014 của Bộ Tài chính', regime: 'TT200' });
  });
  it('B02: doanh thu, giá vốn, chi phí quản lý doanh nghiệp, lợi nhuận trước thuế và sau thuế', async () => {
    const r = await report('B02');
    expect(['01', '10', '11', '20', '26', '30', '50', '60'].map((c) => val(r, c))).toEqual(['500000', '500000', '100000', '400000', '50000', '350000', '350000', '350000']);
    expect(r.json().approximations.fixedZero).toEqual(['70', '71']);
  });
  it('B01 trước kết chuyển lệch bằng lãi lỗ chưa kết chuyển; sau kết chuyển tổng tài sản (270) = tổng nguồn vốn (440)', async () => {
    const before = await report('B01');
    expect(['111', '131', '270', '411', '421', '440'].map((c) => val(before, c))).toEqual(['950000', '400000', '1350000', '1000000', '0', '1000000']);
    const kc = await ctx.app.inject({ method: 'POST', url: '/api/closing/run-all', headers: { cookie }, payload: { postingDate: '2025-12-31' } });
    expect(kc.statusCode, kc.body).toBeLessThan(300);
    const after = await report('B01');
    expect(['270', '421', '421b', '440'].map((c) => val(after, c))).toEqual(['1350000', '350000', '350000', '1350000']);
    expect(after.json().approximations.fixedZero).toEqual(['112', '219', '241', '261', '263', '340']);
    // B02 vẫn lấy phát sinh trước kết chuyển.
    expect(val(await report('B02'), '01')).toBe('500000');
  });
  it('B03 trực tiếp: dòng tiền theo cặp đối ứng, tiền cuối kỳ (70) = đầu kỳ (60) + lưu chuyển thuần (50) + tỷ giá (61) = tiền ở B01', async () => {
    const r = await report('B03');
    expect(['01', '02', '20', '31', '40', '50', '60', '61', '70'].map((c) => val(r, c))).toEqual(['100000', '150000', '-50000', '1000000', '1000000', '950000', '0', '0', '950000']);
    expect(val(r, '70')).toBe(val(await report('B01'), '111'));
  });
});
