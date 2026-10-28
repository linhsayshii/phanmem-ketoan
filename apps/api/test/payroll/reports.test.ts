import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { sql } from 'kysely';
import { D } from '@kt/domain';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 7: báo cáo lương, phiếu lương, tệp BHXH, nhập bảng lương từ Excel. 2026 = TT99: tháng 10 hạch toán, tháng 11 chỉ tính.
// Tham số là Dữ liệu minh họa (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let noFlag: string; let noExport: string; let tenantId: string;
type M = 'GET' | 'POST' | 'PUT';
const call = (method: M, url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const fail = async (method: M, url: string, status: number, code: string, cookie = owner) => {
  const r = await call(method, url, cookie); expect(r.statusCode, r.body).toBe(status); expect(r.json().error.code).toBe(code); return r.json().error;
};
const R = '/api/payroll/runs', P = '/api/payroll/reports';
const emp: Record<string, number> = {};
const CODES = ['NV01', 'NV03', 'NV05', 'NV09'];
const day = (m: number, d: number) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const sumOf = (rows: Json[], k: string) => rows.reduce((s, r) => s.plus(r[k] ?? 0), D(0)).toFixed(0);

async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `pr_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
async function setupEmployee(code: string, name: string, dept: string, i: Json, extra: Json = {}) {
  const id = Number((await ok('POST', '/api/catalogs/employee', { code, name, department_code: dept, tax_code: `80000000${code.slice(2)}`, id_number: `0010900000${code.slice(2)}` })).id);
  const ins = i.insurance;
  await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: i.taxResidency, contractType: i.contractType, region: 'I', siSalary: i.siSalary ?? null, siNo: `SI${code}`, startDate: '2024-01-01',
    siParticipates: ins.si, hiParticipates: ins.hi, uiParticipates: ins.ui, occupationalParticipates: ins.occupational, ...extra });
  await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2024-01-01', monthlySalary: i.segments[0].monthlySalary });
  for (const [k, d] of (i.dependents ?? []).entries()) await ok('POST', `/api/payroll/profiles/${id}/dependents`, { name: `Người phụ thuộc ${k + 1}`, relationship: 'child', fromMonth: '2024-01', toMonth: d.to ? d.to.slice(0, 7) : null });
  return id;
}
async function calculated(m: number, ids: number[]) {
  const cells: Json[] = [];
  for (const id of ids) for (let d = 1; d <= (m === 10 ? 26 : 22); d++) cells.push({ employeeId: id, date: day(m, d), entries: [{ kind: 'work_day', qty: '1' }] });
  await ok('PUT', `/api/attendance?year=2026&month=${m}`, { cells });
  const run = await ok('POST', R, { year: 2026, month: m, employeeIds: ids });
  return ok('POST', `${R}/${run.id}/calculate`);
}
// LU: dư Có theo tài khoản của chứng từ.
const luCredit = (lu: Json, code: string) => (lu.lines as Json[]).filter((l) => l.accountCode === code).reduce((s, l) => s.plus(l.credit).minus(l.debit), D(0)).toFixed(0);

let oct: Json, nov: Json, lu: Json;
beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `PR${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  noFlag = await userWith('ketoan_truong', []);
  await sql`DELETE FROM role_permission rp USING role r WHERE r.id = rp.role_id AND r.tenant_id = ${tenantId}::uuid AND r.code = 'ketoan_vien' AND rp.permission_code = 'payroll.export'`.execute(ctx.t.admin);
  noExport = await userWith('ketoan_vien', ['view_salary']);
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const dept: Record<string, number> = {};
  for (const c of ['QL', 'BH']) dept[c] = Number((await ok('POST', '/api/catalogs/department', { code: c, name: `Bộ phận ${c}` })).id);
  const proj: Record<string, number> = {};
  for (const c of ['P1', 'P2']) proj[c] = Number((await ok('POST', '/api/catalogs/project', { code: c, name: `Vụ việc ${c}` })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dept.QL, kind: 'payroll', role: 'admin' }, { departmentId: dept.BH, kind: 'payroll', role: 'selling' }] });
  for (const c of CODES) { const e = (fx.employees as Json[]).find((x) => x.code === c)!; emp[c] = await setupEmployee(c, e.name, c === 'NV05' || c === 'NV09' ? 'BH' : 'QL', e.input); }
  await ok('PUT', `/api/payroll/profiles/${emp.NV03}/cost-split`, { items: [{ projectId: proj.P1, pct: '60' }, { projectId: proj.P2, pct: '40' }] });
  oct = await calculated(10, CODES.map((c) => emp[c]!));
  lu = await ok('GET', `/api/vouchers/${(await ok('POST', `${R}/${oct.id}/post`)).voucherId}`);
  oct = await ok('GET', `${R}/${oct.id}`);
  nov = await calculated(11, CODES.map((c) => emp[c]!));
});
afterAll(async () => { await ctx.close(); });

