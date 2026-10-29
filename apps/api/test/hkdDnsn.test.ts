import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { accumulatedDep, depMonths } from '../src/modules/hkdbooks/dnsnBooks.js';
import { D } from '@kt/domain';

// TT 58/2026: S4a, S4b, S4d, B01-DNSN, chứng từ 01-TT, 02-TT, 01-VT, 02-VT. Mọi số dưới đây tính tay; tỷ lệ thuế là số giả định cho kiểm thử.
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

interface Doc { title: string; formNo: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown>; outro?: string[]; intro?: string[] }
async function setup(code: string) {
  const { cookie } = await bootstrapTenant(ctx, { code });
  const h = { cookie };
  const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: h, payload: { fiscalYear: 2026, dateFrom: '2026-07-01', months: 12, regime: 'TT58' } });
  expect([fy.statusCode, fy.json()]).toEqual([201, { periods: 13 }]);
  const send = async (method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, payload?: unknown, expectCode = method === 'POST' ? 201 : 200) => {
    const r = await ctx.app.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload: payload as object }) });
    expect([method, url, r.statusCode, r.statusCode === expectCode ? '' : r.body]).toEqual([method, url, expectCode, '']);
    return r;
  };
  const post = async (url: string, payload: unknown, expectCode = 201) => (await send('POST', url, payload, expectCode)).json() as { id: number };
  const book = async (c: string, from: string, to: string, extra = '') => (await send('GET', `/api/hkd/books/${c}?from=${from}&to=${to}${extra}`)).json().docs as Doc[];
  return { h, send, post, book };
}
const row = (d: Doc, desc: string) => d.rows.find((r) => r.desc === desc) as Record<string, unknown>;
const code = (d: Doc, no: string) => d.rows.find((r) => r.code === no) as Record<string, unknown>;

describe('khấu hao S4b: số tháng và khấu hao lũy kế', () => {
  it('tính tròn tháng từ tháng đưa vào sử dụng; tháng chưa kết thúc chưa tính; thôi từ tháng ghi giảm', () => {
    expect(depMonths('2026-08', null, '2026-12-31')).toBe(5);
    expect(depMonths('2026-08', null, '2026-12-15')).toBe(4);
    expect(depMonths('2026-08', null, '2026-07-31')).toBe(0);
    expect(depMonths('2026-07', '2026-10-15', '2026-12-31')).toBe(3);
    expect(depMonths('2026-07', '2026-10-15', '2026-09-30')).toBe(3);
    expect(depMonths('2026-07', '2026-10-15', '2026-08-31')).toBe(2);
  });
  it('lũy kế = nguyên giá x tỷ lệ x tháng / 12, làm tròn nửa lên và không vượt nguyên giá', () => {
    const a = { cost: D('10000000'), rate: D('15'), inUse: '2026-01', decDate: null };
    expect(accumulatedDep(a, '2026-03-31').toString()).toBe('375000');
    expect(accumulatedDep({ ...a, cost: D('1000'), rate: D('10') }, '2026-01-31').toString()).toBe('8'); // 8,33 -> 8
    expect(accumulatedDep({ ...a, cost: D('1000'), rate: D('6') }, '2026-01-31').toString()).toBe('5'); // 5 chẵn
    expect(accumulatedDep({ ...a, rate: D('100') }, '2030-12-31').toString()).toBe('10000000');
  });
});

