import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

// GĐ6 Task 6c: bước "Tính lương và hạch toán" trong quy trình cuối kỳ (CLOSE_STEPS). Tham số là Dữ liệu minh họa (payroll-20.json).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Step = { key: string; status: string; failed: boolean; reason: string | null; masked: boolean; unavailable: boolean; vouchers: { id: string; voucherNo: string | null }[] };
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let noFlag: string; let noPost: string; let tenantId: string; let empId: number;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => { const r = await call(method, url, cookie, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json(); };
const run = (step: string, periodNo: number, cookie = owner, extra: object = {}) => call('POST', '/api/period-close/run', cookie, { fiscalYear: 2026, periodNo, step, ...extra });
const status = async (periodNo: number, cookie = owner) => (await ok('GET', `/api/period-close/2026/${periodNo}`, undefined, cookie)) as { steps: Step[]; nextStep: string | null };
const payroll = async (periodNo: number, cookie = owner) => (await status(periodNo, cookie)).steps.find((s) => s.key === 'payroll')!;
const luCount = async () => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'LU'`.execute(ctx.t.admin)).rows[0]!.n);
const pad = (n: number) => String(n).padStart(2, '0');
// Bảng lương một nhân viên tháng m năm 2026 (26 ngày công); calc = đã tính.
async function monthRun(m: number, calc: boolean) {
  const cells = Array.from({ length: 26 }, (_, i) => ({ employeeId: empId, date: `2026-${pad(m)}-${pad(i + 1)}`, entries: [{ kind: 'work_day', qty: '1' }] }));
  await ok('PUT', `/api/attendance?year=2026&month=${m}`, { cells });
  const r = await ok('POST', '/api/payroll/runs', { year: 2026, month: m, employeeIds: [empId] });
  if (calc) await ok('POST', `/api/payroll/runs/${r.id}/calculate`);
  return r.id as number;
}
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `pc_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await setupLedgerTenant(ctx, `PC${Date.now()}`, 'TT133'));
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays, payroll_expense_account: '6422' });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  empId = Number((await ok('POST', '/api/catalogs/employee', { code: 'NV01', name: 'Nguyễn Văn An' })).id);
  await ok('PUT', `/api/payroll/profiles/${empId}`, { taxResidency: 'resident', contractType: 'long', region: 'I', siSalary: null, startDate: null, endDate: null, siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, defaultProjectId: null });
  await ok('POST', `/api/payroll/profiles/${empId}/salary-history`, { validFrom: '2024-01-01', monthlySalary: '10000000' });
  noFlag = await userWith('ketoan_truong', []); noPost = await userWith('ketoan_vien', ['view_salary']);
});
afterAll(async () => { await ctx.close(); });

