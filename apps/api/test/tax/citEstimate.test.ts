import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { seedAbcFullTx } from '../../scripts/seed-abc.js';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { postVoucher } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const as = (cookie: string) => (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
const ok = async (p: Promise<Res>, code = 200) => { const r = await p; expect(r.statusCode, r.body).toBe(code); return r.json(); };
const tax = (base: bigint, rate: bigint) => (base * rate + 50n) / 100n; // làm tròn nửa lên, base ≥ 0
const b02Line = async (call: ReturnType<typeof as>, from: string, to: string, line: string) =>
  ((await ok(call('GET', `/api/reports/financial/B02?from=${from}&to=${to}`))).rows as { lineCode: string; current: string }[]).find((r) => r.lineCode === line)!.current;

// Công ty TT99 có năm 2025 và 2026: doanh thu 2025 quyết định thuế suất/miễn thuế năm 2026.
async function tt99(rev2025: string) {
  const b = await bootstrapTenant(ctx, { code: `CE${Date.now()}${n++}` }); const call = as(b.cookie);
  for (const y of [2025, 2026]) await ok(call('POST', '/api/fiscal-years', { fiscalYear: y, dateFrom: `${y}-01-01`, months: 12, regime: 'TT99' }), 201);
  const post = async (date: string, debit: string, credit: string, amount: string) => { const r = await postVoucher(ctx, b.cookie, date, [{ accountCode: debit, debit: amount, credit: '0' }, { accountCode: credit, debit: '0', credit: amount }]); expect(r.statusCode, r.body).toBe(201); };
  await post('2025-06-30', '111', '511', rev2025);
  return { ...b, call, post };
}

describe('tạm tính thuế TNDN quý', () => {
  it('dữ liệu mẫu ABC quý 2: lợi nhuận lũy kế = B02 6 tháng (chỉ tiêu lợi nhuận trước thuế); đã tạm nộp quý 1 trừ đúng', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL! }); await c.connect();
    let tenantId: string; try { ({ tenantId } = await seedAbcFullTx(c, { code: 'ABC_CIT' })); } finally { await c.end(); }
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
    const call = as(cookie);
    await ok(call('POST', '/api/report-defs/B02/reload', { regime: 'TT133' })); // dữ liệu mẫu ABC tạo năm tài chính bằng SQL, chưa chép định nghĩa B02
    // Nộp thuế TNDN: 25/01 nộp quý 4 năm trước (ngoài cửa sổ), 20/4 nộp quý 1 năm nay.
    const pay = async (date: string, amount: string) => { const r = await postVoucher(ctx, cookie, date, [{ accountCode: '3334', debit: amount, credit: '0' }, { accountCode: '1121', debit: '0', credit: amount }]); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };
    await pay('2026-01-25', '7000000'); await pay('2026-04-20', '5000000');

    const ytd = BigInt(await b02Line(call, '2026-01-01', '2026-06-30', '50'));
    const noRate = await ok(call('GET', '/api/cit/estimate?year=2026&quarter=2'));
    expect(noRate).toMatchObject({ regime: 'TT133', ytdProfit: ytd.toString(), prevRevenue: null, rate: null, payable: null, paidYtd: '5000000', paidWindow: { from: '2026-04-01', to: '2026-06-30' } });
    expect(noRate.warnings.join(' ')).toMatch(/doanh thu năm trước/);
    const e = await ok(call('GET', '/api/cit/estimate?year=2026&quarter=2&prevRevenue=2000000000'));
    const taxable = ytd > 0n ? ytd : 0n; const due = tax(taxable, 15n) - 5_000_000n;
    expect(e).toMatchObject({ ytdProfit: ytd.toString(), prevRevenue: '2000000000', prevRevenueSource: 'manual', rate: '15', exempt: false, taxableIncome: taxable.toString(), taxYtd: tax(taxable, 15n).toString(), paidYtd: '5000000', payable: (due > 0n ? due : 0n).toString() });
    expect(e.accounts).toEqual({ expense: '821', payable: '3334' });
    expect((await ok(call('GET', '/api/cit/estimate?year=2026&quarter=1&rate=20'))).paidYtd).toBe('0'); // quý 1: chưa có khoản tạm nộp của năm

    // Lập chứng từ chi phí thuế: PKT nháp Nợ 821 / Có 3334, ngày cuối quý; xóa nháp sau khi kiểm (công ty ABC_CIT dùng chung với kiểm thử 03/TNDN).
    const v = await ok(call('POST', '/api/cit/estimate/voucher', { year: 2026, quarter: 2, amount: '1234000' }), 201);
    expect(v).toMatchObject({ voucherType: 'PKT', state: 'draft', postingDate: '2026-06-30' });
    expect(v.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['821', '1234000', '0'], ['3334', '0', '1234000']]);
    expect((await call('DELETE', `/api/vouchers/${v.id}`)).statusCode).toBe(204);
    expect(err(await call('POST', '/api/cit/estimate/voucher', { year: 2026, quarter: 2, amount: '0' }))).toEqual([400, 'VALIDATION']);
  });

  it('TT99, doanh thu năm trước ≤ 1 tỷ (2026): miễn thuế, số phải nộp 0; ≤ 3 tỷ: 15%, chứng từ Nợ 82111', async () => {
    const small = await tt99('800000000');
    await small.post('2026-02-10', '111', '511', '400000000');
    const e1 = await ok(small.call('GET', '/api/cit/estimate?year=2026&quarter=1'));
    expect(e1).toMatchObject({ regime: 'TT99', prevRevenue: '800000000', prevRevenueSource: 'ledger', rate: '0', exempt: true, ytdProfit: '400000000', payable: '0' });
    expect(e1.rateBasis).toMatch(/NĐ 141\/2026/);

    const mid = await tt99('2500000000');
    await mid.post('2026-02-10', '111', '511', '500000000'); await mid.post('2026-03-10', '6422', '111', '100000000');
    const e2 = await ok(mid.call('GET', '/api/cit/estimate?year=2026&quarter=1&adjustments=10000000&lossCarried=20000000'));
    expect(e2).toMatchObject({ prevRevenue: '2500000000', rate: '15', exempt: false, ytdProfit: '400000000', taxableIncome: '390000000', taxYtd: '58500000', paidYtd: '0', payable: '58500000' });
    expect(e2.accounts).toEqual({ expense: '82111', payable: '3334' });
    const v = await ok(mid.call('POST', '/api/cit/estimate/voucher', { year: 2026, quarter: 1, amount: e2.payable }), 201);
    expect(v.lines.map((l: { accountCode: string; debit: string }) => [l.accountCode, l.debit])).toEqual([['82111', '58500000'], ['3334', '0']]);
    expect((await ok(mid.call('GET', '/api/cit/estimate?year=2026&quarter=1&rate=17'))).rate).toBe('17'); // nhập tay thắng
    expect(err(await mid.call('GET', '/api/cit/estimate?year=2026&quarter=5'))).toEqual([400, 'VALIDATION']);
    expect(err(await mid.call('GET', '/api/cit/estimate?year=2031&quarter=1'))).toEqual([404, 'PERIOD_NOT_FOUND']);
  });
});
