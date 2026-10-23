import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Step = { failed: boolean; key: string; status: string; reason: string | null; lastRunAt: string | null };

// Năm 2026 TT133 (12 kỳ tháng); một TSCĐ TS01 nguyên giá 120.000.000, 60 tháng từ 01/01/2026.
async function tenant(regime: 'TT133' | 'TT99' = 'TT133') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `CK${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  const pkt = (date: string, lines: object[]) => ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'mua tài sản', autoPost: true, lines }), 201);
  const asset = async () => {
    const a = await ok(call('POST', '/api/assets', { code: 'TS01', name: 'TSCĐ 01', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', depreciationStartDate: '2026-01-01', lifeUnits: 60 }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
    await pkt('2026-01-01', [{ accountCode: '2111', debit: '120000000', credit: '0', assetCode: 'TS01' }, { accountCode: '331', debit: '0', credit: '120000000', partyCode: 'NCC001' }]);
  };
  const step = (r: Res | { steps: Step[] }, key: string) => ('steps' in r ? r.steps : r.json().steps as Step[]).find((s) => s.key === key)!;
  const run = (stepKey: string, periodNo = 1, extra: object = {}) => call('POST', '/api/period-close/run', { fiscalYear: 2026, periodNo, step: stepKey, ...extra });
  const status = (periodNo = 1) => ok(call('GET', `/api/period-close/2026/${periodNo}`)) as Promise<{ steps: Step[]; nextStep: string | null }>;
  const logRaw = (step: string, ok: boolean, summary: object) => sql`INSERT INTO period_close_log(tenant_id, fiscal_year, period_no, step, ran_at, ok, summary) VALUES (${tenantId}::uuid, 2026, 1, ${step}, clock_timestamp(), ${ok}, ${JSON.stringify(summary)}::jsonb)`.execute(ctx.t.admin);
  return { logRaw, cookie, call, ok, pkt, asset, step, run, status };
}

describe('quy trình cuối kỳ có thứ tự', () => {
  it('kỳ mới: nextStep = tool; chạy tool, prepaid, depreciation → ba bước done', async () => {
    const t = await tenant(); await t.asset();
    const s0 = await t.status(); expect(s0.nextStep).toBe('tool');
    expect(s0.steps.map((s) => s.key)).toEqual(['tool', 'prepaid', 'depreciation', 'loan_interest', 'amortization', 'costing', 'fx_outflow', 'fx_revaluation', 'vat_offset', 'closing']);
    for (const k of ['tool', 'prepaid', 'depreciation']) { const r = await t.run(k); expect(r.statusCode, r.body).toBe(200); }
    const s1 = await t.status();
    expect(s1.steps.slice(0, 3).map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(s1.nextStep).toBe('loan_interest');
    const dep = (await t.status()).steps[2]!;
    expect(dep.lastRunAt).not.toBeNull();
    const r = (await t.run('depreciation')).json();
    expect(r.steps[2].vouchers).toHaveLength(1); // chứng từ khấu hao để mở từ màn hình
  });

  it('chạy lại tool sau depreciation → depreciation có status rerun, reason nêu bước trước chạy sau', async () => {
    const t = await tenant(); await t.asset();
    const a = await t.ok(t.call('POST', '/api/assets', { code: 'CC01', name: 'Máy khoan', kind: 'tool', assetAccountCode: '242', depreciationStartDate: '2026-01-05', lifeUnits: 3 }), 201);
    await t.ok(t.call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
    for (const k of ['tool', 'prepaid', 'depreciation']) await t.run(k);
    // dữ liệu CCDC đổi (mua thêm ghi lùi) nên chạy lại tool có thay đổi thật
    await t.pkt('2026-01-05', [{ accountCode: '242', debit: '6000000', credit: '0', assetCode: 'CC01' }, { accountCode: '331', debit: '0', credit: '6000000', partyCode: 'NCC001' }]);
    const r = await t.run('tool'); expect(r.statusCode, r.body).toBe(200);
    const dep = t.step(r, 'depreciation');
    expect(dep.status).toBe('rerun'); expect(dep.reason).toContain('Phân bổ công cụ dụng cụ');
    expect(t.step(r, 'tool').status).toBe('done');
    expect(r.json().nextStep).toBe('prepaid');
  });

  it('ghi lùi chứng từ Nợ 2111 tài sản vào kỳ sau khi khấu hao → depreciation rerun', async () => {
    const t = await tenant(); await t.asset();
    // chạy bằng màn hình cũ vẫn ghi nhật ký
    await t.ok(t.call('POST', '/api/asset-runs', { kind: 'depreciation', fiscalYear: 2026, periodNo: 1 }));
    expect(t.step(await (async () => ({ steps: (await t.status()).steps }))(), 'depreciation').status).toBe('done');
    await t.pkt('2026-01-20', [{ accountCode: '2111', debit: '60000000', credit: '0', assetCode: 'TS01' }, { accountCode: '331', debit: '0', credit: '60000000', partyCode: 'NCC001' }]);
    const dep = (await t.status()).steps[2]!;
    expect(dep.status).toBe('rerun'); expect(dep.reason).toContain('Số liệu tài sản');
  });

  it('chạy kết chuyển qua /api/closing/run-all vẫn ghi nhật ký bước closing', async () => {
    const t = await tenant();
    await t.pkt('2026-01-10', [{ accountCode: '1111', debit: '900', credit: '0' }, { accountCode: '5113', debit: '0', credit: '900' }]);
    expect((await t.status()).steps[9]!.status).toBe('pending');
    await t.ok(t.call('POST', '/api/closing/run-all', { postingDate: '2026-01-31' }));
    const c = (await t.status()).steps[9]!;
    expect(c.status).toBe('done');
    // ngày giữa kỳ không phải bước cuối kỳ
    await t.ok(t.call('POST', '/api/closing/run-all', { postingDate: '2026-02-15' }));
    expect((await t.status(2)).steps[9]!.status).toBe('pending');
  });

  it('người thiếu loan.run chạy bước loan_interest → 403 FORBIDDEN nêu quyền', async () => {
    const t = await tenant();
    const username = `ck_vien_${Date.now()}`;
    await t.ok(t.call('POST', '/api/users', { username, fullName: 'KT viên', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] }), 201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    const r = await t.call('POST', '/api/period-close/run', { fiscalYear: 2026, periodNo: 1, step: 'loan_interest' }, c);
    expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('FORBIDDEN'); expect(r.json().error.message).toContain('loan.run');
  });

  it('bỏ qua bước tùy chọn: fx_revaluation → skipped_empty và nextStep đi tiếp; bước bắt buộc không bỏ qua được', async () => {
    const t = await tenant();
    const bad = await t.run('tool', 1, { skip: true }); expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('STEP_NOT_OPTIONAL');
    const r = await t.run('fx_revaluation', 1, { skip: true }); expect(r.statusCode, r.body).toBe(200);
    expect(t.step(r, 'fx_revaluation').status).toBe('skipped_empty');
  });

  it('chạy lại bước không đổi gì (unchanged) không làm các bước sau thành rerun', async () => {
    const t = await tenant(); await t.asset();
    for (const k of ['tool', 'prepaid', 'depreciation']) await t.run(k);
    const r = await t.run('tool'); expect(r.statusCode, r.body).toBe(200);
    expect(t.step(r, 'depreciation').status).toBe('done'); expect(t.step(r, 'prepaid').status).toBe('done');
    expect(r.json().nextStep).toBe('loan_interest');
  });

  it('giá vốn: nhập ghi lùi sau khi tính → costing rerun (stock_cost_state.stale_from)', async () => {
    const t = await tenant();
    for (const [name, payload] of [['warehouse', { code: 'K1', name: 'Kho K1', inventory_account_code: '156', costing_method: 'avg_period' }], ['item', { code: 'H1', name: 'Hàng H1', base_uom_code: 'CAI', kind: 'goods', tracking: 'none' }]] as const)
      await t.ok(t.call('POST', `/api/catalogs/${name}`, payload), 201);
    const pnk = async (date: string) => { const v = await t.ok(t.call('POST', '/api/stock-vouchers', { description: 'Nhập', voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'H1', uomCode: 'CAI', quantity: '10', unitPrice: '10' }] }), 201);
      await t.ok(t.call('POST', `/api/vouchers/${v.id}/post`, {})); };
    await pnk('2026-01-02');
    const r = await t.run('costing'); expect(r.statusCode, r.body).toBe(200);
    expect(t.step(r, 'costing').status).toBe('done');
    await pnk('2026-01-05');
    const c = (await t.status()).steps[5]!;
    expect(c.status).toBe('rerun'); expect(c.reason).toContain('giá vốn');
  });

  it('giá vốn lỗi (ok=false): không tính là xong, hiện lý do, các bước sau chạy lại; lỗi sau lần thành công vẫn hiện lỗi', async () => {
    const t = await tenant();
    await t.logRaw('costing', true, { voucherIds: [], unchanged: false });
    expect((await t.run('fx_outflow')).statusCode).toBe(200);
    let st = await t.status();
    expect(st.steps[5]).toMatchObject({ status: 'done', failed: false }); expect(st.steps[6]!.status).toBe('done');
    await t.logRaw('costing', false, { voucherIds: [], unchanged: false, errors: 2 }); // lỗi sau lần thành công, có thể đã ghi một phần
    st = await t.status();
    expect(st.steps[5]).toMatchObject({ status: 'rerun', failed: true }); expect(st.steps[5]!.reason).toContain('lỗi (2 mục)');
    expect(st.steps[6]).toMatchObject({ status: 'rerun' }); expect(st.nextStep).toBe('tool'); // bước đầu chưa chạy
    // lỗi không đổi gì (unchanged) thì bước sau giữ nguyên
    const u = await tenant();
    await u.logRaw('costing', true, { voucherIds: [] }); await u.run('fx_outflow');
    await u.logRaw('costing', false, { voucherIds: [], unchanged: true, errors: 1 });
    expect((await u.status()).steps[6]!.status).toBe('done');
  });

  it('lãi vay: giải ngân ghi lùi sau khi tính lãi → loan_interest rerun', async () => {
    const t = await tenant('TT99');
    for (const [name, payload] of [['bank', { code: 'VCB', name: 'Vietcombank' }], ['bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '112' }]] as const)
      await t.ok(t.call('POST', `/api/catalogs/${name}`, payload), 201);
    const loan = await t.ok(t.call('POST', '/api/loans', { code: 'VAYA', name: 'Vay A', partyCode: 'NCC001', value: '2000000000', signedDate: '2026-01-01', rates: [{ validFrom: '2026-01-01', annualRate: '9' }] }), 201);
    await t.ok(t.call('POST', `/api/loans/${loan.id}/disburse`, { date: '2026-01-11', amount: '1000000000', bankAccountNo: '0011001' }), 201);
    const r = await t.run('loan_interest'); expect(r.statusCode, r.body).toBe(200);
    expect(t.step(r, 'loan_interest').status).toBe('done');
    await t.ok(t.call('POST', `/api/loans/${loan.id}/disburse`, { date: '2026-01-25', amount: '100000000', bankAccountNo: '0011001' }), 201);
    expect((await t.status()).steps[3]!).toMatchObject({ key: 'loan_interest', status: 'rerun' });
  });
});
