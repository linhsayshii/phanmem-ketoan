import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { D } from '@kt/domain';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 6a: hạch toán bảng lương (chứng từ LU) theo ba chế độ: năm 2024 = TT133, 2025 = TT200, 2026 = TT99 (cùng một công ty).
// Tham số là Dữ liệu minh họa (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let noFlag: string; let noPost: string; let tenantId: string; let userId: string;
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
const ids: Record<string, number> = {};
const day = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const REGIME: Record<number, { payable: string; si: string; hi: string; ui: string; pit: string; cost: Record<string, string> }> = {
  2024: { payable: '334', si: '3383', hi: '3384', ui: '3385', pit: '3335', cost: { SX: '154', BH: '6421', QL: '6422' } },
  2025: { payable: '3341', si: '3383', hi: '3384', ui: '3386', pit: '3335', cost: { SX: '622', BH: '6411', QL: '6421' } },
  2026: { payable: '334', si: '3383', hi: '3384', ui: '3386', pit: '3335', cost: { SX: '622', BH: '6411', QL: '6421' } },
};

function cells(employeeId: number, y: number, m: number, paid: { days: string; start: number }[], ot?: Json) {
  const out: Json[] = [];
  for (const p of paid) {
    const n = Number(p.days); let d = p.start;
    for (let i = 0; i < Math.floor(n); i++) out.push({ employeeId, date: day(y, m, d++), entries: [{ kind: 'work_day', qty: '1' }] });
    if (n % 1) out.push({ employeeId, date: day(y, m, d), entries: [{ kind: 'half_day', qty: '1' }] });
  }
  if (ot) {
    const kinds: [string, string][] = [['weekday', 'ot_weekday_hour'], ['rest', 'ot_rest_hour'], ['holiday', 'ot_holiday_hour']];
    kinds.forEach(([k, kind], i) => { if (ot[k] && ot[k] !== '0') out.push({ employeeId, date: day(y, m, 27 + i), entries: [{ kind, qty: ot[k] }] }); });
  }
  return out;
}
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `po_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
async function setupEmployee(e: Json, department: string, defaultProjectId: number | null = null) {
  const id = Number((await ok('POST', '/api/catalogs/employee', { code: e.code, name: e.name, department_code: department })).id);
  const i = e.input; const ins = i.insurance;
  await ok('PUT', `/api/payroll/profiles/${id}`, {
    taxResidency: i.taxResidency, contractType: i.contractType, region: 'I', siSalary: i.siSalary ?? null, startDate: e.code === 'NV10' ? '2026-10-14' : (e.startDate ?? null), endDate: e.endDate ?? null,
    siParticipates: ins.si, hiParticipates: ins.hi, uiParticipates: ins.ui, occupationalParticipates: ins.occupational, defaultProjectId,
  });
  const segs = i.segments as Json[];
  const from = segs.length > 1 ? ['2024-01-01', '2026-10-16'] : ['2024-01-01'];
  for (const [k, s] of segs.entries()) await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: from[k], monthlySalary: s.monthlySalary });
  for (const a of i.allowances ?? []) await ok('POST', `/api/payroll/profiles/${id}/allowances`, { code: a.code, name: a.code, amount: a.amount, taxable: a.taxable, siBase: a.siBase });
  for (const [k, d] of (i.dependents ?? []).entries()) await ok('POST', `/api/payroll/profiles/${id}/dependents`, { name: `Người phụ thuộc ${k + 1}`, relationship: 'child', fromMonth: d.from.slice(0, 7), toMonth: d.to ? d.to.slice(0, 7) : null });
  return id;
}
// Bảng lương chính tháng 10 của năm y cho 20 nhân viên, đã tính.
async function calculatedRun(y: number) {
  const all: Json[] = [];
  for (const e of fx.employees as Json[]) {
    const segs = e.input.segments as Json[];
    const starts = e.code === 'NV10' ? [14] : e.code === 'NV12' ? [1, 16] : [1];
    all.push(...cells(emp[e.code]!, y, 10, segs.map((s, k) => ({ days: s.paidDays, start: starts[k]! })), e.input.otHours));
  }
  await ok('PUT', `/api/attendance?year=${y}&month=10`, { cells: all });
  const run = await ok('POST', R, { year: y, month: 10, employeeIds: Object.values(emp) });
  for (const e of fx.employees as Json[]) if (e.input.manual) await ok('PUT', `${R}/${run.id}/lines/${emp[e.code]}/values`, { values: e.input.manual });
  return ok('POST', `${R}/${run.id}/calculate`);
}
const voucher = (id: string) => ok('GET', `/api/vouchers/${id}`);
const sumOf = (xs: Json[], f: (x: Json) => string) => xs.reduce((s, x) => s.plus(f(x)), D(0)).toFixed(0);
const ledger334 = async (y: number, payable: string, code: string) =>
  (await ok('GET', `/api/reports/ledgers/detail?accountCode=${payable}&from=${y}-10-01&to=${y}-10-31&employeeCode=${code}`)).closing;

const runs: Record<number, Json> = {};
beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId, userId } = await bootstrapTenant(ctx, { code: `PO${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2024, 'TT133'], [2025, 'TT200'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime });
  noFlag = await userWith('ketoan_truong', []); noPost = await userWith('ketoan_vien', ['view_salary']);
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  for (const c of ['SX', 'BH', 'QL', 'DV']) ids[c] = Number((await ok('POST', '/api/catalogs/department', { code: c, name: `Bộ phận ${c}` })).id);
  for (const c of ['P1', 'P2']) ids[c] = Number((await ok('POST', '/api/catalogs/project', { code: c, name: `Vụ việc ${c}` })).id);
  ids.NC = Number((await ok('POST', '/api/catalogs/cost_item', { code: 'NC', name: 'Nhân công' })).id);
  ids.OBJ = Number((await ok('POST', '/api/costing/objects', { code: 'OBJ1', name: 'Sản phẩm vụ việc P1', kind: 'project', projectCode: 'P1' })).id);
  for (const e of fx.employees as Json[]) emp[e.code] = await setupEmployee(e, e.department, e.code === 'NV04' ? ids.P2! : null);
  await ok('PUT', `/api/payroll/profiles/${emp.NV03}/cost-split`, { items: [{ projectId: ids.P1, pct: '60' }, { projectId: ids.P2, pct: '40' }] });
  // SX: sản xuất trực tiếp, mang khoản mục và đối tượng tập hợp chi phí (TT133: 154 cần đối tượng); BH: bán hàng; QL: quản lý doanh nghiệp.
  await ok('PUT', '/api/payroll/cost-accounts', { items: [
    { departmentId: ids.SX, kind: 'payroll', role: 'direct', costItemId: ids.NC, costObjectId: ids.OBJ }, { departmentId: ids.BH, kind: 'payroll', role: 'selling' }, { departmentId: ids.QL, kind: 'payroll', role: 'admin' }] });
  for (const y of [2024, 2025, 2026]) runs[y] = await calculatedRun(y);
});
afterAll(async () => { await ctx.close(); });

