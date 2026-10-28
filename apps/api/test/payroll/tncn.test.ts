import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 9: bảng kê khấu trừ TNCN, quyết toán năm, tờ khai 05/KK-TNCN, 05/QTT-TNCN. 2026 = TT99.
// NV20: 12 tháng lương thay đổi + thưởng tháng 12, quyết toán khớp tính tay docs/dev/bang-luong-mau-20.md mục 6 (fixture annualSettlement).
// NV03: không ủy quyền quyết toán (làm hai nơi) → bị loại khỏi quyết toán thay. Tham số là Dữ liệu minh họa, không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let noFlag: string; let tenantId: string;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object) => {
  const r = await call(method, url, owner, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.statusCode === 204 ? null : r.json();
};
const fail = async (method: M, url: string, status: number, code: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, r.body).toBe(status); expect(r.json().error.code).toBe(code); return r.json().error;
};
const T = '/api/tncn';
const emp: Record<string, number> = {};
const pad = (n: number) => String(n).padStart(2, '0');

async function employee(code: string, name: string, pitAuthorized: boolean, salaries: [string, string][], deps: string[]) {
  const id = Number((await ok('POST', '/api/catalogs/employee', { code, name, department_code: 'QL', tax_code: `80000000${code.slice(2)}` })).id);
  await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: 'resident', contractType: 'long', region: 'I', startDate: '2024-01-01', pitAuthorized,
    siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true });
  for (const [validFrom, monthlySalary] of salaries) await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom, monthlySalary });
  for (const [k, fromMonth] of deps.entries()) await ok('POST', `/api/payroll/profiles/${id}/dependents`, { name: `Người phụ thuộc ${k + 1}`, relationship: 'child', fromMonth, toMonth: null });
  return id;
}
async function postedRun(m: number, ids: number[], kind = 'regular', manual?: Record<string, string>) {
  if (kind === 'regular') {
    const cells = ids.flatMap((employeeId) => Array.from({ length: 26 }, (_, d) => ({ employeeId, date: `2026-${pad(m)}-${pad(d + 1)}`, entries: [{ kind: 'work_day', qty: '1' }] })));
    await ok('PUT', `/api/attendance?year=2026&month=${m}`, { cells });
  }
  const run = await ok('POST', '/api/payroll/runs', { year: 2026, month: m, kind, employeeIds: ids });
  if (manual) await ok('PUT', `/api/payroll/runs/${run.id}/lines/${ids[0]}/values`, { values: manual });
  await ok('POST', `/api/payroll/runs/${run.id}/calculate`);
  await ok('POST', `/api/payroll/runs/${run.id}/post`);
  return run.id as number;
}
const postedPit = async (months: number[]) => (await sql<{ s: string }>`SELECT coalesce(sum(pit), 0)::text AS s FROM payroll_line WHERE tenant_id = ${tenantId}::uuid AND year = 2026
  AND month IN (${sql.join(months)}) AND run_status = 'posted'`.execute(ctx.t.admin)).rows[0]!.s;

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `TN${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  const username = `tn_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] });
  noFlag = `sid=${(await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } })).cookies.find((x) => x.name === 'sid')!.value}`;
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const dept = Number((await ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dept, kind: 'payroll', role: 'admin' }] });
  // Lương NV20: 30tr tháng 1–6, 40tr tháng 7–9, 45tr tháng 10–12; người phụ thuộc 1 từ 01/2026, người thứ 2 từ 08/2026 (bang-luong-mau-20.md mục 6).
  emp.NV20 = await employee('NV20', 'Quách Văn Vinh', true, [['2024-01-01', '30000000'], ['2026-07-01', '40000000'], ['2026-10-01', '45000000']], ['2026-01', '2026-08']);
  emp.NV03 = await employee('NV03', 'Lê Văn Cường', false, [['2024-01-01', '40000000']], []);
  for (let m = 1; m <= 12; m++) await postedRun(m, [emp.NV20, emp.NV03]);
  await postedRun(12, [emp.NV20], 'bonus', { bonus: '30000000' });
  // Bảng truy lĩnh tháng 11 chỉ tính, chưa hạch toán: không vào bảng kê.
  const retro = await ok('POST', '/api/payroll/runs', { year: 2026, month: 11, kind: 'retro', employeeIds: [emp.NV03] });
  await ok('POST', `/api/payroll/runs/${retro.id}/calculate`);
  // Khấu trừ ngoài lương: hóa đơn mua dịch vụ của cá nhân 10tr, TNCN_KT 10% (thuế suất minh họa).
  await ok('POST', '/api/catalogs/party', { code: 'CN01', name: 'Trần Văn Cá Nhân', tax_code: '8123456789', is_vendor: true });
  await sql`UPDATE tax_code SET rate = 10 WHERE tenant_id = ${tenantId}::uuid AND code = 'TNCN_KT'`.execute(ctx.t.admin);
  await ok('POST', '/api/invoices', { voucherType: 'HDM', postingDate: '2026-11-10', documentDate: '2026-11-10', partyCode: 'CN01', autoPost: true,
    items: [{ description: 'Dịch thuật', accountCode: '6422', amountCurrency: '10000000', taxCodes: ['TNCN_KT'] }],
    invoice: { serial: 'BK', invoiceNo: '0000001', invoiceDate: '2026-11-10', invoiceGroupCode: '01' } });
});
afterAll(async () => { await ctx.close(); });

