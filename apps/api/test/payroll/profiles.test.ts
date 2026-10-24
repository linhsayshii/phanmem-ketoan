import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { buildProfileTemplate } from '../../src/modules/payroll/profileImport.js';
import { salaryUse } from '../../src/modules/payroll/profiles.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let owner: string; let vien: string; let hasFlag: string; let viewer: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const P = '/api/payroll/profiles';
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `pf_${roleCode}_${sensitiveFlags.length}_${Math.random().toString(36).slice(2, 7)}`;
  const made = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: owner }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags } });
  expect(made.statusCode, made.body).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
async function newEmployee(code: string, name = `Nhân viên ${code}`): Promise<number> {
  const r = await call('POST', '/api/catalogs/employee', owner, { code, name });
  expect(r.statusCode, r.body).toBe(201);
  return Number(r.json().id);
}
async function newProject(code: string): Promise<number> {
  const r = await call('POST', '/api/catalogs/project', owner, { code, name: `Vụ việc ${code}` });
  expect(r.statusCode, r.body).toBe(201);
  return Number(r.json().id);
}

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner } = await bootstrapTenant(ctx, { code: `PF${Date.now()}` }));
  vien = await userWith('ketoan_vien', []); hasFlag = await userWith('ketoan_vien', ['view_salary']); viewer = await userWith('xem', ['view_salary']);
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('hồ sơ lương: CRUD', () => {
  it('hồ sơ: GET chưa có → profile null; PUT tạo, PUT lại sửa; ngày nghỉ việc trước ngày bắt đầu là 400; nhân viên/vụ việc không có là 404', async () => {
    const e = await newEmployee('CRUD1'); const pj = await newProject('PJ-CRUD');
    const g0 = (await call('GET', `${P}/${e}`)).json();
    expect(g0.profile).toBeNull(); expect(g0.employee.code).toBe('CRUD1'); expect(g0.currentSalary).toBeNull();
    const body = { payMethod: 'transfer', bankCode: 'VCB', bankName: 'Vietcombank', bankAccountNo: '0011001234567', bankAccountName: 'NGUYEN VAN A', taxResidency: 'resident', contractType: 'long',
      startDate: '2026-01-05', region: 'I', siNo: '0123456789', siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, siSalary: '10000000',
      unionEmployer: true, unionMember: false, pitAuthorized: true, defaultProjectId: pj, note: 'Minh họa' };
    const put = await call('PUT', `${P}/${e}`, owner, body);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ bankAccountNo: '0011001234567', siSalary: '10000000', pitAuthorized: true, defaultProjectId: pj, region: 'I', endDate: null });
    const upd = await call('PUT', `${P}/${e}`, owner, { ...body, siSalary: null, endDate: '2026-12-31', payMethod: 'cash' });
    expect(upd.json()).toMatchObject({ siSalary: null, endDate: '2026-12-31', payMethod: 'cash' });
    expect((await call('GET', `${P}/${e}`)).json().profile.payMethod).toBe('cash');
    expect((await call('PUT', `${P}/${e}`, owner, { ...body, endDate: '2026-01-01' })).statusCode).toBe(400);
    expect((await call('PUT', `${P}/${e}`, owner, { ...body, siSalary: '1.5' })).statusCode).toBe(400);
    expect((await call('PUT', `${P}/${e}`, owner, { ...body, region: 'V' })).statusCode).toBe(400);
    expect((await call('PUT', `${P}/${e}`, owner, { ...body, defaultProjectId: 999999 })).json().error.code).toBe('PROJECT_NOT_FOUND');
    expect((await call('PUT', `${P}/999999`, owner, body)).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    expect((await call('GET', `${P}/999999`)).statusCode).toBe(404);
    const list = (await call('GET', `${P}?q=CRUD1`)).json();
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ employeeId: e, code: 'CRUD1', hasProfile: true, currentSalary: null });
    // Xóa nhân viên khỏi danh mục kéo theo hồ sơ (ON DELETE CASCADE); xóa được vì chưa có chứng từ.
    expect((await call('DELETE', `/api/catalogs/employee/${e}`)).statusCode).toBe(204);
    expect((await call('GET', `${P}/${e}`)).statusCode).toBe(404);
    expect((await sql`SELECT 1 FROM employee_payroll WHERE employee_id = ${e}`.execute(ctx.t.admin)).rows).toHaveLength(0);
  });

  it('phụ cấp: thêm, sửa, xóa; cùng mã chồng khoảng hiệu lực là 409; mã sai/số tiền sai là 400', async () => {
    const e = await newEmployee('CRUD2');
    const a = await call('POST', `${P}/${e}/allowances`, owner, { code: 'an_trua', name: 'Phụ cấp ăn trưa', amount: '730000', taxable: false, siBase: false });
    expect(a.statusCode, a.body).toBe(201); const id = a.json().id;
    expect(a.json()).toMatchObject({ code: 'an_trua', amount: '730000', taxable: false, siBase: false, validFrom: null });
    expect((await call('POST', `${P}/${e}/allowances`, owner, { code: 'an_trua', name: 'Trùng', amount: '1', validFrom: '2026-05-01' })).json().error.code).toBe('ALLOWANCE_OVERLAP');
    expect((await call('PUT', `${P}/${e}/allowances/${id}`, owner, { code: 'an_trua', name: 'Ăn trưa', amount: '800000', taxable: false, validTo: '2026-06-30' })).json()).toMatchObject({ amount: '800000', validTo: '2026-06-30' });
    expect((await call('POST', `${P}/${e}/allowances`, owner, { code: 'an_trua', name: 'Từ tháng 7', amount: '900000', validFrom: '2026-07-01' })).statusCode).toBe(201); // liền kề, không chồng
    expect((await call('POST', `${P}/${e}/allowances`, owner, { code: 'An Trua', name: 'x', amount: '1' })).statusCode).toBe(400);
    expect((await call('POST', `${P}/${e}/allowances`, owner, { code: 'xang', name: 'x', amount: '-5' })).statusCode).toBe(400);
    expect((await call('POST', `${P}/${e}/allowances`, owner, { code: 'xang', name: 'x', amount: '5', validFrom: '2026-02-01', validTo: '2026-01-01' })).statusCode).toBe(400);
    expect((await call('GET', `${P}/${e}`)).json().allowances).toHaveLength(2);
    expect((await call('DELETE', `${P}/${e}/allowances/${id}`)).statusCode).toBe(204);
    expect((await call('DELETE', `${P}/${e}/allowances/${id}`)).statusCode).toBe(404);
    expect((await call('PUT', `${P}/${e}/allowances/999999`, owner, { code: 'x', name: 'x', amount: '1' })).statusCode).toBe(404);
  });

  it('lịch sử lương: thêm theo ngày hiệu lực, trùng ngày là 409, lương hiện tại lấy dòng hiệu lực mới nhất đến hôm nay; xóa được khi chưa có bảng lương dùng', async () => {
    const e = await newEmployee('CRUD3');
    expect((await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-01-01', monthlySalary: '10000000' })).statusCode).toBe(201);
    const s2 = await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-04-01', monthlySalary: '12000000', note: 'Tăng lương' });
    expect(s2.statusCode).toBe(201);
    expect((await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-04-01', monthlySalary: '13000000' })).json().error.code).toBe('SALARY_HISTORY_DUPLICATE');
    expect((await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-02-30', monthlySalary: '1' })).statusCode).toBe(400);
    expect((await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-05-01', monthlySalary: '1.5' })).statusCode).toBe(400);
    const g = (await call('GET', `${P}/${e}`)).json();
    expect(g.salaryHistory.map((h: Json) => h.validFrom)).toEqual(['2026-04-01', '2026-01-01']); // mới nhất trước
    expect(g.currentSalary).toBe('12000000'); // hôm nay (sau 01/04/2026)
    expect((await call('GET', `${P}?q=CRUD3`)).json()[0].currentSalary).toBe('12000000');
    expect((await call('DELETE', `${P}/${e}/salary-history/${s2.json().id}`)).statusCode).toBe(204);
    expect((await call('GET', `${P}/${e}`)).json().currentSalary).toBe('10000000');
    expect((await call('DELETE', `${P}/${e}/salary-history/${s2.json().id}`)).statusCode).toBe(404);
  });

  it('lịch sử lương đã được bảng lương dùng: thêm hoặc xóa trả 409 SALARY_HISTORY_USED (móc cho Task 5)', async () => {
    const e = await newEmployee('CRUD4');
    const first = await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-01-01', monthlySalary: '9000000' });
    const spy = vi.spyOn(salaryUse, 'used').mockResolvedValue(true);
    try {
      const add = await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-03-01', monthlySalary: '9500000' });
      expect(add.statusCode).toBe(409); expect(add.json().error.code).toBe('SALARY_HISTORY_USED');
      expect((await call('DELETE', `${P}/${e}/salary-history/${first.json().id}`)).json().error.code).toBe('SALARY_HISTORY_USED');
    } finally { spy.mockRestore(); }
    expect((await call('GET', `${P}/${e}`)).json().salaryHistory).toHaveLength(1);
  });

  it('phân bổ chi phí: lưu cả bộ, tổng phải bằng 100, vụ việc không trùng, thay thế bộ cũ, rỗng là xóa hết', async () => {
    const e = await newEmployee('CRUD5'); const a = await newProject('PJ-A'); const b = await newProject('PJ-B');
    const put = (items: object[]) => call('PUT', `${P}/${e}/cost-split`, owner, { items });
    expect((await put([{ projectId: a, pct: '60' }, { projectId: b, pct: '30' }])).statusCode).toBe(400);
    expect((await put([{ projectId: a, pct: '100.0001' }])).statusCode).toBe(400);
    expect((await put([{ projectId: a, pct: '50' }, { projectId: a, pct: '50' }])).statusCode).toBe(400);
    expect((await put([{ projectId: a, pct: '0' }, { projectId: b, pct: '100' }])).statusCode).toBe(400);
    expect((await put([{ projectId: 999999, pct: '100' }])).json().error.code).toBe('PROJECT_NOT_FOUND');
    const ok = await put([{ projectId: a, pct: '33.3333' }, { projectId: b, pct: '66.6667' }]);
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json()).toHaveLength(2);
    expect((await put([{ projectId: b, pct: '100' }])).json()).toEqual([{ projectId: b, projectCode: 'PJ-B', projectName: 'Vụ việc PJ-B', pct: '100.0000' }]);
    expect((await put([])).json()).toEqual([]);
    expect((await call('GET', `${P}/${e}`)).json().costSplit).toEqual([]);
  });
});

describe('người phụ thuộc', () => {
  const dep = (o: Json = {}) => ({ name: 'Nguyễn Thị Con', relationship: 'child', fromMonth: '2026-01', ...o });
  it('đến tháng phải sau hoặc bằng từ tháng; định dạng tháng sai là 400', async () => {
    const e = await newEmployee('DEP1');
    const r = await call('POST', `${P}/${e}/dependents`, owner, dep({ fromMonth: '2026-05', toMonth: '2026-04' }));
    expect(r.statusCode).toBe(400);
    expect((await call('POST', `${P}/${e}/dependents`, owner, dep({ toMonth: '2026-13' }))).statusCode).toBe(400);
    expect((await call('POST', `${P}/${e}/dependents`, owner, dep({ fromMonth: '2026-1' }))).statusCode).toBe(400);
    expect((await call('POST', `${P}/${e}/dependents`, owner, dep({ relationship: 'cousin' }))).statusCode).toBe(400);
    const ok = await call('POST', `${P}/${e}/dependents`, owner, dep({ fromMonth: '2026-05', toMonth: '2026-05' })); // một tháng là hợp lệ
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('cùng một người không trùng khoảng với chính nó; người khác, khoảng liền kề, nhân viên khác thì được', async () => {
    const e = await newEmployee('DEP2'); const e2 = await newEmployee('DEP3');
    const first = await call('POST', `${P}/${e}/dependents`, owner, dep({ taxCode: '8000000001', fromMonth: '2026-01', toMonth: '2026-06' }));
    expect(first.statusCode, first.body).toBe(201);
    const clash = await call('POST', `${P}/${e}/dependents`, owner, dep({ taxCode: '8000000001', name: 'Tên khác', fromMonth: '2026-06' })); // trùng đúng tháng 06
    expect(clash.statusCode).toBe(409); expect(clash.json().error.code).toBe('DEPENDENT_OVERLAP');
    expect((await call('POST', `${P}/${e}/dependents`, owner, dep({ name: '  nguyễn thị CON ', fromMonth: '2026-03' }))).json().error.code).toBe('DEPENDENT_OVERLAP'); // không MST: cùng họ tên và quan hệ
    expect((await call('POST', `${P}/${e}/dependents`, owner, dep({ taxCode: '8000000001', fromMonth: '2026-07' }))).statusCode).toBe(201); // liền kề
    expect((await call('POST', `${P}/${e}/dependents`, owner, dep({ taxCode: '8000000002', name: 'Nguyễn Thị Con', fromMonth: '2026-01' }))).statusCode).toBe(201); // MST khác: người khác
    expect((await call('POST', `${P}/${e2}/dependents`, owner, dep({ taxCode: '8000000001', fromMonth: '2026-01' }))).statusCode).toBe(201); // nhân viên khác
    // Sửa chính nó không tự va chạm; sửa kéo dài đè lên dòng khác của cùng người thì 409.
    const id = first.json().id;
    expect((await call('PUT', `${P}/${e}/dependents/${id}`, owner, dep({ taxCode: '8000000001', fromMonth: '2026-01', toMonth: '2026-05', note: 'Sửa' }))).json().note).toBe('Sửa');
    expect((await call('PUT', `${P}/${e}/dependents/${id}`, owner, dep({ taxCode: '8000000001', fromMonth: '2026-01', toMonth: '2026-08' }))).json().error.code).toBe('DEPENDENT_OVERLAP');
    expect((await call('DELETE', `${P}/${e}/dependents/${id}`)).statusCode).toBe(204);
    expect((await call('DELETE', `${P}/${e}/dependents/${id}`)).statusCode).toBe(404);
    expect((await call('GET', `${P}/${e}`)).json().dependents).toHaveLength(2);
  });
});

describe('cờ view_salary và danh mục', () => {
  it('thiếu cờ: mọi route hồ sơ lương trả 403 SALARY_FORBIDDEN (kể cả khi có đủ quyền payroll.*)', async () => {
    const e = await newEmployee('FLAG1');
    await call('PUT', `${P}/${e}`, owner, { siSalary: '5000000' });
    const dep = (await call('POST', `${P}/${e}/dependents`, owner, { name: 'A', relationship: 'child', fromMonth: '2026-01' })).json().id;
    const al = (await call('POST', `${P}/${e}/allowances`, owner, { code: 'x', name: 'x', amount: '1' })).json().id;
    const sh = (await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-01-01', monthlySalary: '1' })).json().id;
    const routes: [string, string, object?][] = [
      ['GET', P], ['GET', `${P}/${e}`], ['PUT', `${P}/${e}`, {}],
      ['POST', `${P}/${e}/allowances`, { code: 'y', name: 'y', amount: '1' }], ['PUT', `${P}/${e}/allowances/${al}`, { code: 'x', name: 'x', amount: '2' }], ['DELETE', `${P}/${e}/allowances/${al}`],
      ['POST', `${P}/${e}/dependents`, { name: 'B', relationship: 'child', fromMonth: '2026-01' }], ['PUT', `${P}/${e}/dependents/${dep}`, { name: 'A', relationship: 'child', fromMonth: '2026-01' }], ['DELETE', `${P}/${e}/dependents/${dep}`],
      ['POST', `${P}/${e}/salary-history`, { validFrom: '2026-02-01', monthlySalary: '1' }], ['DELETE', `${P}/${e}/salary-history/${sh}`],
      ['PUT', `${P}/${e}/cost-split`, { items: [] }], ['GET', `${P}/import/template.xlsx`], ['POST', `${P}/import?mode=validate`],
    ];
    for (const [m, url, body] of routes) {
      const r = await call(m as 'GET', url, vien, body);
      expect(r.statusCode, `${m} ${url}: ${r.body}`).toBe(403);
      expect(r.json().error.code, `${m} ${url}`).toBe('SALARY_FORBIDDEN'); expect(r.json().error.message).toBe('Không có quyền xem lương');
    }
    // Không ghi gì: dữ liệu vẫn nguyên.
    const g = (await call('GET', `${P}/${e}`)).json();
    expect(g.profile.siSalary).toBe('5000000'); expect(g.allowances).toHaveLength(1); expect(g.dependents).toHaveLength(1); expect(g.salaryHistory).toHaveLength(1);
    // Có cờ nhưng không có quyền sửa (vai trò xem): đọc được, ghi bị 403 FORBIDDEN.
    expect((await call('GET', `${P}/${e}`, viewer)).statusCode).toBe(200);
    const w = await call('PUT', `${P}/${e}`, viewer, {});
    expect(w.statusCode).toBe(403); expect(w.json().error.code).toBe('FORBIDDEN');
    expect((await call('PUT', `${P}/${e}`, hasFlag, { siSalary: '6000000' })).statusCode).toBe(200); // kế toán viên có cờ: được
  });

  it('danh mục nhân viên /api/catalogs/employee không trả trường lương, ngân hàng nhận lương, bảo hiểm, người phụ thuộc', async () => {
    const e = await newEmployee('CATL1');
    await call('PUT', `${P}/${e}`, owner, { bankAccountNo: '123456789', siNo: '0987654321', siSalary: '7000000', siParticipates: true });
    await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-01-01', monthlySalary: '7000000' });
    await call('POST', `${P}/${e}/dependents`, owner, { name: 'Phụ thuộc', relationship: 'child', fromMonth: '2026-01' });
    const body = [(await call('GET', '/api/catalogs/employee?q=CATL1', vien)).body, (await call('GET', `/api/catalogs/employee/${e}`, vien)).body, (await call('GET', '/api/catalogs/employee?q=CATL1', owner)).body];
    for (const b of body) {
      expect(b).toContain('CATL1');
      for (const leak of ['salary', 'bank_account', 'si_no', 'si_salary', 'dependent', 'allowance', 'pit_', '123456789', '0987654321', '7000000', 'pay_method', 'tax_residency'])
        expect(b, `rò ${leak}`).not.toContain(leak);
    }
  });

  it('nhật ký kiểm toán: người thiếu view_salary không thấy dòng của bảng hồ sơ lương (tổng và danh sách), hỏi thẳng bảng đó là 403; người có cờ thấy trước/sau', async () => {
    const e = await newEmployee('AUD1');
    await call('PUT', `${P}/${e}`, owner, { siSalary: '4444000', bankAccountNo: '555000111' });
    await call('PUT', `${P}/${e}`, owner, { siSalary: '4555000', bankAccountNo: '555000111' });
    await call('POST', `${P}/${e}/dependents`, owner, { name: 'Con kiểm toán', relationship: 'child', fromMonth: '2026-01' });
    await call('POST', `${P}/${e}/salary-history`, owner, { validFrom: '2026-01-01', monthlySalary: '4555000' });
    await call('POST', `${P}/${e}/allowances`, owner, { code: 'kt', name: 'Phụ cấp kiểm toán', amount: '123000' });
    await call('PUT', `${P}/${e}/cost-split`, owner, { items: [{ projectId: await newProject('PJ-AUD'), pct: '100' }] });
    const entities = ['employee_payroll', 'employee_allowance', 'employee_salary_history', 'employee_dependent', 'employee_cost_split'];
    for (const ent of entities) {
      const full = (await call('GET', `/api/audit?entity=${ent}&size=100`, owner)).json();
      expect(full.total, ent).toBeGreaterThan(0);
      const denied = await call('GET', `/api/audit?entity=${ent}`, vien);
      expect(denied.statusCode, ent).toBe(403); expect(denied.json().error.code).toBe('SALARY_FORBIDDEN');
    }
    const upd = (await call('GET', '/api/audit?entity=employee_payroll&action=update&size=100', owner)).json().rows.find((r: Json) => Number(r.after?.si_salary) === 4555000);
    expect(Number(upd.before.si_salary)).toBe(4444000); // người có cờ thấy trước/sau
    const all = (await call('GET', '/api/audit?size=500', vien)).json();
    expect(all.total).toBeGreaterThan(0);
    const text = JSON.stringify(all.rows);
    for (const ent of entities) expect(text).not.toContain(`"${ent}"`);
    for (const leak of ['4444000', '4555000', '555000111', '123000', 'Con kiểm toán']) expect(text, leak).not.toContain(leak);
    expect(JSON.stringify((await call('GET', '/api/audit?size=500', hasFlag)).json().rows)).toContain('"employee_payroll"');
    // Tìm theo entityId (không nêu bảng) cũng không lộ.
    const pid = upd.entityId as string;
    expect((await call('GET', `/api/audit?entityId=${pid}&size=100`, vien)).json().rows.filter((r: Json) => r.entity === 'employee_payroll')).toHaveLength(0);
  });
});

describe('nhập Excel hồ sơ lương', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as { region: string; employees: { code: string; name: string; input: Json; startDate?: string; endDate?: string }[] };
  const SALARY_FROM = '2026-01-01';
  type Cell = ExcelJS.CellValue;
  // Điền mẫu: mỗi dòng là { khóa cột: giá trị }, ghi vào đúng cột theo dòng khóa kỹ thuật (dòng 2) từ dòng 4.
  async function workbook(sheets: Record<string, Record<string, Cell>[]>): Promise<Buffer> {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await buildProfileTemplate() as unknown as ArrayBuffer);
    for (const [name, rows] of Object.entries(sheets)) {
      const ws = wb.getWorksheet(name)!; const col = new Map<string, number>();
      ws.getRow(2).eachCell((c, n) => { col.set(String(c.value), n); });
      rows.forEach((r, i) => { const row = ws.getRow(4 + i); for (const [k, v] of Object.entries(r)) row.getCell(col.get(k)!).value = v; row.commit(); });
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const upload = (buf: Buffer, mode: 'validate' | 'commit', cookie = owner) => {
    const fd = new FormData(); fd.append('file', buf, { filename: 'x.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return ctx.app.inject({ method: 'POST', url: `${P}/import?mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
  };
  // Sheet Du_lieu / Phu_cap / Nguoi_phu_thuoc dựng từ payroll-20.json (đầu vào động cơ của từng nhân viên).
  function fromFixture(prefix: string) {
    const main: Record<string, Cell>[] = []; const allowances: Record<string, Cell>[] = []; const dependents: Record<string, Cell>[] = [];
    for (const e of fx.employees) {
      const i = e.input as Json; const code = `${prefix}${e.code}`;
      main.push({ employee_code: code, base_salary: i.segments.at(-1).monthlySalary, salary_from: e.startDate ? null : SALARY_FROM, pay_method: 'transfer', bank_name: 'Ngân hàng minh họa', bank_account_no: `0000${e.code.slice(2)}`,
        tax_residency: i.taxResidency, contract_type: i.contractType, start_date: e.startDate ?? null, end_date: e.endDate ?? null, region: fx.region,
        si_participates: i.insurance.si, hi_participates: i.insurance.hi, ui_participates: i.insurance.ui, occupational_participates: i.insurance.occupational, si_salary: i.siSalary ?? null });
      for (const a of i.allowances ?? []) allowances.push({ employee_code: code, code: a.code, name: `Phụ cấp ${a.code}`, amount: a.amount, taxable: a.taxable, si_base: a.siBase });
      (i.dependents ?? []).forEach((d: Json, n: number) => dependents.push({ employee_code: code, name: `${e.name} PT${n + 1}`, relationship: 'child', from_month: d.from, to_month: d.to ?? null }));
    }
    return { Du_lieu: main, Phu_cap: allowances, Nguoi_phu_thuoc: dependents };
  }
  const byCode = (a: Json[]) => [...a].sort((x, y) => x.code.localeCompare(y.code)); // API trả theo mã phụ cấp, từ tháng
  const byFrom = (a: Json[]) => [...a].sort((x, y) => x.from.localeCompare(y.from));
  const profilesOf = async (prefix: string) => (await call('GET', `${P}?q=${prefix}&size=100`)).json() as Json[];

  it('mẫu 20 nhân viên dựng từ payroll-20.json: kiểm tra thử không ghi gì; nhập thật tạo đúng hồ sơ, phụ cấp, người phụ thuộc và lương; đầu vào khớp động cơ', async () => {
    for (const e of fx.employees) await newEmployee(`IM${e.code}`, e.name);
    const sheets = fromFixture('IM'); const buf = await workbook(sheets);
    const dry = (await upload(buf, 'validate')).json();
    expect(dry.errorCount, JSON.stringify(dry.errors)).toBe(0);
    expect((await profilesOf('IMNV')).filter((p) => p.hasProfile)).toHaveLength(0);

    const res = await upload(buf, 'commit');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ inserted: 20, allowances: sheets.Phu_cap.length, dependents: sheets.Nguoi_phu_thuoc.length, errorCount: 0 });
    expect(sheets.Phu_cap.length).toBe(7); expect(sheets.Nguoi_phu_thuoc.length).toBe(8); // đếm từ fixture: NV03, 05, 14, 15 mỗi người 1, NV17 có 3; người phụ thuộc NV04 1, NV05 2, NV08 2, NV17 1, NV20 2
    const list = await profilesOf('IMNV'); expect(list).toHaveLength(20); expect(list.every((p) => p.hasProfile)).toBe(true);

    for (const e of fx.employees) {
      const id = list.find((p) => p.code === `IM${e.code}`)!.employeeId;
      const g = (await call('GET', `${P}/${id}`)).json();
      const i = e.input as Json; const p = g.profile;
      // Cột hồ sơ → đầu vào động cơ (PayrollInput): cờ bảo hiểm, cư trú, loại hợp đồng, mức lương đóng BH, phụ cấp, người phụ thuộc theo tháng.
      const engine = {
        insurance: { si: p.siParticipates, hi: p.hiParticipates, ui: p.uiParticipates, occupational: p.occupationalParticipates }, taxResidency: p.taxResidency, contractType: p.contractType,
        siSalary: p.siSalary ?? undefined, allowances: byCode(g.allowances.map((a: Json) => ({ code: a.code, amount: a.amount, taxable: a.taxable, siBase: a.siBase }))),
        dependents: byFrom(g.dependents.map((d: Json) => ({ from: d.fromMonth, to: d.toMonth }))),
      };
      const expected = {
        insurance: i.insurance, taxResidency: i.taxResidency, contractType: i.contractType, siSalary: i.siSalary, allowances: byCode(i.allowances ?? []),
        dependents: byFrom((i.dependents ?? []).map((d: Json) => ({ from: d.from.slice(0, 7), to: d.to ?? null }))),
      };
      expect(engine, e.code).toEqual(expected);
      expect(p.region).toBe(fx.region); expect(p.startDate).toBe(e.startDate ?? null); expect(p.endDate).toBe(e.endDate ?? null);
      expect(g.currentSalary).toBe(i.segments.at(-1).monthlySalary);
      expect(p.bankAccountNo).toBe(`0000${e.code.slice(2)}`);
    }
    // NV10 không nhập ngày hiệu lực lương nên lấy ngày bắt đầu làm việc; NV11 nghỉ việc 09/10/2026.
    const nv10 = (await call('GET', `${P}/${list.find((p) => p.code === 'IMNV10')!.employeeId}`)).json();
    expect(nv10.salaryHistory[0]).toMatchObject({ validFrom: '2026-10-15', monthlySalary: '18000000' });
    const nv11 = (await call('GET', `${P}/${list.find((p) => p.code === 'IMNV11')!.employeeId}`)).json();
    expect(nv11.profile).toMatchObject({ endDate: '2026-10-09', siParticipates: false });
  });

  it('nhập lại cùng tệp: mọi nhân viên đã có hồ sơ nên báo lỗi từng dòng và không ghi gì thêm', async () => {
    const res = await upload(await workbook(fromFixture('IM')), 'commit');
    expect(res.statusCode).toBe(409); expect(res.json().error.code).toBe('IMPORT_ERRORS');
    const rows = res.json().error.details as Json[];
    expect(rows.filter((r) => r.message.includes('đã có hồ sơ lương'))).toHaveLength(20);
    expect((await call('GET', `${P}/${(await profilesOf('IMNV01'))[0]!.employeeId}`)).json().allowances).toHaveLength(0); // NV01 không có phụ cấp, NV03 có: dòng phụ cấp trùng không nhân đôi
    const nv03 = (await profilesOf('IMNV03'))[0]!.employeeId;
    expect((await call('GET', `${P}/${nv03}`)).json().allowances).toHaveLength(1);
  });

  it('dòng lỗi được báo theo dòng/cột và không ghi nửa chừng: dòng hợp lệ đứng trước lỗi cũng không được ghi', async () => {
    const good = await newEmployee('ERR1'); const bad = await newEmployee('ERR2'); await newEmployee('ERR3'); await newEmployee('ERR4');
    const buf = await workbook({
      Du_lieu: [
        { employee_code: 'ERR1', base_salary: '8000000', salary_from: '2026-01-01', si_participates: true }, // dòng 4: hợp lệ
        { employee_code: 'KHONG_CO', base_salary: '1', salary_from: '2026-01-01' }, // 5
        { employee_code: 'ERR2', base_salary: '12.5', salary_from: '2026-01-01' }, // 6
        { employee_code: 'ERR4', base_salary: '5000000' }, // 7: có lương mà không có ngày hiệu lực
        { employee_code: 'ERR3', region: 'II' }, // 8: hợp lệ
        { employee_code: 'ERR3', region: 'III' }, // 9: trùng dòng 8
      ],
      Phu_cap: [{ employee_code: 'ERR1', code: 'Sai Ma', name: 'x', amount: '1000' }],
      Nguoi_phu_thuoc: [
        { employee_code: 'ERR1', name: 'Con A', relationship: 'child', from_month: '2026-01', to_month: '2026-06' }, // 4: hợp lệ
        { employee_code: 'ERR1', name: 'Con A', relationship: 'child', from_month: '2026-06' }, // 5: trùng tháng 06 với dòng 4
        { employee_code: 'ERR1', name: 'Con B', relationship: 'child', from_month: '2026-09', to_month: '2026-03' }, // 6: đến tháng nhỏ hơn từ tháng
      ],
    });
    const dry = (await upload(buf, 'validate')).json();
    const res = await upload(buf, 'commit');
    expect(res.statusCode).toBe(409); expect(res.json().error.code).toBe('IMPORT_ERRORS');
    const errs = res.json().error.details as { row: number; column: string; message: string }[];
    const main = (row: number) => errs.filter((e) => e.row === row && !/^(Phụ cấp|Người phụ thuộc):/.test(e.message));
    const tagged = (tag: string, row: number) => errs.filter((e) => e.row === row && e.message.startsWith(`${tag}:`));
    expect(main(4)).toHaveLength(0);
    expect(main(5)[0]!.message).toContain('Không có nhân viên mã "KHONG_CO"');
    expect(main(6).map((e) => e.column)).toEqual(['base_salary']); // 12.5 không phải số nguyên
    expect(main(7)[0]!).toMatchObject({ column: 'salary_from' }); expect(main(7)[0]!.message).toContain('ngày hiệu lực');
    expect(main(8)).toHaveLength(0);
    expect(main(9)[0]!).toMatchObject({ column: 'employee_code', message: 'Trùng với dòng 8' });
    expect(tagged('Phụ cấp', 4)[0]!).toMatchObject({ column: 'code' }); expect(tagged('Phụ cấp', 4)[0]!.message).toContain('Mã phụ cấp');
    expect(tagged('Người phụ thuộc', 4)).toHaveLength(0);
    expect(tagged('Người phụ thuộc', 5)[0]!.message).toContain('đã được tính giảm trừ');
    expect(tagged('Người phụ thuộc', 6)[0]!.message).toContain('Đến tháng');
    expect(dry.errorCount).toBe(errs.length); expect(dry.inserted).toBe(0); // kiểm tra thử báo cùng lỗi
    // Không ghi nửa chừng: dòng hợp lệ đứng trước (ERR1 dòng 4, người phụ thuộc dòng 4, ERR3 dòng 8) cũng không được ghi.
    for (const id of [good, bad]) expect((await call('GET', `${P}/${id}`)).json()).toMatchObject({ profile: null, allowances: [], dependents: [], salaryHistory: [] });
    expect((await profilesOf('ERR')).filter((p) => p.hasProfile)).toHaveLength(0);
  });

  it('tệp sai mẫu bị từ chối; sheet tùy chọn vắng thì chỉ nhập hồ sơ; mẫu tải về có ba sheet', async () => {
    const t = await call('GET', `${P}/import/template.xlsx`);
    expect(t.statusCode).toBe(200); expect(t.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(t.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Du_lieu', 'Phu_cap', 'Nguoi_phu_thuoc', 'Huong_dan']);
    expect(wb.getWorksheet('Du_lieu')!.getRow(1).getCell(1).value).toBe('Mã nhân viên (*)');
    const e = await newEmployee('ONLY1');
    const one = new ExcelJS.Workbook(); const ws = one.addWorksheet('Du_lieu'); ws.addRow(['Mã nhân viên']); ws.addRow(['employee_code']); ws.addRow(['VD']); ws.addRow(['ONLY1']);
    const res = await upload(Buffer.from(await one.xlsx.writeBuffer()), 'commit');
    expect(res.statusCode, res.body).toBe(200); expect(res.json()).toMatchObject({ inserted: 1, allowances: 0, dependents: 0 });
    expect((await call('GET', `${P}/${e}`)).json().profile).toMatchObject({ siParticipates: false, taxResidency: 'resident', payMethod: 'transfer' });
    const wrong = new ExcelJS.Workbook(); const w2 = wrong.addWorksheet('Du_lieu'); w2.addRow(['x']); w2.addRow(['code']); w2.addRow(['a']);
    expect((await upload(Buffer.from(await wrong.xlsx.writeBuffer()), 'validate')).statusCode).toBe(400);
  });
});
