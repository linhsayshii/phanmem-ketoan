import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

// GĐ6 Task 14a: quy tắc soát lỗi lương, giá thành, hợp đồng (migration 0109). Mỗi quy tắc một ca dương tính, một ca âm tính; thiếu cờ nhạy cảm thì bỏ qua.
// Tham số lương là "Dữ liệu minh họa" (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hit = { ruleCode: string; message: string; voucherId: string | null; ref: string | null; detail: string | null };
const fx = JSON.parse(readFileSync(new URL('./fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

async function tenant(regime: 'TT99' | 'TT133' = 'TT99') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `G6${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie): Promise<Json> => {
    const r = await call(method, url, payload, c); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
  };
  const admin = <T>(q: ReturnType<typeof sql<T>>) => q.execute(ctx.t.admin);
  const raw = async (codes: string[], range: { from: string; to: string }, c = cookie) => (await ok('POST', '/api/data-check/run', { ...range, codes }, c));
  const run = async (code: string, range = { from: '2026-01-01', to: '2026-12-31' }): Promise<Hit[]> => {
    const r = await raw([code], range);
    expect(r.skipped, `quy tắc ${code} bị bỏ qua`).toEqual([]);
    return (r.results as Hit[]).filter((x) => x.ruleCode === code);
  };
  const userWith = async (flags: string[]) => {
    const username = `g6_${Math.random().toString(36).slice(2, 8)}`;
    await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: flags });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Bút toán', autoPost: true, lines });
  return { cookie, tenantId, call, ok, admin, raw, run, userWith, pkt };
}
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });

const SALARY = ['LUONG_THIEU_MST', 'LUONG_THIEU_TK_NH', 'LUONG_NV_NGHI_VAN_TINH', 'LUONG_CAN_TINH_LAI', 'LUONG_LECH_SO_CAI', 'LUONG_BH_VUOT_TRAN'];
const COST = ['VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', 'GIA_THANH_CAN_CHAY_LAI', 'GIA_THANH_154_CON_DU', 'GIA_THANH_THIEU_DINH_MUC', 'GIA_THANH_621_622_627_CON_DU', 'GIA_THANH_DAU_RA_KHONG_MA_HANG'];
const CONTRACT = ['HOP_DONG_QUA_HAN_DOT', 'HOP_DONG_VUOT_GIA_TRI'];

describe('cờ nhạy cảm của quy tắc GĐ6', () => {
  it('thiếu view_salary: sáu quy tắc lương bị bỏ qua; thiếu view_cost: năm quy tắc giá thành bị bỏ qua; quy tắc hợp đồng luôn chạy; đủ cờ thì không bỏ qua', async () => {
    const t = await tenant();
    const all = [...SALARY, ...COST, ...CONTRACT]; const range = { from: '2026-01-01', to: '2026-12-31' };
    const none = await t.userWith([]);
    const r0 = await t.raw(all, range, none);
    expect((r0.skipped as { code: string; reason: string }[]).map((x) => x.code).sort()).toEqual([...SALARY, ...COST].sort());
    expect((r0.skipped as { reason: string }[]).filter((x) => x.reason.includes('lương'))).toHaveLength(SALARY.length);
    expect((r0.skipped as { reason: string }[]).filter((x) => x.reason.includes('giá vốn'))).toHaveLength(COST.length);
    expect(r0.ran).toBe(CONTRACT.length);
    const salaryOnly = await t.raw(all, range, await t.userWith(['view_salary']));
    expect((salaryOnly.skipped as { code: string }[]).map((x) => x.code).sort()).toEqual([...COST].sort());
    const costOnly = await t.raw(all, range, await t.userWith(['view_cost']));
    expect((costOnly.skipped as { code: string }[]).map((x) => x.code).sort()).toEqual([...SALARY].sort());
    const full = await t.raw(all, range);
    expect(full.skipped).toEqual([]); expect(full.ran).toBe(all.length);
  });
});

describe('soát lỗi lương', () => {
  let t: Awaited<ReturnType<typeof tenant>>; let a1: number; let a2: number; let runId: number;
  const oct = { from: '2026-10-01', to: '2026-10-31' };
  const sqlOf = (q: ReturnType<typeof sql>) => t.admin(q);
  beforeAll(async () => {
    t = await tenant();
    await t.ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
    for (const [code, value] of Object.entries(fx.params)) await t.ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
    const dep = Number((await t.ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
    await t.ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dep, kind: 'payroll', role: 'admin' }] });
    const mk = async (code: string, extra: object) => {
      const id = Number((await t.ok('POST', '/api/catalogs/employee', { code, name: `Nhân viên ${code}`, department_code: 'QL' })).id);
      await t.ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: 'resident', contractType: 'long', region: 'I', siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, ...extra });
      await t.ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2026-01-01', monthlySalary: '20000000' });
      return id;
    };
    // A1: đủ mã số thuế và tài khoản; A2: chuyển khoản nhưng thiếu cả hai.
    a1 = await mk('A1', { payMethod: 'transfer', bankAccountNo: '0011001234567', bankName: 'Vietcombank' });
    a2 = await mk('A2', { payMethod: 'transfer' });
    await sqlOf(sql`UPDATE employee SET tax_code = '0312345678' WHERE tenant_id = ${t.tenantId}::uuid AND id = ${a1}`);
    const cells: Json[] = [];
    for (const e of [a1, a2]) for (let d = 1; d <= 26; d++) cells.push({ employeeId: e, date: `2026-10-${String(d).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] });
    await t.ok('PUT', '/api/attendance?year=2026&month=10', { cells });
    runId = (await t.ok('POST', '/api/payroll/runs', { year: 2026, month: 10, employeeIds: [a1, a2] })).id;
    await t.ok('POST', `/api/payroll/runs/${runId}/calculate`);
  });

  it('LUONG_THIEU_MST: nhân viên thiếu mã số thuế bị báo; có mã hoặc ngoài khoảng thì không', async () => {
    const hits = await t.run('LUONG_THIEU_MST');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: 'A2', detail: 'Nhân viên A2, kỳ 10/2026, thu nhập chịu thuế 20000000' });
    expect(await t.run('LUONG_THIEU_MST', { from: '2026-01-01', to: '2026-09-30' })).toEqual([]);
    await sqlOf(sql`UPDATE employee SET tax_code = '0312345679' WHERE tenant_id = ${t.tenantId}::uuid AND id = ${a2}`);
    expect(await t.run('LUONG_THIEU_MST')).toEqual([]);
    await sqlOf(sql`UPDATE employee SET tax_code = '  ' WHERE tenant_id = ${t.tenantId}::uuid AND id = ${a2}`); // chỉ có khoảng trắng vẫn là thiếu
    expect(await t.run('LUONG_THIEU_MST')).toHaveLength(1);
    await sqlOf(sql`UPDATE employee SET tax_code = '0312345679' WHERE tenant_id = ${t.tenantId}::uuid AND id = ${a2}`);
  });

  it('LUONG_THIEU_TK_NH: chuyển khoản thiếu số tài khoản bị báo; đổi sang tiền mặt hoặc khai số tài khoản thì không', async () => {
    const hits = await t.run('LUONG_THIEU_TK_NH');
    expect(hits.map((x) => x.ref)).toEqual(['A2']);
    expect(hits[0]!.detail).toBe('Nhân viên A2, có bảng lương từ kỳ 10/2026');
    await sqlOf(sql`UPDATE employee_payroll SET pay_method = 'cash' WHERE tenant_id = ${t.tenantId}::uuid AND employee_id = ${a2}`);
    expect(await t.run('LUONG_THIEU_TK_NH')).toEqual([]);
    await sqlOf(sql`UPDATE employee_payroll SET pay_method = 'transfer', bank_account_no = '999' WHERE tenant_id = ${t.tenantId}::uuid AND employee_id = ${a2}`);
    expect(await t.run('LUONG_THIEU_TK_NH')).toEqual([]);
  });

  it('LUONG_NV_NGHI_VAN_TINH: nghỉ việc trước đầu tháng của bảng lương bị báo; nghỉ cuối tháng hoặc chưa nghỉ thì không', async () => {
    expect(await t.run('LUONG_NV_NGHI_VAN_TINH')).toEqual([]);
    await sqlOf(sql`UPDATE employee_payroll SET end_date = '2026-10-31' WHERE tenant_id = ${t.tenantId}::uuid AND employee_id = ${a1}`);
    expect(await t.run('LUONG_NV_NGHI_VAN_TINH')).toEqual([]);
    await sqlOf(sql`UPDATE employee_payroll SET end_date = '2026-09-30' WHERE tenant_id = ${t.tenantId}::uuid AND employee_id = ${a1}`);
    const hits = await t.run('LUONG_NV_NGHI_VAN_TINH');
    expect(hits.map((x) => x.ref)).toEqual(['A1']);
    expect(hits[0]!.detail).toBe('Nhân viên A1, nghỉ việc 30/09/2026, vẫn có lương kỳ 10/2026');
    await sqlOf(sql`UPDATE employee_payroll SET end_date = NULL WHERE tenant_id = ${t.tenantId}::uuid AND employee_id = ${a1}`);
  });

  it('LUONG_BH_VUOT_TRAN: lương đóng vượt trần theo tham số bị báo; trong trần, thiếu tham số thì không', async () => {
    expect(await t.run('LUONG_BH_VUOT_TRAN')).toEqual([]);
    const setBase = (code: string, v: string) => sqlOf(sql`UPDATE payroll_line_value SET value = ${v} WHERE tenant_id = ${t.tenantId}::uuid AND column_code = ${code}
      AND line_id = (SELECT id FROM payroll_line WHERE tenant_id = ${t.tenantId}::uuid AND run_id = ${runId} AND employee_id = ${a1})`);
    await setBase('si_base', '60000000'); // trần BHXH 50.600.000
    let hits = await t.run('LUONG_BH_VUOT_TRAN');
    expect(hits.map((x) => x.ref)).toEqual(['A1']);
    expect(hits[0]!.detail).toBe('Nhân viên A1, kỳ 10/2026: lương đóng BHXH, BHYT 60000000 vượt trần 50600000');
    await setBase('si_base', '20000000'); await setBase('ui_base', '110000000'); // trần BHTN = 20 × 5.310.000 = 106.200.000 (vùng I)
    hits = await t.run('LUONG_BH_VUOT_TRAN');
    expect(hits[0]!.detail).toBe('Nhân viên A1, kỳ 10/2026: lương đóng BHTN 110000000 vượt trần 106200000');
    await sqlOf(sql`DELETE FROM payroll_param WHERE tenant_id = ${t.tenantId}::uuid AND code = 'si_ceiling'`); // không có tham số trần: không báo
    expect(await t.run('LUONG_BH_VUOT_TRAN')).toEqual([]);
    await setBase('ui_base', '20000000');
    await t.ok('PUT', '/api/payroll/params', { code: 'si_ceiling', validFrom: '2024-01-01', value: fx.params.si_ceiling, source: fx.source }); // trả lại tham số (chữ ký bảng lương phụ thuộc tham số)
  });

  it('LUONG_CAN_TINH_LAI và LUONG_LECH_SO_CAI: bảng sạch thì không báo; đổi lương sau khi tính → cần tính lại; sổ cái lệch thực lĩnh → lệch', async () => {
    expect(await t.run('LUONG_CAN_TINH_LAI')).toEqual([]);
    expect(await t.run('LUONG_LECH_SO_CAI')).toEqual([]); // bảng chưa hạch toán: không so
    await t.ok('POST', `/api/payroll/runs/${runId}/post`);
    expect(await t.run('LUONG_CAN_TINH_LAI')).toEqual([]);
    expect(await t.run('LUONG_LECH_SO_CAI')).toEqual([]);
    // 334 theo nhân viên = Có gross − Nợ khấu trừ = thực lĩnh; sửa thực lĩnh trong bảng lương (mô phỏng lệch) thì báo đúng nhân viên.
    await sqlOf(sql`UPDATE payroll_line SET net = net + 1000 WHERE tenant_id = ${t.tenantId}::uuid AND run_id = ${runId} AND employee_id = ${a2}`);
    const lech = await t.run('LUONG_LECH_SO_CAI');
    expect(lech.map((x) => x.ref)).toEqual(['A2']);
    expect(lech[0]!.voucherId).not.toBeNull(); expect(lech[0]!.detail).toMatch(/^Nhân viên A2, kỳ 10\/2026: bảng lương \d+, sổ cái \d+$/);
    await sqlOf(sql`UPDATE payroll_line SET net = net - 1000 WHERE tenant_id = ${t.tenantId}::uuid AND run_id = ${runId} AND employee_id = ${a2}`);
    expect(await t.run('LUONG_LECH_SO_CAI')).toEqual([]);
    // Đổi mức lương hiệu lực trong kỳ sau khi tính: chữ ký đầu vào đổi.
    await sqlOf(sql`INSERT INTO employee_salary_history(tenant_id, employee_id, valid_from, monthly_salary) VALUES (${t.tenantId}::uuid, ${a1}, '2026-10-01', 25000000)`); // API chặn khi bảng đã tính
    const stale = await t.run('LUONG_CAN_TINH_LAI');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toMatch(/^Kỳ 10\/2026: 1 nhân viên/);
    expect(await t.run('LUONG_CAN_TINH_LAI', { from: '2026-01-01', to: '2026-09-30' })).toEqual([]);
    expect((await t.run('LUONG_CAN_TINH_LAI', oct))).toHaveLength(1);
  });
});

