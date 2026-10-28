import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

// GĐ7 gói 1 (review trục 6 F1/F2): giao điểm chi nhánh × lương × giá thành.
// Quy tắc đã chốt (xem quyết định 1325): người dùng bị giới hạn chi nhánh chỉ giữ quyền chứng từ, kho, sổ sách (BRANCH_SCOPED_PERMISSIONS) nên không chạy được lương, giá thành, TNCN, hợp đồng;
// chứng từ lương (LU), giá thành (GT) do người không bị giới hạn chạy mang chi nhánh làm việc của người chạy. Người bị giới hạn thấy chứng từ đó khi nó thuộc phạm vi của họ và vẫn bị che số lương theo view_salary.
// Tham số lương là "Dữ liệu minh họa" (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('./fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let tenantId: string; let brA: number; let brB: number;
const call = (method: string, url: string, payload?: object, c = owner) => ctx.app.inject({ method: method as 'GET', url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
const ok = async (method: string, url: string, payload?: object, c = owner): Promise<Json> => {
  const r = await call(method, url, payload, c); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
async function scopedUser(name: string, branches: ('HO' | number)[], flags: string[]) {
  const username = `${name}${Date.now()}`.toLowerCase();
  const { id } = await ok('POST', '/api/users', { username, fullName: name, password: TEST_PASSWORD, roleCode: 'ketoan_truong', sensitiveFlags: flags });
  await ok('PUT', `/api/users/${id}/branch-scope`, { branches });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const ALL = ['view_cost', 'view_receivable', 'view_payable', 'view_salary'];
const has = (body: string, n: string) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(body);
const salaries = ['23456789', '31234567'];
let luVoucher: string; let runId: number; let userA: string; let userANoSalary: string; let userB: string;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `BP${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  for (const [c, n] of [['KH001', 'Khách 1'], ['NCC001', 'NCC 1']]) await ok('POST', '/api/catalogs/party', { code: c, name: n, is_customer: true, is_vendor: true });
  brA = (await ok('POST', '/api/branches', { code: 'CNA', name: 'Chi nhánh A' })).id;
  brB = (await ok('POST', '/api/branches', { code: 'CNB', name: 'Chi nhánh B' })).id;
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const dep = Number((await ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dep, kind: 'payroll', role: 'admin' }] });
  const emps: number[] = [];
  for (const [code, salary] of [['A1', salaries[0]!], ['A2', salaries[1]!]] as const) {
    const id = Number((await ok('POST', '/api/catalogs/employee', { code, name: `Nhân viên ${code}`, department_code: 'QL' })).id); emps.push(id);
    await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: 'resident', contractType: 'long', region: 'I', siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, payMethod: 'transfer', bankAccountNo: `00110${id}` });
    await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2026-01-01', monthlySalary: salary });
  }
  const cells: Json[] = [];
  for (const e of emps) for (let d = 1; d <= 26; d++) cells.push({ employeeId: e, date: `2026-10-${String(d).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] });
  await ok('PUT', '/api/attendance?year=2026&month=10', { cells });
  // Người chạy bảng lương đang làm việc ở chi nhánh A: chứng từ LU mang chi nhánh A.
  await ok('PUT', '/api/me/branch', { branch: brA });
  const run = await ok('POST', '/api/payroll/runs', { year: 2026, month: 10, employeeIds: emps }); runId = run.id;
  await ok('POST', `/api/payroll/runs/${run.id}/calculate`);
  await ok('POST', `/api/payroll/runs/${run.id}/post`);
  luVoucher = (await sql<{ id: string }>`SELECT id::text FROM voucher WHERE tenant_id = ${tenantId}::uuid AND source_doc_type = 'payroll_run' ORDER BY created_at LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
  // Giá thành: phiếu xuất NVL ở chi nhánh B, chạy giá thành khi người chạy làm việc ở trụ sở chính.
  await ok('PUT', '/api/me/branch', { branch: brB });
  for (const [name, body] of [['uom', { code: 'CAI', name: 'Cái' }], ['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }],
    ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }]] as const) await call('POST', `/api/catalogs/${name}`, body);
  await ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
  const stock = async (b: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...b }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
  await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
  const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
  const v = await ok('GET', `/api/vouchers/${pxk.id}`);
  await ok('PUT', `/api/vouchers/${pxk.id}`, { version: v.version, lines: [{ lineNo: (v.lines as Json[]).find((l) => l.accountCode === '621')!.lineNo, costObjectCode: 'SP1' }] });
  await ok('PUT', '/api/me/branch', { branch: 'HO' });
  await ok('POST', '/api/costing/runs', { year: 2026, month: 3, params: {} });
  userA = await scopedUser('ktA', [brA], ALL);
  userANoSalary = await scopedUser('ktAn', [brA], ['view_cost', 'view_receivable', 'view_payable']);
  userB = await scopedUser('ktB', [brB], ALL);
});
afterAll(async () => { await ctx?.close(); });

describe('chi nhánh × lương', () => {
  it('chứng từ lương mang chi nhánh làm việc của người chạy; người dùng chi nhánh khác không thấy, không đọc được theo id', async () => {
    expect((await ok('GET', `/api/vouchers/${luVoucher}/branch`)).branch).toBe(brA);
    expect((await call('GET', `/api/vouchers/${luVoucher}`, undefined, userB)).statusCode).toBe(404);
    expect((await call('GET', `/api/vouchers/${luVoucher}`, undefined, userA)).statusCode).toBe(200);
    const list = await ok('GET', '/api/vouchers?size=500', undefined, userB);
    expect((list.rows as Json[]).some((r) => r.id === luVoucher)).toBe(false);
  });

  it('người dùng chi nhánh B không thấy lương của A ở sổ cái, nhật ký chung, bảng cân đối số phát sinh', async () => {
    const q = 'from=2026-10-01&to=2026-10-31';
    for (const url of [`/api/reports/ledgers/detail?accountCode=334&${q}`, `/api/reports/ledgers/general-journal?${q}`, `/api/reports/ledgers/trial-balance?${q}&splitParty=false`]) {
      const r = await call('GET', url, undefined, userB);
      expect(r.statusCode, `${url} ${r.body.slice(0, 100)}`).toBe(200);
      expect(salaries.filter((s) => has(r.body, s)), url).toEqual([]);
      // Không có dòng nào của chứng từ lương (334 phát sinh trong kỳ) với chi nhánh B.
      expect(r.body, url).not.toMatch(/"accountCode":"334"[^}]*"credit":"[1-9]/);
    }
    const a = await call('GET', `/api/reports/ledgers/detail?accountCode=334&${q}`, undefined, userA);
    expect(a.statusCode, a.body.slice(0, 200)).toBe(200);
    expect(a.json().totalCredit, 'người dùng A đủ cờ lương thấy phát sinh Có 334 của chi nhánh A').not.toBe('0');
  });

  it('thiếu view_salary: người dùng chi nhánh A thấy tổng nhưng không có số lương từng nhân viên; BCTC theo chi nhánh vẫn tính đủ chi phí lương', async () => {
    const q = 'from=2026-10-01&to=2026-10-31';
    const n = await call('GET', `/api/reports/ledgers/general-journal?${q}`, undefined, userANoSalary);
    expect(n.statusCode, n.body.slice(0, 120)).toBe(403); // sổ tổng hợp đòi đủ bốn cờ
    const d = await call('GET', `/api/reports/ledgers/detail?accountCode=334&${q}`, undefined, userANoSalary);
    expect(d.statusCode).toBe(403); expect(d.json().error.message).toContain('lương');
    const b02a = await ok('GET', `/api/reports/financial/B02?${q}&branch=${brA}`, undefined, userA);
    const b02n = await ok('GET', `/api/reports/financial/B02?${q}`, undefined, userANoSalary);
    expect(b02n.rows, 'cùng số liệu B02 dù thiếu view_salary: chi phí lương nằm trong dòng tổng hợp').toEqual(b02a.rows);
    const b02b = await ok('GET', `/api/reports/financial/B02?${q}`, undefined, userB);
    const expense = (r: Json) => (r.rows as Json[]).filter((x) => x.isBold).map((x) => x.current).join(',');
    expect(expense(b02b), 'chi nhánh B không có chi phí lương của A').not.toBe(expense(b02a));
  });

  it('người dùng bị giới hạn không chạm tới lương, TNCN, giá thành, hợp đồng (403 vì thiếu quyền)', async () => {
    for (const [m, url] of [['GET', '/api/payroll/runs'], ['GET', `/api/payroll/runs/${runId}`], ['GET', '/api/payroll/profiles'], ['POST', `/api/payroll/runs/${runId}/post`], ['GET', '/api/tncn/withholding?year=2026&month=10'],
      ['GET', '/api/costing/runs/2026/3'], ['POST', '/api/costing/runs'], ['GET', '/api/costing/objects'], ['GET', '/api/contracts'], ['GET', '/api/contracts/pnl?from=2026-01-01&to=2026-12-31']] as const) {
      for (const c of [userA, userB]) {
        const r = await call(m, url + (m === 'GET' && !url.includes('?') ? '?year=2026&month=10&from=2026-01-01&to=2026-12-31' : ''), m === 'POST' ? { year: 2026, month: 3, params: {} } : undefined, c);
        expect([m, url, r.statusCode]).toEqual([m, url, 403]);
        expect(r.json().error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('nhật ký kiểm toán: người dùng bị giới hạn không có audit.view nên không đọc được nhật ký của hồ sơ lương', async () => {
    expect((await call('GET', '/api/audit?size=50', undefined, userA)).statusCode).toBe(403);
  });
});

describe('chi nhánh × giá thành', () => {
  it('chứng từ giá thành, giá vốn do lần chạy sinh mang chi nhánh làm việc của người chạy (trụ sở chính), không phải chi nhánh phiếu xuất gốc', async () => {
    const rows = (await sql<{ id: string; branch: string | null; t: string }>`SELECT id::text, branch_id::text AS branch, voucher_type AS t FROM voucher WHERE tenant_id = ${tenantId}::uuid AND source_doc_type = 'cost_run'`.execute(ctx.t.admin)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.branch, `${r.t} ${r.id}`).toBeNull();
  });

  it('người dùng chi nhánh B thấy phiếu xuất của B nhưng không thấy giá trị chứng từ giá thành của trụ sở chính; người dùng A không thấy phiếu kho của B', async () => {
    const pxk = (await sql<{ id: string }>`SELECT id::text FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PXK'`.execute(ctx.t.admin)).rows[0]!.id;
    expect((await call('GET', `/api/stock-vouchers/${pxk}`, undefined, userB)).statusCode).toBe(200);
    expect((await call('GET', `/api/stock-vouchers/${pxk}`, undefined, userA)).statusCode).toBe(404);
    const costVoucher = (await sql<{ id: string }>`SELECT id::text FROM voucher WHERE tenant_id = ${tenantId}::uuid AND source_doc_type = 'cost_run' LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
    expect((await call('GET', `/api/vouchers/${costVoucher}`, undefined, userB)).statusCode).toBe(404);
    expect((await call('GET', `/api/vouchers/${costVoucher}`, undefined, userA)).statusCode).toBe(404);
  });
});
