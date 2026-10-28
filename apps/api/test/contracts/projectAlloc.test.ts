import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

// GĐ6 Task 13c: phân bổ chi phí chung vào vụ việc (PB), kết chuyển giá vốn vụ việc/hợp đồng (GT 154 → 632), số dư theo vụ việc/hợp đồng,
// số dư đầu kỳ có vụ việc/hợp đồng, bộ lọc hợp đồng/đối tượng ở sổ chi tiết.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let seq = 0;
const tenant = (cookie: string, tenantId: string, userId: string) => {
  const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) }) as Promise<Res>;
  const ok = async (r: Promise<Res>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json() as Json; };
  const pkt = (date: string, lines: object[]) => ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Bút toán', autoPost: true, lines }), 201);
  const run = (kind: 'alloc' | 'cogs', month: number, params: object = {}, c = cookie) => ok(call('POST', '/api/projects/alloc', { kind, year: 2026, month, params }, c));
  const pnl = (from: string, to: string) => ok(call('GET', `/api/projects/pnl?from=${from}&to=${to}`));
  // Phát sinh ròng (Nợ − Có) sổ cái theo tiền tố TK, có/không vụ việc.
  const net = async (prefix: string, from: string, to: string, project?: string | null) => (await sql<{ n: string | null }>`SELECT sum(l.debit - l.credit)::text AS n
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN project p ON p.id = l.project_id
    WHERE l.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND starts_with(a.code, ${prefix}) AND l.posting_date BETWEEN ${from}::date AND ${to}::date
      AND (${project === undefined}::boolean OR p.code IS NOT DISTINCT FROM ${project ?? null})`.execute(ctx.t.admin)).rows[0]!.n ?? '0';
  const lines = async (id: string) => (await sql<{ a: string; d: string; c: string; p: string | null; k: string | null }>`SELECT a.code AS a, l.debit::text AS d, l.credit::text AS c, p.code AS p, k.code AS k
    FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN project p ON p.id = l.project_id LEFT JOIN contract k ON k.id = l.contract_id WHERE l.voucher_id = ${id}::uuid ORDER BY l.line_no`.execute(ctx.t.admin))
    .rows.map((r) => [r.a, r.d, r.c, r.p, r.k]);
  const runRow = async (kind: string, m: number) => (await sql<{ status: string; voucher_id: string | null }>`SELECT status, voucher_id FROM project_alloc_run WHERE tenant_id = ${tenantId}::uuid AND kind = ${kind} AND year = 2026 AND month = ${m}`.execute(ctx.t.admin)).rows[0]!;
  const asUser = (q: ReturnType<typeof sql>) => ctx.t.admin.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`.execute(trx);
    await q.execute(trx);
  });
  const login = async (perms: string[], flags: string[]) => {
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
    const username = `pb_${Date.now()}_${seq++}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
    const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  return { call, ok, pkt, run, pnl, net, lines, runRow, asUser, login, tenantId };
};
const M = (n: number) => String(n * 1_000_000);
const setup = async (code: string, regime: 'TT99' | 'TT133') => {
  const b = await setupLedgerTenant(ctx, `${code}${Date.now()}`, regime);
  const t = tenant(b.cookie, b.tenantId, b.userId);
  for (const [c, n] of [['P1', 'Công trình 1'], ['P2', 'Công trình 2'], ['P3', 'Công trình 3']]) await t.ok(t.call('POST', '/api/catalogs/project', { code: c, name: n }), 201);
  return t;
};
let A: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await createTestApp();
  A = await setup('PB', 'TT99');
  await A.ok(A.call('POST', '/api/contracts', { code: 'HB1', name: 'Hợp đồng bán 1', kind: 'sale', partyCode: 'KH001', value: M(100), status: 'active' }), 201);
  // Tháng 3: doanh thu P1 60 triệu, P2 40 triệu; 6411 chưa gắn 1.000.000, 6421 chưa gắn 2.000.001 (có dòng gắn hợp đồng nhưng không vụ việc); 6421 gắn P2 500.000; 632 P1 10 triệu.
  await A.pkt('2026-03-10', [{ accountCode: '131', debit: M(60), partyCode: 'KH001', projectCode: 'P1' }, { accountCode: '511', credit: M(60), projectCode: 'P1' }]);
  await A.pkt('2026-03-11', [{ accountCode: '111', debit: M(40) }, { accountCode: '511', credit: M(40), projectCode: 'P2' }]);
  await A.pkt('2026-03-20', [{ accountCode: '6411', debit: M(1) }, { accountCode: '6421', debit: '1100001' }, { accountCode: '6421', debit: '900000', contractCode: 'HB1' },
    { accountCode: '6421', debit: '500000', projectCode: 'P2' }, { accountCode: '632', debit: M(10), projectCode: 'P1' }, { accountCode: '111', credit: '13500001' }]);
});
afterAll(async () => { await ctx.close(); });

