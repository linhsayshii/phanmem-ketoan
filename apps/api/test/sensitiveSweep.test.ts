import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

// GĐ6 Task 14a: quét cờ nhạy cảm. Liệt kê mọi route /api/payroll, /api/tncn, /api/costing, /api/contracts, /api/projects/pnl từ app.printRoutes(),
// gọi từng route bằng người dùng có đủ quyền nhưng thiếu một cờ, và kiểm: route gắn cờ trả 403 (GET) hoặc 400/403 (ghi, thân rỗng), không route nào trả số lương/giá thành.
// Tham số lương là "Dữ liệu minh họa" (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('./fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let tenantId: string;
const ids: Record<string, number | string> = {};
const call = (method: string, url: string, payload?: object, c = owner) => ctx.app.inject({ method: method as 'GET', url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
const ok = async (method: string, url: string, payload?: object): Promise<Json> => {
  const r = await call(method, url, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const userWith = async (flags: string[]) => {
  const username = `sw_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: flags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
};

// Cây app.printRoutes({ commonPrefix: false }): mỗi dòng "<tiền tố cây 4 ký tự mỗi cấp><đoạn đường dẫn> (PHƯƠNG THỨC, ...)". Dựng lại đường dẫn đầy đủ từ độ thụt.
export function listRoutes(tree: string): { method: string; path: string }[] {
  const stack: string[] = []; const out: { method: string; path: string }[] = [];
  for (const line of tree.split('\n')) {
    const i = line.indexOf('/'); if (i < 0) continue;
    const m = /^(\S+)(?: \((.*)\))?$/.exec(line.slice(i)); if (!m) continue;
    stack.length = Math.max(0, i / 4 - 1); stack.push(m[1]!);
    for (const method of (m[2] ?? '').split(', ').filter((x) => x && x !== 'HEAD')) out.push({ method, path: stack.join('') });
  }
  return out;
}
const SCOPE = /^\/api\/(payroll|tncn|costing|contracts)(\/|$)|^\/api\/projects\/pnl$/;
// Không phải số lương: tham số pháp lý (thuế suất, tỷ lệ), nhập/xóa chúng. Mọi route khác của /api/payroll và /api/tncn phải đòi view_salary.
const SALARY_OPEN = /^\/api\/payroll\/params(\/|$)/;
// Giá thành: chạy, xem trước, báo cáo, thu thập chi phí và lãi lỗ hợp đồng/vụ việc đòi view_cost; danh mục đối tượng, định mức (chỉ số lượng), hợp đồng, theo dõi thì không.
const COST_GATED = /^\/api\/costing\/(runs|reports|collect)(\/|$)|^\/api\/contracts\/pnl$|^\/api\/projects\/pnl$/;

const fill = (path: string) => path.replace(/\/([a-z-]+)\/:(\w+)/g, (_m, prev: string, name: string) => `/${prev}/${name === 'employeeId' ? ids.a1 : name === 'year' ? '2026' : name === 'month' ? '3' : name === 'mid' ? '1' : (ids[prev] ?? 1)}`)
  .replace(/:(\w+)/g, (_m, name: string) => (name === 'year' ? '2026' : name === 'month' ? '3' : '1'));
const QUERY = 'year=2026&month=3&from=2026-01-01&to=2026-12-31&asOf=2026-12-31&periodKind=month&period=3&quarter=1&format=json&code=si_ceiling&date=2026-10-31&kind=sale&year2=2026&month2=2&runId=1';

// Số bí mật theo cờ: lương (bảng lương, mức lương, 334/338) và giá thành (giá thành đối tượng, chi phí 622, giá vốn hợp đồng).
const secrets: Record<'view_salary' | 'view_cost', string[]> = { view_salary: [], view_cost: [] };
const has = (body: string, n: string) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(body); // nguyên số, không là một phần số dài hơn
const leaks = (body: string, flag: 'view_salary' | 'view_cost') => secrets[flag].filter((s) => has(body, s));
const allSecrets = () => [...secrets.view_salary, ...secrets.view_cost];

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await setupLedgerTenant(ctx, `SW${Date.now()}`, 'TT99'));
  // Lương: hai nhân viên, tháng 10/2026, bảng lương đã tính và hạch toán (mức lương lẻ để số dễ nhận ra khi rò).
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const dep = Number((await ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dep, kind: 'payroll', role: 'admin' }] });
  const emps: number[] = [];
  for (const [code, salary] of [['A1', '23456789'], ['A2', '31234567']] as const) {
    const id = Number((await ok('POST', '/api/catalogs/employee', { code, name: `Nhân viên ${code}`, department_code: 'QL' })).id); emps.push(id);
    await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: 'resident', contractType: 'long', region: 'I', siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, payMethod: 'transfer', bankAccountNo: `00110${id}` });
    await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2026-01-01', monthlySalary: salary });
  }
  ids.a1 = emps[0]!;
  const cells: Json[] = [];
  for (const e of emps) for (let d = 1; d <= 26; d++) cells.push({ employeeId: e, date: `2026-10-${String(d).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] });
  await ok('PUT', '/api/attendance?year=2026&month=10', { cells });
  const run = await ok('POST', '/api/payroll/runs', { year: 2026, month: 10, employeeIds: emps });
  await ok('POST', `/api/payroll/runs/${run.id}/calculate`);
  await ok('POST', `/api/payroll/runs/${run.id}/post`);
  ids.runs = run.id; ids.structures = run.structureId;
  // Giá thành: tháng 3/2026, NVL xuất 60 × 10.000, 622 = 300.000, 6272 = 100.000.
  for (const [name, body] of [['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }], ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  ids.objects = (await ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' })).id;
  const stock = async (b: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...b }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
  await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
  const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
  const v = await ok('GET', `/api/vouchers/${pxk.id}`);
  await ok('PUT', `/api/vouchers/${pxk.id}`, { version: v.version, lines: [{ lineNo: (v.lines as Json[]).find((l) => l.accountCode === '621')!.lineNo, costObjectCode: 'SP1' }] });
  const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi phí', autoPost: true, lines });
  await pkt('2026-03-10', [{ accountCode: '622', debit: '3123457', credit: '0', costObjectCode: 'SP1' }, { accountCode: '111', debit: '0', credit: '3123457' }]);
  await ok('POST', '/api/costing/runs', { year: 2026, month: 3, params: {} });
  // Hợp đồng bán, có doanh thu, giá vốn và chi phí gắn hợp đồng để lãi lỗ có số.
  ids.contracts = (await ok('POST', '/api/contracts', { code: 'HB1', name: 'Hợp đồng bán', kind: 'sale', partyCode: 'KH001', value: '98765432', status: 'active', accountCode: '511', taxCode: 'V10' })).id;
  await pkt('2026-03-20', [{ accountCode: '632', debit: '5432109', credit: '0', contractCode: 'HB1' }, { accountCode: '111', debit: '0', credit: '5432109' }]);
  // Số bí mật cần không lộ: mọi giá trị ≥ 6 chữ số của bảng lương, mức lương, lợi ích 334 và giá thành.
  const q = async <T>(s: ReturnType<typeof sql<T>>) => (await s.execute(ctx.t.admin)).rows;
  const sal = new Set<string>(); const cost = new Set<string>(['3123457', '5432109', '600000']);
  for (const r of await q(sql<{ v: string }>`SELECT value AS v FROM payroll_line_value WHERE tenant_id = ${tenantId}::uuid`)) sal.add(r.v);
  for (const r of await q(sql<{ v: string }>`SELECT monthly_salary::text AS v FROM employee_salary_history WHERE tenant_id = ${tenantId}::uuid`)) sal.add(r.v);
  for (const r of await q(sql<{ v: string }>`SELECT l.credit::text AS v FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.tenant_id = ${tenantId}::uuid AND a.code IN ('334','3383','3384','3386','3335') AND l.credit > 0`)) sal.add(r.v);
  for (const r of await q(sql<{ v: string }>`SELECT total_cost::text AS v FROM cost_run_object WHERE tenant_id = ${tenantId}::uuid`)) cost.add(r.v);
  const big = (n: Set<string>) => [...n].map((x) => x.split('.')[0]!).filter((x) => /^\d{6,}$/.test(x));
  secrets.view_salary = big(sal); secrets.view_cost = big(cost);
  expect(secrets.view_salary.length).toBeGreaterThan(20); expect(secrets.view_salary).toEqual(expect.arrayContaining(['23456789', '31234567'])); expect(secrets.view_cost.length).toBeGreaterThanOrEqual(3);
});
afterAll(async () => { await ctx.close(); });

// Rà soát toàn nhánh GĐ6 (QĐ #980–#989), chạy trước bộ quét route (bộ đó gọi cả route ghi, hủy hạch toán, xóa tham số): quét thêm nhật ký kiểm toán, sổ cái/sổ chi tiết của TK không phải lương và bước cuối kỳ với lương/giá thành thật.
describe('quét nhật ký kiểm toán, sổ sách và cuối kỳ', () => {
  const others = (flag: string) => ['view_receivable', 'view_payable', 'view_cost', 'view_salary'].filter((f) => f !== flag);
  // Số theo từng nhân viên: dòng 334 của LU (lương, khấu trừ) và chứng từ chi lương (thực lĩnh), cùng mọi giá trị bảng lương.
  const perEmployee = async () => [...new Set((await sql<{ v: string }>`SELECT (l.debit + l.credit)::text AS v FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
      WHERE l.tenant_id = ${tenantId}::uuid AND l.employee_id IS NOT NULL AND v.state = 'posted'`.execute(ctx.t.admin)).rows.map((r) => r.v))].filter((x) => /^\d{6,}$/.test(x));
  let emp: string[] = [];
  beforeAll(async () => {
    const pay = await ok('POST', `/api/payroll/runs/${ids.runs}/pay-voucher`, { kind: 'cash', date: '2026-10-31' });
    await ok('POST', `/api/vouchers/${pay.voucherId}/post`, {});
    await ok('POST', '/api/tncn/returns', { formCode: '05/KK-TNCN', year: 2026, periodKind: 'month', period: 10 });
    emp = await perEmployee(); expect(emp.length).toBeGreaterThanOrEqual(6); // 2 người × (lương, khấu trừ, thực lĩnh)
  });

  it('thiếu view_salary: sổ 6421, 111, 3335, 3388 (JSON, HTML, mọi kiểu sổ cái) không có số theo nhân viên; tổng và số dư như người đủ cờ; đủ cờ thấy số từng người', async () => {
    const cookie = await userWith(others('view_salary'));
    const q = 'from=2026-10-01&to=2026-10-31';
    for (const code of ['6421', '111', '3335', '3388']) for (const url of [`/api/reports/ledgers/detail?accountCode=${code}&${q}`, `/api/reports/ledgers/account?accountCode=${code}&${q}`,
      `/api/reports/ledgers/account?accountCode=${code}&${q}&mode=t`, `/api/reports/ledgers/account?accountCode=${code}&${q}&mode=subaccount`, `/api/reports/ledgers/detail?accountCode=${code}&${q}&format=html`]) {
      const n = await call('GET', url, undefined, cookie); const f = await call('GET', url);
      expect(n.statusCode, `${url}: ${n.body.slice(0, 200)}`).toBe(200);
      const html = url.includes('format=html'); const fmt = (s: string) => (html ? Number(s).toLocaleString('vi-VN') : s);
      expect(emp.filter((s) => (html ? n.body.includes(fmt(s)) : has(n.body, s))), url).toEqual([]);
      if (!html) { const a = n.json(); const b = f.json(); expect([a.totalDebit, a.totalCredit, a.closing], url).toEqual([b.totalDebit, b.totalCredit, b.closing]); }
    }
    const full = (await call('GET', `/api/reports/ledgers/detail?accountCode=6421&${q}`)).body;
    expect(emp.filter((s) => has(full, s)).length, 'đủ cờ: sổ 6421 có đối ứng 334 từng người').toBeGreaterThanOrEqual(2);
  });

  it('nhật ký kiểm toán: thiếu view_salary không thấy số lương (tờ khai 05/KK-TNCN, dòng chứng từ lương); thiếu view_cost không thấy lần chạy giá thành và hỏi thẳng là 403', async () => {
    const noSalary = await userWith(others('view_salary'));
    const all = await call('GET', '/api/audit?size=500', undefined, noSalary); expect(all.statusCode).toBe(200);
    const param = JSON.stringify(fx.params); // tham số lương (giảm trừ gia cảnh...) không phải số lương, nhật ký của chúng không che
    expect(leaks(all.body, 'view_salary').filter((x) => !param.includes(x)), 'danh sách chung').toEqual([]);
    const tr = await call('GET', '/api/audit?entity=tax_return&size=500', undefined, noSalary); expect(tr.statusCode).toBe(200);
    expect(tr.json().rows).toEqual([]); expect(leaks(tr.body, 'view_salary')).toEqual([]);
    expect((await call('GET', '/api/audit?entity=tax_return&size=500')).json().rows.length, 'đủ cờ thấy tờ khai TNCN').toBeGreaterThan(0);
    const noCost = await userWith(others('view_cost'));
    const c = await call('GET', '/api/audit?size=500', undefined, noCost); expect(c.statusCode).toBe(200);
    expect((c.json().rows as Json[]).filter((r) => r.entity === 'cost_run' || r.entity === 'project_alloc_run')).toEqual([]);
    for (const e of ['cost_run', 'project_alloc_run']) {
      const r = await call('GET', `/api/audit?entity=${e}`, undefined, noCost); expect(r.statusCode, e).toBe(403); expect(r.json().error.code).toBe('FORBIDDEN');
    }
    expect((await call('GET', '/api/audit?entity=cost_run')).json().rows.length, 'đủ cờ thấy lần chạy giá thành').toBeGreaterThan(0);
  });

  it('cuối kỳ: kỳ có bảng lương/chi phí giá thành thì bước lương đòi view_salary, bước giá thành đòi view_cost (403, không ghi nhật ký)', async () => {
    const steps = async () => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n);
    const noSalary = await userWith(others('view_salary')); const noCost = await userWith(others('view_cost'));
    const before = await steps();
    const s = await call('POST', '/api/period-close/run', { fiscalYear: 2026, periodNo: 10, step: 'payroll' }, noSalary);
    expect(s.statusCode, s.body).toBe(403); expect(s.json().error.code).toBe('SALARY_FORBIDDEN'); expect(leaks(s.body, 'view_salary')).toEqual([]);
    const c = await call('POST', '/api/period-close/run', { fiscalYear: 2026, periodNo: 3, step: 'product_cost' }, noCost);
    expect(c.statusCode, c.body).toBe(403); expect(c.json().error.code).toBe('FORBIDDEN'); expect(leaks(c.body, 'view_cost')).toEqual([]);
    expect(await steps()).toBe(before);
  });
});