describe('chứng từ LU theo ba chế độ', () => {
  it.each([2024, 2025, 2026])('năm %i: cân bằng, chi phí = gross + BH DN, dư Có phải trả theo nhân viên = thực lĩnh, BH và TNCN đúng', async (y) => {
    const run = runs[y]!; const a = REGIME[y]!;
    // Tạm ứng cho NV11 đầu tháng (Nợ 141 theo nhân viên / Có tiền mặt); cuối tháng trừ lương (cột advance) → LU Có 141 theo nhân viên, 141 của NV11 về 0 (#971).
    await ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: `${y}-10-05`, documentDate: `${y}-10-05`, description: 'Tạm ứng NV11', autoPost: true,
      lines: [{ accountCode: '141', debit: '1000000', employeeCode: 'NV11' }, { accountCode: y === 2026 ? '111' : '1111', credit: '1000000' }] });
    const res = await ok('POST', `${R}/${run.id}/post`);
    expect(res).toMatchObject({ runId: run.id, status: 'posted', unchanged: false, reversedVoucherIds: [], voucherNo: expect.stringMatching(/^LU/) });
    const v = await voucher(res.voucherId);
    expect(v).toMatchObject({ voucherType: 'LU', state: 'posted', postingDate: `${y}-10-31`, sourceDocType: 'payroll_run', sourceDocId: (await sql<{ u: string }>`SELECT md5(${`${tenantId}:payroll_run:${run.id}`})::uuid::text AS u`.execute(ctx.t.admin)).rows[0]!.u });
    const lines = v.lines as Json[];
    const dr = sumOf(lines, (l) => l.debit), cr = sumOf(lines, (l) => l.credit);
    expect(dr).toBe(cr); expect(res.totalDebit).toBe(dr); expect(res.lineCount).toBe(lines.length);
    const L = run.lines as Json[]; const val = (c: string) => sumOf(L, (l) => l.values[c] ?? '0');
    const costCodes = Object.values(a.cost);
    const cost = lines.filter((l) => costCodes.includes(l.accountCode));
    expect(sumOf(cost, (l) => l.debit)).toBe(D(val('gross')).plus(val('si_er')).plus(val('union_er')).toFixed(0));
    const credit = (code: string) => sumOf(lines.filter((l) => l.accountCode === code), (l) => D(l.credit).minus(l.debit).toString());
    expect(credit(a.pit)).toBe(val('pit'));
    expect(credit(a.si)).toBe(D(val('si_er_si')).plus(val('si_er_occ')).plus(val('si_emp_si')).toFixed(0));
    expect(credit(a.hi)).toBe(D(val('si_er_hi')).plus(val('si_emp_hi')).toFixed(0));
    expect(credit(a.ui)).toBe(D(val('si_er_ui')).plus(val('si_emp_ui')).toFixed(0));
    // Tạm ứng trừ lương ghi Có 141 theo nhân viên; 3388 chỉ còn khấu trừ khác (đóng góp, đoàn phí), không chứa tạm ứng (#971).
    expect(val('advance')).toBe('1000000');
    expect(lines.filter((l) => l.accountCode === '141').map((l) => [l.employeeCode, l.debit, l.credit])).toEqual([['NV11', '0', '1000000']]);
    expect(credit('3388')).toBe(D(val('other_withholding')).minus(val('advance')).toFixed(0));
    const adv = (await ok('GET', `/api/reports/ledgers/detail?accountCode=141&from=${y}-10-01&to=${y}-10-31&employeeCode=NV11`)).closing;
    expect(D(adv.debit).minus(adv.credit).toFixed(0)).toBe('0');
    // D7b: chỉ dòng phải trả người lao động (và tạm ứng 141) mang nhân viên; dư Có theo nhân viên = thực lĩnh.
    expect(lines.filter((l) => l.employeeCode).every((l) => [a.payable, '141'].includes(l.accountCode))).toBe(true);
    for (const l of L) expect(`${l.employeeCode}:${credit2(lines, a.payable, l.employeeCode)}`).toBe(`${l.employeeCode}:${l.net}`);
    // Tài khoản chi phí theo vai trò bộ phận của chế độ; SX mang khoản mục, đối tượng; NV03 tách 60/40 hai vụ việc; NV04 vụ việc mặc định.
    for (const [dept, code] of Object.entries(a.cost)) expect(cost.filter((l) => l.departmentCode === dept).every((l) => l.accountCode === code), dept).toBe(true);
    expect(cost.filter((l) => l.departmentCode === 'SX').every((l) => l.costItemCode === 'NC' && l.costObjectCode === 'OBJ1')).toBe(true);
    const nv03 = (fx.employees as Json[]).find((e) => e.code === 'NV03')!; const nv04 = (fx.employees as Json[]).find((e) => e.code === 'NV04')!;
    expect(cost.some((l) => l.projectCode === 'P1')).toBe(true);
    const p1 = sumOf(cost.filter((l) => l.projectCode === 'P1' && l.departmentCode === nv03.department), (l) => l.debit);
    const g3 = L.find((l) => l.employeeCode === 'NV03')!; const e3 = D(g3.gross).plus(g3.siEr).plus(g3.values.union_er ?? 0);
    expect(D(p1).minus(e3.times('0.6')).abs().lte(2)).toBe(true);
    expect(cost.some((l) => l.projectCode === 'P2' && l.departmentCode === nv04.department)).toBe(true);
    // Sổ chi tiết phải trả người lao động theo nhân viên (employeeCode) khớp thực lĩnh.
    for (const code of ['NV01', 'NV05', 'NV07']) expect((await ledger334(y, a.payable, code)).credit).toBe(L.find((l) => l.employeeCode === code)!.net);
    const after = await ok('GET', `${R}/${run.id}`);
    expect(after).toMatchObject({ status: 'posted', voucherId: res.voucherId, voucherNo: res.voucherNo, stale: false });
    if (y === 2026) for (const c of ['gross', 'pit', 'si_er', 'net']) expect(`${c}=${val(c)}`).toBe(`${c}=${fx.totals[c]}`);
  });
});
const credit2 = (lines: Json[], code: string, emp: string) => lines.filter((l) => l.accountCode === code && l.employeeCode === emp).reduce((s, l) => s.plus(l.credit).minus(l.debit), D(0)).toFixed(0);