describe('báo cáo khớp bảng lương và chứng từ LU', () => {
  it('Bảng thanh toán tiền lương: từng nhân viên khớp bảng lương, cộng khớp, đối chiếu LU bằng 0, không in Mẫu số', async () => {
    const r = await ok('GET', `${P}/payment-sheet?year=2026&month=10`);
    expect(r.rows.map((x: Json) => [x.code, x.gross, x.siEmp, x.pit, x.net])).toEqual((oct.lines as Json[]).map((l) => [l.employeeCode, l.gross, l.siEmp, l.pit, l.net]));
    expect(r.footer).toMatchObject({ gross: oct.totals.gross, net: sumOf(oct.lines, 'net') });
    expect(r.footer.gross).toBe(sumOf(oct.lines, 'gross'));
    expect(r.reconciliation).toMatchObject({ ok: true, postedRuns: 1, unpostedRuns: 0 });
    expect(r.reconciliation.items[0]).toMatchObject({ report: sumOf(oct.lines, 'net'), ledger: sumOf(oct.lines, 'net'), diff: '0' });
    expect(r.intro[0]).toMatch(/^Dữ liệu minh họa/);
    const html = (await call('GET', `${P}/payment-sheet?year=2026&month=10&format=html`)).body;
    expect(html).toContain('BẢNG THANH TOÁN TIỀN LƯƠNG'); expect(html).not.toContain('Mẫu số');
    // Một bảng cụ thể và lọc bộ phận.
    expect((await ok('GET', `${P}/payment-sheet?year=2026&month=10&runId=${oct.id}`)).rows).toHaveLength(4);
    expect((await ok('GET', `${P}/payment-sheet?year=2026&month=10&departmentId=${(await ok('GET', '/api/catalogs/department?q=BH')).rows[0].id}`)).rows.map((x: Json) => x.code)).toEqual(['NV05', 'NV09']);
    // Bảng chưa hạch toán vẫn lên báo cáo nhưng không có dòng đối chiếu và có cảnh báo.
    const n = await ok('GET', `${P}/payment-sheet?year=2026&month=11`);
    expect(n.rows).toHaveLength(4); expect(n.reconciliation).toMatchObject({ ok: true, postedRuns: 0, unpostedRuns: 1, items: [] }); expect(n.intro.join(' ')).toContain('chưa hạch toán');
  });

  it('Bảng tổng hợp bảo hiểm theo tháng và quý khớp Có các tài khoản bảo hiểm của LU', async () => {
    const m = await ok('GET', `${P}/insurance?year=2026&month=10`);
    const sum = (k: string) => m.footer[k];
    expect(sum('eSi')).toBe(oct.lines.reduce((s: any, l: Json) => s.plus(l.values.si_emp_si), D(0)).toFixed(0)); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(D(sum('eSi')).plus(sum('rSi')).plus(sum('rOcc')).toFixed(0)).toBe(luCredit(lu, '3383'));
    expect(D(sum('eHi')).plus(sum('rHi')).toFixed(0)).toBe(luCredit(lu, '3384'));
    expect(D(sum('eUi')).plus(sum('rUi')).toFixed(0)).toBe(luCredit(lu, '3386'));
    expect(sum('union')).toBe(luCredit(lu, '3382'));
    expect(m.reconciliation.ok).toBe(true); expect(m.reconciliation.items).toHaveLength(4);
    expect(m.rows.every((r: Json) => D(r.total).eq(D(r.eTotal).plus(r.rTotal)))).toBe(true);
    // Quý 4 = tháng 10 (đã hạch toán) + tháng 11 (chưa hạch toán): quỹ lương đóng BH cộng cả hai tháng; đối chiếu chỉ trên bảng đã hạch toán.
    const q = await ok('GET', `${P}/insurance?year=2026&quarter=4`);
    expect(q.rows).toHaveLength(4); expect(q.subtitle).toBe('Quý 4/2026');
    expect(q.reconciliation).toMatchObject({ ok: true, postedRuns: 1, unpostedRuns: 1 });
    expect(D(q.footer.siBase).toFixed(0)).toBe(D(m.footer.siBase).plus((await ok('GET', `${P}/insurance?year=2026&month=11`)).footer.siBase).toFixed(0));
    await fail('GET', `${P}/insurance?year=2026`, 400, 'VALIDATION');
    await fail('GET', `${P}/insurance?year=2026&month=10&quarter=4`, 400, 'VALIDATION');
  });

  it('Chi phí lương theo bộ phận và theo vụ việc khớp Nợ chi phí của LU; vụ việc tách 60/40', async () => {
    const d = await ok('GET', `${P}/cost?year=2026&month=10&groupBy=department`);
    expect(d.rows.map((r: Json) => [r.code, r.employees])).toEqual([['BH', '2'], ['QL', '2']]);
    expect(d.reconciliation).toMatchObject({ ok: true }); expect(d.reconciliation.items[0].diff).toBe('0');
    const costDebit = (lu.lines as Json[]).filter((l) => /^(6|1)/.test(l.accountCode) && !['111', '112', '133'].includes(l.accountCode)).reduce((s, l) => s.plus(l.debit).minus(l.credit), D(0)).toFixed(0);
    expect(d.footer.total).toBe(costDebit);
    const p = await ok('GET', `${P}/cost?year=2026&month=10&groupBy=project`);
    expect(p.footer.total).toBe(d.footer.total); expect(p.reconciliation.ok).toBe(true);
    expect(p.rows.map((r: Json) => r.code)).toEqual(['', 'P1', 'P2']); // NV01, NV05, NV09 chưa gán vụ việc; NV03 tách P1 60%, P2 40%
    const nv03 = oct.lines.find((l: Json) => l.employeeCode === 'NV03');
    const p1 = p.rows.find((r: Json) => r.code === 'P1'), p2 = p.rows.find((r: Json) => r.code === 'P2');
    expect(D(p1.salary).plus(p2.salary).toFixed(0)).toBe(D(nv03.values.gross).toFixed(0));
    expect(D(p1.salary).div(nv03.values.gross).toNumber()).toBeCloseTo(0.6, 3);
  });

  it('Thuế TNCN khấu trừ theo nhân viên và tháng khớp Có 3335', async () => {
    const r = await ok('GET', `${P}/pit?year=2026&month=10`);
    expect(r.rows.map((x: Json) => [x.code, x.pit])).toEqual((oct.lines as Json[]).map((l) => [l.employeeCode, l.pit]));
    expect(r.rows[0].taxCode).toMatch(/^80000000/);
    expect(r.footer.pit).toBe(luCredit(lu, '3335')); expect(r.reconciliation.ok).toBe(true);
    const y = await ok('GET', `${P}/pit?year=2026`); // cả năm: tháng 10 và 11, mỗi nhân viên hai dòng
    expect(y.rows).toHaveLength(8); expect(y.rows.map((x: Json) => x.month)).toContain('11/2026');
  });

  it('So sánh hai kỳ: chênh lệch = kỳ sau trừ kỳ trước; nhân viên chỉ có ở một kỳ vẫn lên báo cáo', async () => {
    const c = await ok('GET', `${P}/compare?year=2026&month=10&year2=2026&month2=11`);
    expect(c.rows).toHaveLength(4);
    for (const r of c.rows) expect(D(r.netD).eq(D(r.netB).minus(r.netA))).toBe(true);
    expect(c.footer.netA).toBe(sumOf(oct.lines, 'net')); expect(c.footer.netB).toBe(sumOf(nov.lines, 'net'));
    expect(c.footer.netD).toBe(D(c.footer.netB).minus(c.footer.netA).toFixed(0));
    const c2 = await ok('GET', `${P}/compare?year=2026&month=9&year2=2026&month2=10`); // tháng 9 chưa có bảng lương
    expect(c2.rows).toHaveLength(4); expect(c2.footer.netA).toBe('0'); expect(c2.footer.netB).toBe(sumOf(oct.lines, 'net'));
  });
});