describe('soát lỗi giá thành', () => {
  let t: Awaited<ReturnType<typeof tenant>>;
  const stock = async (body: object) => { const v = await t.ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); return t.ok('POST', `/api/vouchers/${v.id}/post`, {}); };
  const step = (periodNo: number, s: string) => t.ok('POST', '/api/period-close/run', { fiscalYear: 2026, periodNo, step: s });
  const costRun = (month: number, params: object = {}) => t.ok('POST', '/api/costing/runs', { year: 2026, month, params });
  const closeOk = (periodNo: number) => t.admin(sql`INSERT INTO period_close_log(tenant_id, fiscal_year, period_no, step, ran_at, ok, summary) VALUES (${t.tenantId}::uuid, 2026, ${periodNo}, 'closing', clock_timestamp(), true, '{}'::jsonb)`);
  const m = (mo: number) => ({ from: `2026-${String(mo).padStart(2, '0')}-01`, to: `2026-${String(mo).padStart(2, '0')}-${mo === 3 || mo === 5 ? '31' : '30'}` });
  beforeAll(async () => {
    t = await tenant();
    for (const [name, body] of [['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }], ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
      ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }], ['project', { code: 'P1', name: 'Công trình 1' }]] as const)
      await t.ok('POST', `/api/catalogs/${name}`, body);
    await t.ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
    await t.ok('POST', '/api/costing/objects', { code: 'CT1', name: 'Công trình 1', kind: 'project', projectCode: 'P1' });
    // Tháng 3: mua NVL, xuất 60 cho SP1 (621), 622, 6272, nhập thành phẩm 6 cái.
    await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
    const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
    const v = await t.ok('GET', `/api/vouchers/${pxk.id}`);
    await t.ok('PUT', `/api/vouchers/${pxk.id}`, { version: v.version, lines: [{ lineNo: (v.lines as Json[]).find((l) => l.accountCode === '621')!.lineNo, costObjectCode: 'SP1' }] });
    await t.pkt('2026-03-10', [L('622', '300000', '0', { costObjectCode: 'SP1' }), L('111', '0', '300000')]);
    await t.pkt('2026-03-15', [L('6272', '100000', '0', { costObjectCode: 'SP1' }), L('111', '0', '100000')]);
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-03-20', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '6', unitPrice: '100000' }] });
  });

  it('GIA_THANH_THIEU_DINH_MUC: sản phẩm có chi phí NVL mà chưa có định mức bị báo; khai định mức (theo sản phẩm hoặc đối tượng) thì không', async () => {
    expect(await t.run('GIA_THANH_THIEU_DINH_MUC', m(3))).toEqual([]); // chưa chạy giá thành: không có đối tượng nào
    await costRun(3);
    const hits = await t.run('GIA_THANH_THIEU_DINH_MUC', m(3));
    expect(hits.map((x) => x.ref)).toEqual(['SP1']);
    expect(hits[0]!.detail).toBe('Kỳ 03/2026: chi phí nguyên vật liệu 600000, chưa có định mức');
    expect(await t.run('GIA_THANH_THIEU_DINH_MUC', m(4))).toEqual([]);
    await t.ok('POST', '/api/costing/norms', { itemCode: 'TP1', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '10' }] });
    expect(await t.run('GIA_THANH_THIEU_DINH_MUC', m(3))).toEqual([]);
  });

  it('GIA_THANH_154_CON_DU: chưa có giá vốn thì không báo; sau giá vốn 154 = dở dang thì không báo; dư 154 ngoài dở dang thì báo', async () => {
    expect(await t.run('GIA_THANH_154_CON_DU', m(3))).toEqual([]); // chưa có GV của tháng
    await step(3, 'costing');
    expect(await t.run('GIA_THANH_154_CON_DU', m(3))).toEqual([]);
    await t.pkt('2026-03-28', [L('154', '50000', '0', { costObjectCode: 'SP1' }), L('111', '0', '50000')]);
    const hits = await t.run('GIA_THANH_154_CON_DU', m(3));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: 'TK 154', detail: 'Dư 50000, dở dang cuối theo giá thành 0' });
    expect(await t.run('GIA_THANH_154_CON_DU', m(4))).toEqual([]); // tháng 4 chưa có GV
  });

  it('GIA_THANH_621_622_627_CON_DU và GIA_THANH_CAN_CHAY_LAI: chi phí chưa vào giá thành ở kỳ đã kết chuyển bị báo; chạy giá thành rồi thì không; thêm chi phí sau khi chạy → cần chạy lại', async () => {
    await t.pkt('2026-04-10', [L('622', '70000', '0', { costObjectCode: 'SP1' }), L('111', '0', '70000')]);
    expect(await t.run('GIA_THANH_621_622_627_CON_DU', m(4))).toEqual([]); // kỳ chưa kết chuyển
    await closeOk(4);
    const hits = await t.run('GIA_THANH_621_622_627_CON_DU', m(4));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: 'Kỳ 4/2026', detail: 'Dư Nợ 70000 trên TK 621, 622, 623, 627 cuối kỳ' });
    expect(await t.run('GIA_THANH_CAN_CHAY_LAI', m(4))).toEqual([]); // chưa có lần chạy
    await costRun(4);
    expect(await t.run('GIA_THANH_621_622_627_CON_DU', m(4))).toEqual([]);
    expect(await t.run('GIA_THANH_CAN_CHAY_LAI', m(4))).toEqual([]);
    await t.pkt('2026-04-20', [L('622', '30000', '0', { costObjectCode: 'SP1' }), L('111', '0', '30000')]);
    const stale = await t.run('GIA_THANH_CAN_CHAY_LAI', m(4));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ ref: 'Giá thành kỳ 04/2026', detail: 'Chi phí, nhập kho thành phẩm hoặc dở dang kỳ trước đã đổi sau lần chạy' });
    expect(stale[0]!.voucherId).not.toBeNull();
    expect(await t.run('GIA_THANH_CAN_CHAY_LAI', m(5))).toEqual([]); // ngoài khoảng
    await costRun(4);
    expect(await t.run('GIA_THANH_CAN_CHAY_LAI', m(4))).toEqual([]);
  });

  it('GIA_THANH_DAU_RA_KHONG_MA_HANG: công trình hoàn thành còn dư 154 bị báo; kết chuyển giá vốn Nợ 632 / Có 154 thì không; chưa hoàn thành thì không', async () => {
    await t.pkt('2026-05-10', [L('622', '200000', '0', { projectCode: 'P1', costObjectCode: 'CT1' }), L('111', '0', '200000')]);
    await costRun(5, { objects: [{ objectCode: 'CT1', method: 'project', completed: false }] });
    expect(await t.run('GIA_THANH_DAU_RA_KHONG_MA_HANG', m(5))).toEqual([]); // chưa hoàn thành
    await costRun(5, { objects: [{ objectCode: 'CT1', method: 'project', completed: true }] });
    const hits = await t.run('GIA_THANH_DAU_RA_KHONG_MA_HANG', m(5));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: 'CT1', detail: 'Đã hoàn thành (kỳ 05/2026), TK 154 còn dư 200000' });
    await t.pkt('2026-05-31', [L('632', '200000', '0', { projectCode: 'P1' }), L('154', '0', '200000', { projectCode: 'P1' })]);
    expect(await t.run('GIA_THANH_DAU_RA_KHONG_MA_HANG', m(5))).toEqual([]);
  });

  it('GIA_THANH_DAU_RA_KHONG_MA_HANG: kết chuyển giá vốn bằng chứng từ GT của 13c (POST /api/projects/alloc, kind cogs) thì hết báo', async () => {
    const jul = { from: '2026-07-01', to: '2026-07-31' };
    await t.ok('POST', '/api/catalogs/project', { code: 'P2', name: 'Công trình 2' }); // vụ việc sạch: không dính dư 154 của ca tháng 5
    await t.ok('POST', '/api/costing/objects', { code: 'CT2', name: 'Công trình 2', kind: 'project', projectCode: 'P2' });
    await t.pkt('2026-07-10', [L('622', '300000', '0', { projectCode: 'P2', costObjectCode: 'CT2' }), L('111', '0', '300000')]);
    await costRun(7, { objects: [{ objectCode: 'CT2', method: 'project', completed: true }] });
    expect((await t.run('GIA_THANH_DAU_RA_KHONG_MA_HANG', jul)).map((x) => x.detail)).toEqual(['Đã hoàn thành (kỳ 07/2026), TK 154 còn dư 300000']);
    const cogs = await t.ok('POST', '/api/projects/alloc', { kind: 'cogs', year: 2026, month: 7, params: { projectCodes: ['P2'] } });
    expect(cogs.status).toBe('posted');
    expect(await t.run('GIA_THANH_DAU_RA_KHONG_MA_HANG', jul)).toEqual([]);
  });
});