describe('phân bổ chi phí chung vào vụ việc (TT99)', () => {
  it('doanh thu thuần: cân, Σ phân bổ = chi phí chung, chưa phân bổ về 0, tổng công ty không đổi, làm tròn dồn vụ việc cuối; chạy lại unchanged', async () => {
    const before = await A.pnl('2026-03-01', '2026-03-31');
    expect(before.unassigned).toMatchObject({ selling: M(1), admin: '2000001' });
    const pv = await A.ok(A.call('POST', '/api/projects/alloc/preview', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'revenue' } }));
    expect(pv.accounts).toEqual([{ code: '6411', name: expect.any(String), pool: M(1) }, { code: '6421', name: expect.any(String), pool: '2000001' }]);
    expect(pv.result.map((r: Json) => [r.projectCode, r.ratio, r.amounts, r.total])).toEqual([
      ['P1', '60.0000', { 6411: '600000', 6421: '1200000' }, '1800000'], ['P2', '40.0000', { 6411: '400000', 6421: '800001' }, '1200001']]);
    const r = await A.run('alloc', 3, { basis: 'revenue' });
    expect(r).toMatchObject({ status: 'posted', unchanged: false, stale: false });
    expect(await A.lines(r.voucherId)).toEqual([['6411', '600000', '0', 'P1', null], ['6411', '400000', '0', 'P2', null], ['6411', '0', M(1), null, null],
      ['6421', '1200000', '0', 'P1', null], ['6421', '800001', '0', 'P2', null], ['6421', '0', '2000001', null, null]]);
    const v = await A.ok(A.call('GET', `/api/vouchers/${r.voucherId}`));
    expect(v).toMatchObject({ voucherType: 'PB', state: 'posted' });
    const after = await A.pnl('2026-03-01', '2026-03-31');
    expect(after.unassigned).toMatchObject({ selling: '0', admin: '0' });
    expect(after.totals).toEqual(before.totals); // tổng công ty không đổi
    expect(after.rows.find((x: Json) => x.code === 'P1')).toMatchObject({ selling: '600000', admin: '1200000' });
    expect(after.rows.find((x: Json) => x.code === 'P2')).toMatchObject({ selling: '400000', admin: '1300001' });
    expect(await A.net('64', '2026-03-01', '2026-03-31')).toBe('3500001');
    expect(await A.net('64', '2026-03-01', '2026-03-31', null)).toBe('0');
    // Chạy lại không đổi: không chứng từ mới.
    const again = await A.run('alloc', 3, { basis: 'revenue' });
    expect(again).toMatchObject({ unchanged: true, voucherId: r.voucherId });
    expect((await A.ok(A.call('GET', '/api/projects/alloc/alloc/2026/3'))).stale).toBe(false);
  });

  it('chi phí phát sinh thêm → cần chạy lại; chạy lại đảo cũ + sinh mới; đổi tiêu thức; tay; tiêu thức bằng 0 → 409', async () => {
    const old = (await A.ok(A.call('GET', '/api/projects/alloc/alloc/2026/3'))).voucherId as string;
    await A.pkt('2026-03-25', [{ accountCode: '6421', debit: '300000' }, { accountCode: '111', credit: '300000' }]);
    expect((await A.ok(A.call('GET', '/api/projects/alloc/alloc/2026/3'))).stale).toBe(true);
    const r = await A.run('alloc', 3, { basis: 'revenue' });
    expect(r).toMatchObject({ unchanged: false, reversedVoucherIds: [old] });
    expect((await A.ok(A.call('GET', `/api/vouchers/${old}`))).state).toBe('reversed');
    expect((await A.pnl('2026-03-01', '2026-03-31')).unassigned).toMatchObject({ selling: '0', admin: '0' });
    expect(await A.net('6421', '2026-03-01', '2026-03-31', 'P1')).toBe('1380000'); // 2.300.001 × 60% làm tròn xuống
    // Chi phí trực tiếp: P1 = giá vốn 10 triệu, P2 = 6421 trực tiếp 500.000 (bỏ chính PB).
    const dc = await A.ok(A.call('POST', '/api/projects/alloc/preview', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'direct_cost' } }));
    expect(dc.result.map((x: Json) => [x.projectCode, x.basis])).toEqual([['P1', M(10)], ['P2', '500000']]);
    const man = await A.ok(A.call('POST', '/api/projects/alloc/preview', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'manual', manual: [{ projectCode: 'P3', weight: '1' }] } }));
    expect(man.result).toMatchObject([{ projectCode: 'P3', total: '3300001' }]);
    expect((await A.call('POST', '/api/projects/alloc/preview', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'manual', manual: [{ projectCode: 'XX', weight: '1' }] } })).statusCode).toBe(404);
    const z = await A.call('POST', '/api/projects/alloc', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'manual', manual: [{ projectCode: 'P3', weight: '0' }] } });
    expect([z.statusCode, z.json().error.code]).toEqual([409, 'PROJECT_ALLOC_BASIS_ZERO']);
  });

  it('gỡ liên kết: route chung 409; bỏ ghi sổ bị chặn ở CSDL; đảo ngoài luồng → unlinked, cần chạy lại, chạy lại sinh mới đúng số', async () => {
    const cur = (await A.ok(A.call('GET', '/api/projects/alloc/alloc/2026/3'))).voucherId as string;
    for (const [u, p] of [['unpost'], ['reverse', { postingDate: '2026-03-31' }], ['discard']] as [string, object?][]) {
      const r = await A.call('POST', `/api/vouchers/${cur}/${u}`, p);
      expect([u, r.statusCode, r.json().error.code]).toEqual([u, 409, 'VOUCHER_SYSTEM_GENERATED']);
    }
    await expect(sql`SELECT unpost_voucher(${cur}::uuid)`.execute(ctx.t.admin)).rejects.toThrow(/VOUCHER_SYSTEM_GENERATED/);
    // Đảo ngoài luồng ở tháng sau: không làm phân bổ cộng dồn khi chạy lại tháng 3 (mọi PB phân bổ bị loại khỏi phần chung).
    await A.asUser(sql`SELECT reverse_voucher(${cur}::uuid, '2026-04-05'::date, NULL)`);
    expect(await A.runRow('alloc', 3)).toEqual({ status: 'unlinked', voucher_id: null });
    expect((await A.ok(A.call('GET', '/api/projects/alloc/alloc/2026/3'))).stale).toBe(true);
    const r = await A.run('alloc', 3, { basis: 'revenue' });
    expect(r).toMatchObject({ status: 'posted', unchanged: false, reversedVoucherIds: [] });
    // Bản đảo ngày 05/4 trả phần chung về tháng 4; PB mới ghi lại tháng 3: lũy kế tháng 3–4 chưa phân bổ = 0, đúng một lần phân bổ.
    expect(await A.net('64', '2026-03-01', '2026-04-30', null)).toBe('0');
    expect(await A.net('64', '2026-03-01', '2026-04-30', 'P1')).toBe('1980000');
    // Tháng 4 chỉ có bản đảo của PB: không có chi phí chung (bản đảo không bị phân bổ lại).
    const apr = await A.ok(A.call('POST', '/api/projects/alloc/preview', { kind: 'alloc', year: 2026, month: 4, params: {} }));
    expect([apr.accounts, apr.lines]).toEqual([[], []]);
  });

  it('kỳ khóa cứng: đầu vào đổi → 409; không đổi → unchanged; thiếu cờ/quyền 403; công ty khác không thấy (RLS)', async () => {
    await A.pkt('2026-03-26', [{ accountCode: '6411', debit: '100000' }, { accountCode: '111', credit: '100000' }]);
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${A.tenantId}::uuid AND fiscal_year = 2026 AND period_no = 3`.execute(ctx.t.admin);
    const locked = await A.call('POST', '/api/projects/alloc', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'revenue' } });
    expect([locked.statusCode, locked.json().error.code]).toEqual([409, 'PERIOD_HARD_LOCKED']);
    await sql`UPDATE fiscal_period SET status = 'open' WHERE tenant_id = ${A.tenantId}::uuid AND fiscal_year = 2026 AND period_no = 3`.execute(ctx.t.admin);
    await A.run('alloc', 3, { basis: 'revenue' });
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${A.tenantId}::uuid AND fiscal_year = 2026 AND period_no = 3`.execute(ctx.t.admin);
    expect((await A.run('alloc', 3, { basis: 'revenue' })).unchanged).toBe(true);
    await sql`UPDATE fiscal_period SET status = 'open' WHERE tenant_id = ${A.tenantId}::uuid AND fiscal_year = 2026 AND period_no = 3`.execute(ctx.t.admin);

    const noCost = await A.login(['contract_track.view', 'contract_track.run'], ['view_receivable', 'view_payable', 'view_salary']);
    for (const [m, u, p] of [['GET', '/api/projects/alloc/alloc/2026/3'], ['POST', '/api/projects/alloc/preview', { kind: 'alloc', year: 2026, month: 3 }],
      ['POST', '/api/projects/alloc', { kind: 'alloc', year: 2026, month: 3 }], ['GET', '/api/projects/balances?from=2026-01-01&to=2026-12-31']] as ['GET' | 'POST', string, object?][])
      expect([u, (await A.call(m, u, p, noCost)).statusCode]).toEqual([u, 403]);
    const viewOnly = await A.login(['contract_track.view'], ['view_receivable', 'view_payable', 'view_salary', 'view_cost']);
    expect((await A.call('GET', '/api/projects/alloc/alloc/2026/3', undefined, viewOnly)).statusCode).toBe(200);
    expect((await A.call('POST', '/api/projects/alloc', { kind: 'alloc', year: 2026, month: 3 }, viewOnly)).statusCode).toBe(403);
    // Công ty khác: không thấy lần chạy, không thấy bảng (RLS).
    const B = await setup('PX', 'TT99');
    expect((await B.call('GET', '/api/projects/alloc/alloc/2026/3')).statusCode).toBe(404);
    const seen = await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx); await sql`SELECT set_config('app.current_tenant', ${B.tenantId}, true)`.execute(trx);
      return (await sql<{ n: number }>`SELECT count(*)::int AS n FROM project_alloc_run`.execute(trx)).rows[0]!.n;
    });
    expect(seen).toBe(0);
  });
});

