import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { assetRunStale, refreshRuns } from '../../src/modules/assets/periodRun.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const nợ = (account: string, debit: string, more: object = {}) => ({ accountCode: account, debit, credit: '0', ...more });
const có = (account: string, credit: string, more: object = {}) => ({ accountCode: account, debit: '0', credit, ...more });

// Năm 2026 TT133 (12 kỳ tháng), đối tượng NCC001.
async function tenant() {
  const { cookie, tenantId, userId } = await setupLedgerTenant(ctx, `KH${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  const pkt = (date: string, lines: object[]) => ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'mua tài sản', autoPost: true, lines }), 201);
  // Thẻ TSCĐ 2111/2141 bắt đầu khấu hao 01/01/2026, nguyên giá ghi bằng PKT ngày 01/01, phân bổ chi phí từ kỳ 1.
  const fixed = async (code: string, cost: string, lifeUnits: number, alloc: object[] = [{ expenseAccountCode: '6422', ratio: '100' }], more: object = {}) => {
    const a = await ok(call('POST', '/api/assets', { code, name: `TSCĐ ${code}`, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', depreciationStartDate: '2026-01-01', lifeUnits, ...more }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: alloc }));
    const v = await pkt('2026-01-01', [nợ('2111', cost, { assetCode: code }), có('331', cost, { partyCode: 'NCC001' })]);
    return { id: a.id as number, voucherId: v.id as string };
  };
  const run = (periodNo: number) => call('POST', '/api/asset-runs', { kind: 'depreciation', fiscalYear: 2026, periodNo });
  const runOk = (periodNo: number) => ok(run(periodNo));
  const voucher = (id: string) => ok(call('GET', `/api/vouchers/${id}`));
  const db = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.t.db, { tenantId, userId }, fn);
  const count = async (q: string) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.raw(q)} AND tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n);
  return { cookie, tenantId, userId, call, ok, pkt, fixed, run, runOk, voucher, db, count };
}
const lineKey = (l: { accountCode: string; debit: string; credit: string; assetCode?: string | null; departmentCode?: string | null }) =>
  `${l.accountCode}|${l.debit}|${l.credit}|${l.assetCode ?? ''}|${l.departmentCode ?? ''}`;

describe('chạy khấu hao TSCĐ theo kỳ (KH)', () => {
  it('TS01 nguyên giá 120.000.000, 60 tháng từ 01/01/2026: KH tháng 1 Nợ 6422 2.000.000 / Có 2141 TS01', async () => {
    const t = await tenant(); const a = await t.fixed('TS01', '120000000', 60);
    // Chưa chạy kỳ nào: lịch xem trước tính trong bộ nhớ đủ 60 kỳ, tổng bằng nguyên giá, không lưu phiên bản.
    const pre = await t.ok(t.call('GET', `/api/assets/${a.id}/schedule`)) as { periodNo: number; amount: string }[];
    expect(pre).toHaveLength(60);
    expect(pre.reduce((s, l) => s + Number(l.amount), 0)).toBe(120_000_000);
    expect(pre[0]).toMatchObject({ periodNo: 1, amount: '2000000' });
    expect(await t.count(`asset_schedule WHERE true`)).toBe(0);
    expect((await t.ok(t.call('GET', '/api/assets?kind=fixed')))[0]).toMatchObject({ remainingUnits: '60' });
    const r = await t.runOk(1);
    expect((await t.ok(t.call('GET', '/api/assets?kind=fixed')))[0]).toMatchObject({ remainingUnits: '59' });
    expect(r).toMatchObject({ unchanged: false, reversedVoucherIds: [], lines: [{ assetCode: 'TS01', amount: '2000000' }] });
    const v = await t.voucher(r.voucherId);
    expect(v).toMatchObject({ voucherType: 'KH', state: 'posted', postingDate: '2026-01-31' });
    expect(v.lines.map(lineKey)).toEqual(['6422|2000000|0||', '2141|0|2000000|TS01|']);
    const runs = await t.ok(t.call('GET', '/api/asset-runs?kind=depreciation&year=2026'));
    expect(runs).toMatchObject([{ id: r.runId, fiscalYear: 2026, periodNo: 1, status: 'active', voucherId: r.voucherId }]);
    const sch = await t.ok(t.call('GET', `/api/assets/${a.id}/schedule`));
    expect(sch).toHaveLength(60);
    expect(sch[0]).toMatchObject({ fiscalYear: 2026, periodNo: 1, amount: '2000000', accumulated: '2000000' });
    expect(sch[59]).toMatchObject({ fiscalYear: 2030, periodNo: 12, accumulated: '120000000' });
  });

  it('chạy lại tháng 1 không đổi gì → unchanged, không chứng từ mới, vẫn một period_run active', async () => {
    const t = await tenant(); await t.fixed('TS01', '120000000', 60);
    const a = await t.runOk(1); const b = await t.runOk(1);
    expect(b).toMatchObject({ unchanged: true, runId: a.runId, voucherId: a.voucherId, reversedVoucherIds: [] });
    expect(await t.count(`voucher WHERE voucher_type = 'KH'`)).toBe(1);
    expect(await t.count(`period_run WHERE status = 'active'`)).toBe(1);
    expect(await t.count(`period_run WHERE checked_at IS NOT NULL`)).toBe(1);
  });

  it('hai yêu cầu chạy tháng 1 đồng thời → đúng một period_run active (chỉ mục duy nhất + khóa tư vấn)', async () => {
    const t = await tenant(); await t.fixed('TS01', '120000000', 60);
    const [a, b] = await Promise.all([t.run(1), t.run(1)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().unchanged, b.json().unchanged].sort()).toEqual([false, true]);
    expect(await t.count(`period_run WHERE status = 'active'`)).toBe(1);
    expect(await t.count(`period_run WHERE true`)).toBe(1);
    expect(await t.count(`voucher WHERE voucher_type = 'KH'`)).toBe(1);
  });

  it('chạy tháng 3 khi tháng 2 chưa chạy → 409 PERIOD_RUN_GAP', async () => {
    const t = await tenant(); await t.fixed('TS01', '120000000', 60);
    await t.runOk(1);
    expect(err(await t.run(3))).toEqual([409, 'PERIOD_RUN_GAP']);
    expect((await t.runOk(2)).lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }]);
    expect((await t.runOk(3)).lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }]);
    expect(await t.count(`asset_schedule WHERE true`)).toBe(1);
    // Kỳ 1 không có số (nguyên giá ghi ngày 01/02): chạy thẳng kỳ 2 được; lần tính thử kỳ 1 trong điểm lưu không để lại phiên bản.
    const u = await tenant();
    const a = await u.ok(u.call('POST', '/api/assets', { code: 'TS05', name: 'TS05', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', depreciationStartDate: '2026-01-01', lifeUnits: 60 }), 201);
    await u.ok(u.call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
    await u.pkt('2026-02-01', [nợ('2111', '59000000', { assetCode: 'TS05' }), có('331', '59000000', { partyCode: 'NCC001' })]);
    expect((await u.runOk(2)).lines).toEqual([{ assetCode: 'TS05', amount: '1000000' }]); // 59.000.000 / 59 tháng còn lại
    expect((await sql<{ eff: string }>`SELECT string_agg(eff_year || '/' || eff_period, ',') AS eff FROM asset_schedule WHERE asset_id = ${a.id}`.execute(ctx.t.admin)).rows[0]!.eff).toBe('2026/2');
  });

  it('ghi lùi PKT Nợ 2111 TS01 12.000.000 ngày 15/02 sau khi chạy tháng 2: assetRunStale(2) = true; chạy lại tháng 2 đảo KH cũ, phiên bản mới eff 2/2026 B = 130.000.000, U = 59, KH = 2.203.390', async () => {
    const t = await tenant(); const a = await t.fixed('TS01', '120000000', 60);
    await t.runOk(1); const r2 = await t.runOk(2);
    expect(r2.lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }]);
    expect(await t.db((trx) => assetRunStale(trx, 'depreciation', 2026, 2))).toEqual({ stale: false, reason: null });
    await t.pkt('2026-02-15', [nợ('2111', '12000000', { assetCode: 'TS01' }), có('331', '12000000', { partyCode: 'NCC001' })]);
    expect((await t.db((trx) => assetRunStale(trx, 'depreciation', 2026, 2))).stale).toBe(true);
    expect((await t.db((trx) => assetRunStale(trx, 'depreciation', 2026, 1))).stale).toBe(false);
    const again = await t.runOk(2);
    expect(again).toMatchObject({ unchanged: false, reversedVoucherIds: [r2.voucherId], lines: [{ assetCode: 'TS01', amount: '2203390' }] });
    expect((await t.voucher(r2.voucherId)).state).toBe('reversed');
    const v = (await sql<{ version: number; eff_year: number; eff_period: number; basis_cost: string; basis_acc: string; units: string; reason: string }>`
      SELECT version, eff_year, eff_period, basis_cost, basis_acc, units, reason FROM asset_schedule WHERE asset_id = ${a.id} AND superseded_at IS NULL ORDER BY version`.execute(ctx.t.admin)).rows;
    expect(v.map((x) => [x.version, x.eff_year, x.eff_period, x.reason])).toEqual([[1, 2026, 1, 'initial'], [2, 2026, 2, 'ledger_change']]);
    expect([Number(v[1]!.basis_cost) - Number(v[1]!.basis_acc), Number(v[1]!.units)]).toEqual([130_000_000, 59]);
    expect(await t.db((trx) => assetRunStale(trx, 'depreciation', 2026, 2))).toEqual({ stale: false, reason: null });
    expect(await t.count(`period_run WHERE status = 'active'`)).toBe(2);
    expect(await t.count(`period_run WHERE status = 'superseded'`)).toBe(1);
    // Chạy lại mọi kỳ từ kỳ 1: không đổi gì; kỳ 3 tiếp theo phiên bản 2 (T(2) − T(1) = 4.406.780 − 2.203.390).
    expect(await t.db((trx) => refreshRuns(trx, { tenantId: t.tenantId, userId: t.userId, canBackdate: true }, 'depreciation', 2026, 1)))
      .toEqual([{ fiscalYear: 2026, periodNo: 1, unchanged: true }, { fiscalYear: 2026, periodNo: 2, unchanged: true }]);
    expect((await t.runOk(3)).lines).toEqual([{ assetCode: 'TS01', amount: '2203390' }]);
    expect(await t.count(`asset_schedule WHERE true`)).toBe(2);
  });

  it('phân bổ 60/40 theo hai bộ phận: tổng dòng Nợ = số khấu hao, dòng Có 2141 một dòng mỗi tài sản', async () => {
    const t = await tenant();
    for (const [code, name] of [['PB1', 'Bộ phận 1'], ['PB2', 'Bộ phận 2']]) await t.ok(t.call('POST', '/api/catalogs/department', { code, name }), 201);
    await t.fixed('TS01', '120000300', 60, [{ expenseAccountCode: '6422', departmentCode: 'PB1', ratio: '60' }, { expenseAccountCode: '6422', departmentCode: 'PB2', ratio: '40' }]);
    await t.fixed('TS02', '36000000', 36, [{ expenseAccountCode: '6421', ratio: '100' }]);
    const r = await t.runOk(1);
    expect(r.lines).toEqual([{ assetCode: 'TS01', amount: '2000005' }, { assetCode: 'TS02', amount: '1000000' }]);
    const v = await t.voucher(r.voucherId);
    expect(v.lines.map(lineKey)).toEqual(['6422|1200003|0||PB1', '6422|800002|0||PB2', '2141|0|2000005|TS01|', '6421|1000000|0||', '2141|0|1000000|TS02|']);
    // Lưu lại phân bổ cùng nội dung, khác thứ tự dòng: chạy lại vẫn không đổi (so khóa dòng không theo thứ tự).
    const ts01 = (await t.ok(t.call('GET', '/api/assets?kind=fixed')))[0];
    await t.ok(t.call('PUT', `/api/assets/${ts01.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', departmentCode: 'PB2', ratio: '40' }, { expenseAccountCode: '6422', departmentCode: 'PB1', ratio: '60' }] }));
    expect(await t.runOk(1)).toMatchObject({ unchanged: true, voucherId: r.voucherId });
  });

  it('kỳ khóa cứng → 409 PERIOD_HARD_LOCKED; khóa sổ không có quyền ghi lùi → 409 PERIOD_SOFT_LOCKED', async () => {
    const t = await tenant(); await t.fixed('TS01', '120000000', 60);
    const lock = (level: string, no: number) => t.ok(t.call('POST', `/api/periods/2026/${no}/lock`, { level }));
    await lock('soft', 1);
    const username = `kh_${Date.now()}`;
    await t.ok(t.call('POST', '/api/users', { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] }), 201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const vien = () => ctx.app.inject({ method: 'POST', url: '/api/asset-runs', headers: { cookie: `sid=${login.cookies.find((x) => x.name === 'sid')!.value}` }, payload: { kind: 'depreciation', fiscalYear: 2026, periodNo: 1 } });
    expect(err(await vien())).toEqual([403, 'FORBIDDEN']);
    await sql`INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT tenant_id, id, 'asset.run' FROM role WHERE tenant_id = ${t.tenantId}::uuid AND code = 'ketoan_vien'`.execute(ctx.t.admin);
    expect(err(await vien())).toEqual([409, 'PERIOD_SOFT_LOCKED']);
    await lock('hard', 0); await lock('hard', 1);
    expect(err(await t.run(1))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(await t.count(`period_run WHERE true`)).toBe(0);
  });

  it('tài sản hết khấu hao vẫn dùng: không có dòng KH; is_depreciable=false: không có dòng KH', async () => {
    const t = await tenant();
    await t.fixed('TS01', '120000000', 60);
    await t.fixed('TS03', '10000000', 1);
    await t.fixed('TS04', '50000000', 60, undefined, { isDepreciable: false });
    expect((await t.runOk(1)).lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }, { assetCode: 'TS03', amount: '10000000' }]);
    expect((await t.runOk(2)).lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }]);
    // Chỉ còn tài sản đã hết khấu hao: lần chạy vẫn ghi nhận, không có chứng từ.
    const u = await tenant(); await u.fixed('TS03', '10000000', 1);
    await u.runOk(1);
    expect(await u.runOk(2)).toMatchObject({ voucherId: null, lines: [], unchanged: false });
    expect(await u.runOk(2)).toMatchObject({ voucherId: null, unchanged: true });
    expect(await u.count(`asset_schedule WHERE true`)).toBe(1);
  });
  it('assetRunStale: bỏ ghi sổ rồi hủy chứng từ mua sau khi chạy → cũ; không đổi gì → không cũ; kỳ trước chạy lại sau → cũ', async () => {
    const t = await tenant(); const a = await t.fixed('TS01', '120000000', 60); await t.fixed('TS02', '36000000', 36);
    await t.runOk(1); await t.runOk(2);
    const stale = (p: number) => t.db((trx) => assetRunStale(trx, 'depreciation', 2026, p));
    expect(await stale(1)).toEqual({ stale: false, reason: null });
    expect(await stale(2)).toEqual({ stale: false, reason: null });
    await t.ok(t.call('POST', `/api/vouchers/${a.voucherId}/unpost`));
    await t.ok(t.call('POST', `/api/vouchers/${a.voucherId}/discard`));
    expect((await stale(1)).stale).toBe(true);
    expect((await stale(2)).stale).toBe(true);
    const r1 = await t.runOk(1);
    expect(r1.lines).toEqual([{ assetCode: 'TS02', amount: '1000000' }]);
    expect(await stale(1)).toEqual({ stale: false, reason: null });
    // Kỳ 2: sổ cái kỳ 2 đã khác (và kỳ 1 vừa được tạo lại sau lần chạy kỳ 2).
    expect((await stale(2)).stale).toBe(true);
    await t.runOk(2);
    expect(await stale(2)).toEqual({ stale: false, reason: null });
    // Chỉ đổi TK chi phí của kỳ 1 (hao mòn không đổi) thẳng trong DB (PUT phân bổ tự chạy lại kỳ 1, 2): kỳ 1 tạo lần chạy mới, kỳ 2 cũ vì lần chạy kỳ trước mới hơn.
    const ts02 = (await t.ok(t.call('GET', '/api/assets?kind=fixed'))).find((x: { code: string }) => x.code === 'TS02');
    await ctx.t.admin.updateTable('asset_allocation').set({ expense_account_code: '6421' }).where('asset_id', '=', ts02.id).execute();
    expect((await t.runOk(1)).unchanged).toBe(false);
    expect(await stale(2)).toEqual({ stale: true, reason: 'Kỳ 1/2026 được chạy lại sau lần chạy kỳ này' });
  });

  it('refreshRuns: kỳ sau khóa sổ mà lần chạy không đổi thì qua; phải ghi chứng từ mới ở kỳ khóa mà không có quyền ghi lùi → 409 nêu kỳ', async () => {
    const t = await tenant(); await t.fixed('TS01', '120000000', 60);
    await t.runOk(1); await t.runOk(2);
    await t.ok(t.call('POST', '/api/periods/2026/2/lock', { level: 'soft' }));
    const refresh = () => t.db((trx) => refreshRuns(trx, { tenantId: t.tenantId, userId: t.userId, canBackdate: false }, 'depreciation', 2026, 1));
    expect(await refresh()).toEqual([{ fiscalYear: 2026, periodNo: 1, unchanged: true }, { fiscalYear: 2026, periodNo: 2, unchanged: true }]);
    await t.pkt('2026-01-20', [nợ('2111', '12000000', { assetCode: 'TS01' }), có('331', '12000000', { partyCode: 'NCC001' })]);
    await expect(refresh()).rejects.toMatchObject({ code: 'PERIOD_SOFT_LOCKED', message: expect.stringContaining('Kỳ 2/2026') });
    expect(await t.count(`period_run WHERE status = 'active'`)).toBe(2);
    expect(await t.count(`voucher WHERE voucher_type = 'KH'`)).toBe(2); // giao dịch hủy toàn bộ, không đảo kỳ 1
  });
});