describe('chạy lại và hủy hạch toán (đảo)', () => {
  it('hạch toán lần hai → 409; chạy lại không đổi → unchanged, không sinh chứng từ; đổi lương → đảo cũ, sinh LU mới', async () => {
    const run = runs[2026]!;
    await fail('POST', `${R}/${run.id}/post`, 409, 'PAYROLL_RUN_POSTED');
    const before = (await ok('GET', `${R}/${run.id}`)).voucherId;
    const count = async () => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'LU'`.execute(ctx.t.admin)).rows[0]!.n);
    const n0 = await count();
    const same = await ok('POST', `${R}/${run.id}/repost`);
    expect(same).toMatchObject({ unchanged: true, voucherId: before, reversedVoucherIds: [] });
    expect(await count()).toBe(n0);
    // Thêm phụ cấp cho NV01 (bảng đã hạch toán hiện "Cần tính lại") → chạy lại đảo LU cũ và sinh LU mới.
    const al = await ok('POST', `/api/payroll/profiles/${emp.NV01}/allowances`, { code: 'an_trua', name: 'Ăn trưa', amount: '1000000', taxable: true, siBase: false, validFrom: '2026-10-01', validTo: '2026-10-31' });
    expect((await ok('GET', `${R}/${run.id}`)).stale).toBe(true);
    const re = await ok('POST', `${R}/${run.id}/repost`);
    expect(re).toMatchObject({ unchanged: false, reversedVoucherIds: [before], status: 'posted' });
    expect(re.voucherId).not.toBe(before);
    expect((await voucher(before)).state).toBe('reversed');
    const after = await ok('GET', `${R}/${run.id}`);
    expect(after).toMatchObject({ status: 'posted', voucherId: re.voucherId, stale: false });
    const nv01 = after.lines.find((l: Json) => l.employeeCode === 'NV01');
    expect(nv01.gross).toBe('11000000');
    expect((await ledger334(2026, '334', 'NV01')).credit).toBe(nv01.net);
    await ok('DELETE', `/api/payroll/profiles/${emp.NV01}/allowances/${al.id}`);
    const back = await ok('POST', `${R}/${run.id}/repost`);
    expect(back.unchanged).toBe(false);
    expect((await ledger334(2026, '334', 'NV01')).credit).toBe((fx.employees as Json[]).find((e) => e.code === 'NV01')!.expected.net);
  });

  it('hủy hạch toán kỳ mở: đảo LU, bảng về "đã tính", mở chấm công; hạch toán lại được', async () => {
    const run = runs[2026]!;
    const cur = (await ok('GET', `${R}/${run.id}`)).voucherId;
    await fail('PUT', '/api/attendance?year=2026&month=10', 409, 'ATTENDANCE_LOCKED', { cells: [{ employeeId: emp.NV01, date: '2026-10-30', entries: [{ kind: 'work_day', qty: '1' }] }] });
    const u = await ok('POST', `${R}/${run.id}/unpost`);
    expect(u).toMatchObject({ status: 'calculated', voucherId: null, reversedVoucherIds: [cur] });
    expect((await voucher(cur)).state).toBe('reversed');
    expect(await ok('GET', `${R}/${run.id}`)).toMatchObject({ status: 'calculated', voucherId: null });
    expect((await ledger334(2026, '334', 'NV01')).credit).toBe('0');
    await fail('POST', `${R}/${run.id}/unpost`, 409, 'PAYROLL_RUN_NOT_POSTED');
    await fail('POST', `${R}/${run.id}/repost`, 409, 'PAYROLL_RUN_NOT_POSTED');
    // Chấm công mở lại → bảng cần tính lại → không hạch toán được đến khi tính lại.
    await ok('PUT', '/api/attendance?year=2026&month=10', { cells: [{ employeeId: emp.NV01, date: '2026-10-30', entries: [{ kind: 'ot_weekday_hour', qty: '1' }] }] });
    await fail('POST', `${R}/${run.id}/post`, 409, 'PAYROLL_RUN_STALE');
    await ok('PUT', '/api/attendance?year=2026&month=10', { cells: [{ employeeId: emp.NV01, date: '2026-10-30', entries: [] }] });
    expect((await ok('POST', `${R}/${run.id}/post`)).status).toBe('posted');
  });

  it('đổi tỷ lệ phân bổ chi phí của nhân viên sau hạch toán: bảng "Cần chạy lại" (không "Cần tính lại" số), chạy lại sinh LU mới (#974)', async () => {
    const run = runs[2026]!;
    const split = (p1: string, p2: string) => ok('PUT', `/api/payroll/profiles/${emp.NV03}/cost-split`, { items: [{ projectId: ids.P1, pct: p1 }, { projectId: ids.P2, pct: p2 }] });
    expect((await ok('GET', `${R}/${run.id}`)).stale).toBe(false);
    await split('50', '50');
    const g = await ok('GET', `${R}/${run.id}`);
    expect(g.stale).toBe(true); expect(g.lines.some((l: Json) => l.stale)).toBe(false);
    const re = await ok('POST', `${R}/${run.id}/repost`);
    expect(re.unchanged).toBe(false);
    expect((await ok('GET', `${R}/${run.id}`)).stale).toBe(false);
    await split('60', '40');
    expect((await ok('GET', `${R}/${run.id}`)).stale).toBe(true);
    expect((await ok('POST', `${R}/${run.id}/repost`)).unchanged).toBe(false);
    expect((await ok('GET', `${R}/${run.id}`)).stale).toBe(false);
    expect((await ok('POST', `${R}/${run.id}/repost`)).unchanged).toBe(true);
  });

  it('kỳ khóa sổ: không có quyền ghi lùi → 409; có quyền → đảo trong kỳ khóa; khóa cứng → 409', async () => {
    const run = runs[2025]!;
    await ok('POST', '/api/periods/2025/10/lock', { level: 'soft' });
    // Người có payroll.post và view_salary nhưng không có quyền ghi lùi ngày.
    await sql`DELETE FROM role_permission rp USING role r WHERE r.id = rp.role_id AND r.tenant_id = ${tenantId}::uuid AND r.code = 'ketoan_truong' AND rp.permission_code = 'voucher.backdate_locked'`.execute(ctx.t.admin);
    const noBackdate = await userWith('ketoan_truong', ['view_salary']);
    await fail('POST', `${R}/${run.id}/unpost`, 409, 'PERIOD_SOFT_LOCKED', undefined, noBackdate);
    // Chạy lại không đổi ở kỳ khóa vẫn qua (không ghi gì).
    expect((await ok('POST', `${R}/${run.id}/repost`, undefined, noBackdate)).unchanged).toBe(true);
    // Người phụ thuộc mới của NV11 (thuế vẫn 0 nên LU không đổi) đổi giảm trừ của bảng lương kỳ khóa: không được ghi âm thầm (#973).
    const lineOf = async () => (await ok('GET', `${R}/${run.id}`)).lines.find((l: Json) => l.employeeCode === 'NV11');
    const v0 = (await lineOf()).values;
    const dep = await ok('POST', `/api/payroll/profiles/${emp.NV11}/dependents`, { name: 'Con', relationship: 'child', fromMonth: '2025-10', toMonth: '2025-10' });
    await fail('POST', `${R}/${run.id}/repost`, 409, 'PERIOD_SOFT_LOCKED', undefined, noBackdate);
    expect((await lineOf()).values).toEqual(v0);
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2025 AND period_no = 10`.execute(ctx.t.admin);
    await fail('POST', `${R}/${run.id}/repost`, 409, 'PERIOD_HARD_LOCKED');
    expect((await lineOf()).values).toEqual(v0);
    await sql`UPDATE fiscal_period SET status = 'soft_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2025 AND period_no = 10`.execute(ctx.t.admin);
    await ok('DELETE', `/api/payroll/profiles/${emp.NV11}/dependents/${dep.id}`);
    expect((await ok('POST', `${R}/${run.id}/repost`, undefined, noBackdate)).unchanged).toBe(true);
    const cur = (await ok('GET', `${R}/${run.id}`)).voucherId;
    const u = await ok('POST', `${R}/${run.id}/unpost`);
    expect(u.reversedVoucherIds).toEqual([cur]);
    expect((await ok('POST', `${R}/${run.id}/post`)).status).toBe('posted');
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2025 AND period_no = 10`.execute(ctx.t.admin);
    await fail('POST', `${R}/${run.id}/unpost`, 409, 'PERIOD_HARD_LOCKED');
    await sql`UPDATE fiscal_period SET status = 'soft_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2025 AND period_no = 10`.execute(ctx.t.admin);
  });
});