describe('bước payroll trong quy trình cuối kỳ', () => {
  it('thứ tự bước mới; kỳ mới nextStep = payroll; giá thành sản phẩm chưa hỗ trợ: hiện "bỏ qua", chạy 409, không chặn nextStep', async () => {
    const s = await status(5);
    expect(s.steps.map((x) => x.key)).toEqual(['payroll', 'tool', 'prepaid', 'depreciation', 'loan_interest', 'costing', 'product_cost', 'amortization', 'fx_outflow', 'fx_revaluation', 'vat_offset', 'closing']);
    expect(s.nextStep).toBe('payroll');
    expect(s.steps.find((x) => x.key === 'product_cost')).toMatchObject({ status: 'skipped_empty', unavailable: true });
    const r = await run('product_cost', 5); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('STEP_UNAVAILABLE');
    expect((await run('product_cost', 5, owner, { skip: true })).statusCode).toBe(409);
  });

  it('kỳ không có bảng lương: chạy → skipped_empty, không sinh LU, bước sau không phải chạy lại; bỏ qua tay được khi chưa chạy', async () => {
    const n0 = await luCount();
    const r = await run('payroll', 6); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toMatchObject({ skipped: true, posted: [], needCalculation: [] });
    expect(r.json().steps.find((x: Step) => x.key === 'payroll').status).toBe('skipped_empty');
    expect(await luCount()).toBe(n0);
    expect((await run('payroll', 7, owner, { skip: true })).statusCode).toBe(200);
    expect((await payroll(7)).status).toBe('skipped_empty');
  });

  it('bảng lương chưa tính: không tự tính, báo cần tính lương (chưa xong); tính xong chạy → sinh LU, done; chạy lại → unchanged; đổi hồ sơ → rerun, chạy lại đảo và sinh LU mới', async () => {
    const runId = await monthRun(2, false);
    const n0 = await luCount();
    const r1 = await run('payroll', 2); expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().result.needCalculation).toEqual([{ runId, name: expect.any(String) }]);
    expect(await luCount()).toBe(n0); expect((await ok('GET', `/api/payroll/runs/${runId}`)).status).toBe('draft');
    expect(await payroll(2)).toMatchObject({ status: 'pending', failed: true, reason: expect.stringContaining('chưa tính') });

    await ok('POST', `/api/payroll/runs/${runId}/calculate`);
    expect((await payroll(2)).status).toBe('pending');
    const r2 = await run('payroll', 2); expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().result).toMatchObject({ skipped: false, posted: [runId], needCalculation: [] });
    const done = r2.json().steps.find((x: Step) => x.key === 'payroll') as Step;
    expect(done).toMatchObject({ status: 'done', failed: false }); expect(done.vouchers).toHaveLength(1); expect(done.vouchers[0]!.voucherNo).toMatch(/^LU/);
    const posted = await ok('GET', `/api/payroll/runs/${runId}`); expect(posted).toMatchObject({ status: 'posted', voucherId: done.vouchers[0]!.id });
    expect(await luCount()).toBe(n0 + 1);

    const r3 = await run('payroll', 2); expect(r3.statusCode, r3.body).toBe(200);
    expect(r3.json().result).toMatchObject({ reposted: [runId], reversedVoucherIds: [], unchanged: true });
    expect(await luCount()).toBe(n0 + 1); expect(r3.json().steps.find((x: Step) => x.key === 'payroll').status).toBe('done');

    await ok('POST', `/api/payroll/profiles/${empId}/allowances`, { code: 'an_trua', name: 'Ăn trưa', amount: '1000000', taxable: true, siBase: false, validFrom: '2026-02-01', validTo: '2026-02-28' });
    expect(await payroll(2)).toMatchObject({ status: 'rerun', reason: expect.stringContaining('cần chạy lại') });
    const r4 = await run('payroll', 2); expect(r4.statusCode, r4.body).toBe(200);
    expect(r4.json().result.reversedVoucherIds).toEqual([posted.voucherId]); expect(r4.json().result.unchanged).toBe(false);
    expect(r4.json().steps.find((x: Step) => x.key === 'payroll').status).toBe('done');
    expect(await luCount()).toBe(n0 + 3); // LU cũ, bản đảo, LU mới
  });

  it('chạy bước payroll làm các bước đứng sau đã chạy thành "cần chạy lại" (chỉ khi bước lương có thay đổi thật)', async () => {
    const runId = await monthRun(8, true);
    expect((await run('tool', 8)).statusCode).toBe(200);
    expect((await run('payroll', 8)).statusCode).toBe(200);
    expect((await status(8)).steps.find((x) => x.key === 'tool')!.status).toBe('rerun');
    expect(runId).toBeGreaterThan(0);
  });

  it('thiếu payroll.post → 403 nêu quyền; thiếu view_salary: chạy được nhưng kết quả và trạng thái che chi tiết', async () => {
    const f = await run('payroll', 2, noPost); expect(f.statusCode).toBe(403); expect(f.json().error.message).toContain('payroll.post');
    const runId = await monthRun(9, false);
    const r = await run('payroll', 9, noFlag); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toEqual({ masked: true, skipped: false, unchanged: true }); // bảng chưa tính: không chi tiết mã bảng lương, tên
    const masked = await payroll(9, noFlag);
    expect(masked).toMatchObject({ status: 'pending', failed: true, masked: true, vouchers: [], reason: 'Lần chạy gần nhất chưa hoàn tất' });
    expect(JSON.stringify(masked)).not.toMatch(/bảng lương|1 /);
    expect((await payroll(9)).masked).toBe(false);
    await ok('POST', `/api/payroll/runs/${runId}/calculate`);
    const r2 = await run('payroll', 9, noFlag); expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().result).toEqual({ masked: true, skipped: false, unchanged: false });
    const m2 = await payroll(9, noFlag); expect(m2).toMatchObject({ status: 'done', masked: true, vouchers: [] });
    expect((await payroll(9)).vouchers).toHaveLength(1);
    // đổi hồ sơ: người thiếu view_salary chỉ thấy câu trung tính
    await ok('POST', `/api/payroll/profiles/${empId}/allowances`, { code: 'xang', name: 'Xăng', amount: '500000', taxable: true, siBase: false, validFrom: '2026-09-01', validTo: '2026-09-30' });
    expect(await payroll(9, noFlag)).toMatchObject({ status: 'rerun', reason: 'Bảng lương trong kỳ đã thay đổi sau lần chạy' });
  });

  it('kỳ khóa cứng: chạy bước hạch toán → 409 PERIOD_HARD_LOCKED, không ghi nhật ký', async () => {
    await monthRun(4, true);
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 4`.execute(ctx.t.admin);
    const r = await run('payroll', 4); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect((await payroll(4)).status).toBe('pending');
  });
});
