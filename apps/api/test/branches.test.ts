import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { D } from '@kt/domain';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let ownerId: string; let userA: string; let userAId: string; let userB: string;
let brA: number; let brB: number;
const ids: Record<string, string> = {};
const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const ok = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => {
  const r = await req(method, url, c, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const L = (accountCode: string, debit: string, credit = '0') => ({ accountCode, debit, credit });
const pkt = async (c: string, date: string, desc: string, lines: object[], autoPost = true) =>
  (await ok('POST', '/api/vouchers', c, { voucherType: 'PKT', postingDate: date, documentDate: date, description: desc, autoPost, lines })).id as string;
const working = (c: string, branch: 'HO' | number) => ok('PUT', '/api/me/branch', c, { branch });
async function login(username: string) {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  return `sid=${r.cookies.find((x) => x.name === 'sid')!.value}`;
}
async function makeUser(name: string, branches: ('HO' | number)[]) {
  const username = `${name}${Date.now()}`.toLowerCase();
  const { id } = await ok('POST', '/api/users', owner, { username, fullName: name, password: TEST_PASSWORD, roleCode: 'ketoan_truong', sensitiveFlags: ['view_cost', 'view_receivable', 'view_payable'] });
  await ok('PUT', `/api/users/${id}/branch-scope`, owner, { branches });
  return { id: id as string, cookie: await login(username) };
}
const range = 'from=2026-01-01&to=2026-01-31';

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner, userId: ownerId } = await bootstrapTenant(ctx, { code: `CN${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  brA = (await ok('POST', '/api/branches', owner, { code: 'CNA', name: 'Chi nhánh Hà Nội', taxCode: '0101234567-001' })).id;
  brB = (await ok('POST', '/api/branches', owner, { code: 'CNB', name: 'Chi nhánh Đà Nẵng' })).id;
  // Trụ sở chính: góp vốn, chuyển vốn cho chi nhánh A (phải thu nội bộ).
  ids.ho1 = await pkt(owner, '2026-01-05', 'Góp vốn', [L('112', '5000'), L('41111', '0', '5000')]);
  ids.ho2 = await pkt(owner, '2026-01-06', 'Chuyển tiền cho chi nhánh A', [L('1368', '2000'), L('112', '0', '2000')]);
  await working(owner, brA);
  ids.a1 = await pkt(owner, '2026-01-06', 'Nhận tiền trụ sở chính', [L('111', '2000'), L('3368', '0', '2000')]);
  ids.a2 = await pkt(owner, '2026-01-10', 'Doanh thu A', [L('111', '700'), L('511', '0', '700')]);
  await working(owner, brB);
  ids.b1 = await pkt(owner, '2026-01-12', 'Doanh thu B', [L('112', '400'), L('511', '0', '400')]);
  ids.b2 = await pkt(owner, '2026-01-13', 'Chi phí B', [L('6422', '150'), L('112', '0', '150')]);
  ids.bDraft = await pkt(owner, '2026-01-14', 'Nháp B', [L('6422', '10'), L('112', '0', '10')], false);
  await working(owner, 'HO');
  ({ id: userAId, cookie: userA } = await makeUser('ktA', [brA]));
  ({ cookie: userB } = await makeUser('ktB', [brB]));
}, 180_000);
afterAll(async () => { await ctx?.close(); });

describe('chi nhánh của chứng từ', () => {
  it('chứng từ mới gắn chi nhánh làm việc; đảo giữ chi nhánh gốc; chứng từ cũ không đổi', async () => {
    expect((await ok('GET', `/api/vouchers/${ids.ho1}/branch`, owner)).branch).toBe('HO');
    expect((await ok('GET', `/api/vouchers/${ids.a1}/branch`, owner)).branch).toBe(brA);
    const rev = await ok('POST', `/api/vouchers/${ids.b2}/reverse`, owner, { postingDate: '2026-01-20' });
    expect((await ok('GET', `/api/vouchers/${rev.id}/branch`, owner)).branch).toBe(brB); // người đảo đang làm việc ở trụ sở chính
    await ok('POST', `/api/vouchers/${rev.id}/reverse`, owner, { postingDate: '2026-01-21' }); // đảo lại: B có lại chi phí 150
  });
  it('đổi chi nhánh: chỉ chứng từ nháp, ghi nhật ký kiểm toán; đã ghi sổ là 409', async () => {
    expect((await req('PUT', `/api/vouchers/${ids.a2}/branch`, owner, { branch: brB })).statusCode).toBe(409);
    await ok('PUT', `/api/vouchers/${ids.bDraft}/branch`, owner, { branch: 'HO' });
    await ok('PUT', `/api/vouchers/${ids.bDraft}/branch`, owner, { branch: brB });
    const a = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE entity = 'voucher' AND entity_id = ${ids.bDraft} AND action = 'branch'`.execute(ctx.t.admin);
    expect(a.rows[0]!.n).toBe(2);
    expect((await req('PUT', `/api/vouchers/${ids.bDraft}/branch`, owner, { branch: 999999 })).statusCode).toBe(404);
  });
});

