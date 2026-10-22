import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let tenantId: string; let owner: string; let none: string; let costOnly: string;
const get = (url: string, c = owner) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
const post = (url: string, payload: object, c = owner) => ctx.app.inject({ method: 'POST', url, headers: { cookie: c }, payload });
const pkt = async (date: string, lines: object[]) => { const r = await post('/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: true, lines }); expect(r.statusCode, r.body).toBe(201); };
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `sf_${roleCode}_${sensitiveFlags.length}_${Date.now()}`;
  const made = await post('/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  expect(made.statusCode, made.body).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const codes = async (qs: string, c: string) => { const r = await get(`/api/balances?${qs}`, c); expect(r.statusCode, r.body).toBe(200); return [...new Set((r.json().rows as { accountCode: string }[]).map((x) => x.accountCode))]; };
const MSG = 'Cần quyền xem công nợ phải thu, phải trả và giá vốn để xem sổ tổng hợp';

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `SF${Date.now()}` }));
  await post('/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await post('/api/catalogs/party', { code: 'KH001', name: 'Khách 1', is_customer: true });
  await post('/api/catalogs/party', { code: 'NCC01', name: 'Nhà cung cấp 1', is_vendor: true });
  await pkt('2026-01-10', [{ accountCode: '131', debit: '500', partyCode: 'KH001' }, { accountCode: '5113', credit: '500' }]);
  await pkt('2026-01-11', [{ accountCode: '6421', debit: '200' }, { accountCode: '331', credit: '200', partyCode: 'NCC01' }]);
  await pkt('2026-01-12', [{ accountCode: '632', debit: '300' }, { accountCode: '1111', credit: '300' }]);
  await pkt('2026-01-13', [{ accountCode: '1111', debit: '900' }, { accountCode: '4111', credit: '900' }]);
  none = await userWith('ketoan_vien', []);
  costOnly = await userWith('ketoan_vien', ['view_cost']);
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('quyền GĐ3 của công ty mới và cờ view_cost cho tài khoản kho', () => {
  it('công ty mới: ketoan_vien có stock_voucher.create, không có costing.run; xem có item.view', async () => {
    const r = await sql<{ role: string; p: string }>`SELECT r.code AS role, rp.permission_code AS p FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    const has = (role: string, p: string) => r.rows.some((x) => x.role === role && x.p === p);
    expect(has('ketoan_vien', 'stock_voucher.create')).toBe(true);
    expect(has('ketoan_vien', 'costing.run')).toBe(false);
    expect(has('ketoan_vien', 'costing.view')).toBe(true);
    expect(has('ketoan_truong', 'costing.run')).toBe(true);
    expect(has('xem', 'item.view')).toBe(true);
    expect(has('xem', 'item.create')).toBe(false);
  });
  it('người dùng không có view_cost: sổ chi tiết tài khoản 156 trả 403 FORBIDDEN nêu cờ view_cost', async () => {
    const r = await get('/api/balances?asOf=2026-01-31&accountCode=156', none);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().message ?? r.body).toContain('giá vốn');
    expect((await get('/api/balances?asOf=2026-01-31&accountCode=156', costOnly)).statusCode).toBe(200);
  });
});

describe('cờ nhạy cảm bao phủ sổ tổng hợp và số dư', () => {
  const range = 'from=2026-01-01&to=2026-01-31';
  it('Nhật ký chung và Bảng cân đối số phát sinh: thiếu bất kỳ cờ nào là 403 (JSON và bản in); đủ cờ thì xem được', async () => {
    for (const c of [none, costOnly]) {
      for (const url of [`/api/reports/ledgers/general-journal?${range}`, `/api/reports/ledgers/general-journal?${range}&format=html`,
        `/api/reports/ledgers/trial-balance?${range}`, `/api/reports/ledgers/trial-balance?${range}&format=html`, `/api/reports/ledgers/trial-balance?${range}&format=xlsx`]) {
        const r = await get(url, c);
        expect([url, r.statusCode, r.json().error.code, r.json().error.message]).toEqual([url, 403, 'FORBIDDEN', MSG]);
      }
    }
    expect((await get(`/api/reports/ledgers/general-journal?${range}`)).statusCode).toBe(200);
    expect((await get(`/api/reports/ledgers/trial-balance?${range}&format=html`)).statusCode).toBe(200);
    expect((await get(`/api/reports/ledgers/account?accountCode=1111&${range}`, none)).statusCode).toBe(200); // sổ tài khoản thường vẫn mở
  });
  it('bộ sổ năm: Bảng cân đối số phát sinh cũng cần đủ ba cờ; báo cáo tài chính thì không', async () => {
    expect((await post('/api/print/book-set', { fiscalYear: 2026, include: ['trial'], format: 'xlsx' }, none)).statusCode).toBe(403);
    expect((await post('/api/print/book-set', { fiscalYear: 2026, include: ['B01', 'trial'], format: 'xlsx' }, costOnly)).statusCode).toBe(403);
    expect((await post('/api/print/book-set', { fiscalYear: 2026, include: ['trial'], format: 'xlsx' })).statusCode).toBe(200);
  });
  it('/api/balances bỏ dòng tài khoản bị che: 131 (phải thu), 331 (phải trả), 632 (giá vốn); đủ cờ thì thấy cả', async () => {
    expect(await codes('asOf=2026-01-31&byParty=true', owner)).toEqual(expect.arrayContaining(['131', '331', '632', '1111']));
    expect(await codes('asOf=2026-01-31', none)).toEqual(expect.not.arrayContaining(['131']));
    const n = await codes('asOf=2026-01-31', none); expect(n).toEqual(expect.arrayContaining(['1111', '5113', '6421'])); expect(n).not.toContain('131'); expect(n).not.toContain('331'); expect(n).not.toContain('632');
    const c = await codes('asOf=2026-01-31&byParty=true', costOnly); expect(c).toContain('632'); expect(c).not.toContain('131'); expect(c).not.toContain('331');
  });
  it('accountCode chỉ trúng tài khoản bị che thì 403; tiền tố có cả tài khoản được xem thì chỉ bỏ dòng bị che', async () => {
    for (const q of ['accountCode=131', 'accountCode=331', 'accountCode=632']) expect((await get(`/api/balances?asOf=2026-01-31&${q}`, none)).statusCode, q).toBe(403);
    expect((await get('/api/balances?asOf=2026-01-31&accountCode=632', costOnly)).statusCode).toBe(200);
    expect(await codes('asOf=2026-01-31&accountCode=1', none)).toEqual(['1111']); // 131 bị bỏ, 1111 còn
    expect((await get('/api/balances?asOf=2026-01-31&accountCode=9999', none)).statusCode).toBe(200); // không có tài khoản nào: rỗng, không phải 403
  });
});