describe('phân bổ TT133 (6421/6422)', () => {
  it('nhóm tài khoản theo chế độ: Nợ 6422 có vụ việc / Có 6422, chưa phân bổ về 0', async () => {
    const T = await setup('PT', 'TT133');
    await T.pkt('2026-02-10', [{ accountCode: '1111', debit: M(5) }, { accountCode: '5113', credit: M(5), projectCode: 'P2' }]);
    await T.pkt('2026-02-20', [{ accountCode: '6422', debit: M(1) }, { accountCode: '6421', debit: '250000' }, { accountCode: '1111', credit: '1250000' }]);
    const r = await T.run('alloc', 2, {});
    expect(await T.lines(r.voucherId)).toEqual([['6421', '250000', '0', 'P2', null], ['6421', '0', '250000', null, null], ['6422', M(1), '0', 'P2', null], ['6422', '0', M(1), null, null]]);
    expect((await T.pnl('2026-02-01', '2026-02-28')).unassigned).toMatchObject({ selling: '0', admin: '0' });
  });
  it('kết chuyển giá vốn TT133 qua API: GT Nợ 632 / Có 154 giữ vụ việc, 154 về 0, giá vốn vào lãi lỗ theo nhóm cogs của chế độ, chạy lại unchanged', async () => {
    const T = await setup('PG', 'TT133');
    await T.pkt('2026-05-10', [{ accountCode: '154', debit: M(3), projectCode: 'P1' }, { accountCode: '154', debit: M(1), projectCode: 'P3' }, { accountCode: '1111', credit: M(4) }]);
    const r = await T.run('cogs', 5, { projectCodes: ['P1'] });
    expect(await T.lines(r.voucherId)).toEqual([['632', M(3), '0', 'P1', null], ['154', '0', M(3), 'P1', null]]);
    expect((await T.ok(T.call('GET', `/api/vouchers/${r.voucherId}`))).voucherType).toBe('GT');
    expect([await T.net('154', '2026-05-01', '2026-05-31', 'P1'), await T.net('154', '2026-05-01', '2026-05-31', 'P3')]).toEqual(['0', M(1)]);
    expect((await T.pnl('2026-05-01', '2026-05-31')).rows.find((x: Json) => x.code === 'P1')).toMatchObject({ cogs: M(3) });
    expect((await T.run('cogs', 5, { projectCodes: ['P1'] })).unchanged).toBe(true);
  });
});