describe('liên kết bảng lương ↔ LU gỡ ở mọi đường đổi trạng thái (Review Focus 6)', () => {
  // Bảng lương nhỏ một nhân viên tháng 11/2026 đã hạch toán.
  async function postedSmall(month: number) {
    await ok('PUT', `/api/attendance?year=2026&month=${month}`, { cells: cells(emp.NV02!, 2026, month, [{ days: '20', start: 1 }]) });
    const run = await ok('POST', R, { year: 2026, month, employeeIds: [emp.NV02] });
    await ok('POST', `${R}/${run.id}/calculate`);
    const p = await ok('POST', `${R}/${run.id}/post`);
    return { runId: run.id as number, voucherId: p.voucherId as string };
  }
  // Câu lệnh SQL ngoài luồng dưới danh nghĩa người dùng (người lập chứng từ đảo), có thể bật cờ đổi trạng thái như unpost_voucher.
  const asUser = (q: ReturnType<typeof sql>, stateChange = false) => ctx.t.admin.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`.execute(trx);
    if (stateChange) await sql`SELECT set_config('app.state_change', 'on', true), set_config('app.unposting', 'on', true)`.execute(trx);
    await q.execute(trx);
  });
  const runRow = async (id: number) => (await sql<{ status: string; voucher_id: string | null }>`SELECT status, voucher_id FROM payroll_run WHERE id = ${id}`.execute(ctx.t.admin)).rows[0]!;

  it('route chứng từ chung: LU không bỏ ghi sổ, đảo, sửa, hủy, xóa (409); hàm SQL bỏ ghi sổ/hủy chặn source payroll_run', async () => {
    const { runId, voucherId } = await postedSmall(11);
    const v = await voucher(voucherId);
    for (const [m, u, p] of [['POST', 'unpost'], ['POST', 'reverse', { postingDate: '2026-11-30' }], ['POST', 'discard']] as [M, string, object?][]) {
      const r = await call(m, `/api/vouchers/${voucherId}/${u}`, owner, p);
      expect([u, r.statusCode, r.json().error.code]).toEqual([u, 409, 'VOUCHER_SYSTEM_GENERATED']);
    }
    const put = await call('PUT', `/api/vouchers/${voucherId}`, owner, { version: v.version, voucherType: 'LU', postingDate: '2026-11-30', documentDate: '2026-11-30', lines: [{ accountCode: '6421', debit: '1' }, { accountCode: '334', credit: '1' }] });
    expect(put.statusCode).toBe(409);
    expect((await call('DELETE', `/api/vouchers/${voucherId}`)).statusCode).toBe(409);
    await expect(sql`SELECT unpost_voucher(${voucherId}::uuid)`.execute(ctx.t.admin)).rejects.toThrow(/VOUCHER_SYSTEM_GENERATED/);
    await expect(sql`SELECT discard_voucher(${voucherId}::uuid)`.execute(ctx.t.admin)).rejects.toThrow(/VOUCHER_SYSTEM_GENERATED/);
    expect(await runRow(runId)).toEqual({ status: 'posted', voucher_id: voucherId });
    // Lập tay loại LU/GT qua route chung → 409.
    for (const t of ['LU', 'GT']) {
      const r = await call('POST', '/api/vouchers', owner, { voucherType: t, postingDate: '2026-11-30', documentDate: '2026-11-30', lines: [{ accountCode: '6421', debit: '1' }, { accountCode: '1111', credit: '1' }] });
      expect([t, r.statusCode, r.json().error.code]).toEqual([t, 409, 'VOUCHER_TYPE_SYSTEM']);
    }
    // Đường đảo ngoài luồng (hàm SQL): gỡ liên kết, bảng về "đã tính".
    await asUser(sql`SELECT reverse_voucher(${voucherId}::uuid, '2026-11-30'::date, NULL)`);
    expect(await runRow(runId)).toEqual({ status: 'calculated', voucher_id: null });
    await sql`UPDATE payroll_run SET status = 'cancelled' WHERE id = ${runId}`.execute(ctx.t.admin);
  });

  it('bỏ ghi sổ, hủy, xóa LU ngoài luồng (giả lập bỏ chặn nguồn) → gỡ liên kết', async () => {
    const { runId, voucherId } = await postedSmall(12);
    // Bỏ ghi sổ ngoài luồng (đổi trạng thái trực tiếp như thân unpost_voucher, vượt chặn nguồn): posted → draft.
    await asUser(sql`UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = ${voucherId}::uuid`, true);
    expect(await runRow(runId)).toEqual({ status: 'calculated', voucher_id: null });
    const lineStatus = async () => (await sql<{ s: string }>`SELECT run_status AS s FROM payroll_line WHERE run_id = ${runId}`.execute(ctx.t.admin)).rows[0]!.s;
    expect(await lineStatus()).toBe('calculated'); // chấm công mở lại
    // Hủy nháp ngoài luồng: gắn lại liên kết rồi hủy → gỡ.
    await sql`UPDATE payroll_run SET voucher_id = ${voucherId}::uuid, status = 'posted' WHERE id = ${runId}`.execute(ctx.t.admin);
    await asUser(sql`UPDATE voucher SET state = 'cancelled' WHERE id = ${voucherId}::uuid`, true);
    expect(await runRow(runId)).toEqual({ status: 'calculated', voucher_id: null });
    expect(await lineStatus()).toBe('calculated');
    // Xóa chứng từ nháp: khóa ngoại SET NULL → bảng về "đã tính".
    const d = await sql<{ id: string }>`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, state, description, currency_code, created_by)
      SELECT tenant_id, 'LU', '2026-12-31', '2026-12-31', 'draft', 'nháp', 'VND', created_by FROM voucher WHERE id = ${voucherId}::uuid RETURNING id`.execute(ctx.t.admin);
    await sql`UPDATE payroll_run SET voucher_id = ${d.rows[0]!.id}::uuid, status = 'posted' WHERE id = ${runId}`.execute(ctx.t.admin);
    await sql`DELETE FROM voucher WHERE id = ${d.rows[0]!.id}::uuid`.execute(ctx.t.admin);
    expect(await runRow(runId)).toEqual({ status: 'calculated', voucher_id: null });
    await sql`UPDATE payroll_run SET status = 'cancelled' WHERE id = ${runId}`.execute(ctx.t.admin);
  });
});

describe('cấu hình tài khoản và bảng thưởng', () => {
  it('bộ phận chưa cấu hình, không có tài khoản mặc định → 400 ACCOUNT_MISSING kèm bộ phận; tài khoản tổng hợp → 400; tài khoản mặc định công ty dùng được', async () => {
    const id = await setupEmployee({ code: 'DV01', name: 'Dịch vụ', input: { segments: [{ monthlySalary: '10000000', paidDays: '20' }], insurance: { si: false, hi: false, ui: false, occupational: false }, taxResidency: 'resident', contractType: 'long' } }, 'DV');
    await ok('PUT', '/api/attendance?year=2026&month=9', { cells: cells(id, 2026, 9, [{ days: '20', start: 1 }]) });
    const run = await ok('POST', R, { year: 2026, month: 9, employeeIds: [id] });
    await ok('POST', `${R}/${run.id}/calculate`);
    const e = await fail('POST', `${R}/${run.id}/post`, 400, 'ACCOUNT_MISSING');
    expect(e.details.departments).toEqual(['DV Bộ phận DV']);
    const cfg = await ok('GET', '/api/payroll/cost-accounts');
    const items = cfg.items.map((i: Json) => ({ departmentId: i.departmentId, kind: i.kind, role: i.role, accountCode: i.accountCode, costItemId: i.costItemId, costObjectId: i.costObjectId }));
    expect(cfg.roleAccounts.TT133).toEqual({ direct: '154', workshop: '154', selling: '6421', admin: '6422' });
    await ok('PUT', '/api/payroll/cost-accounts', { items: [...items, { departmentId: ids.DV, kind: 'payroll', accountCode: '642' }] });
    expect((await fail('POST', `${R}/${run.id}/post`, 400, 'ACCOUNT_MISSING')).details.accounts).toEqual(['642']);
    await fail('PUT', '/api/payroll/cost-accounts', 400, 'VALIDATION', { items: [{ departmentId: ids.DV, kind: 'payroll', role: 'admin', accountCode: '6421' }] });
    await ok('PUT', '/api/payroll/cost-accounts', { items });
    await ok('PUT', '/api/settings', { payroll_expense_account: '6428' });
    const p = await ok('POST', `${R}/${run.id}/post`);
    const v = await voucher(p.voucherId);
    expect(v.lines.filter((l: Json) => D(l.debit).gt(0)).map((l: Json) => [l.accountCode, l.departmentCode, l.debit])).toEqual([['6428', 'DV', '7692308']]);
    await ok('PUT', '/api/settings', { payroll_expense_account: null });
  });

  it('bảng thưởng hạch toán LU riêng (chỉ lương và thuế TNCN)', async () => {
    const id = emp.NV20!; const b = fx.bonusRun;
    await ok('PUT', '/api/attendance?year=2026&month=12', { cells: cells(id, 2026, 12, [{ days: '26', start: 1 }]) });
    const reg = await ok('POST', R, { year: 2026, month: 12, employeeIds: [id] });
    await ok('POST', `${R}/${reg.id}/calculate`);
    const bonus = await ok('POST', R, { year: 2026, month: 12, kind: 'bonus', employeeIds: [id] });
    await ok('PUT', `${R}/${bonus.id}/lines/${id}/values`, { values: b.input.manual });
    const calc = await ok('POST', `${R}/${bonus.id}/calculate`);
    const pr = await ok('POST', `${R}/${reg.id}/post`); const pb = await ok('POST', `${R}/${bonus.id}/post`);
    expect(pb.voucherId).not.toBe(pr.voucherId);
    const v = await voucher(pb.voucherId); const l = calc.lines[0];
    expect(v.lines.map((x: Json) => x.accountCode).sort()).toEqual(['334', '334', '3335', '6421'].sort());
    expect(credit2(v.lines, '334', 'NV20')).toBe(l.net);
  });
});

describe('quyền', () => {
  it('thiếu view_salary → 403 SALARY_FORBIDDEN; thiếu payroll.post → 403', async () => {
    const id = runs[2026]!.id;
    for (const p of ['post', 'repost', 'unpost']) {
      await fail('POST', `${R}/${id}/${p}`, 403, 'SALARY_FORBIDDEN', undefined, noFlag);
      await fail('POST', `${R}/${id}/${p}`, 403, 'FORBIDDEN', undefined, noPost);
    }
    await fail('GET', '/api/payroll/cost-accounts', 403, 'SALARY_FORBIDDEN', undefined, noFlag);
    await fail('PUT', '/api/payroll/cost-accounts', 403, 'SALARY_FORBIDDEN', { items: [] }, noFlag);
    // LU qua route chứng từ chung: thiếu view_salary thì dòng phải trả, BH bị che.
    const v = await ok('GET', `/api/vouchers/${(await ok('GET', `${R}/${id}`)).voucherId}`, undefined, noFlag);
    expect(v.salaryRedacted).toBe(true); expect(v.totalDebit).toBeNull();
    expect(v.lines.filter((l: Json) => ['334', '3383'].includes(l.accountCode)).every((l: Json) => l.debit === '0' && l.credit === '0' && l.employeeCode === null)).toBe(true);
  });
});