describe('TT 58/2026: S4a, S4b, S4d, B01-DNSN và chứng từ', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup(`DN${Date.now()}`);
    const g = await s.post('/api/hkd/groups', { code: 'BH', name: 'Bán hàng', vatRate: '1', incomeRate: '1' });
    await s.send('PUT', '/api/hkd/settings/2026', { taxMethod: 'vat_deduct_cit_profit', incomeTaxRate: '20' });
    const entry = (e: Record<string, unknown>) => s.post('/api/hkd/entries', { docNo: null, ...e });
    // Tiền: 10.000.000 + 50.000.000 - 20.000.000 = 40.000.000. Thuế GTGT 5.000.000 - 2.000.000 = 3.000.000 phải nộp. TNDN (50.000.000 - 20.000.000) x 20% = 6.000.000.
    await entry({ entryDate: '2026-07-01', description: 'Tiền mặt đầu kỳ', kind: 'opening', amount: '10000000', openingRef: 'cash', moneyAccount: 'TM' });
    await entry({ entryDate: '2026-07-10', docNo: 'PT01', description: 'Bán hàng thu tiền mặt', kind: 'revenue', amount: '50000000', groupId: g.id, moneyAccount: 'TM' });
    await entry({ entryDate: '2026-07-12', docNo: 'PC01', description: 'Mua nguyên liệu', kind: 'expense', amount: '20000000', expenseCat: 'a', moneyAccount: 'TM' });
    await entry({ entryDate: '2026-07-10', description: 'Thuế GTGT đầu ra', kind: 'vat_output', amount: '5000000' });
    await entry({ entryDate: '2026-07-12', description: 'Thuế GTGT đầu vào', kind: 'vat_input', amount: '2000000' });
    // Công nợ: Cty A phải thu 4.000.000 + 6.000.000 - 3.000.000 = 7.000.000; NCC B phải trả 8.000.000 - 2.000.000 = 6.000.000; thuế TNCN phải nộp 1.000.000.
    const debt = (d: Record<string, unknown>) => s.post('/api/hkd/debts', { docNo: null, nature: 'trade', ...d });
    await debt({ entryDate: '2026-07-01', description: 'Nợ đầu kỳ', party: 'Cty A', side: 'recv', kind: 'opening', amount: '4000000' });
    await debt({ entryDate: '2026-07-15', docNo: 'HD10', description: 'Bán chịu', party: 'Cty A', side: 'recv', kind: 'incur', amount: '6000000' });
    await debt({ entryDate: '2026-07-20', docNo: 'PT05', description: 'Thu nợ', party: 'Cty A', side: 'recv', kind: 'settle', amount: '3000000' });
    await debt({ entryDate: '2026-07-16', docNo: 'HD77', description: 'Mua chịu', party: 'NCC B', side: 'pay', kind: 'incur', amount: '8000000' });
    await debt({ entryDate: '2026-07-25', docNo: 'PC09', description: 'Trả nợ', party: 'NCC B', side: 'pay', kind: 'settle', amount: '2000000' });
    await debt({ entryDate: '2026-12-31', description: 'Thuế TNCN tháng 12', party: 'Thuế', side: 'pay', kind: 'incur', amount: '1000000', nature: 'tax' });
    // Kho: nhập 10 x 100.000, xuất 4 -> tồn 600.000.
    const item = await s.post('/api/hkd/stock-items', { code: 'VT1', name: 'Vải', unit: 'm', warehouse: 'Kho chính' });
    const mv = (moveDate: string, direction: string, quantity: string, unitPrice: string | null, docNo: string, description: string) => s.post('/api/hkd/stock-moves', { itemId: item.id, moveDate, docNo, direction, quantity, unitPrice, description });
    await mv('2026-07-05', 'in', '10', '100000', 'PN01', 'Nhập vải'); await mv('2026-07-20', 'out', '4', null, 'PX01', 'Xuất may');
    // TSCĐ: máy A 24.000.000, 20%/năm, dùng từ 08/2026: đến 31/12 có 5 tháng = 2.000.000 -> còn 22.000.000. Máy B 12.000.000, 10%, từ 07/2026, thanh lý 15/10: 3 tháng = 300.000.
    await s.post('/api/hkd/fixed-assets', { assetType: 'Máy móc', name: 'Máy may A', incDocNo: 'TS01', incDate: '2026-07-20', inUseMonth: '2026-08', cost: '24000000', depRate: '20' });
    await s.post('/api/hkd/fixed-assets', { assetType: 'Máy móc', name: 'Máy cắt B', incDocNo: 'TS02', incDate: '2026-07-01', inUseMonth: '2026-07', cost: '12000000', depRate: '10', decDocNo: 'TL01', decDate: '2026-10-15', decReason: 'Thanh lý' });
    // Tài sản khác: 5.000.000 + 1.000.000 - 500.000 = 5.500.000.
    await s.post('/api/hkd/other-assets', { entryDate: '2026-07-01', description: 'Tiền gửi tiết kiệm', kind: 'opening', amount: '5000000' });
    await s.post('/api/hkd/other-assets', { entryDate: '2026-09-01', description: 'Gửi thêm', kind: 'increase', amount: '1000000' });
    await s.post('/api/hkd/other-assets', { entryDate: '2026-11-01', description: 'Rút một phần', kind: 'decrease', amount: '500000' });
    // Vốn chủ sở hữu: vốn góp 30.000.000 + 5.000.000; lợi nhuận chưa phân phối -2.000.000 + 1.000.000; quỹ 3.000.000 - 1.000.000.
    const eq = (e: Record<string, unknown>) => s.post('/api/hkd/equity', { docNo: null, ...e });
    await eq({ entryDate: '2026-07-01', description: 'Vốn góp đầu kỳ', section: 'capital', kind: 'opening', amount: '30000000' });
    await eq({ entryDate: '2026-09-01', docNo: 'GV01', description: 'Góp thêm vốn', section: 'capital', kind: 'increase', amount: '5000000' });
    await eq({ entryDate: '2026-07-01', description: 'Lỗ lũy kế đầu kỳ', section: 'retained', kind: 'opening', amount: '-2000000' });
    await eq({ entryDate: '2026-12-31', description: 'Kết chuyển lãi', section: 'retained', kind: 'increase', amount: '1000000' });
    await eq({ entryDate: '2026-07-01', description: 'Quỹ đầu kỳ', section: 'funds', kind: 'opening', amount: '3000000' });
    await eq({ entryDate: '2026-10-01', description: 'Chi quỹ', section: 'funds', kind: 'decrease', amount: '1000000' });
  });

  it('S4a-DNSN: mỗi đối tượng một sổ; Cty A đầu kỳ 4.000.000, phát sinh 6.000.000, đã thu 3.000.000, còn phải thu 7.000.000', async () => {
    const docs = await s.book('S4a-DNSN', '2026-07-01', '2026-12-31');
    expect(docs.map((d) => d.intro![0])).toEqual(['Đối tượng: Cty A', 'Đối tượng: NCC B', 'Đối tượng: Thuế']);
    const a = docs[0]!;
    expect(a.formNo).toBe('S4a-DNSN');
    expect(a.columns.map((c) => c.key)).toEqual(['docNo', 'date', 'desc', 'recv', 'recvPaid', 'recvLeft', 'pay', 'payPaid', 'payLeft']);
    expect(row(a, 'Số dư đầu kỳ')).toMatchObject({ recvLeft: '4000000', payLeft: '0' });
    expect(a.rows.filter((r) => r.docNo).map((r) => [r.docNo, r.recv ?? null, r.recvPaid ?? null, r.recvLeft])).toEqual([['HD10', '6000000', null, '10000000'], ['PT05', null, '3000000', '7000000']]);
    expect(row(a, 'Cộng số phát sinh trong kỳ')).toMatchObject({ recv: '6000000', recvPaid: '3000000', pay: '0', payPaid: '0' });
    expect(row(a, 'Số dư cuối kỳ')).toMatchObject({ recvLeft: '7000000', payLeft: '0' });
    expect(row(docs[1]!, 'Số dư cuối kỳ')).toMatchObject({ recvLeft: '0', payLeft: '6000000' });
    // kỳ sau lấy số dư cuối kỳ trước làm đầu kỳ; lọc theo đối tượng
    const [later] = await s.book('S4a-DNSN', '2026-08-01', '2026-12-31', '&party=NCC%20B');
    expect(row(later!, 'Số dư đầu kỳ')).toMatchObject({ payLeft: '6000000' });
    expect(later!.rows.filter((r) => r.docNo)).toHaveLength(0);
  });

  it('S4b-DNSN: một sổ theo loại tài sản; máy B đã thanh lý hiện lý do, khấu hao 3 tháng; cộng nguyên giá 36.000.000, khấu hao 2.300.000', async () => {
    const [d] = await s.book('S4b-DNSN', '2026-07-01', '2026-12-31');
    expect(d!.intro![0]).toBe('Loại tài sản: Máy móc');
    expect(d!.columns.map((c) => c.key)).toEqual(['incDocNo', 'incDate', 'name', 'inUse', 'cost', 'depRate', 'dep', 'accDep', 'decDocNo', 'decDate', 'decReason']);
    const a = d!.rows.find((r) => r.name === 'Máy may A')!; const b = d!.rows.find((r) => r.name === 'Máy cắt B')!;
    expect([a.inUse, a.cost, a.depRate, a.dep, a.accDep, a.decReason]).toEqual(['08/2026', '24000000', '20', '2000000', '2000000', undefined]);
    expect([b.dep, b.accDep, b.decDocNo, b.decDate, b.decReason]).toEqual(['300000', '300000', 'TL01', '2026-10-15', 'Thanh lý']);
    expect(d!.rows.find((r) => r.name === 'Cộng')).toMatchObject({ cost: '36000000', dep: '2300000', accDep: '2300000' });
    // kỳ sau khi đã thanh lý: máy B không còn trên sổ; máy A khấu hao lũy kế 3.200.000 (8 tháng), phát sinh trong kỳ 1.200.000
    const [later] = await s.book('S4b-DNSN', '2027-01-01', '2027-03-31');
    expect(later!.rows.map((r) => r.name)).toEqual(['Máy may A', 'Cộng']);
    expect(later!.rows[0]).toMatchObject({ dep: '1200000', accDep: '3200000' });
  });

  it('S4d-DNSN: ba phần, số dư đầu kỳ, phát sinh tăng giảm, số dư cuối kỳ (lỗ lũy kế âm)', async () => {
    const [d] = await s.book('S4d-DNSN', '2026-07-01', '2026-12-31');
    expect(d!.columns.map((c) => c.key)).toEqual(['docNo', 'date', 'desc', 'inc', 'dec', 'bal']);
    const bal = (desc: string) => (row(d!, desc) as { bal: string }).bal;
    expect([bal('1.1. Số dư đầu kỳ'), bal('1.3. Số dư cuối kỳ'), bal('2.1. Số dư đầu kỳ'), bal('2.3. Số dư cuối kỳ'), bal('3.1. Số dư đầu kỳ'), bal('3.3. Số dư cuối kỳ')])
      .toEqual(['30000000', '35000000', '-2000000', '-1000000', '3000000', '2000000']);
    expect(d!.rows.find((r) => r.desc === 'Góp thêm vốn')).toMatchObject({ docNo: 'GV01', inc: '5000000' });
    expect(d!.rows.find((r) => r.desc === 'Chi quỹ')).toMatchObject({ dec: '1000000' });
  });

  it('B01-DNSN: từng chỉ tiêu theo sổ; 200 lệch 500 thì nêu số chênh lệch và hướng rà soát', async () => {
    const [d] = await s.book('B01-DNSN', '2026-07-01', '2026-12-31');
    expect(d!.formNo).toBe('B01 – DNSN');
    const cur = (no: string) => code(d!, no).cur;
    // 110 = 40.000.000; 120 = 7.000.000; 130 = 600.000; 140 = 22.000.000; 150 = 5.500.000; 200 = 75.100.000
    expect(['110', '120', '130', '140', '150', '200'].map(cur)).toEqual(['40000000', '7000000', '600000', '22000000', '5500000', '75100000']);
    // 310 = 6.000.000; 320 = GTGT 3.000.000 + TNDN 6.000.000 + TNCN 1.000.000 = 10.000.000; 300 = 16.000.000; 400 = 36.000.000; 500 = 52.000.000
    expect(['310', '320', '300', '410', '420', '430', '400', '500'].map(cur)).toEqual(['6000000', '10000000', '16000000', '35000000', '-1000000', '2000000', '36000000', '52000000']);
    expect(['110', '200', '500'].map((n) => code(d!, n).prev)).toEqual(['0', '0', '0']);
    expect(d!.outro!.some((t) => t.includes('chưa bằng nhau') && t.includes('lệch 23100000 đồng'))).toBe(true);
    expect(d!.outro!.some((t) => t.includes('(mã 20) là 24000000 đồng') && t.includes('S4d'))).toBe(true);
  });

  it('B01-DNSN: cột số đầu năm là số cuối năm trước (tính đến ngày liền trước đầu năm)', async () => {
    const t = await setup(`DP${Date.now()}`);
    await t.send('PUT', '/api/hkd/settings/2026', { taxMethod: 'vat_percent_cit_profit', incomeTaxRate: '20' });
    await t.post('/api/hkd/entries', { entryDate: '2026-01-01', description: 'Tiền trước năm', kind: 'opening', amount: '2000000', openingRef: 'cash', moneyAccount: 'TM' });
    await t.post('/api/hkd/entries', { entryDate: '2026-08-01', description: 'Chi trong năm', kind: 'cash_out', amount: '500000', moneyAccount: 'TM' });
    await t.post('/api/hkd/equity', { entryDate: '2026-01-01', description: 'Vốn góp', section: 'capital', kind: 'opening', amount: '2000000' });
    const [d] = await t.book('B01-DNSN', '2026-07-01', '2026-12-31');
    expect([code(d!, '110').cur, code(d!, '110').prev, code(d!, '410').cur, code(d!, '410').prev]).toEqual(['1500000', '2000000', '2000000', '2000000']);
    expect(d!.outro!.some((x) => x.includes('số đầu năm lệch 0 đồng') && x.includes('số cuối năm lệch -500000 đồng'))).toBe(true);
  });

  it('B01-DNSN: chưa chọn phương pháp nộp thuế thì 409 TAX_METHOD_MISSING', async () => {
    const t = await setup(`DM${Date.now()}`);
    const r = await t.send('GET', '/api/hkd/books/B01-DNSN?from=2026-07-01&to=2026-12-31', undefined, 409);
    expect(r.json().error.code).toBe('TAX_METHOD_MISSING');
  });

  it('B01-DNSN cân đối: tiền 1.000.000 = vốn góp 1.000.000 thì 200 = 500 và không có chú thích lệch', async () => {
    const t = await setup(`DB${Date.now()}`);
    await t.send('PUT', '/api/hkd/settings/2026', { taxMethod: 'vat_percent_cit_profit', incomeTaxRate: '20' });
    await t.post('/api/hkd/entries', { entryDate: '2026-07-01', description: 'Tiền đầu kỳ', kind: 'opening', amount: '1000000', openingRef: 'cash', moneyAccount: 'TM' });
    await t.post('/api/hkd/equity', { entryDate: '2026-07-01', description: 'Vốn góp', section: 'capital', kind: 'opening', amount: '1000000' });
    const [d] = await t.book('B01-DNSN', '2026-07-01', '2026-12-31');
    expect([code(d!, '200').cur, code(d!, '500').cur]).toEqual(['1000000', '1000000']);
    expect(d!.outro!.some((x) => x.includes('chưa bằng nhau'))).toBe(false);
  });

  it('B01-DNSN: thuế TNDN nộp thừa so với phải nộp vào Tài sản khác (150); thuế GTGT còn được khấu trừ vào Nợ phải thu (120)', async () => {
    const t = await setup(`DO${Date.now()}`);
    await t.send('PUT', '/api/hkd/settings/2026', { taxMethod: 'vat_deduct_cit_profit', incomeTaxRate: '20' });
    const e = (x: Record<string, unknown>) => t.post('/api/hkd/entries', { docNo: null, ...x });
    await e({ entryDate: '2026-08-01', description: 'Thuế GTGT đầu vào', kind: 'vat_input', amount: '800000' });
    await e({ entryDate: '2026-08-02', description: 'Nộp tạm TNDN', kind: 'tax_paid', amount: '300000', taxType: 'income' });
    const [d] = await t.book('B01-DNSN', '2026-07-01', '2026-12-31');
    expect([code(d!, '120').cur, code(d!, '150').cur, code(d!, '320').cur]).toEqual(['800000', '300000', '0']);
  });

  it('kiểm tra đầu vào: thuế chỉ ở bên phải trả, ghi giảm cần lý do, số âm chỉ ở số dư đầu lợi nhuận chưa phân phối, nguyên giá > 0', async () => {
    const bad = async (url: string, payload: unknown) => { const r = await ctx.app.inject({ method: 'POST', url, headers: s.h, payload: payload as object }); expect([url, r.statusCode]).toEqual([url, 400]); };
    await bad('/api/hkd/debts', { entryDate: '2026-07-01', description: 'x', party: 'A', side: 'recv', kind: 'incur', nature: 'tax', amount: '100' });
    await bad('/api/hkd/debts', { entryDate: '2026-07-01', description: 'x', party: 'A', side: 'recv', kind: 'incur', amount: '0' });
    await bad('/api/hkd/fixed-assets', { assetType: 'M', name: 'x', incDate: '2026-07-01', inUseMonth: '2026-07', cost: '100', depRate: '10', decDate: '2026-08-01' });
    await bad('/api/hkd/fixed-assets', { assetType: 'M', name: 'x', incDate: '2026-07-01', inUseMonth: '2026-07', cost: '0', depRate: '10' });
    await bad('/api/hkd/fixed-assets', { assetType: 'M', name: 'x', incDate: '2026-07-01', inUseMonth: '2026-07', cost: '100', depRate: '101' });
    await bad('/api/hkd/equity', { entryDate: '2026-07-01', description: 'x', section: 'capital', kind: 'opening', amount: '-100' });
    await bad('/api/hkd/equity', { entryDate: '2026-07-01', description: 'x', section: 'retained', kind: 'increase', amount: '-100' });
    await bad('/api/hkd/other-assets', { entryDate: '2026-07-01', description: 'x', kind: 'increase', amount: '12.5' });
  });

  it('sửa, xóa, 404; danh sách đối tượng công nợ; công ty khác không thấy dữ liệu (RLS)', async () => {
    const d = await s.post('/api/hkd/debts', { entryDate: '2026-07-02', description: 'Tạm', party: 'Cty Z', side: 'recv', kind: 'incur', amount: '1000' });
    const u = await s.send('PUT', `/api/hkd/debts/${d.id}`, { entryDate: '2026-07-02', description: 'Tạm sửa', party: 'Cty Z', side: 'recv', kind: 'incur', nature: 'loan', amount: '2000' });
    expect(u.json()).toMatchObject({ description: 'Tạm sửa', amount: '2000', nature: 'loan' });
    expect(((await s.send('GET', '/api/hkd/debt-parties')).json() as string[])).toContain('Cty Z');
    const other = await setup(`DR${Date.now()}`);
    expect((await other.send('GET', '/api/hkd/debts')).json()).toEqual([]);
    expect((await other.send('GET', '/api/hkd/debt-parties')).json()).toEqual([]);
    await other.send('DELETE', `/api/hkd/debts/${d.id}`, undefined, 404);
    await s.send('DELETE', `/api/hkd/debts/${d.id}`, undefined, 204);
    await s.send('DELETE', `/api/hkd/debts/${d.id}`, undefined, 404);
    await s.send('PUT', '/api/hkd/fixed-assets/999999999', { assetType: 'M', name: 'x', incDate: '2026-07-01', inUseMonth: '2026-07', cost: '100', depRate: '10' }, 404);
  });

  it('danh mục sổ: S4a, S4b, S4d, B01-DNSN đã dựng; có bốn mẫu chứng từ', async () => {
    const c = (await s.send('GET', '/api/hkd/books?year=2026')).json() as { items: { code: string; built: boolean }[]; vouchers: { code: string; built: boolean }[] };
    expect(c.items.filter((i) => ['S4a-DNSN', 'S4b-DNSN', 'S4d-DNSN', 'B01-DNSN'].includes(i.code)).map((i) => i.built)).toEqual([true, true, true, true]);
    expect(c.items.every((i) => i.built)).toBe(true);
    expect(c.vouchers.map((v) => v.code)).toEqual(['01-TT', '02-TT', '01-VT', '02-VT']);
  });

  it('xuất Excel và PDF của S4a, S4b, B01-DNSN', async () => {
    for (const c of ['S4a-DNSN', 'S4b-DNSN', 'S4d-DNSN', 'B01-DNSN']) {
      const x = await s.send('GET', `/api/hkd/books/${c}?from=2026-07-01&to=2026-12-31&format=xlsx`);
      expect([c, x.headers['content-type']]).toEqual([c, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    }
    const pdf = await s.send('GET', '/api/hkd/books/B01-DNSN?from=2026-07-01&to=2026-12-31&format=pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const h = (await s.send('GET', '/api/hkd/books/B01-DNSN?from=2026-07-01&to=2026-12-31&format=html')).body;
    expect(h).toContain('Mẫu số B01 – DNSN'); expect(h).toContain('Kèm theo Thông tư số 58/2026/TT-BTC');
  });

  describe('chứng từ 01-TT, 02-TT, 01-VT, 02-VT', () => {
    const idOf = async (docNo: string) => ((await s.send('GET', '/api/hkd/entries?from=2026-07-01&to=2026-12-31')).json() as { id: number; docNo: string | null }[]).find((e) => e.docNo === docNo)!.id;
    const html = async (url: string) => (await s.send('GET', url)).body;
    const order = (h: string, labels: string[]) => labels.map((l) => h.indexOf(l));
    const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

    it('Phiếu thu 01-TT: mẫu số, số tiền bằng số và bằng chữ, thứ tự chữ ký đúng văn bản gốc', async () => {
      const h = await html(`/api/hkd/vouchers/01-TT?entryId=${await idOf('PT01')}&person=Nguy%E1%BB%85n%20V%C4%83n%20A&address=H%C3%A0%20N%E1%BB%99i`);
      expect(h).toContain('Mẫu số 01-TT'); expect(h).toContain('Kèm theo Thông tư số 58/2026/TT-BTC'); expect(h).toContain('PHIẾU THU');
      expect(h).toContain('Số: <b>PT01</b>'); expect(h).toContain('50.000.000 đồng'); expect(h).toContain('Nguyễn Văn A'); expect(h).toContain('Lý do nộp'); expect(h).toContain('Đã nhận đủ số tiền');
      expect(ascending(order(h, ['GIÁM ĐỐC', 'KẾ TOÁN TRƯỞNG', 'NGƯỜI NỘP TIỀN', 'THỦ QUỸ']))).toBe(true);
    });
    it('Phiếu chi 02-TT: thứ tự Giám đốc, Kế toán trưởng, Thủ quỹ, Người nhận tiền', async () => {
      const h = await html(`/api/hkd/vouchers/02-TT?entryId=${await idOf('PC01')}`);
      expect(h).toContain('PHIẾU CHI'); expect(h).toContain('Mẫu số 02-TT'); expect(h).toContain('20.000.000 đồng'); expect(h).toContain('Lý do chi');
      expect(ascending(order(h, ['GIÁM ĐỐC', 'KẾ TOÁN TRƯỞNG', 'THỦ QUỸ', 'NGƯỜI NHẬN TIỀN']))).toBe(true);
    });
    it('Phiếu thu cho khoản không phải tiền mặt thu vào: 400 VOUCHER_NOT_CASH; bút ghi lạ 404; thiếu entryId 400', async () => {
      const chi = await idOf('PC01');
      expect((await s.send('GET', `/api/hkd/vouchers/01-TT?entryId=${chi}`, undefined, 400)).json().error.code).toBe('VOUCHER_NOT_CASH');
      await s.send('GET', '/api/hkd/vouchers/01-TT?entryId=999999999', undefined, 404);
      await s.send('GET', '/api/hkd/vouchers/02-TT', undefined, 400);
      await s.send('GET', '/api/hkd/vouchers/03-TT?entryId=1', undefined, 400);
    });
    it('Phiếu nhập kho 01-VT: 10 x 100.000 = 1.000.000; chữ ký Người giao hàng, Thủ kho, Kế toán trưởng', async () => {
      const h = await html('/api/hkd/vouchers/01-VT?docNo=PN01&person=C%C3%B4ng%20ty%20X&basis=h%C3%B3a%20%C4%91%C6%A1n%20s%E1%BB%91%2012');
      expect(h).toContain('PHIẾU NHẬP KHO'); expect(h).toContain('Mẫu số 01-VT'); expect(h).toContain('Theo chứng từ'); expect(h).toContain('Thực nhập'); expect(h).toContain('Nhập tại kho: <b>Kho chính</b>');
      expect(h).toContain('Theo <b>hóa đơn số 12</b>'); expect(h).toContain('>Vải<'); expect(h).toContain('100.000'); expect(h).toContain('1.000.000');
      expect(ascending(order(h, ['NGƯỜI GIAO HÀNG', 'THỦ KHO', 'KẾ TOÁN TRƯỞNG']))).toBe(true);
    });
    it('Phiếu xuất kho 02-VT: xuất 4 x bình quân 100.000 = 400.000; chữ ký có thêm Giám đốc ở cuối', async () => {
      const h = await html('/api/hkd/vouchers/02-VT?docNo=PX01&reason=Xu%E1%BA%A5t%20may');
      expect(h).toContain('PHIẾU XUẤT KHO'); expect(h).toContain('Mẫu số 02-VT'); expect(h).toContain('Yêu cầu'); expect(h).toContain('Thực xuất'); expect(h).toContain('Lý do xuất kho: <b>Xuất may</b>');
      expect(h).toContain('400.000'); expect(h).toContain('Bốn trăm nghìn đồng');
      expect(ascending(order(h, ['NGƯỜI NHẬN HÀNG', 'THỦ KHO', 'KẾ TOÁN TRƯỞNG', 'GIÁM ĐỐC']))).toBe(true);
    });
    it('dòng kho không có số chứng từ đó: 404 VOUCHER_NOT_FOUND; nhập kho không in được bằng 02-VT; thiếu docNo 400; xuất PDF được', async () => {
      expect((await s.send('GET', '/api/hkd/vouchers/02-VT?docNo=PN01', undefined, 404)).json().error.code).toBe('VOUCHER_NOT_FOUND');
      await s.send('GET', '/api/hkd/vouchers/01-VT', undefined, 400);
      const pdf = await s.send('GET', '/api/hkd/vouchers/01-VT?docNo=PN01&format=pdf');
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    });
  });
});
