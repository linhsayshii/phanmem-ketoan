import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 5: cấu trúc bảng lương và bảng lương. Tham số là Dữ liệu minh họa (payroll-20.json, docs/dev/bang-luong-mau-20.md), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let other: string; let noFlag: string;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.statusCode === 204 ? null : r.json();
};
const fail = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, status: number, code: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, r.body).toBe(status); expect(r.json().error.code).toBe(code); return r.json().error;
};
const S = '/api/payroll/structures', R = '/api/payroll/runs';
const emp: Record<string, number> = {};
const day = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lineOf = (run: Json, code: string) => run.lines.find((l: Json) => l.employeeCode === code);

// Chấm công dựng từ số công của từng đoạn lương: ngày nguyên = X, phần lẻ 0,5 = N; đoạn i bắt đầu từ ngày starts[i].
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

async function userNoFlag() {
  const username = `rn_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

// Hồ sơ, lịch sử lương, phụ cấp, người phụ thuộc của một nhân viên theo đầu vào của tệp mẫu.
async function setupEmployee(e: Json, cookie = owner) {
  const id = Number((await ok('POST', '/api/catalogs/employee', { code: e.code, name: e.name }, cookie)).id);
  const i = e.input; const ins = i.insurance;
  await ok('PUT', `/api/payroll/profiles/${id}`, {
    taxResidency: i.taxResidency, contractType: i.contractType, region: 'I', siSalary: i.siSalary ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null,
    siParticipates: ins.si, hiParticipates: ins.hi, uiParticipates: ins.ui, occupationalParticipates: ins.occupational,
  }, cookie);
  const segs = i.segments as Json[];
  const from = segs.length > 1 ? ['2026-01-01', '2026-10-16'] : ['2026-01-01']; // NV12 đổi lương từ 16/10
  for (const [k, s] of segs.entries()) await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: from[k], monthlySalary: s.monthlySalary }, cookie);
  for (const a of i.allowances ?? []) await ok('POST', `/api/payroll/profiles/${id}/allowances`, { code: a.code, name: a.code, amount: a.amount, taxable: a.taxable, siBase: a.siBase }, cookie);
  for (const [k, d] of (i.dependents ?? []).entries()) await ok('POST', `/api/payroll/profiles/${id}/dependents`, { name: `Người phụ thuộc ${k + 1}`, relationship: 'child', fromMonth: d.from.slice(0, 7), toMonth: d.to ? d.to.slice(0, 7) : null }, cookie);
  return id;
}

let oct: Json; // bảng lương chính tháng 10/2026 của 20 nhân viên
beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner } = await bootstrapTenant(ctx, { code: `RN${Date.now()}` }));
  ({ cookie: other } = await bootstrapTenant(ctx, { code: `RO${Date.now()}` }));
  noFlag = await userNoFlag();
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2026-01-01', value, source: fx.source });
  for (const e of fx.employees as Json[]) emp[e.code] = await setupEmployee(e.code === 'NV10' ? { ...e, startDate: '2026-10-14' } : e);
  // Chấm công tháng 10. NV10: 17,5 công không xếp được vào 17 ngày lịch từ 15/10 (mỗi ngày tối đa 1 công) nên hồ sơ ghi vào làm 14/10,
  // chấm 18 ngày từ 14/10 và thêm một ngày 13/10 trước ngày vào làm (không được tính, chỉ cảnh báo). NV12: 11 công lương cũ từ 01/10, 15 công lương mới từ 16/10.
  const all: Json[] = [];
  for (const e of fx.employees as Json[]) {
    const segs = e.input.segments as Json[]; const id = emp[e.code]!;
    const starts = e.code === 'NV10' ? [14] : e.code === 'NV12' ? [1, 16] : [1];
    all.push(...cells(id, 2026, 10, segs.map((s, k) => ({ days: s.paidDays, start: starts[k]! })), e.input.otHours));
    if (e.code === 'NV10') all.push({ employeeId: id, date: '2026-10-13', entries: [{ kind: 'work_day', qty: '1' }] });
  }
  await ok('PUT', '/api/attendance?year=2026&month=10', { cells: all });
  oct = await ok('POST', R, { year: 2026, month: 10, employeeIds: Object.values(emp) });
  for (const e of fx.employees as Json[]) if (e.input.manual) await ok('PUT', `${R}/${oct.id}/lines/${emp[e.code]}/values`, { values: e.input.manual });
  oct = await ok('POST', `${R}/${oct.id}/calculate`);
});
afterAll(async () => { await ctx.close(); });

describe('bảng lương 20 nhân viên khớp tính tay', () => {
  it('từng cột từng nhân viên và tổng bảng khớp payroll-20.json', () => {
    expect(oct).toMatchObject({ status: 'calculated', kind: 'regular', employeeCount: 20, stale: false, name: 'Bảng lương tháng 10/2026', structureName: 'Lương cơ bản' });
    expect(oct.inputHash).toMatch(/^[0-9a-f]{64}$/);
    for (const e of fx.employees as Json[]) {
      const l = lineOf(oct, e.code);
      for (const [c, v] of Object.entries(e.expected)) expect(`${e.code}.${c}=${l.values[c]}`).toBe(`${e.code}.${c}=${v}`);
      expect({ gross: l.gross, siEmp: l.siEmp, siEr: l.siEr, pit: l.pit, net: l.net }).toEqual({ gross: e.expected.gross, siEmp: e.expected.si_emp, siEr: e.expected.si_er, pit: e.expected.pit, net: e.expected.net });
    }
    for (const [c, v] of Object.entries(fx.totals)) expect(`${c}=${oct.totals[c]}`).toBe(`${c}=${v}`);
    // Ngày ngoài thời gian làm việc không tính, chỉ cảnh báo; ô nhập tay được đánh dấu.
    expect(lineOf(oct, 'NV10').warnings.map((w: Json) => w.code)).toContain('ATTENDANCE_OUT_OF_EMPLOYMENT');
    expect(lineOf(oct, 'NV07').manual).toEqual(['bonus']);
    expect(lineOf(oct, 'NV05').warnings.map((w: Json) => w.code)).toContain('SI_CEILING_APPLIED');
    expect(oct.columns.map((c: Json) => c.code)).toContain('bonus');
  });

  it('danh sách theo năm/tháng có tổng; GET lại không đổi chữ ký (ổn định)', async () => {
    const list = await ok('GET', `${R}?year=2026&month=10`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: oct.id, status: 'calculated', employeeCount: 20, totals: { gross: fx.totals.gross, siEmp: fx.totals.si_emp, siEr: fx.totals.si_er, pit: fx.totals.pit, net: fx.totals.net } });
    const again = await ok('GET', `${R}/${oct.id}`);
    expect(again.stale).toBe(false); expect(again.inputHash).toBe(oct.inputHash);
    expect((await ok('GET', `${R}/${oct.id}/lines`))).toHaveLength(20);
  });
});

describe('bảng thưởng (D12)', () => {
  it('bảng thưởng tháng 12 của NV20 khớp mục 5; bảng chính chưa tính thì 409', async () => {
    const b = fx.bonusRun; const id = emp[b.employee]!;
    await ok('PUT', '/api/attendance?year=2026&month=12', { cells: cells(id, 2026, 12, [{ days: '26', start: 1 }]) });
    const reg = await ok('POST', R, { year: 2026, month: 12, employeeIds: [id] });
    const bonus = await ok('POST', R, { year: 2026, month: 12, kind: 'bonus', employeeIds: [id] });
    expect(bonus.name).toBe('Bảng thưởng tháng 12/2026');
    await fail('PUT', `${R}/${bonus.id}/lines/${id}/values`, 409, 'PAYROLL_REGULAR_NOT_CALCULATED', { values: b.input.manual });
    const r = await ok('POST', `${R}/${reg.id}/calculate`);
    expect(lineOf(r, b.employee)).toMatchObject({ pit: b.input.prior.pit, values: { taxable_income: b.input.prior.taxableIncome, si_emp: b.input.prior.siEmployee } });
    await ok('PUT', `${R}/${bonus.id}/lines/${id}/values`, { values: b.input.manual });
    const done = await ok('POST', `${R}/${bonus.id}/calculate`);
    const l = lineOf(done, b.employee);
    for (const [c, v] of Object.entries(b.expected)) expect(`${c}=${l.values[c]}`).toBe(`${c}=${v}`);
    expect(l.values.si_emp).toBe('0'); expect(done.stale).toBe(false);
    // Bảng chính tính lại với số khác → bảng thưởng (prior đổi) cần tính lại.
    await ok('PUT', `/api/attendance?year=2026&month=12`, { cells: [{ employeeId: id, date: '2026-12-26', entries: [] }] });
    await ok('POST', `${R}/${reg.id}/calculate`);
    expect((await ok('GET', `${R}/${bonus.id}`)).stale).toBe(true);
  });
});

describe('cấu trúc bảng lương', () => {
  it('cấu trúc mặc định tạo lười; nhân bản, thêm cột "Thưởng chuyên cần" công thức IF, xem thử', async () => {
    const list = await ok('GET', S);
    const def = list.find((s: Json) => s.isDefault);
    expect(def).toMatchObject({ code: 'LUONG_CO_BAN', name: 'Lương cơ bản', proration: 'calendar', inUse: true });
    expect((await ok('GET', `${S}/builtin-columns`)).map((c: Json) => c.code)).toContain('net');
    const cc = await ok('POST', `${S}/${def.id}/clone`, { code: 'CHUYEN_CAN', name: 'Lương có chuyên cần' });
    expect(cc).toMatchObject({ parentId: def.id, isDefault: false, inUse: false });
    const columns = [...cc.columns, { code: 'chuyen_can', name: 'Thưởng chuyên cần', kind: 'formula', formula: 'IF([work_days] >= 26, 500000, 0)', income: true }];
    const upd = await ok('PUT', `${S}/${cc.id}`, { code: 'CHUYEN_CAN', name: 'Lương có chuyên cần', proration: 'standard_26', columns });
    expect(upd.columns.at(-1)).toMatchObject({ code: 'chuyen_can' });
    const p1 = await ok('POST', `${S}/preview`, { structureId: cc.id, employeeId: emp.NV01, year: 2026, month: 10 });
    expect(p1.values).toMatchObject({ chuyen_can: '500000', gross: '10500000' });
    const p2 = await ok('POST', `${S}/preview`, { structureId: cc.id, employeeId: emp.NV10, year: 2026, month: 10 });
    expect(p2.values.chuyen_can).toBe('0');
    // Xem thử cấu trúc đang soạn (chưa lưu)
    const p3 = await ok('POST', `${S}/preview`, { employeeId: emp.NV01, year: 2026, month: 10, proration: 'standard_26', columns: [...columns.slice(0, -1), { ...columns.at(-1), formula: 'IF([work_days] >= 26, 700000, 0)' }] });
    expect(p3.values.chuyen_can).toBe('700000');
    // Bảng lương dùng cấu trúc tùy biến
    const run = await ok('POST', R, { year: 2026, month: 9, structureId: cc.id, employeeIds: [emp.NV01] });
    await ok('PUT', '/api/attendance?year=2026&month=9', { cells: cells(emp.NV01!, 2026, 9, [{ days: '26', start: 1 }]) });
    const calc = await ok('POST', `${R}/${run.id}/calculate`);
    expect(lineOf(calc, 'NV01').values).toMatchObject({ chuyen_can: '500000', gross: '10500000' });
    expect((await ok('GET', `${S}/${cc.id}`)).inUse).toBe(true);
    await fail('PUT', `${S}/${cc.id}`, 409, 'STRUCTURE_IN_USE', { code: 'CHUYEN_CAN', name: 'x', proration: 'standard_26', columns });
    await fail('DELETE', `${S}/${cc.id}`, 409, 'STRUCTURE_IN_USE');
    await fail('DELETE', `${S}/${def.id}`, 409, 'STRUCTURE_DEFAULT');
  });

  it('công thức xấu, mã trùng → 400/409; cấu trúc chưa dùng xóa được', async () => {
    const base = (await ok('GET', S)).find((s: Json) => s.isDefault).columns as Json[];
    const mk = (extra: Json[]) => ({ code: `X${Math.random().toString(36).slice(2, 6)}`, name: 'Thử', columns: [...base, ...extra] });
    await fail('POST', S, 400, 'FORMULA_UNKNOWN_COLUMN', mk([{ code: 'a', name: 'A', kind: 'formula', formula: '[khong_co] + 1' }]));
    await fail('POST', S, 400, 'FORMULA_CYCLE', mk([{ code: 'a', name: 'A', kind: 'formula', formula: '[b]' }, { code: 'b', name: 'B', kind: 'formula', formula: '[a] + 1' }]));
    await fail('POST', S, 400, 'FORMULA_SYNTAX', mk([{ code: 'a', name: 'A', kind: 'formula', formula: 'IF([gross] > 1, 2' }]));
    await fail('POST', S, 400, 'FORMULA_UNKNOWN_FUNCTION', mk([{ code: 'a', name: 'A', kind: 'formula', formula: 'EVAL(1)' }]));
    await fail('POST', S, 400, 'STRUCTURE_INVALID', mk([{ code: 'gross', name: 'Trùng', kind: 'input' }, { code: 'gross', name: 'Trùng', kind: 'input' }]));
    await fail('POST', S, 400, 'STRUCTURE_INVALID', mk([{ code: 'khong_co', name: 'X', kind: 'builtin' }]));
    const s = await ok('POST', S, mk([]));
    await fail('POST', S, 409, 'STRUCTURE_DUPLICATE', { ...mk([]), code: s.code });
    await ok('DELETE', `${S}/${s.id}`);
    await fail('GET', `${S}/${s.id}`, 404, 'STRUCTURE_NOT_FOUND');
  });
});

describe('ràng buộc bảng lương', () => {
  it('hai bảng lương chính trùng nhân viên cùng tháng → 409; hủy bảng thì tạo lại được; xóa chỉ khi nháp', async () => {
    const e = await fail('POST', R, 409, 'PAYROLL_EMPLOYEE_IN_OTHER_RUN', { year: 2026, month: 10, employeeIds: [emp.NV01] });
    expect(e.details.employeeCodes).toEqual(['NV01']);
    const a = await ok('POST', R, { year: 2026, month: 11, employeeIds: [emp.NV01] });
    await fail('POST', R, 409, 'PAYROLL_EMPLOYEE_IN_OTHER_RUN', { year: 2026, month: 11, employeeIds: [emp.NV01] });
    // Chốt chặn ở DB: chỉ mục duy nhất một phần không cho chèn thẳng NV01 vào bảng chính khác cùng tháng
    const other11 = await ok('POST', R, { year: 2026, month: 11, employeeIds: [emp.NV02] });
    await expect(sql`INSERT INTO payroll_line(tenant_id, run_id, employee_id) SELECT tenant_id, id, ${emp.NV01} FROM payroll_run WHERE id = ${other11.id}`.execute(ctx.t.admin)).rejects.toThrow(/payroll_line_one_regular/);
    await ok('DELETE', `${R}/${other11.id}`);
    expect((await ok('POST', `${R}/${a.id}/cancel`)).status).toBe('cancelled');
    await fail('POST', `${R}/${a.id}/calculate`, 409, 'PAYROLL_RUN_CANCELLED');
    const b = await ok('POST', R, { year: 2026, month: 11, employeeIds: [emp.NV01] });
    await ok('DELETE', `${R}/${b.id}`);
    await fail('DELETE', `${R}/${oct.id}`, 409, 'PAYROLL_RUN_NOT_DRAFT');
    const dept = await ok('POST', '/api/catalogs/department', { code: 'TRONG', name: 'Bộ phận trống' });
    await fail('POST', R, 400, 'PAYROLL_RUN_EMPTY', { year: 2026, month: 10, departmentId: Number(dept.id) });
    await fail('POST', R, 409, 'PAYROLL_PROFILE_MISSING', { year: 2026, month: 12, kind: 'bonus', employeeIds: [999999] });
  });

  it('thiếu tham số → 409 PAYROLL_PARAM_MISSING nêu tên tham số; RLS chéo công ty', async () => {
    await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: '8', payroll_standard_days_per_month: '26' }, other);
    const id = await setupEmployee({ code: 'K01', name: 'Khác', input: { segments: [{ monthlySalary: '10000000', paidDays: '1' }], insurance: { si: true, hi: true, ui: true, occupational: true }, taxResidency: 'resident', contractType: 'long' } }, other);
    await ok('PUT', '/api/attendance?year=2026&month=10', { cells: cells(id, 2026, 10, [{ days: '1', start: 1 }]) }, other);
    const run = await ok('POST', R, { year: 2026, month: 10 }, other);
    const err = await fail('POST', `${R}/${run.id}/calculate`, 409, 'PAYROLL_PARAM_MISSING', undefined, other);
    expect(err.details.param).toMatch(/^(si_|pit_)/);
    expect(err.message).toContain(err.details.param); expect(err.message).toContain('31/10/2026'); expect(err.details.employeeCode).toBe('K01');
    await fail('GET', `${R}/${oct.id}`, 404, 'PAYROLL_RUN_NOT_FOUND', undefined, other);
    await fail('POST', `${R}/${oct.id}/calculate`, 404, 'PAYROLL_RUN_NOT_FOUND', undefined, other);
    expect(await ok('GET', `${R}?year=2026&month=10`, undefined, other)).toHaveLength(1);
  });
});

describe('cần tính lại (input_hash)', () => {
  it('sửa chấm công, hồ sơ → stale; trả lại như cũ → hết stale không cần tính; tính lại → false', async () => {
    const get = () => ok('GET', `${R}/${oct.id}`);
    await ok('PUT', '/api/attendance?year=2026&month=10', { cells: [{ employeeId: emp.NV01, date: '2026-10-30', entries: [{ kind: 'ot_weekday_hour', qty: '2' }] }] });
    let r = await get();
    expect(r.stale).toBe(true); expect(lineOf(r, 'NV01').stale).toBe(true); expect(lineOf(r, 'NV02').stale).toBe(false);
    await ok('PUT', '/api/attendance?year=2026&month=10', { cells: [{ employeeId: emp.NV01, date: '2026-10-30', entries: [] }] });
    expect((await get()).stale).toBe(false);
    const dep = await ok('POST', `/api/payroll/profiles/${emp.NV02}/dependents`, { name: 'Con mới', relationship: 'child', fromMonth: '2026-10' });
    expect(lineOf(await get(), 'NV02').stale).toBe(true);
    r = await ok('POST', `${R}/${oct.id}/calculate`);
    expect(r.stale).toBe(false); expect(lineOf(r, 'NV02').values.dependents).toBe('1');
    await ok('DELETE', `/api/payroll/profiles/${emp.NV02}/dependents/${dep.id}`);
    expect((await get()).stale).toBe(true);
    r = await ok('POST', `${R}/${oct.id}/calculate`);
    expect(r.stale).toBe(false); expect(r.inputHash).toBe(oct.inputHash); expect(r.totals.net).toBe(fx.totals.net);
  });

  it('ô nhập tay: tính lại dòng ngay, đổi chữ ký bảng, ghi audit trước/sau; cột không phải nhập tay → 400', async () => {
    const id = emp.NV01!;
    const l = await ok('PUT', `${R}/${oct.id}/lines/${id}/values`, { values: { bonus: '1000000' } });
    expect(l).toMatchObject({ manual: ['bonus'], gross: '11000000', stale: false });
    const r = await ok('GET', `${R}/${oct.id}`);
    expect(r.stale).toBe(false); expect(r.inputHash).not.toBe(oct.inputHash);
    await ok('PUT', `${R}/${oct.id}/lines/${id}/values`, { values: { bonus: null } });
    const back = await ok('GET', `${R}/${oct.id}`);
    expect(back.inputHash).toBe(oct.inputHash); expect(lineOf(back, 'NV01').manual).toEqual([]);
    const audit = await ok('GET', `/api/audit?entity=payroll_line_value&entityId=${lineOf(back, 'NV01').lineId}`);
    expect(audit.rows.map((a: Json) => [a.action, a.before.values.bonus, a.after.values.bonus])).toEqual([['manual_value', '1000000', null], ['manual_value', null, '1000000']]);
    await fail('PUT', `${R}/${oct.id}/lines/${id}/values`, 400, 'PAYROLL_COLUMN_NOT_INPUT', { values: { gross: '1' } });
    await fail('PUT', `${R}/${oct.id}/lines/999999/values`, 404, 'PAYROLL_LINE_NOT_FOUND', { values: { bonus: '1' } });
    await fail('PUT', `${R}/${oct.id}/lines/${id}/values`, 400, 'VALIDATION', { values: { bonus: '1,5' } });
  });

  it('tham số đổi giữa kỳ → cảnh báo PARAM_CHANGED_IN_PERIOD (dùng giá trị cuối kỳ)', async () => {
    await ok('PUT', '/api/payroll/params', { code: 'pit_non_resident_rate', validFrom: '2026-01-01', validTo: '2026-11-14', value: { rate: 20 }, source: fx.source });
    await ok('PUT', '/api/payroll/params', { code: 'pit_non_resident_rate', validFrom: '2026-11-15', value: { rate: 25 }, source: fx.source });
    await ok('PUT', '/api/attendance?year=2026&month=11', { cells: cells(emp.NV15!, 2026, 11, [{ days: '26', start: 1 }]) });
    const run = await ok('POST', R, { year: 2026, month: 11, employeeIds: [emp.NV15] });
    const r = await ok('POST', `${R}/${run.id}/calculate`);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'PARAM_CHANGED_IN_PERIOD', message: expect.stringContaining('pit_non_resident_rate') })]);
    expect(lineOf(r, 'NV15').pit).toBe('10500000'); // 25% × 42.000.000 (giá trị hiệu lực 30/11)
  });
});

describe('móc hồ sơ lương và chấm công', () => {
  it('salaryUse: bảng đã tính chặn sửa lịch sử lương từ tháng đó; tháng sau vẫn thêm được', async () => {
    const id = emp.NV03!;
    await fail('POST', `/api/payroll/profiles/${id}/salary-history`, 409, 'SALARY_HISTORY_USED', { validFrom: '2026-10-20', monthlySalary: '1' });
    const hist = (await ok('GET', `/api/payroll/profiles/${id}`)).salaryHistory;
    await fail('DELETE', `/api/payroll/profiles/${id}/salary-history/${hist[0].id}`, 409, 'SALARY_HISTORY_USED');
    const n = await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2027-01-01', monthlySalary: '41000000' });
    await ok('DELETE', `/api/payroll/profiles/${id}/salary-history/${n.id}`);
  });

  it('attendanceGate: bảng lương đã hạch toán (giả lập posted) khóa chấm công, không tính lại, không hủy', async () => {
    await ok('PUT', '/api/attendance?year=2026&month=8', { cells: cells(emp.NV04!, 2026, 8, [{ days: '20', start: 1 }]) });
    const run = await ok('POST', R, { year: 2026, month: 8, employeeIds: [emp.NV04] });
    await ok('POST', `${R}/${run.id}/calculate`);
    await sql`UPDATE payroll_run SET status = 'posted' WHERE id = ${run.id}`.execute(ctx.t.admin); // Task 6 chưa có: giả lập đã hạch toán
    await fail('PUT', '/api/attendance?year=2026&month=8', 409, 'ATTENDANCE_LOCKED', { cells: [{ employeeId: emp.NV04, date: '2026-08-25', entries: [{ kind: 'work_day', qty: '1' }] }] });
    await ok('PUT', '/api/attendance?year=2026&month=8', { cells: [{ employeeId: emp.NV05, date: '2026-08-25', entries: [{ kind: 'work_day', qty: '1' }] }] });
    await fail('POST', `${R}/${run.id}/calculate`, 409, 'PAYROLL_RUN_POSTED');
    await fail('POST', `${R}/${run.id}/cancel`, 409, 'PAYROLL_RUN_POSTED');
    await fail('PUT', `${R}/${run.id}/lines/${emp.NV04}/values`, 409, 'PAYROLL_RUN_POSTED', { values: { bonus: '1' } });
    await sql`UPDATE payroll_run SET status = 'calculated' WHERE id = ${run.id}`.execute(ctx.t.admin);
    await ok('PUT', '/api/attendance?year=2026&month=8', { cells: [{ employeeId: emp.NV04, date: '2026-08-25', entries: [{ kind: 'work_day', qty: '1' }] }] });
  });
});

describe('cờ view_salary', () => {
  it('thiếu view_salary → 403 SALARY_FORBIDDEN mọi route cấu trúc và bảng lương', async () => {
    const body = { code: 'Z', name: 'Z', columns: [{ code: 'gross', name: 'G', kind: 'builtin' }] };
    const routes: [('GET' | 'POST' | 'PUT' | 'DELETE'), string, object?][] = [
      ['GET', S], ['GET', `${S}/builtin-columns`], ['POST', `${S}/preview`, { employeeId: emp.NV01, year: 2026, month: 10 }], ['GET', `${S}/1`], ['POST', S, body],
      ['POST', `${S}/1/clone`, { code: 'Z', name: 'Z' }], ['PUT', `${S}/1`, body], ['DELETE', `${S}/1`],
      ['GET', `${R}?year=2026`], ['POST', R, { year: 2026, month: 10 }], ['GET', `${R}/${oct.id}`], ['GET', `${R}/${oct.id}/lines`], ['DELETE', `${R}/${oct.id}`],
      ['POST', `${R}/${oct.id}/calculate`], ['POST', `${R}/${oct.id}/cancel`], ['PUT', `${R}/${oct.id}/lines/${emp.NV01}/values`, { values: { bonus: '1' } }],
    ];
    for (const [m, u, p] of routes) await fail(m, u, 403, 'SALARY_FORBIDDEN', p, noFlag);
    await fail('GET', '/api/audit?entity=payroll_line_value', 403, 'SALARY_FORBIDDEN', undefined, noFlag);
  });
});