describe('quét cờ nhạy cảm', () => {
  it('liệt kê được route của các tiền tố cần quét', () => {
    const routes = listRoutes(ctx.app.printRoutes({ commonPrefix: false })).filter((r) => SCOPE.test(r.path));
    expect(routes.length).toBeGreaterThan(80);
    for (const p of ['/api/payroll/runs/:id', '/api/payroll/profiles/:employeeId', '/api/tncn/withholding', '/api/costing/reports/card', '/api/contracts/pnl', '/api/projects/pnl'])
      expect(routes.some((r) => r.path === p), p).toBe(true);
  });

  it.each([
    ['view_salary', (p: string) => /^\/api\/(payroll|tncn)(\/|$)/.test(p) && !SALARY_OPEN.test(p), 'SALARY_FORBIDDEN'],
    ['view_cost', (p: string) => COST_GATED.test(p), 'FORBIDDEN'],
  ] as const)('thiếu %s: route gắn cờ trả 403 (GET) hoặc 400/403 (ghi, thân rỗng); không route nào của phạm vi trả số bí mật', async (flag, gated, code) => {
    const cookie = await userWith(['view_receivable', 'view_payable', 'view_cost', 'view_salary'].filter((f) => f !== flag));
    const routes = listRoutes(ctx.app.printRoutes({ commonPrefix: false })).filter((r) => SCOPE.test(r.path));
    const bad: string[] = []; let strict = 0, soft = 0;
    for (const r of routes) {
      const url = fill(r.path) + (r.method === 'GET' ? `?${QUERY}` : '');
      const res = await call(r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, cookie);
      const where = `${r.method} ${r.path} → ${res.statusCode} ${res.body.slice(0, 120)}`;
      if (res.statusCode >= 500) bad.push(`lỗi máy chủ: ${where}`);
      if (leaks(res.body, flag).length) bad.push(`lộ số ${leaks(res.body, flag).slice(0, 3).join(',')}: ${where}`);
      if (!gated(r.path)) continue;
      if (res.statusCode === 403 && res.json().error?.code === code) strict++;
      else if (r.method !== 'GET' && res.statusCode === 400) soft++; // thân rỗng bị lược đồ chặn trước khi tới cờ: không có dữ liệu nào trả về
      else bad.push(`không bị chặn bởi ${flag}: ${where}`);
    }
    expect(bad).toEqual([]);
    expect(strict).toBeGreaterThan(flag === 'view_salary' ? 40 : 8);
    console.log(`${flag}: ${routes.length} route trong phạm vi, ${strict} bị chặn 403, ${soft} ghi bị lược đồ chặn 400`);
  });

  it('có đủ cờ: cùng các route đọc không còn 403 vì cờ (kiểm cờ là điều kiện thật chứ không chặn hết)', async () => {
    const routes = listRoutes(ctx.app.printRoutes({ commonPrefix: false })).filter((r) => SCOPE.test(r.path) && r.method === 'GET' && !r.path.includes(':'));
    let allowed = 0;
    for (const r of routes) {
      const res = await call('GET', `${r.path}?${QUERY}`);
      if (res.statusCode === 200) allowed++;
      expect(res.statusCode, `${r.path}: ${res.body.slice(0, 120)}`).not.toBeGreaterThanOrEqual(500);
    }
    expect(allowed).toBeGreaterThan(15);
    // Chủ sở hữu có cờ thì thấy số thật: bảng lương, giá thành.
    expect((await call('GET', `/api/payroll/runs/${ids.runs}`)).body).toContain('23456789');
    expect(has((await call('GET', '/api/costing/runs/2026/3')).body, '3123457')).toBe(true);
  });

  it('gói xuất cho cơ quan thẩm quyền: thiếu bất kỳ cờ nào là 403, không ghi audit xuất và không chứa số lương hay giá thành', async () => {
    const before = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action IN ('export', 'export_completed')`.execute(ctx.t.admin)).rows[0]!.n);
    for (const flag of ['view_receivable', 'view_payable', 'view_cost', 'view_salary']) {
      const cookie = await userWith(['view_receivable', 'view_payable', 'view_cost', 'view_salary'].filter((f) => f !== flag));
      const res = await call('POST', '/api/export/authority', { from: '2026-01-01', to: '2026-12-31' }, cookie);
      expect(res.statusCode, `thiếu ${flag}: ${res.body.slice(0, 120)}`).toBe(403);
      expect(res.json().error.message).toContain(flag);
      expect(allSecrets().filter((x) => has(res.body, x))).toEqual([]);
    }
    const after = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action IN ('export', 'export_completed')`.execute(ctx.t.admin)).rows[0]!.n);
    expect(after).toBe(before);
    // Hạn chế: nhánh thành công (đủ bốn cờ) dựng PDF bằng Chromium, môi trường không có Chromium nên không kiểm gói zip ở đây (exportAuthority.test.ts kiểm khi có).
  });
});

