import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { D, DEFAULT_PAYROLL_STRUCTURE } from '@kt/domain';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ7 gói 2 (phụ lục B, TB1): cột khấu trừ có làm tròn lẻ (round > 0) và tài khoản Có riêng không được làm chứng từ LU lệch Nợ/Có.
// Tham số là dữ liệu minh họa (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let structureId: number;
type M = 'GET' | 'POST' | 'PUT';
const ok = async (method: M, url: string, payload?: object) => {
  const r = await ctx.app.inject({ method, url, headers: { cookie: owner }, ...(payload ? { payload } : {}) });
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const R = '/api/payroll/runs';
const emp: Record<string, number> = {};
const day = (m: number, d: number) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Hai cột khấu trừ làm tròn 2 chữ số lẻ: "Tạm ứng" có TK Có 141 theo nhân viên, "Đóng góp" không có TK Có riêng (rơi vào 3388).
const columns = DEFAULT_PAYROLL_STRUCTURE.columns.map((c) => (c.code === 'advance' ? { ...c, round: 2, creditAccount: '141' } : c.code === 'charity' ? { ...c, round: 2 } : c));

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner } = await bootstrapTenant(ctx, { code: `PR${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const ql = Number((await ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: ql, kind: 'payroll', role: 'admin' }] });
  for (const c of ['NV01', 'NV03', 'NV05']) {
    const e = (fx.employees as Json[]).find((x) => x.code === c)!; const i = e.input; const ins = i.insurance;
    const id = Number((await ok('POST', '/api/catalogs/employee', { code: c, name: e.name, department_code: 'QL' })).id);
    await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: i.taxResidency, contractType: i.contractType, region: 'I', siSalary: i.siSalary ?? null,
      siParticipates: ins.si, hiParticipates: ins.hi, uiParticipates: ins.ui, occupationalParticipates: ins.occupational });
    await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2024-01-01', monthlySalary: i.segments[0].monthlySalary });
    emp[c] = id;
  }
  structureId = (await ok('POST', '/api/payroll/structures', { code: 'LAM_TRON', name: 'Làm tròn lẻ', proration: 'calendar', columns })).id;
});
afterAll(async () => { await ctx.close(); });

// Bảng lương tháng `month` cho các nhân viên với giá trị tạm ứng và đóng góp nhập tay; trả về chứng từ LU đã ghi sổ.
async function postedRun(month: number, people: { code: string; advance: string; charity?: string }[]) {
  const cells: Json[] = [];
  for (const p of people) for (let d = 1; d <= 22; d++) cells.push({ employeeId: emp[p.code], date: day(month, d), entries: [{ kind: 'work_day', qty: '1' }] });
  await ok('PUT', `/api/attendance?year=2026&month=${month}`, { cells });
  const run = await ok('POST', R, { year: 2026, month, structureId, employeeIds: people.map((p) => emp[p.code]) });
  for (const p of people) await ok('PUT', `${R}/${run.id}/lines/${emp[p.code]}/values`, { values: { advance: p.advance, ...(p.charity !== undefined && { charity: p.charity }) } });
  await ok('POST', `${R}/${run.id}/calculate`);
  const res = await ok('POST', `${R}/${run.id}/post`);
  const v = await ok('GET', `/api/vouchers/${res.voucherId}`);
  return v.lines as Json[];
}
const total = (ls: Json[], f: 'debit' | 'credit') => ls.reduce((s, l) => s.plus(l[f]), D(0));
const balanced = (ls: Json[]) => { expect(ls.every((l) => /^\d+$/.test(l.debit) && /^\d+$/.test(l.credit))).toBe(true); expect(total(ls, 'debit').toFixed(0)).toBe(total(ls, 'credit').toFixed(0)); };
const net = (ls: Json[], code: string) => ls.filter((l) => l.accountCode === code).reduce((s, l) => s.plus(l.credit).minus(l.debit), D(0)).toFixed(0);

describe('LU với cột khấu trừ làm tròn lẻ', () => {
  it('ví dụ báo cáo: một nhân viên tạm ứng 100,50 → Có 141 = 101, 3388 không lệch, chứng từ cân', async () => {
    const ls = await postedRun(1, [{ code: 'NV01', advance: '100.50' }]);
    balanced(ls);
    expect(net(ls, '141')).toBe('101'); // làm tròn nửa xa 0 từng giá trị trước khi cộng
    expect(net(ls, '3388')).toBe('0');
  });
  it('ví dụ báo cáo: hai nhân viên mỗi người 100,25 → Có 141 = 200, 3388 = 0 (không còn Nợ 3388 1 đồng)', async () => {
    const ls = await postedRun(2, [{ code: 'NV01', advance: '100.25' }, { code: 'NV03', advance: '100.25' }]);
    balanced(ls);
    expect(net(ls, '141')).toBe('200'); expect(net(ls, '3388')).toBe('0');
  });
  it('phần dư làm tròn của khấu trừ nhiều cột vào 3388: 0,4 + 0,4 = 1 đồng khấu trừ, tạm ứng làm tròn 0, 3388 nhận 1', async () => {
    const ls = await postedRun(3, [{ code: 'NV01', advance: '0.40', charity: '0.40' }]);
    balanced(ls);
    expect(net(ls, '141')).toBe('0'); expect(net(ls, '3388')).toBe('1');
  });
  it('thuộc tính: giá trị khấu trừ lẻ ngẫu nhiên của nhiều nhân viên, chứng từ luôn cân Nợ/Có và là số nguyên', async () => {
    // Mỗi bảng lương một tháng riêng nên lấy mẫu cố định (tối đa 8 tháng còn trống) thay vì để fast-check lặp lại không giới hạn khi thu nhỏ.
    const money = fc.integer({ min: 0, max: 99_999_999 }).map((n) => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`);
    const cases = fc.sample(fc.array(fc.record({ advance: money, charity: money }), { minLength: 1, maxLength: 3 }), { numRuns: Math.min(Number(process.env.FC_RUNS ?? 6), 8), seed: 20261028 });
    for (const [i, vals] of cases.entries()) balanced(await postedRun(4 + i, vals.map((v, k) => ({ code: ['NV01', 'NV03', 'NV05'][k]!, ...v }))));
  });
});
