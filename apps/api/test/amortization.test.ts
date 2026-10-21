import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { buildLines } from '../src/modules/invoices/amortization.js';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Sched = { id: number; started: boolean; postedAmount: string; isActive: boolean; lines: { seq: number; fiscalYear: number; periodNo: number; amount: string; voucherId: string | null; voucherState: string | null }[] };
const err = (r: { statusCode: number; json(): { error?: { code: string } } }) => [r.statusCode, r.json().error?.code];

async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `PB${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const body = (o: object = {}) => ({ fromAccountCode: '3387', toAccountCode: '5113', total: '12000001', periods: 12, startYear: 2026, startPeriod: 1, description: 'Thu trước 12 tháng', ...o });
  const create = async (o: object = {}) => { const r = await call('POST', '/api/amortizations', body(o)); expect(r.statusCode, r.body).toBe(201); return r.json() as Sched; };
  const run = (periodNo: number, fiscalYear = 2026) => call('POST', '/api/amortizations/run', { fiscalYear, periodNo });
  type RunOut = { created: { scheduleId: number; voucherId: string }[]; reversedVoucherIds: string[]; unchanged: number };
  const runOk = async (periodNo: number) => { const r = await run(periodNo); expect(r.statusCode, r.body).toBe(200); return r.json() as RunOut; };
  const voucher = async (id: string) => (await call('GET', `/api/vouchers/${id}`)).json();
  const sched = async (id: number) => (await call('GET', `/api/amortizations/${id}`)).json() as Sched;
  // Số phát sinh ròng (Nợ − Có) của tài khoản trong khoảng ngày, cộng thẳng từ dòng đã ghi sổ (cả chứng từ đã đảo và bản đảo).
  const net = async (code: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND a.code = ${code}`.execute(ctx.t.admin)).rows[0]!.n;
  return { cookie, tenantId, call, create, run, runOk, voucher, sched, net };
}