describe('phạm vi chi nhánh chặn ở API', () => {
  it('người dùng chi nhánh A chỉ thấy chứng từ A; chứng từ B là 404 khi đọc, sửa, ghi sổ, xóa', async () => {
    const list = await ok('GET', '/api/vouchers?size=500', userA);
    expect(new Set(list.rows.map((r: { id: string }) => r.id))).toEqual(new Set([ids.a1, ids.a2]));
    for (const [m, url, body] of [['GET', `/api/vouchers/${ids.b1}`], ['GET', `/api/vouchers/${ids.b1}/branch`], ['POST', `/api/vouchers/${ids.bDraft}/post`, {}],
      ['DELETE', `/api/vouchers/${ids.bDraft}`], ['POST', `/api/vouchers/${ids.b1}/unpost`, {}], ['POST', `/api/vouchers/${ids.b1}/reverse`, { postingDate: '2026-01-25' }],
      ['PUT', `/api/vouchers/${ids.bDraft}/branch`, { branch: brA }]] as const) {
      const r = await req(m, url, userA, body);
      expect([m, url, r.statusCode]).toEqual([m, url, 404]);
    }
    // vẫn còn nguyên
    expect((await ok('GET', `/api/vouchers/${ids.bDraft}`, owner)).state).toBe('draft');
  });
  it('người dùng A lập chứng từ: tự gắn chi nhánh A; không chuyển được sang B hay trụ sở chính', async () => {
    const id = await pkt(userA, '2026-01-15', 'Chi phí A', [L('6422', '50'), L('111', '0', '50')], false);
    expect((await ok('GET', `/api/vouchers/${id}/branch`, userA)).branch).toBe(brA);
    expect((await req('PUT', `/api/vouchers/${id}/branch`, userA, { branch: brB })).statusCode).toBe(403);
    expect((await req('PUT', '/api/me/branch', userA, { branch: 'HO' })).statusCode).toBe(403);
    await ok('POST', `/api/vouchers/${id}/post`, userA, {});
    ids.a3 = id;
  });
  it('người dùng B không thấy chứng từ A', async () => {
    expect((await req('GET', `/api/vouchers/${ids.a1}`, userB)).statusCode).toBe(404);
  });
  it('người dùng bị giới hạn mất quyền cả công ty và báo cáo không theo chi nhánh', async () => {
    expect((await req('GET', '/api/balances?asOf=2026-01-31', userA)).json().error.code).toBe('BRANCH_SCOPE_FORBIDDEN');
    expect((await req('GET', `/api/reports/arap/summary?${range}&accountCode=131`, userA)).statusCode).toBe(403);
    expect((await req('GET', '/api/closing/steps', userA)).statusCode).toBe(403);
    expect((await req('GET', `/api/reports/ledgers/trial-balance?${range}&branch=${brB}`, userA)).json().error.code).toBe('BRANCH_FORBIDDEN');
    expect((await req('PUT', `/api/users/${ownerId}/branch-scope`, owner, { branches: [brA] })).json().error.code).toBe('BRANCH_SCOPE_SELF');
  });
});

describe('sổ sách và BCTC theo chi nhánh', () => {
  type Row = { accountCode: string; opening: { debit: string; credit: string }; period: { debit: string; credit: string }; closing: { debit: string; credit: string } };
  const tb = async (c: string, extra = '') => (await ok('GET', `/api/reports/ledgers/trial-balance?${range}&splitParty=false${extra}`, c)).rows as Row[];
  const find = (rows: Row[], code: string) => rows.find((r) => r.accountCode === code);
  it('Bảng cân đối số phát sinh của người dùng A chỉ gồm chi nhánh A', async () => {
    const rows = await tb(userA);
    expect(find(rows, '111')!.closing.debit).toBe('2650');
    expect(find(rows, '112')).toBeUndefined();
    expect(find(rows, '3368')!.closing.credit).toBe('2000');
    expect(rows).toEqual(await tb(owner, `&branch=${brA}`));
  });
  it('tổng các đơn vị = toàn công ty (Bảng cân đối số phát sinh, Sổ Cái)', async () => {
    const all = await tb(owner); const parts = await Promise.all(['HO', brA, brB].map((b) => tb(owner, `&branch=${b}`)));
    for (const r of all) for (const k of ['period', 'closing'] as const) for (const s of ['debit', 'credit'] as const) {
      if (r.accountCode.length > 3 && !find(parts[0]!, r.accountCode) && !find(parts[1]!, r.accountCode) && !find(parts[2]!, r.accountCode)) continue;
      const net = (x?: Row) => (x ? D(x[k].debit).minus(x[k].credit) : D(0));
      expect([r.accountCode, k, s, parts.reduce((t, p) => t.plus(net(find(p, r.accountCode))), D(0)).toString()]).toEqual([r.accountCode, k, s, net(r).toString()]);
    }
    const led = async (b?: string | number) => (await ok('GET', `/api/reports/ledgers/account?${range}&accountCode=112${b === undefined ? '' : `&branch=${b}`}`, owner));
    const [t, h, a, bb] = [await led(), await led('HO'), await led(brA), await led(brB)];
    expect(D(h.totalDebit).plus(a.totalDebit).plus(bb.totalDebit).toString()).toBe(t.totalDebit);
    expect(D(h.closing.debit).plus(bb.closing.debit).toString()).toBe(t.closing.debit);
  });
  it('Nhật ký chung của người dùng A chỉ có chứng từ A', async () => {
    const j = await ok('GET', `/api/reports/ledgers/general-journal?${range}`, userA);
    expect(new Set(j.rows.map((r: { voucherId: string }) => r.voucherId))).toEqual(new Set([ids.a1, ids.a2, ids.a3]));
  });
  it('B02 theo chi nhánh: người dùng A thấy doanh thu 700, chi phí 50', async () => {
    const r = await ok('GET', `/api/reports/financial/B02?${range}`, userA);
    expect(r.rows.find((x: { lineCode: string }) => x.lineCode === '01').current).toBe('700');
    expect(r).toEqual(await ok('GET', `/api/reports/financial/B02?${range}&branch=${brA}`, owner));
  });
});