describe('phiếu lương cá nhân', () => {
  it('số trên phiếu đúng bảng lương, thu nhập trừ khấu trừ bằng thực lĩnh, mỗi nhân viên một trang', async () => {
    const d = await ok('GET', `${P}/slips?runId=${oct.id}`);
    expect(d.slips.map((s: Json) => s.code)).toEqual(CODES);
    for (const s of d.slips) {
      const l = oct.lines.find((x: Json) => x.employeeCode === s.code);
      expect(s).toMatchObject({ gross: l.gross, net: l.net });
      expect(D(s.gross).minus(s.totalDeductions).toFixed(0)).toBe(l.net);
      expect(sumOf(s.income, 'amount')).toBe(s.gross);
    }
    const html = await call('GET', `${P}/slips?runId=${oct.id}&format=html`);
    expect(html.headers['content-type']).toContain('text/html'); expect(html.body.match(/PHIẾU LƯƠNG/g)).toHaveLength(4); expect(html.body.match(/class="pb"/g)).toHaveLength(3);
    expect(html.body).toContain('Tháng 10/2026'); expect(html.body).not.toContain('Mẫu số');
    const one = await ok('GET', `${P}/slips?runId=${oct.id}&employeeId=${emp.NV03}`);
    expect(one.slips).toHaveLength(1);
    await fail('GET', `${P}/slips?runId=${oct.id}&employeeId=999999`, 404, 'PAYROLL_LINE_NOT_FOUND');
    const draft = await ok('POST', R, { year: 2026, month: 12, employeeIds: [emp.NV01] });
    await fail('GET', `${P}/slips?runId=${draft.id}`, 409, 'PAYROLL_RUN_NOT_CALCULATED');
  });
});

