import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let brA: number; let brB: number; let scoped: string;
const req = (method: 'GET' | 'POST' | 'PUT', url: string, c: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, c: string, payload?: object) => { const r = await req(method, url, c, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json(); };
const pkt = async (date: string, branch: 'HO' | number, post = true) => {
  const v = await ok('POST', '/api/vouchers', owner, { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: false, lines: [{ accountCode: '6422', debit: '10' }, { accountCode: '1111', credit: '10' }] });
  await ok('PUT', `/api/vouchers/${v.id}/branch`, owner, { branch });
  if (post) await ok('POST', `/api/vouchers/${v.id}/post`, owner);
  return v.id as string;
};
const list = async (qs: string, c = owner) => (await ok('GET', `/api/vouchers?type=PKT&size=100${qs}`, c)).rows as { id: string; branchCode: string | null }[];

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner } = await bootstrapTenant(ctx, { code: `VL${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  brA = (await ok('POST', '/api/branches', owner, { code: 'HN', name: 'Hà Nội' })).id;
  brB = (await ok('POST', '/api/branches', owner, { code: 'DN', name: 'Đà Nẵng' })).id;
  await pkt('2026-01-05', 'HO'); await pkt('2026-01-06', brA); await pkt('2026-01-07', brB); await pkt('2026-01-08', brB, false);
  const username = `ktA${Date.now()}`.toLowerCase();
  const u = await ok('POST', '/api/users', owner, { username, fullName: 'KT A', password: TEST_PASSWORD, roleCode: 'ketoan_truong', sensitiveFlags: [] });
  await ok('PUT', `/api/users/${u.id}/branch-scope`, owner, { branches: [brA] });
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  scoped = `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
});
afterAll(async () => { await ctx?.close(); });

describe('danh sách chứng từ theo chi nhánh', () => {
  it('mỗi dòng có mã chi nhánh (null = trụ sở chính); lọc theo HO hoặc id chi nhánh', async () => {
    const all = await list('');
    expect(all.map((r) => r.branchCode).sort()).toEqual(['DN', 'DN', 'HN', null]);
    expect((await list('&branch=HO')).map((r) => r.branchCode)).toEqual([null]);
    expect((await list(`&branch=${brB}`)).map((r) => r.branchCode)).toEqual(['DN', 'DN']);
    expect((await list(`&branch=${brA}&state=posted`)).map((r) => r.branchCode)).toEqual(['HN']);
    expect((await req('GET', '/api/vouchers?branch=abc', owner)).statusCode).toBe(400);
  });

  it('người bị giới hạn chi nhánh chỉ thấy chứng từ trong phạm vi, kể cả khi lọc sang chi nhánh khác', async () => {
    expect((await list('', scoped)).map((r) => r.branchCode)).toEqual(['HN']);
    expect(await list(`&branch=${brB}`, scoped)).toEqual([]);
    expect(await list('&branch=HO', scoped)).toEqual([]);
  });
});