describe('BCTC tổng hợp', () => {
  type Row = { lineCode: string; byUnit: string[]; total: string; elimination: string; consolidated: string };
  const line = (rows: Row[], c: string) => rows.find((x) => x.lineCode === c)!;
  it('B02: cộng = tổng các đơn vị = B02 toàn công ty, từng đơn vị khớp B02 lọc chi nhánh', async () => {
    const r = await ok('GET', `/api/reports/consolidated/B02?${range}`, owner);
    expect(r.units.map((u: { code: string }) => u.code)).toEqual(['HO', 'CNA', 'CNB']);
    const whole = await ok('GET', `/api/reports/financial/B02?${range}`, owner);
    for (const row of r.rows as Row[]) {
      expect(row.byUnit.reduce((t, x) => t.plus(x), D(0)).toString()).toBe(row.total);
      expect([row.lineCode, row.total]).toEqual([row.lineCode, whole.rows.find((x: { lineCode: string }) => x.lineCode === row.lineCode).current]);
    }
    expect(line(r.rows, '01').byUnit).toEqual(['0', '700', '400']);
    expect(line(r.rows, '01').consolidated).toBe('1100');
    for (const [i, b] of ['HO', brA, brB].entries()) {
      const one = await ok('GET', `/api/reports/financial/B02?${range}&branch=${b}`, owner);
      for (const row of r.rows as Row[]) expect(row.byUnit[i]).toBe(one.rows.find((x: { lineCode: string }) => x.lineCode === row.lineCode).current);
    }
  });
  it('B01: loại trừ phải thu/phải trả nội bộ cân, tổng tài sản = tổng nguồn vốn sau loại trừ', async () => {
    const r = await ok('GET', `/api/reports/consolidated/B01?from=2026-01-01&to=2026-01-31`, owner);
    expect(r.internalPrefixes).toEqual(['136', '336']);
    expect(r.internalNet).toBe('0');
    expect(line(r.rows, '133').elimination).toBe('2000');
    expect(line(r.rows, '317').elimination).toBe('2000');
    expect(line(r.rows, '133').consolidated).toBe('0');
    expect(line(r.rows, '280').elimination).toBe(line(r.rows, '440').elimination);
    // Chưa kết chuyển: tài sản lệch nguồn vốn đúng bằng lãi chưa kết chuyển (700 + 400 − 50 − 150 + 150 − 150 = 900) ở cả cột cộng và cột tổng hợp.
    const gap = (k: 'total' | 'consolidated') => D(line(r.rows, '280')[k]).minus(line(r.rows, '440')[k]).toString();
    expect(gap('total')).toBe(gap('consolidated'));
  });
  it('người dùng A: tổng hợp chỉ gồm đơn vị trong phạm vi; khai báo thêm tài khoản nội bộ', async () => {
    const r = await ok('GET', `/api/reports/consolidated/B02?${range}`, userA);
    expect(r.units.map((u: { code: string }) => u.code)).toEqual(['CNA']);
    expect((await req('PUT', '/api/branch-consolidation/settings', userA, { internalPrefixes: ['136'] })).statusCode).toBe(403);
    await ok('PUT', '/api/branch-consolidation/settings', owner, { internalPrefixes: ['136', '336', '511'] });
    const c = await ok('GET', `/api/reports/consolidated/B02?${range}`, owner);
    expect(line(c.rows, '01').elimination).toBe('1100');
    await ok('PUT', '/api/branch-consolidation/settings', owner, { internalPrefixes: ['136', '336'] });
  });
  it('xóa phạm vi: người dùng A thành toàn công ty', async () => {
    await ok('PUT', `/api/users/${userAId}/branch-scope`, owner, { branches: [] });
    expect((await ok('GET', '/api/vouchers/' + ids.b1, userA)).id).toBe(ids.b1);
  });
});
