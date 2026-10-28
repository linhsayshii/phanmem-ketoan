import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

// GĐ7 gói 1 (review trục 3 C1, C2, M1; trục 5 #1): API mobile, phân tích tài chính, số dư quỹ theo phạm vi chi nhánh; kiểm soát lúc ghi sổ (tồn kho, quỹ âm, ngân sách) tính toàn công ty.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let userA: string; let userB: string; let brA: number; let brB: number;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const ok = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => {
  const r = await call(method, url, c, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const L = (accountCode: string, debit: string, credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = (c: string, date: string, desc: string, lines: object[], autoPost = true) =>
  call('POST', '/api/vouchers', c, { voucherType: 'PKT', postingDate: date, documentDate: date, description: desc, autoPost, lines });
const working = (branch: 'HO' | number) => ok('PUT', '/api/me/branch', owner, { branch });
async function makeUser(name: string, branches: ('HO' | number)[]) {
  const username = `${name}${Date.now()}`.toLowerCase();
  const { id } = await ok('POST', '/api/users', owner, { username, fullName: name, password: TEST_PASSWORD, roleCode: 'ketoan_truong', sensitiveFlags: ['view_cost', 'view_receivable', 'view_payable', 'view_salary'] });
  await ok('PUT', `/api/users/${id}/branch-scope`, owner, { branches });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const range = 'from=2026-01-01&to=2026-12-31';
type Row = { lineCode: string; current: string; isBold?: boolean };

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner } = await bootstrapTenant(ctx, { code: `BC${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  brA = (await ok('POST', '/api/branches', owner, { code: 'CNA', name: 'Chi nhánh A' })).id;
  brB = (await ok('POST', '/api/branches', owner, { code: 'CNB', name: 'Chi nhánh B' })).id;
  // Trụ sở chính góp vốn 10.000 vào 112 và 1.000 vào 111; A có 111 +2.000, B có 111 +500 rồi chi 800 (quỹ tiền mặt cả công ty vẫn dương).
  expect((await pkt(owner, '2026-01-05', 'Góp vốn', [L('112', '10000'), L('111', '1000'), L('41111', '0', '11000')])).statusCode).toBe(201);
  await working(brA);
  expect((await pkt(owner, '2026-01-10', 'Thu tiền A', [L('111', '2000'), L('511', '0', '2000')])).statusCode).toBe(201);
  await working(brB);
  expect((await pkt(owner, '2026-01-12', 'Thu tiền B', [L('111', '500'), L('511', '0', '500')])).statusCode).toBe(201);
  expect((await pkt(owner, '2026-01-13', 'Chi B', [L('6422', '800'), L('111', '0', '800')])).statusCode).toBe(201);
  await working('HO');
  userA = await makeUser('ktA', [brA]); userB = await makeUser('ktB', [brB]);
  // Hàng dùng chung kho K1: B nhập 50, A nhập 100.
  await call('POST', '/api/catalogs/uom', owner, { code: 'CAI', name: 'Cái' });
  await call('POST', '/api/catalogs/party', owner, { code: 'NCC1', name: 'NCC 1', is_vendor: true });
  await ok('POST', '/api/catalogs/item', owner, { code: 'SP1', name: 'Hàng 1', base_uom_code: 'CAI', kind: 'goods' });
  await ok('POST', '/api/catalogs/warehouse', owner, { code: 'K1', name: 'Kho chung', inventory_account_code: '156', costing_method: 'avg_moving' });
  const stockIn = async (c: string, date: string, qty: string) => {
    const v = await ok('POST', '/api/stock-vouchers', c, { voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC1', description: 'Nhập kho', items: [{ itemCode: 'SP1', uomCode: 'CAI', quantity: qty, unitPrice: '10' }] });
    await ok('POST', `/api/vouchers/${v.id}/post`, c, {}); return v.id as string;
  };
  await stockIn(userA, '2026-01-14', '100'); await stockIn(userB, '2026-01-15', '50');
}, 240_000);
afterAll(async () => { await ctx?.close(); });


describe('API mobile theo phạm vi chi nhánh (C1)', () => {
  it('B01 mobile của người dùng A bằng B01 web theo chi nhánh A, khác B01 cả công ty', async () => {
    const web = await ok('GET', `/api/reports/financial/B01?${range}`, userA);
    const mobile = await ok('GET', `/api/mobile/v1/reports/financial/B01?${range}`, userA);
    const full = await ok('GET', `/api/mobile/v1/reports/financial/B01?${range}`, owner);
    const pick = (rows: { lineCode: string; current: string }[]) => Object.fromEntries(rows.map((r) => [r.lineCode, r.current]));
    const m = pick(mobile.rows); const w = pick((web.rows as Row[]).filter((r) => r.isBold));
    for (const k of Object.keys(m)) expect(m[k], `chỉ tiêu ${k}`).toBe(w[k]);
    expect(pick(mobile.rows)).not.toEqual(pick(full.rows));
    // Người dùng B không thấy số của A.
    const b = await ok('GET', `/api/mobile/v1/reports/financial/B01?${range}`, userB);
    expect(pick(b.rows)).not.toEqual(pick(mobile.rows));
  });

  it('số dư tiền mobile: A thấy 111 = 2.000, B thấy 500 − 800; cả công ty 111 = 2.700; 112 chỉ ở trụ sở chính nên A, B thấy 0', async () => {
    const asOf = 'asOf=2026-12-31';
    const a = await ok('GET', `/api/mobile/v1/reports/cash?${asOf}`, userA);
    const b = await ok('GET', `/api/mobile/v1/reports/cash?${asOf}`, userB);
    const all = await ok('GET', `/api/mobile/v1/reports/cash?${asOf}`, owner);
    expect([a.cash, a.bank]).toEqual(['2000', '0']);
    expect([b.cash, b.bank]).toEqual(['-300', '0']);
    expect([all.cash, all.bank]).toEqual(['2700', '10000']);
  });

  it('báo cáo lãi lỗ mobile chỉ gồm chứng từ trong phạm vi', async () => {
    const a = await ok('GET', `/api/mobile/v1/reports/pnl?${range}`, userA);
    expect(a.totalRevenue).toBe('2000'); expect(a.totalExpense).toBe('0');
  });
});

describe('phân tích tài chính và số dư quỹ theo phạm vi chi nhánh (C2, M1)', () => {
  it('/api/analytics/overview: A thấy tiền, doanh thu của chi nhánh A; không có ngân sách cả công ty; cờ branchLimited', async () => {
    const a = await ok('GET', '/api/analytics/overview?year=2026&month=12', userA);
    const all = await ok('GET', '/api/analytics/overview?year=2026&month=12', owner);
    expect(a.branchLimited).toBe(true); expect(all.branchLimited).toBe(false);
    expect(a.budget).toBeNull();
    const jan = (x: { months: { month: number; cash: string; revenue: string }[] }) => x.months[0]!;
    expect([jan(a).cash, jan(a).revenue]).toEqual(['2000', '2000']);
    expect([jan(all).cash, jan(all).revenue]).toEqual(['12700', '2500']);
    expect(a.summary.cash).toBe('2000');
  });

  it('/api/analytics/overview: hệ số tài chính tính trên báo cáo của chi nhánh (không dùng B01/B02 cả công ty)', async () => {
    const a = await ok('GET', '/api/analytics/overview?year=2026&month=12', userA);
    const all = await ok('GET', '/api/analytics/overview?year=2026&month=12', owner);
    expect(JSON.stringify(a.ratios)).not.toEqual(JSON.stringify(all.ratios));
  });

  it('/api/cash/balance: người dùng bị giới hạn nhận số dư trong phạm vi; không giới hạn nhận cả công ty', async () => {
    const q = 'accountCode=111&asOf=2026-12-31';
    expect((await ok('GET', `/api/cash/balance?${q}`, userA)).balance).toBe('2000');
    expect((await ok('GET', `/api/cash/balance?${q}`, userB)).balance).toBe('-300');
    expect((await ok('GET', `/api/cash/balance?${q}`, owner)).balance).toBe('2700');
    expect((await ok('GET', '/api/cash/balance?accountCode=112&asOf=2026-12-31', userA)).balance).toBe('0');
  });
});

describe('kiểm soát lúc ghi sổ tính toàn công ty (M1)', () => {
  it('tồn kho dùng chung: A xuất 120 (A nhập 100, B nhập 50) được ghi sổ; xuất thêm 40 (tổng 160 > 150) bị chặn tồn âm', async () => {
    const out = async (qty: string, date: string) => ok('POST', '/api/stock-vouchers', userA, { voucherType: 'PXK', stockKind: 'sale', postingDate: date, warehouseCode: 'K1', description: 'Xuất bán', items: [{ itemCode: 'SP1', uomCode: 'CAI', quantity: qty }] });
    const v1 = await out('120', '2026-01-20');
    const p1 = await call('POST', `/api/vouchers/${v1.id}/post`, userA, {});
    expect(p1.statusCode, p1.body).toBe(200);
    const v2 = await out('40', '2026-01-21');
    const p2 = await call('POST', `/api/vouchers/${v2.id}/post`, userA, {});
    expect(p2.statusCode, p2.body).toBe(409);
  });

  it('tồn quỹ âm: A chi 3.000 từ quỹ cả công ty 2.700 vào ngày 22/01 → cảnh báo CASH_NEGATIVE không nêu số dư toàn công ty; người không bị giới hạn thấy số', async () => {
    const r = await pkt(userA, '2026-01-22', 'Chi lớn', [L('6422', '3000'), L('111', '0', '3000')]);
    expect(r.statusCode, r.body).toBe(201);
    const w = (r.json().warnings ?? []) as { code: string; message: string }[];
    expect(w.map((x) => x.code)).toEqual(['CASH_NEGATIVE']);
    expect(w[0]!.message).toMatch(/âm tại ngày/); // "âm" liền "tại ngày": không có số tiền
    const r2 = await pkt(owner, '2026-01-23', 'Chi lớn HO', [L('6422', '100'), L('111', '0', '100')]);
    const w2 = (r2.json().warnings ?? []) as { message: string }[];
    expect(w2[0]?.message, 'người không bị giới hạn vẫn thấy số tiền').toMatch(/âm \d/);
  });

  it('vượt ngân sách: B đã chi 900 trên 6421 (ngân sách tháng 1 = 1.000) nên A ghi sổ 200 bị chặn BUDGET_EXCEEDED dù A chỉ thấy phần của mình', async () => {
    const months = (v: string) => Array.from({ length: 12 }, () => v);
    await working(brB);
    expect((await pkt(owner, '2026-01-16', 'Chi B 6421', [L('6421', '900'), L('112', '0', '900')])).statusCode).toBe(201);
    await working('HO');
    const b = await ok('POST', '/api/budgets', owner, { fiscalYear: 2026, name: 'NS 6421', lines: [{ accountPrefix: '6421', months: months('1000') }] });
    await ok('POST', `/api/budgets/${b.id}/approve`, owner);
    await ok('PUT', '/api/budget-settings', owner, { enabled: true, warnPct: 90, blockPct: 100 });
    const a = await pkt(userA, '2026-01-17', 'Chi A 6421', [L('6421', '200'), L('111', '0', '200')]);
    expect(a.statusCode, a.body).toBe(409);
    expect(a.json().error.code).toBe('BUDGET_EXCEEDED');
    expect(a.json().error.message, 'chỉ nêu phần trăm, không nêu số tiền').toContain('110%');
    // Chi nhỏ vẫn qua: 900 + 50 < 1.000, nhưng dưới ngưỡng cảnh báo 90% chỉ khi tổng thấp; 950 là 95% nên chỉ cảnh báo.
    const small = await pkt(userA, '2026-01-18', 'Chi A nhỏ', [L('6421', '50'), L('112', '0', '50')]);
    expect(small.statusCode, small.body).toBe(201);
    expect((small.json().warnings as { code: string }[]).map((x) => x.code)).toContain('BUDGET_WARNING');
    await ok('PUT', '/api/budget-settings', owner, { enabled: false, warnPct: 90, blockPct: null });
  });
});
