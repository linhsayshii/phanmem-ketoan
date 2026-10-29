import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { calcOtherTax } from '../src/modules/hkdbooks/books.js';

// Số liệu kiểm thử tính tay. Tỷ lệ thuế dưới đây là số giả định cho kiểm thử (phần mềm không đặt sẵn tỷ lệ pháp lý nào).
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

interface Doc { title: string; formNo: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown>; outro?: string[] }
async function setup(code: string, regime: 'TT152' | 'TT58', dateFrom: string, year: number) {
  const { cookie } = await bootstrapTenant(ctx, { code });
  const h = { cookie };
  const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: h, payload: { fiscalYear: year, dateFrom, months: 12, regime } });
  expect([fy.statusCode, fy.json()]).toEqual([201, { periods: 13 }]);
  const post = async (url: string, payload: unknown, expectCode = 201) => { const r = await ctx.app.inject({ method: 'POST', url, headers: h, payload: payload as object }); expect([url, r.statusCode, r.statusCode === expectCode ? '' : r.body]).toEqual([url, expectCode, '']); return r.json() as { id: number }; };
  const put = async (url: string, payload: unknown) => { const r = await ctx.app.inject({ method: 'PUT', url, headers: h, payload: payload as object }); expect([url, r.statusCode]).toEqual([url, 200]); return r.json(); };
  const entry = (e: Record<string, unknown>) => post('/api/hkd/entries', { docNo: null, ...e });
  const book = async (c: string, from: string, to: string, extra = '') => { const r = await ctx.app.inject({ method: 'GET', url: `/api/hkd/books/${c}?from=${from}&to=${to}${extra}`, headers: h }); expect([c, r.statusCode, r.statusCode === 200 ? '' : r.body]).toEqual([c, 200, '']); return (r.json() as { docs: Doc[] }).docs; };
  return { h, post, put, entry, book };
}
const row = (d: Doc, desc: string) => d.rows.find((r) => r.desc === desc) as Record<string, unknown>;

