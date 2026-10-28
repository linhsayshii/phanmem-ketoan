import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { D } from '@kt/domain';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 6b: chứng từ chi lương, nộp bảo hiểm, nộp thuế TNCN (nháp PC/BN) từ bảng lương đã hạch toán; năm 2024 = TT133, 2026 = TT99.
// Tham số là Dữ liệu minh họa (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let noFlag: string; let noPay: string; let tenantId: string;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.statusCode === 204 ? null : r.json();
};
const fail = async (method: M, url: string, status: number, code: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, r.body).toBe(status); expect(r.json().error.code).toBe(code); return r.json().error;
};
const R = '/api/payroll/runs';
const emp: Record<string, number> = {};
const bank: Record<number, number> = {};
const day = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const A: Record<number, { payable: string; si: string; hi: string; ui: string; pit: string; cash: string; bank: string }> = {
  2024: { payable: '334', si: '3383', hi: '3384', ui: '3385', pit: '3335', cash: '1111', bank: '1121' },
  2026: { payable: '334', si: '3383', hi: '3384', ui: '3386', pit: '3335', cash: '111', bank: '112' },
};
const CODES = ['NV01', 'NV03', 'NV05', 'NV09'];

async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `pp_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
async function setupEmployee(code: string, name: string, i: Json) {
  const id = Number((await ok('POST', '/api/catalogs/employee', { code, name, department_code: 'QL' })).id);
  const ins = i.insurance;
  await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: i.taxResidency, contractType: i.contractType, region: 'I', siSalary: i.siSalary ?? null,
    siParticipates: ins.si, hiParticipates: ins.hi, uiParticipates: ins.ui, occupationalParticipates: ins.occupational });
  await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2024-01-01', monthlySalary: i.segments[0].monthlySalary });
  for (const [k, d] of (i.dependents ?? []).entries()) await ok('POST', `/api/payroll/profiles/${id}/dependents`, { name: `Người phụ thuộc ${k + 1}`, relationship: 'child', fromMonth: '2024-01', toMonth: d.to ? d.to.slice(0, 7) : null });
  return id;
}
// Bảng lương tháng 10 năm y đã tính: bốn nhân viên đủ công, ZERO không công (thực lĩnh 0, không có dòng chi).
async function calculatedRun(y: number) {
  const cells: Json[] = [];
  for (const c of CODES) for (let d = 1; d <= 26; d++) cells.push({ employeeId: emp[c], date: day(y, 10, d), entries: [{ kind: 'work_day', qty: '1' }] });
  await ok('PUT', `/api/attendance?year=${y}&month=10`, { cells });
  const run = await ok('POST', R, { year: y, month: 10, employeeIds: [...CODES.map((c) => emp[c]), emp.ZERO] });
  return ok('POST', `${R}/${run.id}/calculate`);
}
const voucher = (id: string) => ok('GET', `/api/vouchers/${id}`);
const links = async (runId: number) => (await ok('GET', `${R}/${runId}/vouchers`)) as Json[];
const closing = async (y: number, code: string) => (await ok('GET', `/api/reports/ledgers/detail?accountCode=${A[y]!.payable}&from=${y}-10-01&to=${y}-11-30&employeeCode=${code}`)).closing;
const credit = (lines: Json[], code: string) => lines.filter((l) => l.accountCode === code).reduce((s, l) => s.plus(l.credit).minus(l.debit), D(0)).toFixed(0);

const runs: Record<number, Json> = {};
beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `PP${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2024, 'TT133'], [2025, 'TT200'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime });
  noFlag = await userWith('ketoan_truong', []);
  await sql`DELETE FROM role_permission rp USING role r WHERE r.id = rp.role_id AND r.tenant_id = ${tenantId}::uuid AND r.code = 'ketoan_vien' AND rp.permission_code = 'payroll.pay'`.execute(ctx.t.admin);
  noPay = await userWith('ketoan_vien', ['view_salary']);
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const ql = Number((await ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: ql, kind: 'payroll', role: 'admin' }] });
  for (const c of CODES) { const e = (fx.employees as Json[]).find((x) => x.code === c)!; emp[c] = await setupEmployee(c, e.name, e.input); }
  emp.ZERO = await setupEmployee('ZERO', 'Không công', { segments: [{ monthlySalary: '5000000' }], insurance: { si: false, hi: false, ui: false, occupational: false }, taxResidency: 'resident', contractType: 'long' });
  await ok('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' });
  for (const y of [2024, 2026]) {
    bank[y] = Number((await ok('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: `00${y}`, gl_account_code: A[y]!.bank, currency_code: 'VND' })).id);
    runs[y] = await calculatedRun(y);
  }
});
afterAll(async () => { await ctx.close(); });

describe('lập chứng từ chi từ bảng lương đã hạch toán', () => {
  it.each([2024, 2026])('năm %i: chi lương theo nhân viên = thực lĩnh, nộp BH theo loại, nộp TNCN; dư phải trả NLĐ về 0 sau ghi sổ', async (y) => {
    const run = runs[y]!; const a = A[y]!; const id = run.id as number;
    await fail('POST', `${R}/${id}/pay-voucher`, 409, 'PAYROLL_RUN_NOT_POSTED', { kind: 'bank', bankAccountId: bank[y], date: `${y}-11-05` });
    const lu = await voucher((await ok('POST', `${R}/${id}/post`)).voucherId);

    // Chi lương qua ngân hàng: BN nháp, Nợ phải trả NLĐ một dòng mỗi nhân viên (bỏ ZERO), Có tài khoản ngân hàng.
    const p = await ok('POST', `${R}/${id}/pay-voucher`, { kind: 'bank', bankAccountId: bank[y], date: `${y}-11-05` });
    expect(p).toMatchObject({ runId: id, kind: 'pay', voucherType: 'BN', state: 'draft' });
    const pv = await voucher(p.voucherId);
    expect(pv).toMatchObject({ voucherType: 'BN', state: 'draft', postingDate: `${y}-11-05`, bankAccountNo: `00${y}`, sourceDocType: 'payroll_payment' });
    const L = run.lines as Json[];
    const payLines = (pv.lines as Json[]).filter((l) => l.accountCode === a.payable);
    expect(payLines.map((l) => [l.employeeCode, l.debit])).toEqual(L.filter((l) => D(l.net).gt(0)).map((l) => [l.employeeCode, l.net]).sort());
    expect(payLines.some((l) => l.employeeCode === 'ZERO')).toBe(false);
    const total = L.reduce((s, l) => s.plus(l.net), D(0)).toFixed(0);
    expect((pv.lines as Json[]).filter((l) => D(l.credit).gt(0)).map((l) => [l.accountCode, l.credit])).toEqual([[a.bank, total]]);
    expect(p.amount).toBe(total);
    await fail('POST', `${R}/${id}/pay-voucher`, 409, 'PAYROLL_VOUCHER_EXISTS', { kind: 'cash', date: `${y}-11-05` });

    // Nộp BH: Nợ BHXH, BHYT, BHTN (TK theo chế độ) = Có của LU; Có ngân hàng.
    const ins = await ok('POST', `${R}/${id}/insurance-voucher`, { kind: 'bank', bankAccountId: bank[y], date: `${y}-11-10` });
    const iv = await voucher(ins.voucherId);
    expect(iv.purpose).toBe('nop_bao_hiem');
    for (const c of [a.si, a.hi, a.ui]) expect(`${c}:${(iv.lines as Json[]).find((l) => l.accountCode === c)?.debit}`).toBe(`${c}:${credit(lu.lines, c)}`);
    expect((iv.lines as Json[]).filter((l) => D(l.credit).gt(0)).map((l) => [l.accountCode, l.credit])).toEqual([[a.bank, D(credit(lu.lines, a.si)).plus(credit(lu.lines, a.hi)).plus(credit(lu.lines, a.ui)).toFixed(0)]]);

    // Nộp TNCN bằng tiền mặt: PC, Nợ 3335 = TNCN khấu trừ, Có tiền mặt chi tiết của chế độ.
    const pit = await ok('POST', `${R}/${id}/pit-voucher`, { kind: 'cash', date: `${y}-11-15` });
    const tv = await voucher(pit.voucherId);
    expect(tv.voucherType).toBe('PC');
    expect((tv.lines as Json[]).map((l) => [l.accountCode, l.debit, l.credit])).toEqual([[a.pit, L.reduce((s, l) => s.plus(l.values.pit ?? 0), D(0)).toFixed(0), '0'], [a.cash, '0', tv.lines[0].debit]]);

    expect((await links(id)).map((l) => [l.kind, l.voucherId, l.state, l.stale])).toEqual([['pay', p.voucherId, 'draft', false], ['insurance', ins.voucherId, 'draft', false], ['pit', pit.voucherId, 'draft', false]]);
    // Ghi sổ phiếu chi lương: dư phải trả NLĐ từng nhân viên về 0; liên kết giữ.
    await ok('POST', `/api/vouchers/${p.voucherId}/post`, {});
    for (const c of [...CODES, 'ZERO']) expect(`${c}:${JSON.stringify(await closing(y, c))}`).toBe(`${c}:${JSON.stringify({ debit: '0', credit: '0' })}`);
    expect((await links(id))[0]).toMatchObject({ kind: 'pay', state: 'posted', stale: false });
  });

  it('bảng lương đổi: bảng cần chạy lại → 409; chạy lại hạch toán làm chứng từ chi cũ "lỗi thời"; thiếu ngân hàng → 400', async () => {
    const id = runs[2024]!.id as number;
    // Hủy nháp nộp TNCN (route chung) → gỡ liên kết, lập lại được.
    const pit = (await links(id)).find((l) => l.kind === 'pit')!;
    await ok('POST', `/api/vouchers/${pit.voucherId}/discard`, {});
    expect((await links(id)).map((l) => l.kind)).toEqual(['pay', 'insurance']);
    await fail('POST', `${R}/${id}/pit-voucher`, 400, 'VALIDATION', { kind: 'bank', date: '2024-11-15' });
    await ok('POST', `/api/payroll/profiles/${emp.NV03}/allowances`, { code: 'an_trua', name: 'Ăn trưa', amount: '1000000', taxable: true, siBase: false, validFrom: '2024-10-01', validTo: '2024-10-31' });
    await fail('POST', `${R}/${id}/pit-voucher`, 409, 'PAYROLL_RUN_STALE', { kind: 'cash', date: '2024-11-15' });
    // Phiếu chi lương đã ghi sổ: chạy lại hạch toán làm LU đổi sẽ chi hai lần/lệch 334 nên bị chặn (409) kèm danh sách phiếu; bỏ ghi sổ phiếu đó thì chạy lại được.
    const blocked = await fail('POST', `${R}/${id}/repost`, 409, 'PAYROLL_PAYMENT_POSTED');
    expect(blocked.details.vouchers).toEqual([expect.objectContaining({ kind: 'pay', state: 'posted' })]);
    expect(blocked.message).toMatch(/chi lương .*đã ghi sổ/);
    const payV = (await links(id)).find((l) => l.kind === 'pay')!;
    await ok('POST', `/api/vouchers/${payV.voucherId}/unpost`, {});
    // Bỏ ghi sổ giữ liên kết (0111): phiếu nháp vẫn là phiếu chi lương của bảng, không lập được phiếu thứ hai.
    expect((await links(id)).map((l) => [l.kind, l.state])).toEqual([['pay', 'draft'], ['insurance', 'draft']]);
    const dup = await fail('POST', `${R}/${id}/pay-voucher`, 409, 'PAYROLL_VOUCHER_EXISTS', { kind: 'bank', bankAccountId: bank[2024], date: '2024-11-05' });
    expect(dup.details).toMatchObject({ voucherId: payV.voucherId, state: 'draft' });
    const re = await ok('POST', `${R}/${id}/repost`);
    expect(re.unchanged).toBe(false);
    expect(re.draftPayments.map((x: Json) => x.kind)).toEqual(['pay', 'insurance']); // nháp còn liên kết: cảnh báo
    expect((await links(id)).map((l) => [l.kind, l.stale])).toEqual([['pay', true], ['insurance', true]]);
    await fail('POST', `${R}/${id}/insurance-voucher`, 409, 'PAYROLL_VOUCHER_EXISTS', { kind: 'bank', bankAccountId: bank[2024], date: '2024-11-10' });
    await ok('POST', `${R}/${id}/pit-voucher`, { kind: 'cash', date: '2024-11-15' });
    expect((await links(id)).map((l) => [l.kind, l.stale])).toEqual([['pay', true], ['insurance', true], ['pit', false]]);
  });
});

describe('gỡ liên kết khi chứng từ bị xóa, hủy, đảo; giữ khi bỏ ghi sổ', () => {
  it('xóa nháp, đảo qua route chứng từ chung → liên kết gỡ, lập lại được; bỏ ghi sổ giữ liên kết, lập lại 409 (hủy: kiểm thử trên)', async () => {
    const id = runs[2026]!.id as number;
    const kinds = async () => (await links(id)).map((l) => l.kind);
    const body = { kind: 'bank', bankAccountId: bank[2026], date: '2026-11-10' };
    // Xóa nháp: khóa ngoại xóa liên kết.
    const ins = (await links(id)).find((l) => l.kind === 'insurance')!;
    await ok('DELETE', `/api/vouchers/${ins.voucherId}`);
    expect(await kinds()).toEqual(['pay', 'pit']);
    // Bỏ ghi sổ (posted → draft): GIỮ liên kết (0111); lập lại → 409 nêu phiếu nháp; hủy nháp đó (đã cấp số nên không xóa được) thì gỡ.
    const again = await ok('POST', `${R}/${id}/insurance-voucher`, body);
    await ok('POST', `/api/vouchers/${again.voucherId}/post`, {});
    await ok('POST', `/api/vouchers/${again.voucherId}/unpost`, {});
    expect(await kinds()).toEqual(['pay', 'pit', 'insurance']);
    expect((await voucher(again.voucherId)).state).toBe('draft');
    const dup = await fail('POST', `${R}/${id}/insurance-voucher`, 409, 'PAYROLL_VOUCHER_EXISTS', body);
    expect(dup.details).toMatchObject({ voucherId: again.voucherId, state: 'draft' });
    await ok('POST', `/api/vouchers/${again.voucherId}/discard`, {});
    expect(await kinds()).toEqual(['pay', 'pit']);
    // Đảo phiếu chi lương đã ghi sổ: gỡ; dư phải trả NLĐ trở lại bằng thực lĩnh.
    const pay = (await links(id)).find((l) => l.kind === 'pay')!;
    await ok('POST', `/api/vouchers/${pay.voucherId}/reverse`, { postingDate: '2026-11-06' });
    expect(await kinds()).toEqual(['pit']);
    expect((await closing(2026, 'NV01')).credit).toBe((runs[2026]!.lines as Json[]).find((l) => l.employeeCode === 'NV01')!.net);
    expect((await ok('POST', `${R}/${id}/pay-voucher`, { kind: 'cash', date: '2026-11-07' })).voucherType).toBe('PC');
    // Hủy hạch toán bảng lương: chứng từ chi còn lại thành "lỗi thời"; bảng chưa hạch toán không lập chứng từ chi.
    // Phiếu nộp TNCN đã ghi sổ thì không hủy hạch toán được (409); bỏ ghi sổ phiếu đó (về nháp, vẫn liên kết) thì hủy được, mọi nháp còn liên kết được báo lại.
    const pitV = (await links(id)).find((l) => l.kind === 'pit')!;
    await ok('POST', `/api/vouchers/${pitV.voucherId}/post`, {});
    const blocked = await fail('POST', `${R}/${id}/unpost`, 409, 'PAYROLL_PAYMENT_POSTED');
    expect(blocked.details.vouchers).toEqual([expect.objectContaining({ kind: 'pit', voucherId: pitV.voucherId })]);
    expect((await ok('GET', `${R}/${id}`)).status).toBe('posted');
    await ok('POST', `/api/vouchers/${pitV.voucherId}/unpost`, {});
    const un = await ok('POST', `${R}/${id}/unpost`);
    expect(un.draftPayments.map((x: Json) => x.kind).sort()).toEqual(['pay', 'pit']); // phiếu chi lương nháp và phiếu nộp TNCN vừa bỏ ghi sổ
    expect((await links(id)).every((l) => l.stale)).toBe(true);
    await fail('POST', `${R}/${id}/insurance-voucher`, 409, 'PAYROLL_RUN_NOT_POSTED', body);
  });
});

describe('quyền', () => {
  it('thiếu view_salary → 403 SALARY_FORBIDDEN; thiếu payroll.pay → 403 FORBIDDEN', async () => {
    const id = runs[2026]!.id as number;
    for (const p of ['pay-voucher', 'insurance-voucher', 'pit-voucher']) {
      await fail('POST', `${R}/${id}/${p}`, 403, 'SALARY_FORBIDDEN', { kind: 'cash', date: '2026-11-07' }, noFlag);
      await fail('POST', `${R}/${id}/${p}`, 403, 'FORBIDDEN', { kind: 'cash', date: '2026-11-07' }, noPay);
    }
    await fail('GET', `${R}/${id}/vouchers`, 403, 'SALARY_FORBIDDEN', undefined, noFlag);
    expect((await ok('GET', `${R}/${id}/vouchers`, undefined, noPay)).length).toBeGreaterThan(0);
  });
});
