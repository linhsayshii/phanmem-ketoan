import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { payrollParam } from '../../src/modules/payroll/params.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let tenantId: string; let owner: string; let viewer: string; let vien: string;
const SRC = 'Dữ liệu minh họa — kiểm thử';
const put = (payload: object, c = owner) => ctx.app.inject({ method: 'PUT', url: '/api/payroll/params', headers: { cookie: c }, payload });
const get = (url: string, c = owner) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
const del = (url: string, c = owner) => ctx.app.inject({ method: 'DELETE', url, headers: { cookie: c } });
const BR = [{ upTo: '5000000', rate: 5 }, { upTo: '10000000', rate: 10 }, { upTo: null, rate: 20 }];
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `pp_${roleCode}_${sensitiveFlags.length}_${Date.now()}`;
  const made = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: owner }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags } });
  expect(made.statusCode, made.body).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `PP${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: owner }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  vien = await userWith('ketoan_vien', []); viewer = await userWith('xem', []);
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('quyền GĐ6 trong vai trò hệ thống của công ty mới', () => {
  it('ketoan_vien có payroll.create, không có payroll.post/param/export; xem chỉ có .view; kế toán trưởng có đủ', async () => {
    const r = await sql<{ role: string; p: string }>`SELECT r.code AS role, rp.permission_code AS p FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    const has = (role: string, p: string) => r.rows.some((x) => x.role === role && x.p === p);
    expect(has('ketoan_vien', 'payroll.create')).toBe(true);
    for (const p of ['payroll.post', 'payroll.param', 'payroll.export']) { expect(has('ketoan_vien', p), p).toBe(false); expect(has('ketoan_truong', p), p).toBe(true); expect(has('admin', p), p).toBe(true); }
    expect(has('ketoan_vien', 'payroll.pay')).toBe(true);
    expect(has('xem', 'payroll.view')).toBe(true); expect(has('xem', 'payroll.create')).toBe(false);
    expect(has('ketoan_vien', 'cost_run.run')).toBe(true); expect(has('xem', 'contract_track.view')).toBe(true);
  });
});