// GĐ7 gói 1: quét cờ nhạy cảm cho ngân sách, phân tích, phê duyệt, API mobile, nhật ký kiểm toán, chi nhánh, sổ Chứng từ ghi sổ. Liệt kê route từ printRoutes() như bộ quét GĐ6,
// chỉ gọi route đọc (GET) vì route ghi của các phân hệ này xóa/duyệt dữ liệu mà các kiểm thử sau cần; các route ghi nhạy cảm kiểm riêng ở các ca dưới.
describe('quét route GĐ7', () => {
  const GD7 = /^\/api\/(budgets|budget-settings|analytics|approvals|approval-flows|approval-attachments|mobile\/v1|audit|branches|branch-consolidation|voucher-sets)(\/|$)|^\/api\/reports\/(consolidated|books)(\/|$)/;
  const AR = '7777771'; const AP = '8888881'; const REQ = '9999991';
  const g7: Record<string, number | string> = {};
  const without = (flag: string) => ['view_receivable', 'view_payable', 'view_cost', 'view_salary'].filter((f) => f !== flag);
  const months = (v: string) => Array.from({ length: 12 }, () => v);

  beforeAll(async () => {
    // Phải thu 131 và phải trả 331 với số riêng (vế đối ứng khác số để không nhầm với doanh thu, chi phí được phép xem).
    const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Công nợ', autoPost: true, lines });
    const ar = await pkt('2026-05-10', [{ accountCode: '131', partyCode: 'KH001', debit: AR, credit: '0' }, { accountCode: '511', debit: '0', credit: '6000000' }, { accountCode: '3388', debit: '0', credit: '1777771' }]);
    await pkt('2026-05-11', [{ accountCode: '6422', debit: '8000000', credit: '0' }, { accountCode: '3388', debit: '888881', credit: '0' }, { accountCode: '331', partyCode: 'NCC001', debit: '0', credit: AP }]);
    // Sửa diễn giải dòng đã ghi sổ: sinh nhật ký voucher_line mang số 131.
    const v = await ok('GET', `/api/vouchers/${ar.id}`);
    await ok('PUT', `/api/vouchers/${ar.id}`, { version: v.version, lines: [{ lineNo: (v.lines as Json[]).find((l) => l.accountCode === '131')!.lineNo, description: 'sửa diễn giải' }] });
    // Ngân sách đã duyệt: dòng trên TK lương, tiền mặt (có phiếu chi lương), phải thu, phải trả, giá vốn.
    const b = await ok('POST', '/api/budgets', { fiscalYear: 2026, name: 'NS quét cờ', lines: ['334', '111', '131', '331', '632', '642'].map((p) => ({ accountPrefix: p, months: months('1000000') })) });
    await ok('POST', `/api/budgets/${b.id}/approve`);
    const lineOf = (p: string) => (b.lines as Json[]).find((l) => l.accountPrefix === p)!.id as number;
    g7.budgets = b.id; g7.salaryLine = lineOf('334'); g7.cashLine = lineOf('111');
    // Đề nghị thanh toán lương (nháp) của chủ sở hữu.
    g7.approvals = (await ok('POST', '/api/approvals', { kind: 'payment', requestDate: '2026-10-31', payeeName: 'Nguyễn Văn A', reason: 'Lương tháng 10', amountCurrency: REQ, accountCode: '334', payMethod: 'cash' })).id;
  });

  it('liệt kê được route GĐ7 cần quét', () => {
    const routes = listRoutes(ctx.app.printRoutes({ commonPrefix: false })).filter((r) => GD7.test(r.path));
    expect(routes.length).toBeGreaterThan(40);
    for (const p of ['/api/budgets/:id/report', '/api/analytics/overview', '/api/approvals', '/api/mobile/v1/reports/financial/:code', '/api/audit', '/api/branches', '/api/reports/consolidated/:code', '/api/voucher-sets'])
      expect(routes.some((r) => r.path === p), p).toBe(true);
  });

  it.each(['view_salary', 'view_cost', 'view_receivable', 'view_payable'] as const)('thiếu %s: không route đọc GĐ7 nào trả 5xx hay lộ số bí mật của cờ đó', async (flag) => {
    const cookie = await userWith(without(flag));
    const own: Record<string, string[]> = { view_receivable: [AR], view_payable: [AP], view_salary: [...secrets.view_salary, REQ], view_cost: secrets.view_cost };
    const routes = listRoutes(ctx.app.printRoutes({ commonPrefix: false })).filter((r) => GD7.test(r.path) && r.method === 'GET');
    const withIds = (p: string) => p.replace(':lineId', String(g7.salaryLine)).replace('/budgets/:id', `/budgets/${g7.budgets}`).replace('/approvals/:id', `/approvals/${g7.approvals}`);
    const bad: string[] = [];
    for (const r of routes) {
      const res = await call('GET', `${fill(withIds(r.path))}?${QUERY}&box=all`, undefined, cookie);
      const where = `GET ${r.path} → ${res.statusCode} ${res.body.slice(0, 100)}`;
      if (res.statusCode >= 500) bad.push(`lỗi máy chủ: ${where}`);
      const hit = own[flag]!.filter((s) => has(res.body, s));
      if (hit.length) bad.push(`lộ số ${hit.slice(0, 3).join(',')}: ${where}`);
    }
    expect(bad).toEqual([]);
  });

  it('thiếu view_salary: ngân sách TK lương bị chặn, drill tiền mặt không lộ số từng người, đề nghị thanh toán lương ẩn, sao chép thực tế bỏ TK lương', async () => {
    const cookie = await userWith(without('view_salary'));
    for (const url of [`/api/budgets/${g7.budgets}/lines/${g7.salaryLine}/entries?month=10`, `/api/budgets/${g7.budgets}/report?month=10`]) {
      const r = await call('GET', url, undefined, cookie);
      expect(r.statusCode, `${url} ${r.body.slice(0, 100)}`).toBe(403); expect(r.json().error.message).toContain('lương');
    }
    // Báo cáo ngân sách có cả dòng 334 nên bị chặn nguyên: tạo ngân sách chỉ có dòng 111 để kiểm drill.
    const cash = await ok('POST', '/api/budgets', { fiscalYear: 2026, name: 'NS tiền mặt', lines: [{ accountPrefix: '111', months: months('1000000') }] });
    const d = await call('GET', `/api/budgets/${cash.id}/lines/${cash.lines[0].id}/entries`, undefined, cookie);
    expect(d.statusCode, d.body.slice(0, 200)).toBe(200);
    expect(leaks(d.body, 'view_salary')).toEqual([]);
    expect((d.json().rows as Json[]).some((x) => x.description === 'Đã ẩn do thiếu quyền xem lương'), 'dòng chi lương gộp và bỏ diễn giải').toBe(true);
    const full = await call('GET', `/api/budgets/${cash.id}/lines/${cash.lines[0].id}/entries`);
    expect((full.json().rows as Json[]).some((x) => x.description === 'Đã ẩn do thiếu quyền xem lương'), 'đủ cờ: không gộp, không ẩn diễn giải').toBe(false);
    expect((full.json().rows as Json[]).length).toBeGreaterThanOrEqual((d.json().rows as Json[]).length);

    const list = await call('GET', '/api/approvals?box=all', undefined, cookie);
    expect(list.statusCode).toBe(200); expect(has(list.body, REQ)).toBe(false);
    expect((await call('GET', `/api/approvals/${g7.approvals}`, undefined, cookie)).statusCode).toBe(403);
    expect((await call('GET', `/api/approvals/${g7.approvals}`)).statusCode, 'đủ cờ thấy đề nghị').toBe(200);
    const copy = await call('POST', '/api/budgets/copy-actual', { sourceYear: 2026, fiscalYear: 2026, name: 'Sao chép', factor: '1' }, cookie);
    expect(copy.statusCode, copy.body.slice(0, 200)).toBe(201); // TK lương nằm ở loại 3 nên sao chép thực tế (loại 5–8) không chạm; kiểm cờ salary vẫn bật ở canSee
    expect((copy.json().budget.lines as Json[]).some((l) => String(l.accountPrefix).startsWith('334'))).toBe(false);
  });

  it('nhật ký kiểm toán: thiếu view_cost không thấy dòng hàng phiếu kho, tồn đầu kỳ; thiếu view_receivable/view_payable không thấy dòng chứng từ TK 131/331; hỏi thẳng thực thể bị che là 403', async () => {
    const noCost = await userWith(without('view_cost'));
    const c = await call('GET', '/api/audit?size=500', undefined, noCost); expect(c.statusCode).toBe(200);
    expect((c.json().rows as Json[]).filter((r) => ['voucher_item_line', 'opening_stock', 'costing_run', 'landed_cost_alloc'].includes(r.entity))).toEqual([]);
    for (const e of ['voucher_item_line', 'opening_stock', 'costing_run', 'landed_cost_alloc', 'contract']) expect((await call('GET', `/api/audit?entity=${e}`, undefined, noCost)).statusCode, e).toBe(403);
    expect((await call('GET', '/api/audit?entity=voucher_item_line&size=500')).json().rows.length, 'đủ cờ thấy dòng hàng phiếu kho').toBeGreaterThan(0);
    const noAr = await userWith(without('view_receivable')); const noAp = await userWith(without('view_payable'));
    const lineEvents = async (cookie: string, secret: string) => { const r = await call('GET', '/api/audit?entity=voucher_line&size=500', undefined, cookie); expect(r.statusCode, r.body.slice(0, 200)).toBe(200); return (r.json().rows as Json[]).filter((r) => has(JSON.stringify([r.before, r.after]), secret)); };
    expect(await lineEvents(owner, AR), 'đủ cờ thấy nhật ký sửa dòng 131').not.toEqual([]);
    expect(await lineEvents(noAr, AR)).toEqual([]);
    expect(has((await call('GET', '/api/audit?size=500', undefined, noAr)).body, AR)).toBe(false);
    expect(has((await call('GET', '/api/audit?size=500', undefined, noAp)).body, AP)).toBe(false);
  });
});