describe('lịch phân bổ', () => {
  it('chia 12.000.001 cho 12 kỳ: 11 kỳ 1.000.000, kỳ cuối 1.000.001; tổng đúng bằng total', async () => {
    const t = await tenant();
    const s = await t.create();
    expect(s.lines.map((l) => l.amount)).toEqual([...Array(11).fill('1000000'), '1000001']);
    expect(s.lines.reduce((a, l) => a + BigInt(l.amount), 0n)).toBe(12000001n);
    expect((await sql<{ n: string }>`SELECT count(*)::text AS n FROM amortization_schedule WHERE id = ${s.id} AND created_by IS NOT NULL`.execute(ctx.t.admin)).rows[0]!.n).toBe('1');
    expect([s.lines[0]!.periodNo, s.lines[11]!.periodNo, s.lines[11]!.fiscalYear]).toEqual([1, 12, 2026]);
    // bắt đầu giữa năm: kỳ chuyển sang năm sau
    expect(buildLines('10', 4, 2026, 11).map((l) => [l.fiscal_year, l.period_no, l.amount])).toEqual([[2026, 11, '2'], [2026, 12, '2'], [2027, 1, '2'], [2027, 2, '4']]);
  }, 60_000);

  it('đầu vào sai: tổng < số kỳ, hai tài khoản trùng, tài khoản không có, kỳ không có, tài khoản tổng hợp', async () => {
    const t = await tenant();
    const post = (o: object) => t.call('POST', '/api/amortizations', { fromAccountCode: '3387', toAccountCode: '5113', total: '1200', periods: 12, startYear: 2026, startPeriod: 1, ...o });
    expect(err(await post({ total: '11' }))).toEqual([400, 'VALIDATION']);
    expect(err(await post({ toAccountCode: '3387' }))).toEqual([400, 'VALIDATION']);
    expect(err(await post({ toAccountCode: '99999' }))).toEqual([404, 'ACCOUNT_NOT_FOUND']);
    expect(err(await post({ toAccountCode: '511' }))).toEqual([400, 'VALIDATION']);
    expect(err(await post({ startYear: 2030 }))).toEqual([404, 'PERIOD_NOT_FOUND']);
    expect((await post({ total: '1.5' })).statusCode).toBe(400);
    expect((await post({ periods: 121 })).statusCode).toBe(400);
  }, 60_000);

  it('chạy kỳ 3 sinh một PB: Nợ 3387 / Có 5113 ngày cuối kỳ; PB không bỏ ghi sổ, hủy, đảo qua route chung', async () => {
    const t = await tenant();
    const s = await t.create();
    const out = await t.runOk(3);
    expect(out).toMatchObject({ unchanged: 0, reversedVoucherIds: [] }); expect(out.created).toHaveLength(1);
    const v = await t.voucher(out.created[0]!.voucherId);
    expect([v.voucherType, v.state, v.postingDate, v.sourceDocType]).toEqual(['PB', 'posted', '2026-03-31', 'amortization']);
    expect(v.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['3387', '1000000', '0'], ['5113', '0', '1000000']]);
    expect(await t.net('3387')).toBe('1000000');
    const got = await t.sched(s.id);
    expect([got.started, got.postedAmount, got.lines[2]!.voucherId, got.lines[0]!.voucherId]).toEqual([true, '1000000', v.id, null]);
    for (const [p, body] of [['unpost', undefined], ['discard', undefined], ['reverse', { postingDate: '2026-04-01' }]] as const)
      expect(err(await t.call('POST', `/api/vouchers/${v.id}/${p}`, body))).toEqual([409, 'VOUCHER_SYSTEM_GENERATED']);
    expect((await t.call('DELETE', `/api/vouchers/${v.id}`)).statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('kỳ cuối nhận phần dư; chạy đủ 12 kỳ thì tổng phân bổ đúng bằng total; kỳ chưa tới hoặc lịch ngừng không sinh', async () => {
    const t = await tenant();
    const s = await t.create();
    for (let p = 1; p <= 12; p++) await t.runOk(p);
    expect(await t.net('3387')).toBe('12000001');
    expect(await t.net('5113')).toBe('-12000001');
    expect((await t.sched(s.id)).postedAmount).toBe('12000001');
    const off = await t.create({ total: '1200', periods: 12 });
    expect((await t.call('PUT', `/api/amortizations/${off.id}`, { ...{ fromAccountCode: '3387', toAccountCode: '5113', total: '1200', periods: 12, startYear: 2026, startPeriod: 1 }, isActive: false })).statusCode).toBe(200);
    expect(await t.runOk(1)).toMatchObject({ created: [], unchanged: 1 }); // chỉ lịch s (đã có PB, không đổi)
  }, 120_000);

  it('chạy lại không đổi: không chạm sổ; lệch (số tiền hoặc tài khoản) thì đảo PB cũ ngày cuối kỳ rồi sinh PB mới', async () => {
    const t = await tenant();
    const s = await t.create();
    const first = (await t.runOk(3)).created[0]!;
    expect(await t.runOk(3)).toMatchObject({ created: [], reversedVoucherIds: [], unchanged: 1 });
    // số liệu lịch bị sửa thẳng trong cơ sở dữ liệu: mô phỏng lệch so với chứng từ đã ghi
    await sql`UPDATE amortization_line SET amount = 900000 WHERE schedule_id = ${s.id} AND seq = 3`.execute(ctx.t.admin);
    const second = await t.runOk(3);
    expect(second.reversedVoucherIds).toEqual([first.voucherId]); expect(second.created).toHaveLength(1);
    const old = await t.voucher(first.voucherId);
    expect(old.state).toBe('reversed'); expect((await t.voucher(old.reversedById)).postingDate).toBe('2026-03-31');
    expect((await t.voucher(second.created[0]!.voucherId)).lines[0].debit).toBe('900000');
    expect(await t.net('3387')).toBe('900000'); // 1.000.000 − 1.000.000 + 900.000
    expect((await t.sched(s.id)).lines[2]).toMatchObject({ voucherId: second.created[0]!.voucherId, voucherState: 'posted' });
  }, 60_000);

  it('sửa, xóa: tự do khi chưa có chứng từ; đã phân bổ thì 409 AMORTIZATION_STARTED (vẫn đổi được diễn giải và ngừng lịch)', async () => {
    const t = await tenant();
    const s = await t.create();
    const put = (id: number, o: object) => t.call('PUT', `/api/amortizations/${id}`, { fromAccountCode: '3387', toAccountCode: '5113', total: '12000001', periods: 12, startYear: 2026, startPeriod: 1, ...o });
    const edited = await put(s.id, { total: '600', periods: 6, startPeriod: 2 });
    expect(edited.statusCode, edited.body).toBe(200); expect((edited.json() as Sched).lines.map((l) => l.amount)).toEqual(Array(6).fill('100')); expect((edited.json() as Sched).lines[0]!.periodNo).toBe(2);
    expect((await t.call('DELETE', `/api/amortizations/${s.id}`)).statusCode).toBe(204);
    expect(err(await t.call('GET', `/api/amortizations/${s.id}`))).toEqual([404, 'AMORTIZATION_NOT_FOUND']);

    const k = await t.create({ total: '1200', periods: 12 });
    await t.runOk(1);
    expect(err(await put(k.id, { total: '2400' }))).toEqual([409, 'AMORTIZATION_STARTED']);
    expect(err(await put(k.id, { total: '1200', periods: 12, toAccountCode: '5111' }))).toEqual([409, 'AMORTIZATION_STARTED']);
    expect(err(await t.call('DELETE', `/api/amortizations/${k.id}`))).toEqual([409, 'AMORTIZATION_STARTED']);
    const stop = await put(k.id, { total: '1200', periods: 12, description: 'Mới', isActive: false });
    expect(stop.statusCode, stop.body).toBe(200); expect(stop.json()).toMatchObject({ isActive: false, description: 'Mới' });
    expect(await t.runOk(2)).toMatchObject({ created: [], unchanged: 0 }); // ngừng: kỳ sau không sinh, PB đã ghi sổ giữ nguyên
    expect((await t.sched(k.id)).postedAmount).toBe('100');
  }, 60_000);

  it('kỳ khóa mềm cần quyền ghi lùi; kỳ khóa cứng 409; kỳ không có 404; danh sách và nhật ký kiểm toán', async () => {
    const t = await tenant();
    const s = await t.create();
    const lock = async (level: string, no: number) => { const r = await t.call('POST', `/api/periods/2026/${no}/lock`, { level }); expect(r.statusCode, r.body).toBe(200); };
    await lock('soft', 1);
    expect((await t.run(1)).statusCode).toBe(200); // chủ sở hữu có quyền ghi lùi: PB ghi vào kỳ khóa mềm
    expect((await t.sched(s.id)).lines[0]!.voucherState).toBe('posted');
    // ketoan_vien không có quyền chạy phân bổ; cấp quyền chạy nhưng không có quyền ghi lùi thì kỳ khóa mềm bị chặn
    const username = `pb_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const vien = (m: string) => ctx.app.inject({ method: 'POST', url: '/api/amortizations/run', headers: { cookie: `sid=${login.cookies.find((x) => x.name === 'sid')!.value}` }, payload: { fiscalYear: 2026, periodNo: Number(m) } });
    expect(err(await vien('1'))).toEqual([403, 'FORBIDDEN']);
    await sql`INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT tenant_id, id, 'amortization.run' FROM role WHERE tenant_id = ${t.tenantId}::uuid AND code = 'ketoan_vien'`.execute(ctx.t.admin);
    expect(err(await vien('1'))).toEqual([409, 'PERIOD_SOFT_LOCKED']);
    await lock('hard', 0); await lock('hard', 1);
    expect(err(await t.run(1))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(err(await t.run(1, 2027))).toEqual([404, 'PERIOD_NOT_FOUND']);
    expect((await t.run(16)).statusCode).toBe(400);
    const list = await t.call('GET', '/api/amortizations');
    expect((list.json() as Sched[]).map((x) => x.id)).toEqual([s.id]);
    const audit = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity IN ('amortization_schedule', 'amortization_line')`.execute(ctx.t.admin);
    expect(Number(audit.rows[0]!.n)).toBeGreaterThan(0);
  }, 60_000);
  it('năm tài chính 15 tháng: lịch 15 kỳ ánh xạ kỳ 1-15 của năm đó và chạy được kỳ 14', async () => {
    const t = await tenant();
    expect((await t.call('POST', '/api/fiscal-years', { fiscalYear: 2027, dateFrom: '2027-01-01', months: 15, regime: 'TT133' })).statusCode).toBe(201);
    const s = await t.create({ total: '1500', periods: 15, startYear: 2027, startPeriod: 1 });
    expect(s.lines.map((l) => [l.fiscalYear, l.periodNo])).toEqual(Array.from({ length: 15 }, (_, i) => [2027, i + 1]));
    const r = await t.run(14, 2027); expect(r.statusCode, r.body).toBe(200);
    const v = await t.voucher((r.json() as { created: { voucherId: string }[] }).created[0]!.voucherId);
    expect(v.postingDate).toBe('2028-02-29');
  }, 60_000);

  it('năm tạo sau với số kỳ khác 12: chạy kỳ 409 AMORTIZATION_PERIOD_LAYOUT; sửa lịch (chưa bắt đầu) thì xếp lại theo kỳ thật', async () => {
    const t = await tenant();
    const o = { total: '400', periods: 4, startPeriod: 11 };
    const s = await t.create(o);
    expect(s.lines.map((l) => [l.fiscalYear, l.periodNo])).toEqual([[2026, 11], [2026, 12], [2027, 1], [2027, 2]]); // 2027 chưa có: giả định 12 kỳ
    expect((await t.call('POST', '/api/fiscal-years', { fiscalYear: 2027, dateFrom: '2027-01-01', months: 1, regime: 'TT133' })).statusCode).toBe(201);
    expect(err(await t.run(1, 2027))).toEqual([409, 'AMORTIZATION_PERIOD_LAYOUT']);
    const fixed = await t.call('PUT', `/api/amortizations/${s.id}`, { fromAccountCode: '3387', toAccountCode: '5113', startYear: 2026, ...o });
    expect((fixed.json() as Sched).lines.map((l) => [l.fiscalYear, l.periodNo])).toEqual([[2026, 11], [2026, 12], [2027, 1], [2028, 1]]);
    expect((await t.run(1, 2027)).statusCode).toBe(200);
  }, 60_000);

  it('chạy lại có lệch ở kỳ khóa mềm: người có quyền ghi lùi đảo PB cũ (ngày cuối kỳ) và sinh PB mới', async () => {
    const t = await tenant();
    const s = await t.create();
    const first = (await t.runOk(1)).created[0]!;
    expect((await t.call('POST', '/api/periods/2026/1/lock', { level: 'soft' })).statusCode).toBe(200);
    await sql`UPDATE amortization_line SET amount = 900000 WHERE schedule_id = ${s.id} AND seq = 1`.execute(ctx.t.admin);
    const out = await t.runOk(1);
    expect(out.reversedVoucherIds).toEqual([first.voucherId]); expect(out.created).toHaveLength(1);
    const old = await t.voucher(first.voucherId);
    expect(old.state).toBe('reversed'); expect((await t.voucher(old.reversedById)).postingDate).toBe('2026-01-31');
    expect((await t.voucher(out.created[0]!.voucherId)).lines[0].debit).toBe('900000');
  }, 60_000);
});
