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