describe('TT 152/2025 hộ kinh doanh: tạo năm tài chính, sổ doanh thu theo nhóm, doanh thu chi phí, tiền', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup(`HK${Date.now()}`, 'TT152', '2026-01-01', 2026);
    const g1 = await s.post('/api/hkd/groups', { code: 'BL', name: 'Bán lẻ hàng hóa', vatRate: '1', incomeRate: '0.5' });
    const g2 = await s.post('/api/hkd/groups', { code: 'DV', name: 'Dịch vụ', vatRate: '5', incomeRate: '2' });
    await s.put('/api/hkd/settings/2026', { taxMethod: 'income', incomeTaxRate: '15' });
    const rev = (date: string, docNo: string, group: number, amount: string, money: string | null, desc = 'Bán hàng') => s.entry({ entryDate: date, docNo, description: desc, kind: 'revenue', amount, groupId: group, moneyAccount: money });
    await s.entry({ entryDate: '2026-01-01', description: 'Tiền mặt đầu năm', kind: 'opening', amount: '1000000', openingRef: 'cash', moneyAccount: 'TM' });
    await rev('2026-01-05', 'HD01', g1.id, '10000000', 'TM'); await rev('2026-01-10', 'HD02', g1.id, '5500000', 'VCB'); await rev('2026-01-20', 'HD03', g2.id, '3333333', 'TM', 'Sửa chữa');
    await s.entry({ entryDate: '2026-01-12', docNo: 'PC01', description: 'Mua hàng', kind: 'expense', amount: '4000000', expenseCat: 'a', moneyAccount: 'TM' });
    await s.entry({ entryDate: '2026-01-14', docNo: 'PC02', description: 'Tiền điện', kind: 'expense', amount: '1000000', expenseCat: 'd', moneyAccount: 'VCB' });
    await s.entry({ entryDate: '2026-01-31', docNo: 'PC03', description: 'Lương', kind: 'expense', amount: '2000000', expenseCat: 'b', moneyAccount: 'TM' });
  });

  it('tạo năm tài chính TT152 chỉ tạo kỳ, không sinh hệ thống tài khoản', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT152', headers: s.h });
    expect(r.statusCode === 200 ? (r.json() as unknown[]).length : 0).toBe(0);
  });

  it('S2a-HKD: doanh thu theo ngành nghề, thuế GTGT và TNCN làm tròn nửa lên: BL 15.500.000 -> 155.000 và 77.500; DV 3.333.333 -> 166.667 và 66.667', async () => {
    const [d] = await s.book('S2a-HKD', '2026-01-01', '2026-01-31');
    expect(d!.formNo).toBe('S2a-HKD');
    expect(d!.columns.map((c) => c.key)).toEqual(['docNo', 'date', 'desc', 'amount']);
    expect(d!.rows.filter((r) => String(r.desc).startsWith('Tổng cộng')).map((r) => r.amount)).toEqual(['15500000', '3333333']);
    const vat = d!.rows.filter((r) => r.desc === 'Thuế GTGT').map((r) => r.amount); const inc = d!.rows.filter((r) => r.desc === 'Thuế TNCN').map((r) => r.amount);
    expect([vat, inc]).toEqual([['155000', '166667'], ['77500', '66667']]);
    expect(row(d!, 'Tổng số thuế GTGT phải nộp').amount).toBe('321667');
    expect(row(d!, 'Tổng số thuế TNCN phải nộp').amount).toBe('144167');
  });

  it('S2b-HKD (Điều 6) chỉ có thuế GTGT; S1a-HKD tổng doanh thu 18.833.333', async () => {
    const [d] = await s.book('S2b-HKD', '2026-01-01', '2026-01-31');
    expect(d!.rows.some((r) => r.desc === 'Thuế TNCN')).toBe(false);
    expect(row(d!, 'Tổng số thuế GTGT phải nộp').amount).toBe('321667');
    const [a] = await s.book('S1a-HKD', '2026-01-01', '2026-01-31');
    expect([a!.rows.length, a!.footer!.amount]).toEqual([3, '18833333']);
  });

  it('S2c-HKD: doanh thu 18.833.333, chi phí 7.000.000, chênh lệch 11.833.333, thuế TNCN theo thuế suất khai báo 15% = 1.775.000', async () => {
    const [d] = await s.book('S2c-HKD', '2026-01-01', '2026-01-31');
    expect(row(d!, '1. Doanh thu bán hàng hóa, dịch vụ').amount).toBe('18833333');
    expect(row(d!, '2. Chi phí hợp lý').amount).toBe('7000000');
    expect(d!.rows.filter((r) => /^[a-eđ]\) /.test(String(r.desc))).map((r) => r.amount)).toEqual(['4000000', '2000000', '0', '1000000', '0', '0']);
    expect(row(d!, '3. Chênh lệch {(3) = (1) - (2)}').amount).toBe('11833333');
    expect(row(d!, '4. Tổng số thuế TNCN phải nộp {(4) = (3) x thuế suất}').amount).toBe('1775000');
  });

  it('S2c-HKD: lỗ thì thuế 0; chưa khai thuế suất thì thuế 0 kèm chú thích', async () => {
    const [d] = await s.book('S2c-HKD', '2026-02-01', '2026-02-28');
    expect(row(d!, '4. Tổng số thuế TNCN phải nộp {(4) = (3) x thuế suất}').amount).toBe('0');
  });

  it('S2e-HKD: tiền mặt tồn đầu 1.000.000, thu 13.333.333, chi 6.000.000, tồn cuối 8.333.333; VCB thu 5.500.000, chi 1.000.000, tồn cuối 4.500.000', async () => {
    const [d] = await s.book('S2e-HKD', '2026-01-01', '2026-01-31');
    const find = (desc: string, nth = 0) => d!.rows.filter((r) => r.desc === desc)[nth] as Record<string, unknown>;
    expect(find('Tiền mặt tồn đầu kỳ').in).toBe('1000000');
    expect([find('Tổng tiền thu vào trong kỳ').in, find('Tổng tiền chi ra trong kỳ').out, find('Tiền mặt tồn cuối kỳ').in]).toEqual(['13333333', '6000000', '8333333']);
    expect([find('Tổng tiền gửi vào trong kỳ').in, find('Tổng tiền rút ra trong kỳ').out, find('Tiền gửi tồn cuối kỳ').in]).toEqual(['5500000', '1000000', '4500000']);
    expect(d!.rows.some((r) => r.desc === 'Ngân hàng VCB')).toBe(true);
  });

  it('S2e-HKD: kỳ sau lấy tồn cuối kỳ trước làm tồn đầu kỳ', async () => {
    const [d] = await s.book('S2e-HKD', '2026-02-01', '2026-02-28');
    expect(d!.rows.find((r) => r.desc === 'Tiền mặt tồn đầu kỳ')!.in).toBe('8333333');
    expect(d!.rows.find((r) => r.desc === 'Tiền gửi tồn đầu kỳ')!.in).toBe('4500000');
  });

  it('S2d-HKD: đơn giá xuất kho bình quân tháng: T1 (1.000.000 + 650.000) / 150 = 11.000; T2 (550.000 + 1.200.000) / 150', async () => {
    const it1 = await s.post('/api/hkd/stock-items', { code: 'VT1', name: 'Gạo', unit: 'kg' });
    const mv = (moveDate: string, direction: string, quantity: string, unitPrice: string | null, description: string) => s.post('/api/hkd/stock-moves', { itemId: it1.id, moveDate, docNo: null, direction, quantity, unitPrice, description });
    await mv('2026-01-02', 'opening', '100', '10000', 'Tồn đầu'); await mv('2026-01-10', 'in', '50', '13000', 'Nhập'); await mv('2026-01-15', 'out', '60', null, 'Xuất bán'); await mv('2026-01-25', 'out', '40', null, 'Xuất bán');
    await mv('2026-02-05', 'in', '100', '12000', 'Nhập'); await mv('2026-02-10', 'out', '30', null, 'Xuất bán');
    const [jan] = await s.book('S2d-HKD', '2026-01-01', '2026-01-31');
    const outs = jan!.rows.filter((r) => r.desc === 'Xuất bán');
    expect(outs.map((r) => [r.price, r.outQty, r.outAmt, r.stockQty, r.stockAmt])).toEqual([['11000', '60', '660000', '90', '990000'], ['11000', '40', '440000', '50', '550000']]);
    expect(row(jan!, 'Cộng phát sinh trong kỳ')).toMatchObject({ inQty: '150', inAmt: '1650000', outQty: '100', outAmt: '1100000' });
    expect(row(jan!, 'Số dư cuối kỳ')).toMatchObject({ stockQty: '50', stockAmt: '550000' });
    const [feb] = await s.book('S2d-HKD', '2026-02-01', '2026-02-28');
    expect(row(feb!, 'Số dư đầu kỳ')).toMatchObject({ stockQty: '50', stockAmt: '550000' });
    expect(feb!.rows.find((r) => r.outQty)).toMatchObject({ outQty: '30', outAmt: '350000' });
    expect(row(feb!, 'Số dư cuối kỳ')).toMatchObject({ stockQty: '120', stockAmt: '1400000' });
    expect(feb!.columns).toHaveLength(12);
  });

  it('S3a-HKD: thuế khác theo công thức của thông tư (cột 5 = 1x3x4, cột 6 = 1x2, 8 = 1x2, 9 = 1x3x4, 10 = 1x3x4)', async () => {
    await s.post('/api/hkd/other-taxes', { entryDate: '2026-01-10', description: 'Hàng chịu TTĐB', taxKind: 'xnk_ttdb', quantity: '100', unitPrice: '50000', ratePct: '10' });
    await s.post('/api/hkd/other-taxes', { entryDate: '2026-01-11', description: 'Xăng', taxKind: 'env', quantity: '200', absRate: '2000' });
    await s.post('/api/hkd/other-taxes', { entryDate: '2026-01-12', description: 'Cát', taxKind: 'resource', quantity: '10', unitPrice: '1000000', ratePct: '5' });
    await s.post('/api/hkd/other-taxes', { entryDate: '2026-01-13', description: 'Đất', taxKind: 'land', quantity: '1', unitPrice: '3000000', ratePct: '0.03' });
    const [d] = await s.book('S3a-HKD', '2026-01-01', '2026-01-31');
    expect(d!.footer).toMatchObject({ pct: '500000', abs: '0', xnk: '500000', env: '400000', res: '500000', land: '900' });
    expect(d!.columns).toHaveLength(12);
  });

  it('sổ lạ trả 404 BOOK_NOT_FOUND (mọi sổ và báo cáo trong định nghĩa đều đã dựng)', async () => {
    const r2 = await ctx.app.inject({ method: 'GET', url: '/api/hkd/books/S9-HKD?from=2026-01-01&to=2026-12-31', headers: s.h });
    expect([r2.statusCode, r2.json().error.code]).toEqual([404, 'BOOK_NOT_FOUND']);
  });

  it('danh mục sổ theo phương pháp nộp thuế: income (Điều 6) cần S2b, S2c, S2d, S2e-HKD', async () => {
    const c = (await ctx.app.inject({ method: 'GET', url: '/api/hkd/books?year=2026', headers: s.h })).json() as { regime: string; taxMethod: string; items: { code: string; required: boolean; built: boolean }[] };
    expect([c.regime, c.taxMethod]).toEqual(['TT152', 'income']);
    expect(c.items.filter((i) => i.required).map((i) => i.code)).toEqual(['S2b-HKD', 'S2c-HKD', 'S2d-HKD', 'S2e-HKD']);
    expect(c.items.every((i) => i.built)).toBe(true);
  });

  it('PDF và Excel của một sổ in được', async () => {
    const x = await ctx.app.inject({ method: 'GET', url: '/api/hkd/books/S2a-HKD?from=2026-01-01&to=2026-01-31&format=xlsx', headers: s.h });
    expect([x.statusCode, x.headers['content-type']]).toEqual([200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    const pdf = await ctx.app.inject({ method: 'GET', url: '/api/hkd/books/S2a-HKD?from=2026-01-01&to=2026-01-31&format=pdf', headers: s.h });
    expect([pdf.statusCode, pdf.headers['content-type'], pdf.rawPayload.subarray(0, 4).toString()]).toEqual([200, 'application/pdf', '%PDF']);
    const h = await ctx.app.inject({ method: 'GET', url: '/api/hkd/books/S2a-HKD?from=2026-01-01&to=2026-01-31&format=html', headers: s.h });
    expect(h.body).toContain('Mẫu số S2a-HKD'); expect(h.body).toContain('Kèm theo Thông tư số 152/2025/TT-BTC');
  });

  it('kiểm tra bút ghi: doanh thu phải có nhóm, chi phí phải có khoản mục, thu chi tiền phải có tài khoản tiền; chặn tiền lẻ', async () => {
    const bad = async (p: Record<string, unknown>) => (await ctx.app.inject({ method: 'POST', url: '/api/hkd/entries', headers: s.h, payload: { entryDate: '2026-01-02', description: 'x', amount: '1000', ...p } })).statusCode;
    expect(await bad({ kind: 'revenue' })).toBe(400); expect(await bad({ kind: 'expense' })).toBe(400); expect(await bad({ kind: 'cash_in' })).toBe(400);
    expect(await bad({ kind: 'cash_in', moneyAccount: 'TM', amount: '1000.5' })).toBe(400); expect(await bad({ kind: 'tax_paid' })).toBe(400);
  });
});