describe('bảng kê khấu trừ TNCN', () => {
  it('quý 4: từng cá nhân từ bảng lương đã hạch toán (cả bảng thưởng), Σ thuế = Σ pit bảng lương posted, khấu trừ ngoài lương riêng', async () => {
    const w = await ok('GET', `${T}/withholding?year=2026&quarter=4`);
    expect(w.rows.map((r: Json) => r.code)).toEqual(['NV03', 'NV20']);
    const v = w.rows.find((r: Json) => r.code === 'NV20');
    // 10, 11: 45tr; 12: 45tr + thưởng 30tr. Giảm trừ mỗi tháng tính một lần dù tháng 12 có hai bảng.
    expect(v).toMatchObject({ months: 3, taxableIncome: '165000000', exemptIncome: '0', deductionSelf: '46500000', deductionDependents: '37200000', deductionSi: '14175000', deductionOther: '0',
      pitBase: '67125000', pit: '6450000', residency: 'resident', contractType: 'long', taxCode: '8000000020' });
    expect(w.totals.pit).toBe(await postedPit([10, 11, 12]));
    expect(w.others).toEqual([{ partyCode: 'CN01', partyName: 'Trần Văn Cá Nhân', taxCode: '8123456789', pit: '1000000' }]);
    expect(w.totals.othersPit).toBe('1000000');
    expect(BigInt(w.totals.totalPit)).toBe(BigInt(w.totals.pit) + 1000000n);
    expect(w.warnings.join(' ')).toContain('1 bảng lương trong kỳ chưa hạch toán');
    expect(w.intro[0]).toMatch(/^Dữ liệu minh họa/);
    // Theo tháng: tháng 12 có bảng thưởng.
    const d = await ok('GET', `${T}/withholding?year=2026&month=12`);
    expect(d.rows.find((r: Json) => r.code === 'NV20')).toMatchObject({ taxableIncome: '75000000', pitBase: '42375000', pit: '4975000' });
    expect(d.totals.pit).toBe(await postedPit([12]));
    await fail('GET', `${T}/withholding?year=2026&month=12&quarter=4`, 400, 'VALIDATION');
  });

  it('xuất Excel và chứng từ khấu trừ HTML không có mẫu số, ký hiệu', async () => {
    const x = await call('GET', `${T}/withholding?year=2026&quarter=4&format=xlsx`);
    expect(x.statusCode, x.body).toBe(200); expect(x.headers['content-type']).toContain('spreadsheetml');
    const c = await ok('GET', `${T}/certificates?year=2026&employeeId=${emp.NV20}`);
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ code: 'NV20', taxableIncome: '465000000', pit: fx.annualSettlement.expected.pitWithheld });
    expect(c.items[0].months).toHaveLength(12);
    const html = (await call('GET', `${T}/certificates?year=2026&format=html`)).body;
    expect(html).toContain('CHỨNG TỪ KHẤU TRỪ THUẾ THU NHẬP CÁ NHÂN'); expect(html).toContain('Quách Văn Vinh'); expect(html).not.toContain('Mẫu số');
  });
});

describe('quyết toán thuế TNCN năm', () => {
  it('NV20 12 tháng thu nhập thay đổi: chênh lệch đúng tính tay; NV03 không ủy quyền bị loại', async () => {
    const s = await ok('GET', `${T}/settlement?year=2026`);
    const v = s.rows.find((r: Json) => r.code === 'NV20');
    expect(v).toMatchObject({ eligible: true, excludeReason: null, months: 12, ...fx.annualSettlement.expected });
    expect(v.difference).toBe('-2902500');
    const n = s.rows.find((r: Json) => r.code === 'NV03');
    expect(n).toMatchObject({ eligible: false, pitDue: null, difference: null, pitAuthorized: false });
    expect(n.excludeReason).toMatch(/Không ủy quyền/);
    expect(s.totals).toMatchObject({ persons: 2, settled: 1, excluded: 1, pitDue: '6792500', pitWithheld: '9695000', payable: '0', refund: '2902500' });
    expect(s.warnings.join(' ')).not.toContain('giảm trừ gia cảnh cả năm');
  });

  it('thiếu biểu thuế năm pit_brackets_annual → 409 PAYROLL_PARAM_MISSING (không suy từ biểu tháng)', async () => {
    const p = (await ok('GET', '/api/payroll/params?code=pit_brackets_annual'))[0];
    await ok('DELETE', `/api/payroll/params/${p.id}`);
    const e = await fail('GET', `${T}/settlement?year=2026`, 409, 'PAYROLL_PARAM_MISSING');
    expect(e.message).toContain('pit_brackets_annual');
    await ok('PUT', '/api/payroll/params', { code: 'pit_brackets_annual', validFrom: '2024-01-01', value: fx.params.pit_brackets_annual, source: fx.source });
  });
});

