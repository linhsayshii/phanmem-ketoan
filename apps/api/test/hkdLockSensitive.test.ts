import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

// QĐ 1517 (b): sổ HKD/DNSN có khóa kỳ (migration 0292) và cờ nhạy cảm giá vốn (view_cost) ở API.
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type U = { cookie: string };
const send = (u: U, method: string, url: string, payload?: object) => ctx.app.inject({ method: method as 'GET', url, headers: u, ...(payload ? { payload } : {}) });
async function setup(code: string) {
  const { cookie } = await bootstrapTenant(ctx, { code });
  const admin = { cookie };
  const fy = await send(admin, 'POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-07-01', months: 12, regime: 'TT58' });
  expect(fy.statusCode).toBe(201);
  const user = async (role: string, flags: string[]): Promise<U> => {
    const username = `u_${role.slice(0, 4)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const made = await send(admin, 'POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: role, sensitiveFlags: flags });
    expect([made.statusCode, made.body]).toEqual([201, made.body]);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return { cookie: `sid=${login.cookies.find((x) => x.name === 'sid')!.value}` };
  };
  const ok = async (u: U, method: string, url: string, payload?: object, status = method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200) => {
    const r = await send(u, method, url, payload); expect([method, url, r.statusCode, r.body]).toEqual([method, url, status, r.statusCode === status ? r.body : '']); return r.statusCode === 204 ? {} : r.json();
  };
  const err = async (u: U, method: string, url: string, payload: object | undefined, status: number, code?: string) => {
    const r = await send(u, method, url, payload); expect([method, url, r.statusCode, code ? r.json().error.code : '']).toEqual([method, url, status, code ?? '']);
  };
  return { admin, user, ok, err };
}

const entry = (date: string, amount = '100') => ({ entryDate: date, docNo: null, description: 'Chi phí', kind: 'expense', amount, expenseCat: 'e', moneyAccount: 'TM' });
const debt = (date: string) => ({ entryDate: date, description: 'Mua chịu', party: 'NCC1', side: 'pay', kind: 'incur', amount: '1000' });
const equity = (date: string) => ({ entryDate: date, description: 'Góp vốn', section: 'capital', kind: 'increase', amount: '500' });
const other = (date: string) => ({ entryDate: date, description: 'Ký quỹ', kind: 'increase', amount: '700' });
const tax = (date: string) => ({ entryDate: date, description: 'Lệ phí', taxKind: 'other', otherAmount: '50' });
const asset = (inc: string, extra: object = {}) => ({ assetType: 'Máy móc', name: 'Máy', incDate: inc, inUseMonth: inc.slice(0, 7), cost: '12000000', depRate: '10', ...extra });

describe('khóa kỳ sổ HKD/DNSN (0292)', () => {
  it('khóa sổ kỳ 1 (tháng 7): kế toán viên không thêm, sửa (ngày cũ hoặc ngày mới), xóa bút ở kỳ đã khóa; người có quyền ghi lùi vẫn ghi được; kỳ mở và ngày ngoài năm tài chính không bị chặn', async () => {
    const s = await setup(`HL${Date.now()}`);
    const kt = await s.user('ketoan_vien', ['view_receivable', 'view_payable', 'view_cost']);
    // dữ liệu tháng 1 và tháng 2 trước khi khóa
    const e1 = await s.ok(s.admin, 'POST', '/api/hkd/entries', entry('2026-07-10'));
    const e2 = await s.ok(s.admin, 'POST', '/api/hkd/entries', entry('2026-08-10'));
    const d1 = await s.ok(s.admin, 'POST', '/api/hkd/debts', debt('2026-07-10'));
    const q1 = await s.ok(s.admin, 'POST', '/api/hkd/equity', equity('2026-07-10'));
    const o1 = await s.ok(s.admin, 'POST', '/api/hkd/other-assets', other('2026-07-10'));
    const t1 = await s.ok(s.admin, 'POST', '/api/hkd/other-taxes', tax('2026-07-10'));
    const item = await s.ok(s.admin, 'POST', '/api/hkd/stock-items', { code: 'H1', name: 'Hàng', unit: 'cái' });
    const m1 = await s.ok(s.admin, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-07-10', description: 'Nhập', direction: 'in', quantity: '10', unitPrice: '1000' });
    const a1 = await s.ok(s.admin, 'POST', '/api/hkd/fixed-assets', asset('2026-07-10'));

    await s.ok(s.admin, 'POST', '/api/periods/2026/1/lock', { level: 'soft' }, 200);
    const L = 'PERIOD_SOFT_LOCKED';
    // book_entry: thêm, sửa giữ ngày, chuyển ra kỳ mở, chuyển vào kỳ khóa, xóa
    await s.err(kt, 'POST', '/api/hkd/entries', entry('2026-07-20'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/entries/${e1.id}`, entry('2026-07-10', '200'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/entries/${e1.id}`, entry('2026-08-15'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/entries/${e2.id}`, entry('2026-07-15'), 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/entries/${e1.id}`, undefined, 409, L);
    await s.ok(kt, 'PUT', `/api/hkd/entries/${e2.id}`, entry('2026-08-11', '150'));
    await s.ok(kt, 'POST', '/api/hkd/entries', entry('2026-08-20'));
    await s.ok(kt, 'POST', '/api/hkd/entries', entry('2025-06-01')); // chưa mở năm 2025: không chặn
    // các bảng sổ đơn khác
    await s.err(kt, 'POST', '/api/hkd/debts', debt('2026-07-20'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/debts/${d1.id}`, debt('2026-08-20'), 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/debts/${d1.id}`, undefined, 409, L);
    await s.err(kt, 'POST', '/api/hkd/equity', equity('2026-07-20'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/equity/${q1.id}`, equity('2026-08-20'), 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/equity/${q1.id}`, undefined, 409, L);
    await s.err(kt, 'POST', '/api/hkd/other-assets', other('2026-07-20'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/other-assets/${o1.id}`, other('2026-08-20'), 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/other-assets/${o1.id}`, undefined, 409, L);
    await s.err(kt, 'POST', '/api/hkd/other-taxes', tax('2026-07-20'), 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/other-taxes/${t1.id}`, undefined, 409, L);
    await s.err(kt, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-07-20', description: 'Xuất', direction: 'out', quantity: '1' }, 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/stock-moves/${m1.id}`, undefined, 409, L);
    await s.ok(kt, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-08-20', description: 'Xuất', direction: 'out', quantity: '1' });
    // TSCĐ: ghi tăng ở kỳ khóa bị chặn; sửa nguyên giá thẻ ghi tăng ở kỳ khóa bị chặn; ghi giảm ở kỳ mở thẻ mua ở kỳ khóa được; xóa thẻ bị chặn
    await s.err(kt, 'POST', '/api/hkd/fixed-assets', asset('2026-07-20'), 409, L);
    await s.err(kt, 'PUT', `/api/hkd/fixed-assets/${a1.id}`, asset('2026-07-10', { cost: '13000000' }), 409, L);
    await s.ok(kt, 'PUT', `/api/hkd/fixed-assets/${a1.id}`, asset('2026-07-10', { decDocNo: 'TL1', decDate: '2026-08-15', decReason: 'Thanh lý' }));
    await s.err(kt, 'PUT', `/api/hkd/fixed-assets/${a1.id}`, asset('2026-07-10', { decDocNo: 'TL1', decDate: '2026-07-15', decReason: 'Thanh lý' }), 409, L);
    await s.err(kt, 'DELETE', `/api/hkd/fixed-assets/${a1.id}`, undefined, 409, L);
    // admin có voucher.backdate_locked: ghi lùi vào kỳ khóa sổ được (như chứng từ)
    await s.ok(s.admin, 'POST', '/api/hkd/entries', entry('2026-07-25'));
    await s.ok(s.admin, 'PUT', `/api/hkd/debts/${d1.id}`, { ...debt('2026-07-10'), amount: '1100' });

    // khóa cứng: chặn cả người có quyền ghi lùi
    await s.ok(s.admin, 'POST', '/api/periods/2026/0/lock', { level: 'hard' }, 200);
    await s.ok(s.admin, 'POST', '/api/periods/2026/1/lock', { level: 'hard' }, 200);
    await s.err(s.admin, 'POST', '/api/hkd/entries', entry('2026-07-26'), 409, 'PERIOD_HARD_LOCKED');
    await s.err(s.admin, 'DELETE', `/api/hkd/entries/${e1.id}`, undefined, 409, 'PERIOD_HARD_LOCKED');
    await s.err(s.admin, 'PUT', `/api/hkd/debts/${d1.id}`, debt('2026-08-01'), 409, 'PERIOD_HARD_LOCKED');
    await s.ok(s.admin, 'POST', '/api/hkd/entries', entry('2026-08-26'));
  });
});