describe('TT 58/2026 doanh nghiệp siêu nhỏ: S2a-DNSN, S2b-DNSN, S3b-DNSN, B02-DNSN', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup(`DN${Date.now()}`, 'TT58', '2026-07-01', 2026);
    const g1 = await s.post('/api/hkd/groups', { code: 'BL', name: 'Bán hàng', vatRate: '1', incomeRate: '0.5' });
    await s.put('/api/hkd/settings/2026', { taxMethod: 'vat_percent_cit_profit', incomeTaxRate: '20' });
    await s.entry({ entryDate: '2026-07-01', description: 'Thuế GTGT phải nộp đầu kỳ', kind: 'opening', amount: '100000', openingRef: 'vat_payable' });
    await s.entry({ entryDate: '2026-07-10', docNo: 'HD10', description: 'Bán hàng tháng 7', kind: 'revenue', amount: '20000000', groupId: g1.id });
    await s.entry({ entryDate: '2026-07-12', description: 'Lãi tiền gửi', kind: 'other_income', amount: '500000' });
    await s.entry({ entryDate: '2026-07-15', docNo: 'PC1', description: 'Mua hàng', kind: 'expense', amount: '12000000', expenseCat: 'a' });
    await s.entry({ entryDate: '2026-07-20', description: 'Nộp thuế GTGT', kind: 'tax_paid', amount: '150000', taxType: 'vat' });
    await s.entry({ entryDate: '2026-07-05', docNo: 'HDV1', description: 'GTGT đầu vào', kind: 'vat_input', amount: '300000' });
    await s.entry({ entryDate: '2026-07-10', docNo: 'HD10', description: 'GTGT đầu ra', kind: 'vat_output', amount: '500000' });
  });

  it('S2a-DNSN: thuế GTGT còn phải nộp đầu kỳ 100.000 + phải nộp 200.000 - đã nộp 150.000 = 150.000; tháng sau chuyển 150.000 sang đầu kỳ', async () => {
    const [d] = await s.book('S2a-DNSN', '2026-07-01', '2026-07-31');
    expect(d!.rows[0]).toMatchObject({ desc: 'Số thuế GTGT còn phải nộp đầu kỳ (1)', amount: '100000' });
    expect(row(d!, 'Tổng số thuế GTGT phải nộp trong kỳ (2)').amount).toBe('200000');
    expect(row(d!, 'Số thuế GTGT đã nộp trong kỳ (3)').amount).toBe('150000');
    expect(row(d!, 'Số thuế GTGT còn phải nộp cuối kỳ {(4)= (1) + (2) - (3)}').amount).toBe('150000');
    const [aug] = await s.book('S2a-DNSN', '2026-08-01', '2026-08-31');
    expect(aug!.rows[0]).toMatchObject({ amount: '150000' });
    expect(row(aug!, 'Số thuế GTGT còn phải nộp cuối kỳ {(4)= (1) + (2) - (3)}').amount).toBe('150000');
  });

  it('S2b-DNSN: doanh thu và thu nhập 20.500.000, chi phí 12.000.000, thuế TNDN 20% x 8.500.000 = 1.700.000', async () => {
    const [d] = await s.book('S2b-DNSN', '2026-07-01', '2026-07-31');
    expect(row(d!, '1. Doanh thu và thu nhập').amount).toBe('20500000');
    expect(row(d!, '2. Chi phí').amount).toBe('12000000');
    expect(row(d!, 'Tổng số thuế TNDN phải nộp trong kỳ (2)').amount).toBe('1700000');
    expect(row(d!, 'Số thuế TNDN còn phải nộp cuối kỳ {(4)=(1) +(2) - (3)}').amount).toBe('1700000');
  });

  it('B02-DNSN: 01 = 20.500.000, 02 = 12.000.000, 03 = 8.500.000, 10 = 1.700.000, 20 = 6.800.000; năm trước 0', async () => {
    const [d] = await s.book('B02-DNSN', '2026-07-01', '2026-12-31');
    const by = Object.fromEntries(d!.rows.map((r) => [r.code, r]));
    expect([by['01']!.cur, by['02']!.cur, by['03']!.cur, by['10']!.cur, by['20']!.cur]).toEqual(['20500000', '12000000', '8500000', '1700000', '6800000']);
    expect(by['01']!.prev).toBe('0'); expect(d!.formNo).toBe('B02 - DNSN');
  });

  it('S3b-DNSN: đầu kỳ phải nộp 100.000; đầu ra 500.000, đầu vào 300.000, đã nộp 150.000 -> còn phải nộp cuối kỳ 150.000', async () => {
    const [d] = await s.book('S3b-DNSN', '2026-07-01', '2026-07-31');
    expect(row(d!, 'Số thuế GTGT còn phải nộp đầu kỳ').vatOut).toBe('100000');
    expect(row(d!, 'Số thuế GTGT còn được khấu trừ hoặc được hoàn đầu kỳ').vatIn).toBe('0');
    expect(row(d!, 'Cộng số phát sinh trong kỳ')).toMatchObject({ vatIn: '300000', vatOut: '500000' });
    expect(row(d!, 'Tổng số thuế GTGT phải nộp trong kỳ (2)').vatOut).toBe('200000');
    expect(row(d!, 'Số thuế GTGT còn phải nộp cuối kỳ').vatOut).toBe('150000');
    expect(row(d!, 'Số thuế GTGT còn được khấu trừ hoặc được hoàn cuối kỳ').vatIn).toBe('0');
  });

  it('S3b-DNSN: đầu vào phát sinh lớn hơn số phải nộp thì còn được khấu trừ: 150.000 - 400.000 = 250.000 được khấu trừ chuyển kỳ sau, hoàn 0', async () => {
    await s.entry({ entryDate: '2026-11-10', docNo: 'HDV9', description: 'GTGT đầu vào mua TSCĐ', kind: 'vat_input', amount: '400000' });
    const [d] = await s.book('S3b-DNSN', '2026-11-01', '2026-11-30');
    expect(row(d!, 'Số thuế GTGT còn phải nộp đầu kỳ').vatOut).toBe('150000');
    expect(row(d!, 'Số thuế GTGT còn được khấu trừ hoặc được hoàn cuối kỳ').vatIn).toBe('250000');
    expect(row(d!, 'Số thuế GTGT còn phải nộp cuối kỳ').vatOut).toBe('0');
    const [dec] = await s.book('S3b-DNSN', '2026-12-01', '2026-12-31');
    expect(row(dec!, 'Số thuế GTGT còn được khấu trừ hoặc được hoàn đầu kỳ').vatIn).toBe('250000');
  });

  it('danh mục TT58 theo phương pháp Điều 6: bốn sổ bắt buộc; S4a-DNSN, B01-DNSN đã dựng (xem hkdDnsn.test.ts)', async () => {
    const c = (await ctx.app.inject({ method: 'GET', url: '/api/hkd/books?year=2026', headers: s.h })).json() as { regime: string; items: { code: string; built: boolean; required: boolean; reason: string | null }[] };
    expect(c.regime).toBe('TT58');
    expect(c.items.filter((i) => i.required).map((i) => i.code)).toEqual(['S2a-DNSN', 'S2b-DNSN', 'S2c-DNSN', 'S2d-DNSN']);
    expect(c.items.find((i) => i.code === 'B01-DNSN')).toMatchObject({ built: true, reason: null });
    expect(c.items.find((i) => i.code === 'S4a-DNSN')).toMatchObject({ built: true });
  });

  it('công ty khác không thấy dữ liệu sổ (RLS)', async () => {
    const o = await bootstrapTenant(ctx, { code: `OT${Date.now()}` });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/hkd/entries?from=2026-01-01&to=2026-12-31', headers: { cookie: o.cookie } });
    expect(r.json()).toEqual([]);
  });
});

describe('calcOtherTax', () => {
  it('làm tròn nửa lên đến đồng: 3 x 1.234 x 0,5% = 18,51 -> 19', () => {
    expect(calcOtherTax({ taxKind: 'resource', quantity: '3', absRate: null, unitPrice: '1234', ratePct: '0.5', otherAmount: null }).res.toString()).toBe('19');
    expect(calcOtherTax({ taxKind: 'xnk_ttdb', quantity: '10', absRate: '300', unitPrice: '1000', ratePct: '5', otherAmount: null }).xnk.toString()).toBe('3500');
  });
});