describe('kết chuyển giá vốn vụ việc/hợp đồng, số dư theo vụ việc, bộ lọc sổ chi tiết', () => {
  it('hoàn thành: GT Nợ 632 / Có 154 giữ chiều, cân; 154 vụ việc về 0; chạy lại unchanged; số dư theo vụ việc khớp sổ cái; sổ chi tiết lọc hợp đồng/vụ việc', async () => {
    await A.pkt('2026-04-10', [{ accountCode: '154', debit: M(5), projectCode: 'P1' }, { accountCode: '154', debit: M(2), projectCode: 'P2', contractCode: 'HB1' },
      { accountCode: '154', debit: M(1), projectCode: 'P2' }, { accountCode: '111', credit: M(8) }]);
    expect((await A.call('POST', '/api/projects/alloc', { kind: 'cogs', year: 2026, month: 4, params: {} })).statusCode).toBe(400);
    const r = await A.run('cogs', 4, { projectCodes: ['P1'], contractCodes: ['HB1'] });
    expect(await A.lines(r.voucherId)).toEqual([['632', M(5), '0', 'P1', null], ['154', '0', M(5), 'P1', null], ['632', M(2), '0', 'P2', 'HB1'], ['154', '0', M(2), 'P2', 'HB1']]);
    expect(r.result).toEqual([{ dim: 'project', code: 'P1', name: 'Công trình 1', amount: M(5) }, { dim: 'contract', code: 'HB1', name: 'Hợp đồng bán 1', amount: M(2) }]);
    expect((await A.ok(A.call('GET', `/api/vouchers/${r.voucherId}`))).voucherType).toBe('GT');
    expect(await A.net('154', '2026-01-01', '2026-04-30', 'P1')).toBe('0');
    expect((await A.run('cogs', 4, { projectCodes: ['P1'], contractCodes: ['HB1'] })).unchanged).toBe(true);
    // Lãi lỗ: giá vốn P1 tăng 5 triệu.
    expect((await A.pnl('2026-04-01', '2026-04-30')).rows.find((x: Json) => x.code === 'P1')).toMatchObject({ cogs: M(5) });

    const b = await A.ok(A.call('GET', '/api/projects/balances?from=2026-04-01&to=2026-04-30'));
    expect(b.wip).toEqual([{ dimId: expect.any(Number), dimCode: 'P2', dimName: 'Công trình 2', amount: M(1) }]);
    // Σ theo TK (gồm dòng "không gắn") = sổ cái của TK: dư cuối và phát sinh.
    const byAcc = new Map<string, number>();
    for (const x of b.rows as Json[]) byAcc.set(x.accountCode, (byAcc.get(x.accountCode) ?? 0) + Number(x.closing.debit) - Number(x.closing.credit));
    for (const [acc, n] of byAcc) expect([acc, String(n)]).toEqual([acc, await A.net(acc, '2000-01-01', '2026-04-30')]);
    expect(b.rows.find((x: Json) => x.dimCode === 'P1' && x.accountCode === '131')).toMatchObject({ opening: { debit: M(60), credit: '0' }, debit: '0', closing: { debit: M(60) } });
    // Một vụ việc, một TK, theo hợp đồng.
    const p2 = (await sql<{ id: number }>`SELECT id::int FROM project WHERE tenant_id = ${A.tenantId}::uuid AND code = 'P2'`.execute(ctx.t.admin)).rows[0]!.id;
    expect((await A.ok(A.call('GET', `/api/projects/balances?from=2026-04-01&to=2026-04-30&id=${p2}&accountCode=154`))).rows)
      .toEqual([expect.objectContaining({ dimCode: 'P2', accountCode: '154', debit: M(3), credit: M(2), closing: { debit: M(1), credit: '0' } })]);
    const byC = await A.ok(A.call('GET', '/api/projects/balances?from=2026-01-01&to=2026-04-30&by=contract&accountCode=154'));
    expect(byC.rows.find((x: Json) => x.dimCode === 'HB1')).toMatchObject({ debit: M(2), credit: M(2), closing: { debit: '0', credit: '0' } });
    const x = await A.call('GET', '/api/projects/balances?from=2026-04-01&to=2026-04-30&format=xlsx');
    expect(x.statusCode, x.body).toBe(200);
    // Sổ chi tiết lọc hợp đồng / vụ việc.
    const d = await A.ok(A.call('GET', '/api/reports/ledgers/detail?accountCode=154&from=2026-04-01&to=2026-04-30&contractCode=HB1'));
    expect([d.totalDebit, d.totalCredit, d.rows.length]).toEqual([M(2), M(2), 2]);
    expect((await A.ok(A.call('GET', '/api/reports/ledgers/detail?accountCode=154&from=2026-04-01&to=2026-04-30&projectCode=P2'))).closing).toEqual({ debit: M(3 - 2), credit: '0' });
    expect((await A.call('GET', '/api/reports/ledgers/detail?accountCode=154&from=2026-04-01&to=2026-04-30&costObjectCode=KHONGCO')).statusCode).toBe(404);
  });
});