describe('tệp BHXH, xuất Excel và CSV', () => {
  it('Danh sách tham gia BHXH, BHYT, BHTN: cột chung (mã số BHXH, họ tên, CCCD, lương đóng, phụ cấp, thời gian); CSV có BOM; xlsx có tiêu đề cột', async () => {
    const r = await ok('GET', `${P}/bhxh-list?year=2026&month=10`);
    expect(r.rows).toHaveLength(4);
    expect(r.rows[0]).toMatchObject({ siNo: 'SINV01', idNumber: '001090000001', siBase: oct.lines[0].values.si_base, period: '10/2026', joined: 'BHXH, BHYT, BHTN, TNLĐ-BNN' });
    const csv = await call('GET', `${P}/bhxh-list?year=2026&month=10&format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const lines = csv.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('STT,Mã số BHXH,Họ và tên,Số CCCD,Mã NV,"Lương đóng BHXH, BHYT",Lương đóng BHTN,Phụ cấp,Tham gia,Tháng đóng,Ngày vào làm,Ngày nghỉ việc');
    expect(lines).toHaveLength(5); expect(lines[1]).toContain('SINV01'); expect(lines[1]).toContain('01/01/2024');
    const x = await call('GET', `${P}/bhxh-list?year=2026&month=10&format=xlsx`);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!; const texts = ws.getSheetValues().flat().map((c) => String(c ?? ''));
    expect(texts).toContain('DANH SÁCH THAM GIA BHXH, BHYT, BHTN'); expect(texts).toContain('Mã số BHXH'); expect(texts).toContain('SINV03');
    expect(texts.join('|')).not.toContain('Mẫu số');
  });

  it('xuất xlsx/csv cần payroll.export; xem json/html chỉ cần payroll.view', async () => {
    await fail('GET', `${P}/payment-sheet?year=2026&month=10&format=xlsx`, 403, 'FORBIDDEN', noExport);
    await fail('GET', `${P}/bhxh-list?year=2026&month=10&format=csv`, 403, 'FORBIDDEN', noExport);
    expect((await call('GET', `${P}/payment-sheet?year=2026&month=10`, noExport)).statusCode).toBe(200);
    expect((await call('GET', `${P}/payment-sheet?year=2026&month=10&format=html`, noExport)).statusCode).toBe(200);
    const x = await call('GET', `${P}/payment-sheet?year=2026&month=10&format=xlsx`);
    expect(x.statusCode).toBe(200); expect(x.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('thiếu cờ view_salary: 403 SALARY_FORBIDDEN ở mọi route báo cáo', () => {
  it.each([
    `${P}/payment-sheet?year=2026&month=10`, `${P}/insurance?year=2026&month=10`, `${P}/cost?year=2026&month=10`, `${P}/pit?year=2026`, `${P}/compare?year=2026&month=10&year2=2026&month2=11`,
    `${P}/bhxh-list?year=2026&month=10&format=csv`, `${P}/slips?runId=1`, `${R}/1/import/template.xlsx`,
  ])('GET %s', async (url) => { await fail('GET', url, 403, 'SALARY_FORBIDDEN', noFlag); });
  it('POST nhập Excel', async () => { const r = await call('POST', `${R}/1/import?mode=validate`, noFlag); expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('SALARY_FORBIDDEN'); });
});

describe('nhập bảng lương từ Excel', () => {
  const upload = (id: number, buf: Buffer, mode: 'validate' | 'commit', cookie = owner) => {
    const fd = new FormData(); fd.append('file', buf, { filename: 'luong.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return ctx.app.inject({ method: 'POST', url: `${R}/${id}/import?mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
  };
  async function sheet(id: number, data: (string | number | null)[][]) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await call('GET', `${R}/${id}/import/template.xlsx`)).rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Du_lieu')!;
    data.forEach((r, i) => ws.getRow(4 + i).values = r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const manual = async (runId: number, code: string) => (await ok('GET', `${R}/${runId}`)).lines.find((l: Json) => l.employeeCode === code);

  it('mẫu theo cột nhập tay của cấu trúc; lỗi báo từng dòng; kiểm tra không ghi gì; nhập có lỗi thì không ghi dòng nào', async () => {
    const t = await call('GET', `${R}/${nov.id}/import/template.xlsx`);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(t.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Du_lieu')!.getRow(2).values).toEqual([undefined, 'employee_code', 'bonus', 'charity', 'advance']);
    // cột: employee_code, bonus (tiền), charity (tiền), advance (tiền)
    const bad = await sheet(nov.id, [['NV01', 500000, null, null], ['KHONGCO', 1, null, null], ['NV03', -5, null, null], ['NV05', 1.5, null, null], ['NV01', 1, null, null], ['NV09', 700000, 100000, null]]);
    const v = (await upload(nov.id, bad, 'validate')).json();
    expect(v.errorCount).toBe(4);
    expect(v.errors.map((e: Json) => [e.row, e.column])).toEqual([[5, 'employee_code'], [6, 'bonus'], [7, 'bonus'], [8, 'employee_code']]);
    expect(v.errors[0].message).toContain('KHONGCO');
    expect((await manual(nov.id, 'NV01')).manual).toEqual([]); // kiểm tra không ghi
    const c = await upload(nov.id, bad, 'commit'); expect(c.statusCode).toBe(409); expect(c.json().error.code).toBe('IMPORT_ERRORS');
    expect((await manual(nov.id, 'NV09')).manual).toEqual([]); // có lỗi thì không ghi dòng nào
  });

  it('nhập hợp lệ ghi ô nhập tay và audit trước/sau, làm bảng "Cần tính lại"; ô trống giữ nguyên; tính lại ra số mới', async () => {
    const before = await manual(nov.id, 'NV01');
    const file = await sheet(nov.id, [['NV01', 500000, null, 200000], ['NV09', 700000, 100000, null]]);
    const v = (await upload(nov.id, file, 'validate')).json(); expect(v).toMatchObject({ total: 2, employees: 2, cells: 4, errorCount: 0 });
    const c = (await upload(nov.id, file, 'commit')).json(); expect(c).toMatchObject({ employees: 2, cells: 4, changedCells: 4 });
    const after = await manual(nov.id, 'NV01');
    expect(after.values).toMatchObject({ bonus: '500000', advance: '200000' }); expect(after.manual).toEqual(['advance', 'bonus']); expect(after.stale).toBe(true);
    expect((await ok('GET', `${R}/${nov.id}`)).stale).toBe(true);
    const audit = await ok('GET', `/api/audit?entity=payroll_line_value&entityId=${after.lineId}`);
    expect(audit.rows.map((a: Json) => [a.action, a.before.values.bonus, a.after.values.bonus])).toEqual([['manual_value', null, '500000']]);
    // Nhập lại đúng số cũ: không đổi ô nào, không thêm audit.
    expect((await upload(nov.id, file, 'commit')).json().changedCells).toBe(0);
    expect((await ok('GET', `/api/audit?entity=payroll_line_value&entityId=${after.lineId}`)).rows).toHaveLength(1);
    const calc = await ok('POST', `${R}/${nov.id}/calculate`);
    expect(calc.stale).toBe(false);
    const nv01 = calc.lines.find((l: Json) => l.employeeCode === 'NV01');
    expect(D(nv01.gross).minus(before.gross).toFixed(0)).toBe('500000'); // thưởng 500.000 cộng vào tổng thu nhập
  });

  it('bảng đã hạch toán không nhập được (409), người không có payroll.update bị chặn', async () => {
    const file = await sheet(oct.id, [['NV01', 1, null, null]]);
    const r = await upload(oct.id, file, 'commit'); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('PAYROLL_RUN_POSTED');
    const bad = await upload(nov.id, Buffer.from('không phải xlsx'), 'validate'); expect(bad.statusCode).toBe(400);
    const noUpdate = await upload(nov.id, file, 'validate', await userWith('xem', ['view_salary']));
    expect(noUpdate.statusCode).toBe(403);
  });
});