describe('tờ khai 05/KK-TNCN và 05/QTT-TNCN', () => {
  it('lập, chốt, sửa sau chốt 409, bổ sung; XML và ký số 409 khi chưa có mẫu', async () => {
    const r = await ok('POST', `${T}/returns`, { formCode: '05/KK-TNCN', year: 2026, periodKind: 'quarter', period: 4 });
    expect(r).toMatchObject({ formCode: '05/KK-TNCN', revision: 0, status: 'draft', templateVersion: 'BANG_KE' });
    expect(r.values.totals.pit).toBe(await postedPit([10, 11, 12]));
    expect(r.values.rows).toHaveLength(2);
    await fail('POST', `${T}/returns`, 409, 'TAX_RETURN_DRAFT_EXISTS', { formCode: '05/KK-TNCN', year: 2026, periodKind: 'quarter', period: 4 });
    await fail('GET', `${T}/returns/${r.id}/xml`, 409, 'TNCN_TEMPLATE_UNAVAILABLE');
    await fail('POST', '/api/signing/sessions', 409, 'TNCN_TEMPLATE_UNAVAILABLE', { docKind: '05kk_tncn', docRef: String(r.id) });
    // Số đã lưu lệch số tính lại → không chốt được.
    await sql`UPDATE tax_return SET values = jsonb_set(values, '{totals,pit}', '"1"') WHERE id = ${r.id}`.execute(ctx.t.admin);
    await fail('POST', `${T}/returns/${r.id}/finalize`, 409, 'TAX_RETURN_STALE');
    expect((await ok('PUT', `${T}/returns/${r.id}`)).values.totals.pit).toBe(r.values.totals.pit);
    expect(await ok('POST', `${T}/returns/${r.id}/finalize`)).toMatchObject({ status: 'final' });
    await fail('PUT', `${T}/returns/${r.id}`, 409, 'TAX_RETURN_FINAL');
    await fail('DELETE', `${T}/returns/${r.id}`, 409, 'TAX_RETURN_FINAL');
    expect(await ok('POST', `${T}/returns`, { formCode: '05/KK-TNCN', year: 2026, periodKind: 'quarter', period: 4 })).toMatchObject({ revision: 1, status: 'draft' });
    // Tháng: 05/KK-TNCN cũng lập theo tháng (D15).
    expect((await ok('POST', `${T}/returns`, { formCode: '05/KK-TNCN', year: 2026, periodKind: 'month', period: 12 })).values.totals.pit).toBe(await postedPit([12]));

    const q = await ok('POST', `${T}/returns`, { formCode: '05/QTT-TNCN', year: 2026, periodKind: 'year', period: 1 });
    expect(q.values.totals).toMatchObject({ settled: 1, refund: '2902500' });
    await fail('GET', `${T}/returns/${q.id}/xml`, 409, 'TNCN_TEMPLATE_UNAVAILABLE');
    await fail('POST', '/api/signing/sessions', 409, 'TNCN_TEMPLATE_UNAVAILABLE', { docKind: '05qtt_tncn', docRef: String(q.id) });
    await fail('POST', `${T}/returns`, 400, 'VALIDATION', { formCode: '05/QTT-TNCN', year: 2026, periodKind: 'quarter', period: 4 });
    const list = await ok('GET', `${T}/returns?year=2026`);
    expect(list.map((x: Json) => `${x.formCode} ${x.periodKind}${x.period} r${x.revision}`).sort()).toEqual(['05/KK-TNCN month12 r0', '05/KK-TNCN quarter4 r0', '05/KK-TNCN quarter4 r1', '05/QTT-TNCN year1 r0']);
    expect(list[0].values.rows).toBeUndefined();
  });

  it('thiếu cờ view_salary: 403 SALARY_FORBIDDEN ở bảng kê, quyết toán, chứng từ khấu trừ, tờ khai', async () => {
    for (const url of [`${T}/withholding?year=2026&quarter=4`, `${T}/settlement?year=2026`, `${T}/certificates?year=2026`, `${T}/returns?year=2026`])
      await fail('GET', url, 403, 'SALARY_FORBIDDEN', undefined, noFlag);
    await fail('POST', `${T}/returns`, 403, 'SALARY_FORBIDDEN', { formCode: '05/KK-TNCN', year: 2026, periodKind: 'quarter', period: 3 }, noFlag);
  });
});