describe('soát lỗi vụ việc', () => {
  const sevenMar = { from: '2026-03-01', to: '2026-03-31' };
  const setup = async (regime: 'TT99' | 'TT133', projects: string[]) => {
    const t = await tenant(regime);
    for (const code of projects) await t.ok('POST', '/api/catalogs/project', { code, name: `Công trình ${code}` });
    return t;
  };
  const rev = (t: Awaited<ReturnType<typeof tenant>>) => t.pkt('2026-03-10', [L('111', '100000000', '0'), L('511', '0', '100000000', { projectCode: 'P1' })]);

  it('TT99: chi phí 641/642 chưa gắn vụ việc bị báo khi có vụ việc đang hoạt động; phân bổ đủ thì hết; chi phí thêm sau phân bổ báo lại; tháng khác và tổng bằng 0 không báo', async () => {
    const t = await setup('TT99', ['P1', 'P2']);
    await rev(t);
    await t.pkt('2026-03-20', [L('6411', '1000000', '0'), L('6421', '500000', '0'), L('111', '0', '1500000')]);
    const hits = await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', sevenMar);
    expect(hits.map((x) => [x.ref, x.detail])).toEqual([['641', 'Kỳ 03/2026: chi phí bán hàng chưa phân bổ vào vụ việc 1000000 (2 vụ việc đang hoạt động)'], ['642', 'Kỳ 03/2026: chi phí quản lý doanh nghiệp chưa phân bổ vào vụ việc 500000 (2 vụ việc đang hoạt động)']]);
    expect(await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', { from: '2026-04-01', to: '2026-04-30' })).toEqual([]);
    await t.ok('POST', '/api/projects/alloc', { kind: 'alloc', year: 2026, month: 3, params: { basis: 'revenue' } });
    expect(await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', sevenMar)).toEqual([]);
    await t.pkt('2026-03-25', [L('6411', '200000', '0'), L('111', '0', '200000')]);
    expect((await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', sevenMar)).map((x) => x.detail)).toEqual(['Kỳ 03/2026: chi phí bán hàng chưa phân bổ vào vụ việc 200000 (2 vụ việc đang hoạt động)']);
    // Khoảng nhiều tháng: mỗi tháng một dòng.
    await t.pkt('2026-05-20', [L('6421', '300000', '0'), L('111', '0', '300000')]);
    expect((await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO')).map((x) => x.detail?.slice(0, 10))).toEqual(['Kỳ 03/2026', 'Kỳ 05/2026']);
  });

  it('TT133: nhóm 6421/6422 theo chế độ; không vụ việc hoạt động (chưa có hoặc đã ngừng) thì không báo', async () => {
    const none = await setup('TT133', []);
    await none.pkt('2026-03-20', [L('6421', '700000', '0'), L('1111', '0', '700000')]);
    expect(await none.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', sevenMar)).toEqual([]);
    const t = await setup('TT133', ['P1']);
    await t.pkt('2026-03-20', [L('6421', '700000', '0'), L('6422', '100000', '0'), L('1111', '0', '800000')]);
    expect((await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', sevenMar)).map((x) => x.ref)).toEqual(['6421', '6422']);
    await t.admin(sql`UPDATE project SET is_active = false WHERE tenant_id = ${t.tenantId}::uuid`);
    expect(await t.run('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', sevenMar)).toEqual([]);
  });
});

describe('soát lỗi hợp đồng', () => {
  let t: Awaited<ReturnType<typeof tenant>>; let seq = 0;
  const M = (x: number) => String(x * 1_000_000);
  const hdb = (contractCode: string, amount: number, date: string) => ({ voucherType: 'HDB', postingDate: date, documentDate: date, partyCode: 'KH001', contractCode, autoPost: true,
    items: [{ description: 'Dịch vụ', accountCode: '511', amountCurrency: M(amount), taxCodes: ['V10'] }], invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: date, invoiceGroupCode: '10' } });
  beforeAll(async () => { t = await tenant(); });

  it('HOP_DONG_QUA_HAN_DOT: đợt quá hạn chưa lập hóa đơn bị báo; lập hóa đơn đã ghi sổ, đợt chưa đến hạn hoặc ngoài khoảng thì không', async () => {
    const c = (await t.ok('POST', '/api/contracts', { code: 'HB1', name: 'Hợp đồng bán 1', kind: 'sale', partyCode: 'KH001', value: M(100), status: 'active', accountCode: '511', taxCode: 'V10' })).id;
    const ms = (await t.ok('PUT', `/api/contracts/${c}/milestones`, { milestones: [{ seq: 1, description: 'Tạm ứng', dueDate: '2026-01-31', amount: M(30) },
      { seq: 2, description: 'Nghiệm thu', dueDate: '2099-01-01', amount: M(70) }] })).milestones;
    const wide = { from: '2026-01-01', to: '2099-12-31' };
    const hits = await t.run('HOP_DONG_QUA_HAN_DOT', wide);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: 'HB1', detail: 'Đợt 1 (Tạm ứng) dự kiến 31/01/2026, số tiền 30000000' });
    expect(await t.run('HOP_DONG_QUA_HAN_DOT', { from: '2026-03-01', to: '2026-12-31' })).toEqual([]);
    const inv = await t.ok('POST', `/api/contracts/${c}/milestones/${ms[0].id}/invoice`, { postingDate: '2026-02-10', invoiceGroupCode: '10', invoiceNo: 'D1' });
    expect(await t.run('HOP_DONG_QUA_HAN_DOT', wide)).toHaveLength(1); // hóa đơn còn nháp: vẫn quá hạn
    await t.ok('POST', `/api/vouchers/${inv.invoice.id}/post`, {});
    expect(await t.run('HOP_DONG_QUA_HAN_DOT', wide)).toEqual([]);
  });

  it('HOP_DONG_VUOT_GIA_TRI: hóa đơn vượt giá trị bị báo; phụ lục tăng giá trị hoặc đến ngày chưa vượt thì không', async () => {
    await t.ok('POST', '/api/contracts', { code: 'HB2', name: 'Hợp đồng bán 2', kind: 'sale', partyCode: 'KH001', value: M(10), status: 'active', accountCode: '511', taxCode: 'V10' });
    await t.ok('POST', '/api/invoices', hdb('HB2', 6, '2026-03-10'));
    expect(await t.run('HOP_DONG_VUOT_GIA_TRI')).toEqual([]);
    await t.ok('POST', '/api/invoices', hdb('HB2', 6, '2026-06-10'));
    const hits = await t.run('HOP_DONG_VUOT_GIA_TRI');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: 'HB2', detail: 'Hóa đơn 12000000 vượt giá trị 10000000 (đã gồm phụ lục)' });
    expect(await t.run('HOP_DONG_VUOT_GIA_TRI', { from: '2026-01-01', to: '2026-04-30' })).toEqual([]); // đến 30/4 mới xuất 6 triệu
    const id = (await t.admin(sql<{ id: number }>`SELECT id::int FROM contract WHERE tenant_id = ${t.tenantId}::uuid AND code = 'HB2'`)).rows[0]!.id;
    await t.ok('PUT', `/api/contracts/${id}/amendments`, { amendments: [{ seq: 1, signedDate: '2026-05-01', description: 'Bổ sung', valueChange: M(5) }] });
    expect(await t.run('HOP_DONG_VUOT_GIA_TRI')).toEqual([]); // 15 triệu ≥ 12 triệu
    expect((await t.run('HOP_DONG_VUOT_GIA_TRI', { from: '2026-01-01', to: '2026-04-30' }))).toEqual([]);
  });
});