describe('cờ nhạy cảm giá vốn của sổ HKD/DNSN', () => {
  it('thiếu view_cost: sổ kho S2c-DNSN và phiếu 01-VT, 02-VT trả 403; danh sách nhập, xuất bỏ đơn giá; ghi, xóa dòng có đơn giá trả 403, dòng xuất ghi được; sổ khác và B01-DNSN vẫn xem được; nhật ký bỏ dòng kho', async () => {
    const s = await setup(`HC${Date.now()}`);
    const item = await s.ok(s.admin, 'POST', '/api/hkd/stock-items', { code: 'H1', name: 'Hàng', unit: 'cái' });
    const mIn = await s.ok(s.admin, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-09-02', docNo: 'PN1', description: 'Nhập', direction: 'in', quantity: '10', unitPrice: '987654' });
    await s.ok(s.admin, 'POST', '/api/hkd/entries', entry('2026-09-05'));
    await s.ok(s.admin, 'PUT', '/api/hkd/settings/2026', { taxMethod: 'vat_deduct_cit_profit', incomeTaxRate: '15' });
    const noCost = await s.user('ketoan_truong', ['view_receivable', 'view_payable']);
    const withCost = await s.user('ketoan_truong', ['view_receivable', 'view_payable', 'view_cost']);
    const range = 'from=2026-09-01&to=2026-09-30';

    await s.err(noCost, 'GET', `/api/hkd/books/S2c-DNSN?${range}`, undefined, 403, 'FORBIDDEN');
    await s.err(noCost, 'GET', `/api/hkd/books/S2c-DNSN?${range}&format=html`, undefined, 403, 'FORBIDDEN');
    await s.err(noCost, 'GET', '/api/hkd/vouchers/01-VT?docNo=PN1', undefined, 403, 'FORBIDDEN');
    await s.err(noCost, 'GET', '/api/hkd/vouchers/02-VT?docNo=PN1', undefined, 403, 'FORBIDDEN');
    for (const code of ['S2b-DNSN', 'S2d-DNSN', 'S4a-DNSN', 'B01-DNSN', 'B02-DNSN']) await s.ok(noCost, 'GET', `/api/hkd/books/${code}?${range}`);
    const moves = await s.ok(noCost, 'GET', '/api/hkd/stock-moves') as { unitPrice: string | null }[];
    expect(moves.map((m) => m.unitPrice)).toEqual([null]);
    expect(((await s.ok(withCost, 'GET', '/api/hkd/stock-moves')) as { unitPrice: string | null }[]).map((m) => m.unitPrice)).toEqual(['987654.0000']);
    await s.err(noCost, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-09-03', description: 'Nhập', direction: 'in', quantity: '1', unitPrice: '5' }, 403, 'FORBIDDEN');
    await s.err(noCost, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-09-03', description: 'Tồn', direction: 'opening', quantity: '1', unitPrice: '5' }, 403, 'FORBIDDEN');
    const out = await s.ok(noCost, 'POST', '/api/hkd/stock-moves', { itemId: item.id, moveDate: '2026-09-04', description: 'Xuất', direction: 'out', quantity: '1' });
    await s.err(noCost, 'DELETE', `/api/hkd/stock-moves/${mIn.id}`, undefined, 403, 'FORBIDDEN');
    await s.ok(noCost, 'DELETE', `/api/hkd/stock-moves/${out.id}`);
    await s.err(noCost, 'DELETE', '/api/hkd/stock-moves/99999999', undefined, 404, 'BOOK_MOVE_NOT_FOUND');
    // có cờ: xem sổ kho, in phiếu nhập
    const docs = (await s.ok(withCost, 'GET', `/api/hkd/books/S2c-DNSN?${range}`) as { docs: unknown[] }).docs;
    expect(JSON.stringify(docs)).toContain('987654');
    expect((await send(withCost, 'GET', '/api/hkd/vouchers/01-VT?docNo=PN1')).statusCode).toBe(200);
    // nhật ký: book_stock_move mang đơn giá nên bị che như dòng hàng phiếu kho
    await s.err(noCost, 'GET', '/api/audit?entity=book_stock_move', undefined, 403, 'FORBIDDEN');
    const gen = await send(noCost, 'GET', '/api/audit?size=500');
    expect([gen.statusCode, gen.body.includes('987654'), gen.body.includes('book_entry')]).toEqual([200, false, true]);
    expect((await send(withCost, 'GET', '/api/audit?entity=book_stock_move&size=500')).body).toContain('987654');
  });

  it('TT152: sổ kho S2d-HKD cần view_cost', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `HD${Date.now()}` });
    const admin = { cookie };
    expect((await send(admin, 'POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT152' })).statusCode).toBe(201);
    const username = `hd_${Date.now()}`;
    await send(admin, 'POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const u = { cookie: `sid=${login.cookies.find((x) => x.name === 'sid')!.value}` };
    expect((await send(u, 'GET', '/api/hkd/books/S2d-HKD?from=2026-01-01&to=2026-01-31')).statusCode).toBe(403);
    expect((await send(u, 'GET', '/api/hkd/books/S2c-HKD?from=2026-01-01&to=2026-01-31')).statusCode).toBe(200);
    expect((await send(admin, 'GET', '/api/hkd/books/S2d-HKD?from=2026-01-01&to=2026-01-31')).statusCode).toBe(200);
  });
});