describe('tham số lương theo công ty', () => {
  it('thiếu quyền payroll.param thì 403; thiếu nguồn hoặc giá trị sai lược đồ thì 400', async () => {
    expect((await put({ code: 'pit_brackets', validFrom: '2026-01-01', value: BR, source: SRC }, vien)).statusCode).toBe(403);
    expect((await put({ code: 'pit_brackets', validFrom: '2026-01-01', value: BR, source: '  ' })).statusCode).toBe(400);
    expect((await put({ code: 'pit_brackets', validFrom: '2026-01-01', value: [{ upTo: '5000000', rate: 5 }], source: SRC })).statusCode).toBe(400); // bậc cuối phải không giới hạn
    expect((await put({ code: 'pit_brackets', validFrom: '2026-01-01', value: [{ upTo: '9', rate: 5 }, { upTo: '5', rate: 6 }, { upTo: null, rate: 7 }], source: SRC })).statusCode).toBe(400); // không tăng dần
    expect((await put({ code: 'pit_deduction', validFrom: '2026-01-01', value: { self: 1.5, dependent: '1' }, source: SRC })).statusCode).toBe(400); // tiền phải là chuỗi nguyên
    expect((await put({ code: 'khong_biet', validFrom: '2026-01-01', value: {}, source: SRC })).statusCode).toBe(400);
    expect((await put({ code: 'pit_deduction', validFrom: '2026-02-01', validTo: '2026-01-01', value: { self: '1', dependent: '1' }, source: SRC })).statusCode).toBe(400);
  });
  it('nhập đủ chín mã + ot_tax_exempt_extra; ghi nhật ký kiểm toán; xem cần payroll.view', async () => {
    const ok: [string, unknown][] = [
      ['pit_brackets', BR], ['pit_deduction', { self: '1000', dependent: '500' }],
      ['si_rates', { employee: { si: 8, hi: 1.5, ui: 1 }, employer: { si: 17, hi: 3, ui: 1, occupational: 0.5 } }],
      ['si_ceiling', { si_base_max: '30000000' }], ['si_floor', { si_base_min: '4000000' }],
      ['min_wage_region', { I: '4000', II: '3500', III: '3000', IV: '2500' }], ['ot_multipliers', { weekday: 1.5, weekly_rest: 2, holiday: 3 }],
      ['pit_non_resident_rate', { rate: 20 }], ['pit_flat_rate_no_contract', { rate: 10 }], ['ot_tax_exempt_extra', true],
    ];
    for (const [code, value] of ok) { const r = await put({ code, validFrom: '2026-01-01', value, source: SRC }); expect(r.statusCode, `${code}: ${r.body}`).toBe(200); }
    const l = await get('/api/payroll/params?code=pit_brackets');
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json()).toHaveLength(1);
    expect(l.json()[0]).toMatchObject({ code: 'pit_brackets', validFrom: '2026-01-01', validTo: null, source: SRC });
    expect((await get('/api/payroll/params', viewer)).statusCode).toBe(200);
    const a = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'payroll_param'`.execute(ctx.t.admin);
    expect(Number(a.rows[0]!.n)).toBeGreaterThanOrEqual(10);
  });
  it('PUT cùng mã + validFrom thì cập nhật; khoảng chồng nhau 409 PARAM_OVERLAP; khoảng liền kề được', async () => {
    const r1 = await put({ code: 'pit_deduction', validFrom: '2026-01-01', validTo: '2026-06-30', value: { self: '2000', dependent: '700' }, source: SRC });
    expect(r1.statusCode, r1.body).toBe(200);
    expect((await get('/api/payroll/params?code=pit_deduction')).json()).toHaveLength(1);
    const bad = await put({ code: 'pit_deduction', validFrom: '2026-06-30', value: { self: '1', dependent: '1' }, source: SRC });
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('PARAM_OVERLAP');
    expect((await put({ code: 'pit_deduction', validFrom: '2026-07-01', value: { self: '3000', dependent: '900' }, source: SRC })).statusCode).toBe(200);
    expect((await put({ code: 'pit_deduction', validFrom: '2025-01-01', validTo: '2025-12-31', value: { self: '1', dependent: '1' }, source: SRC })).statusCode).toBe(200);
    const bad2 = await put({ code: 'pit_deduction', validFrom: '2025-06-01', validTo: '2026-02-01', value: { self: '1', dependent: '1' }, source: SRC });
    expect(bad2.statusCode).toBe(409); expect(bad2.json().error.code).toBe('PARAM_OVERLAP');
  });
  it('payrollParam: tra theo ngày; legal_param thắng khi có (cảnh báo nếu lệch dòng công ty), payroll_param khi legal_param không có, thiếu cả hai thì 409 PAYROLL_PARAM_MISSING', async () => {
    const at = (code: string, d: string) => withTenant(ctx.t.db, { tenantId }, (trx) => payrollParam<{ self?: string; x?: string }>(trx, code, d));
    expect(await at('pit_deduction', '2026-03-15')).toEqual({ value: { self: '2000', dependent: '700' }, source: 'payroll_param' });
    expect((await at('pit_deduction', '2026-07-01')).value).toEqual({ self: '3000', dependent: '900' });
    // legal_param đã kiểm thắng; công ty chưa có dòng cùng mã thì không cảnh báo
    await sql`INSERT INTO legal_param(code, value, valid_from, source) VALUES ('payroll_probe', '{"x":"legal"}', '2026-01-01', 'probe')`.execute(ctx.t.admin);
    expect(await at('payroll_probe', '2026-05-05')).toEqual({ value: { x: 'legal' }, source: 'legal_param' });
    // cả hai có, cùng giá trị: không cảnh báo; khác giá trị: dùng legal_param kèm warning
    await sql`INSERT INTO payroll_param(tenant_id, code, valid_from, value, source) VALUES (${tenantId}::uuid, 'payroll_probe', '2026-01-01', '{"x":"legal"}', ${SRC})`.execute(ctx.t.admin);
    expect(await at('payroll_probe', '2026-05-05')).toEqual({ value: { x: 'legal' }, source: 'legal_param' });
    await sql`UPDATE payroll_param SET value = '{"x":"company"}' WHERE tenant_id = ${tenantId}::uuid AND code = 'payroll_probe'`.execute(ctx.t.admin);
    const both = await at('payroll_probe', '2026-05-05');
    expect(both.value).toEqual({ x: 'legal' }); expect(both.source).toBe('legal_param'); expect(both.warning).toContain('payroll_probe'); expect(both.warning).toContain('05/05/2026');
    // ngoài khoảng hiệu lực của legal_param: dùng dòng công ty
    await sql`UPDATE legal_param SET valid_to = '2026-03-31' WHERE code = 'payroll_probe'`.execute(ctx.t.admin);
    expect(await at('payroll_probe', '2026-05-05')).toEqual({ value: { x: 'company' }, source: 'payroll_param' });
    expect((await put({ code: 'ot_multipliers', validFrom: '2024-01-01', validTo: '2024-12-31', value: { weekday: 1.5, weekly_rest: 2, holiday: 3 }, source: SRC })).statusCode).toBe(200);
    const err = await at('ot_multipliers', '2023-12-31').catch((e) => e);
    expect(err).toMatchObject({ code: 'PAYROLL_PARAM_MISSING', status: 409 });
    expect(err.message).toContain('ot_multipliers'); expect(err.message).toContain('31/12/2023');
    // ot_tax_exempt_extra thiếu cũng 409 như mọi mã, không có mặc định
    const ot = await at('ot_tax_exempt_extra', '2025-12-31').catch((e) => e);
    expect(ot).toMatchObject({ code: 'PAYROLL_PARAM_MISSING', status: 409 }); expect(ot.message).toContain('ot_tax_exempt_extra');
    await sql`DELETE FROM legal_param WHERE code = 'payroll_probe'`.execute(ctx.t.admin);
    await sql`DELETE FROM payroll_param WHERE code = 'payroll_probe'`.execute(ctx.t.admin);
  });
  it('GET /api/payroll/params/effective: giá trị đang áp dụng, kèm warning khi lệch; thiếu 409', async () => {
    const r = await get('/api/payroll/params/effective?code=pit_deduction&date=2026-03-15', viewer);
    expect(r.statusCode, r.body).toBe(200); expect(r.json()).toEqual({ value: { self: '2000', dependent: '700' }, source: 'payroll_param' });
    const miss = await get('/api/payroll/params/effective?code=ot_tax_exempt_extra&date=2025-12-31');
    expect(miss.statusCode).toBe(409); expect(miss.json().error.code).toBe('PAYROLL_PARAM_MISSING');
  });
  it('mã mới: pit_brackets_annual (cùng lược đồ bậc), pit_income_timing (period|payment_date), si_rates có KPCĐ và đoàn phí của đơn vị', async () => {
    const SI = { employee: { si: 8, hi: 1.5, ui: 1 }, employer: { si: 17, hi: 3, ui: 1, occupational: 0.5, union: 2, union_fee: 1 } };
    expect((await put({ code: 'si_rates', validFrom: '2026-01-01', value: SI, source: SRC })).statusCode).toBe(200);
    expect((await put({ code: 'si_rates', validFrom: '2026-01-01', value: { ...SI, employer: { ...SI.employer, union: 101 } }, source: SRC })).statusCode).toBe(400);
    expect((await put({ code: 'si_rates', validFrom: '2026-01-01', value: { ...SI, employer: { ...SI.employer, union_fee: 'x' } }, source: SRC })).statusCode).toBe(400);
    expect((await put({ code: 'pit_brackets_annual', validFrom: '2026-01-01', value: BR, source: SRC })).statusCode).toBe(200);
    expect((await put({ code: 'pit_brackets_annual', validFrom: '2026-01-02', value: [{ upTo: '5', rate: 5 }], source: SRC })).statusCode).toBe(400);
    expect((await put({ code: 'pit_income_timing', validFrom: '2026-01-01', value: 'payment_date', source: SRC })).statusCode).toBe(200);
    expect((await put({ code: 'pit_income_timing', validFrom: '2026-01-01', value: 'whenever', source: SRC })).statusCode).toBe(400);
  });
  it('xóa tham số: DELETE theo id, 404 khi không có', async () => {
    const id = (await get('/api/payroll/params?code=pit_non_resident_rate')).json()[0].id;
    expect((await del(`/api/payroll/params/${id}`, vien)).statusCode).toBe(403);
    expect((await del(`/api/payroll/params/${id}`)).statusCode).toBe(204);
    expect((await del(`/api/payroll/params/${id}`)).statusCode).toBe(404);
  });
});

describe('cờ view_salary trên tài khoản lương', () => {
  it('thiếu view_salary: sổ chi tiết/số dư của 334 và 3383 trả 403 "Không có quyền xem lương"; đủ cờ thì xem được', async () => {
    const full = await userWith('ketoan_vien', ['view_salary']);
    for (const code of ['334', '3383']) {
      const r = await get(`/api/balances?asOf=2026-01-31&accountCode=${code}`, vien);
      expect(r.statusCode, `${code}: ${r.body}`).toBe(403);
      expect(r.json().error?.message ?? r.body).toContain('Không có quyền xem lương');
      expect((await get(`/api/balances?asOf=2026-01-31&accountCode=${code}`, full)).statusCode).toBe(200);
    }
    expect((await get('/api/balances?asOf=2026-01-31&accountCode=1111', vien)).statusCode).toBe(200);
  });
});
