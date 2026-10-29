import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

// T6 (tồn đọng 2026-10-30): chọn chi nhánh của chứng từ số dư đầu kỳ (DK) khi ghi sổ. Cả năm một DK nên toàn bộ số dư thuộc một chi nhánh (QĐ 1808–1812).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let brA: number; let brB: number;
const req = (method: 'GET' | 'POST' | 'PUT', url: string, c: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, c: string, payload?: object) => {
  const r = await req(method, url, c, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
type TbRow = { accountCode: string; opening: { debit: string; credit: string }; closing: { debit: string; credit: string } };
const tb = async (extra = '') => (await ok('GET', `/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-01-31&splitParty=false${extra}`, owner)).rows as TbRow[];
const openingOf = (rows: TbRow[], code: string) => rows.find((r) => r.accountCode === code)?.opening.debit ?? '0';
const rows = [{ accountCode: '111', debit: '1000' }, { accountCode: '41111', credit: '1000' }];

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner } = await bootstrapTenant(ctx, { code: `OB${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  brA = (await ok('POST', '/api/branches', owner, { code: 'CNA', name: 'Chi nhánh A' })).id;
  brB = (await ok('POST', '/api/branches', owner, { code: 'CNB', name: 'Chi nhánh B' })).id;
  await ok('PUT', '/api/opening-balance/2026', owner, { rows });
}, 180_000);
afterAll(async () => { await ctx?.close(); });

describe('số dư đầu kỳ theo chi nhánh', () => {
  it('không chọn: DK theo chi nhánh làm việc (như cũ); chưa có DK thì branch null', async () => {
    expect((await ok('GET', '/api/opening-balance/2026/branch', owner)).branch).toBeNull();
    await ok('PUT', '/api/me/branch', owner, { branch: brB });
    const dk = await ok('POST', '/api/opening-balance/2026/post', owner);
    expect((await ok('GET', `/api/vouchers/${dk.id}/branch`, owner)).branch).toBe(brB);
    expect((await ok('GET', '/api/opening-balance/2026/branch', owner)).branch).toBe(brB);
    // ghi sổ lại không chọn: giữ chi nhánh cũ dù đổi chi nhánh làm việc
    await ok('PUT', '/api/me/branch', owner, { branch: 'HO' });
    await ok('POST', '/api/opening-balance/2026/post', owner, {});
    expect((await ok('GET', '/api/opening-balance/2026/branch', owner)).branch).toBe(brB);
  });

  it('chọn chi nhánh A: DK chuyển sang A; số đầu kỳ chỉ ở A trong Bảng cân đối số phát sinh và BCTC tổng hợp', async () => {
    const before = await ok('GET', '/api/opening-balance/2026/branch', owner); expect(before.branch).toBe(brB);
    const dk = await ok('POST', '/api/opening-balance/2026/post', owner, { branch: brA });
    expect([dk.state, (await ok('GET', `/api/vouchers/${dk.id}/branch`, owner)).branch]).toEqual(['posted', brA]);
    expect([openingOf(await tb(`&branch=${brA}`), '111'), openingOf(await tb(`&branch=${brB}`), '111'), openingOf(await tb('&branch=HO'), '111'), openingOf(await tb(), '111')]).toEqual(['1000', '0', '0', '1000']);
    const c = await ok('GET', '/api/reports/consolidated/B01?from=2026-01-01&to=2026-01-31', owner);
    expect(c.units.map((u: { code: string }) => u.code)).toEqual(['HO', 'CNA', 'CNB']);
    const cash = (c.rows as { lineCode: string; byUnit: string[] }[]).find((r) => r.lineCode === '111')!;
    expect(cash.byUnit).toEqual(['0', '1000', '0']);
    // về trụ sở chính
    await ok('POST', '/api/opening-balance/2026/post', owner, { branch: 'HO' });
    expect((await ok('GET', '/api/opening-balance/2026/branch', owner)).branch).toBe('HO');
    expect(openingOf(await tb('&branch=HO'), '111')).toBe('1000');
  });

  it('chi nhánh không có: 404; giá trị sai: 400', async () => {
    expect((await req('POST', '/api/opening-balance/2026/post', owner, { branch: 99999999 })).json().error.code).toBe('BRANCH_NOT_FOUND');
    expect((await req('POST', '/api/opening-balance/2026/post', owner, { branch: 'X' })).statusCode).toBe(400);
    expect((await ok('GET', '/api/opening-balance/2026/branch', owner)).branch).toBe('HO'); // lỗi không đổi DK
  });

  it('đánh số theo chi nhánh đang bật: DK đã có số không đổi chi nhánh được (409); cùng chi nhánh vẫn ghi lại được', async () => {
    await ok('PUT', '/api/voucher-numbering/settings', owner, { perBranch: true, hqCode: 'TSC' });
    expect((await req('POST', '/api/opening-balance/2026/post', owner, { branch: brA })).json().error.code).toBe('OPENING_BRANCH_NUMBERED');
    expect((await req('POST', '/api/opening-balance/2026/post', owner, { branch: 'HO' })).statusCode).toBe(200);
    await ok('PUT', '/api/voucher-numbering/settings', owner, { perBranch: false, hqCode: 'TSC' });
  });

  it('người dùng bị giới hạn chi nhánh không có quyền số dư đầu kỳ (danh sách quyền theo chi nhánh): 403', async () => {
    const username = `obr${Date.now()}`;
    const { id } = await ok('POST', '/api/users', owner, { username, fullName: 'A', password: TEST_PASSWORD, roleCode: 'ketoan_truong', sensitiveFlags: ['view_cost', 'view_receivable', 'view_payable', 'view_salary'] });
    await ok('PUT', `/api/users/${id}/branch-scope`, owner, { branches: [brA] });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await req('POST', '/api/opening-balance/2026/post', c, { branch: brA })).statusCode).toBe(403);
    expect((await req('GET', '/api/opening-balance/2026/branch', c)).statusCode).toBe(403);
  });
});