describe('số dư đầu kỳ theo vụ việc/hợp đồng', () => {
  it('nhập 154 và 131 theo vụ việc, hợp đồng bán; DK giữ chiều; khớp fn_balances_at; cuối năm 2026 = đầu năm 2027 theo vụ việc', async () => {
    const C = await setup('DK', 'TT99');
    await C.ok(C.call('POST', '/api/contracts', { code: 'HB9', name: 'Hợp đồng 9', kind: 'sale', partyCode: 'KH001', value: M(10), status: 'active' }), 201);
    const row = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', ...more });
    const rows = [row('154', M(3), '0', { projectCode: 'P1' }), row('131', M(2), '0', { partyCode: 'KH001', projectCode: 'P1', contractCode: 'HB9' }), row('41111', '0', M(5))];
    const bad = await C.call('PUT', '/api/opening-balance/2026', { rows: [row('3411', '0', M(1), { contractCode: 'HB9' }), row('111', M(1), '0')] });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'OPENING_CONTRACT_NOT_ALLOWED']);
    expect((await C.call('PUT', '/api/opening-balance/2026', { rows: [row('154', M(1), '0', { projectCode: 'XX' })] })).statusCode).toBe(404);
    await C.ok(C.call('PUT', '/api/opening-balance/2026', { rows }));
    expect((await C.ok(C.call('GET', '/api/opening-balance/2026'))).map((r: Json) => [r.accountCode, r.projectCode, r.contractCode])).toEqual([['131', 'P1', 'HB9'], ['154', 'P1', null], ['41111', null, null]]);
    expect((await C.ok(C.call('GET', '/api/opening-balance/2026/check'))).filter((i: Json) => !i.warning)).toEqual([]);
    await C.ok(C.call('POST', '/api/opening-balance/2026/post'));
    const dk = await sql<{ a: string; p: string | null; k: string | null; d: string }>`SELECT a.code AS a, p.code AS p, k.code AS k, l.debit::text AS d FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
      JOIN account a ON a.id = l.account_id LEFT JOIN project p ON p.id = l.project_id LEFT JOIN contract k ON k.id = l.contract_id
      WHERE v.tenant_id = ${C.tenantId}::uuid AND v.voucher_type = 'DK' AND l.debit > 0 ORDER BY a.code`.execute(ctx.t.admin);
    expect(dk.rows.map((r) => [r.a, r.p, r.k, r.d])).toEqual([['131', 'P1', 'HB9', M(2)], ['154', 'P1', null, M(3)]]);
    await C.pkt('2026-06-30', [{ accountCode: '154', debit: '700000', projectCode: 'P1' }, { accountCode: '111', credit: '700000' }]);

    const y26 = await C.ok(C.call('GET', '/api/projects/balances?from=2026-01-01&to=2026-12-31'));
    const p1 = (acc: string, r: Json) => r.rows.find((x: Json) => x.dimCode === 'P1' && x.accountCode === acc);
    expect(p1('154', y26)).toMatchObject({ opening: { debit: M(3), credit: '0' }, debit: '700000', closing: { debit: '3700000', credit: '0' } });
    expect(p1('131', y26)).toMatchObject({ opening: { debit: M(2), credit: '0' }, closing: { debit: M(2) } });
    // Σ dư đầu theo vụ việc (gồm không gắn) = fn_balances_at theo TK tại ngày trước đầu kỳ.
    const fb = await sql<{ code: string; n: string }>`SELECT a.code, sum(b.debit - b.credit)::text AS n FROM fn_balances_at(${C.tenantId}::uuid, '2025-12-31'::date) b JOIN account a ON a.id = b.account_id GROUP BY a.code`.execute(ctx.t.admin);
    const open = new Map<string, number>();
    for (const x of y26.rows as Json[]) open.set(x.accountCode, (open.get(x.accountCode) ?? 0) + Number(x.opening.debit) - Number(x.opening.credit));
    for (const [acc, n] of open) expect([acc, n]).toEqual([acc, Number(fb.rows.find((r) => r.code === acc)?.n ?? 0)]);
    expect(y26.wip).toEqual([expect.objectContaining({ dimCode: 'P1', amount: '3700000' })]);
    // Năm sau: số dư lũy kế, đầu năm 2027 theo vụ việc = cuối năm 2026.
    await C.ok(C.call('POST', '/api/fiscal-years', { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT99' }), 201);
    const y27 = await C.ok(C.call('GET', '/api/projects/balances?from=2027-01-01&to=2027-01-31'));
    for (const r of y26.rows as Json[]) expect([r.dimCode, r.accountCode, y27.rows.find((x: Json) => x.dimCode === r.dimCode && x.accountCode === r.accountCode)?.opening]).toEqual([r.dimCode, r.accountCode, r.closing]);
  });
});
