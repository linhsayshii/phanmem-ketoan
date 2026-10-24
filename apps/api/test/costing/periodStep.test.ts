import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 11c: bước "Giá thành sản phẩm" (product_cost) của quy trình cuối kỳ. Năm 2026 TT99; mỗi ca dùng một tháng riêng để dở dang/số liệu không lẫn nhau.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let owner: string; let noFlag: string; let noRun: string; let tenantId: string;
type M = 'GET' | 'POST' | 'PUT';
const call = (method: M, url: string, payload?: object, cookie = owner) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, payload, cookie); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi phí sản xuất', lines, autoPost: true });
const stock = async (body: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
const run = (step: string, periodNo: number, cookie = owner, extra: object = {}) => call('POST', '/api/period-close/run', { fiscalYear: 2026, periodNo, step, ...extra }, cookie);
const runOk = async (step: string, periodNo: number, cookie = owner) => { const r = await run(step, periodNo, cookie); expect(r.statusCode, r.body).toBe(200); return r.json(); };
type Step = { key: string; status: string; reason: string | null; masked: boolean; vouchers: { voucherType: string | null }[] };
const status = async (periodNo: number, cookie = owner) => (await ok('GET', `/api/period-close/2026/${periodNo}`, undefined, cookie)) as { steps: Step[]; nextStep: string | null };
const stepOf = (s: { steps: Step[] }, key: string) => s.steps.find((x) => x.key === key)!;
const bal = async (prefix: string, from: string, to: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
  WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND starts_with(a.code, ${prefix}) AND l.posting_date BETWEEN ${from}::date AND ${to}::date`.execute(ctx.t.admin)).rows[0]!.n;
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `ps_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `PS${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  for (const [name, body] of [['party', { code: 'NCC1', name: 'Nhà cung cấp', is_vendor: true }],
    ['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }], ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  await ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
  noFlag = await userWith('ketoan_truong', []); noRun = await userWith('xem', ['view_cost']);
}, 180_000);
afterAll(async () => { await ctx.close(); });

describe('bước product_cost trong quy trình cuối kỳ', () => {
  it('chuỗi giá vốn → giá thành → giá vốn hội tụ; chạy lại không đổi; thêm chi phí → cần chạy lại, chạy lại đảo GT và ra số đúng', async () => {
    await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
    const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
    const v = await ok('GET', `/api/vouchers/${pxk.id}`);
    await ok('PUT', `/api/vouchers/${pxk.id}`, { version: v.version, lines: [{ lineNo: (v.lines as Json[]).find((l) => l.accountCode === '621')!.lineNo, costObjectCode: 'SP1' }] });
    await pkt('2026-03-10', [L('622', '300000', '0', { costObjectCode: 'SP1' }), L('111', '0', '300000')]);
    await pkt('2026-03-15', [L('6272', '100000', '0', { costObjectCode: 'SP1' }), L('111', '0', '100000')]);
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-03-20', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '6', unitPrice: '100000' }] });
    await stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: '2026-03-31', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '4' }] });

    expect(stepOf(await status(3), 'product_cost')).toMatchObject({ status: 'pending', masked: false });
    expect((await runOk('costing', 3)).steps.find((s: Step) => s.key === 'costing').status).toBe('done');

    // Giá thành: 600.000 + 300.000 + 100.000 = 1.000.000, không dở dang → GT; lớp giá nhập làm giá vốn cần chạy lại.
    const p1 = await runOk('product_cost', 3);
    expect(p1.result).toMatchObject({ skipped: false, unchanged: false, status: 'posted', objectCount: 1, reversedVoucherIds: [] });
    expect(p1.result.voucherIds).toHaveLength(1);
    expect(stepOf(p1, 'product_cost')).toMatchObject({ status: 'done' }); expect(stepOf(p1, 'product_cost').vouchers.map((x) => x.voucherType)).toEqual(['GT']);
    expect(stepOf(p1, 'costing')).toMatchObject({ status: 'rerun', reason: expect.stringContaining('giá vốn') });
    expect(p1.nextStep).toBe('payroll'); // bước đầu quy trình còn chưa chạy; kiểm riêng thứ tự giữa hai bước bên dưới

    // Giá vốn lần hai làm giá thành "Cần chạy lại" theo thứ tự (chạy sau); giá thành lần hai không đổi → hội tụ.
    const c2 = await runOk('costing', 3);
    expect(stepOf(c2, 'costing').status).toBe('done');
    expect(stepOf(c2, 'product_cost')).toMatchObject({ status: 'rerun', reason: expect.stringContaining('Tính giá vốn') });
    const p2 = await runOk('product_cost', 3);
    expect(p2.result).toMatchObject({ unchanged: true, voucherIds: [GT(p1)], reversedVoucherIds: [] });
    expect(stepOf(p2, 'product_cost').status).toBe('done'); expect(stepOf(p2, 'costing').status).toBe('done');
    // 154 về 0, 155 = 1.000.000 ÷ 6 × 2 = 333.333, 632 = 666.667.
    expect(await bal('154', '2026-01-01', '2026-03-31')).toBe('0');
    expect(await bal('155', '2026-01-01', '2026-03-31')).toBe('333333');
    expect(await bal('632', '2026-03-01', '2026-03-31')).toBe('666667');
    // Hết việc ở hai bước, kết chuyển không bị chặn và không làm hai bước quay lại "cần chạy lại".
    expect((await run('closing', 3)).statusCode).toBe(200);
    const after = await status(3); expect([stepOf(after, 'costing').status, stepOf(after, 'product_cost').status]).toEqual(['done', 'done']);

    // Thêm chi phí: giá thành cần chạy lại, chạy lại đảo GT cũ + GT mới; giá vốn cần chạy lại rồi 154 về 0, 155 = 1.050.000 ÷ 6 × 2 = 350.000.
    await pkt('2026-03-25', [L('622', '50000', '0', { costObjectCode: 'SP1' }), L('111', '0', '50000')]);
    expect(stepOf(await status(3), 'product_cost')).toMatchObject({ status: 'rerun', reason: expect.stringContaining('đã thay đổi') });
    const p3 = await runOk('product_cost', 3);
    expect(p3.result).toMatchObject({ unchanged: false, reversedVoucherIds: [GT(p1)] });
    expect(stepOf(await runOk('costing', 3), 'product_cost').status).toBe('rerun');
    expect((await runOk('product_cost', 3)).result.unchanged).toBe(true);
    const fin = await status(3);
    expect([stepOf(fin, 'costing').status, stepOf(fin, 'product_cost').status]).toEqual(['done', 'done']);
    expect(await bal('154', '2026-01-01', '2026-03-31')).toBe('0');
    expect(await bal('155', '2026-01-01', '2026-03-31')).toBe('350000');
  });

  it('kỳ không có chi phí sản xuất: chạy → bỏ qua (không GT, không lần chạy); bỏ qua tay được; đã chạy rồi thì không bỏ qua tay', async () => {
    const r = await runOk('product_cost', 8);
    expect(r.result).toMatchObject({ skipped: true, unchanged: true, voucherIds: [] });
    expect(stepOf(r, 'product_cost').status).toBe('skipped_empty');
    expect((await sql<{ n: string }>`SELECT count(*)::text AS n FROM cost_run WHERE tenant_id = ${tenantId}::uuid AND month = 8`.execute(ctx.t.admin)).rows[0]!.n).toBe('0');
    expect((await run('product_cost', 9, owner, { skip: true })).statusCode).toBe(200);
    expect(stepOf(await status(9), 'product_cost').status).toBe('skipped_empty');
    const again = await run('product_cost', 3, owner, { skip: true }); expect(again.statusCode).toBe(409); expect(again.json().error.code).toBe('STEP_NOT_PENDING');
  });

  it('chặn chi phí chưa gắn đối tượng: 409 COST_RUN_UNASSIGNED kèm dòng; thiếu view_cost thì không kèm số; không ghi nhật ký', async () => {
    await pkt('2026-05-10', [L('622', '70000', '0'), L('111', '0', '70000')]);
    const r = await run('product_cost', 5); expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'COST_RUN_UNASSIGNED', details: { lines: [{ accountCode: '622', amount: '70000' }] } });
    const m = await run('product_cost', 5, noFlag); expect(m.statusCode).toBe(409);
    expect(m.json().error.code).toBe('COST_RUN_UNASSIGNED'); expect(JSON.stringify(m.json())).not.toContain('70000');
    expect(stepOf(await status(5), 'product_cost').status).toBe('pending');
  });

  it('thiếu cost_run.run → 403 nêu quyền; thiếu view_cost: chạy được nhưng kết quả và trạng thái che chi tiết', async () => {
    const f = await run('product_cost', 10, noRun); expect(f.statusCode).toBe(403); expect(f.json().error.message).toContain('cost_run.run');
    await pkt('2026-10-10', [L('622', '80000', '0', { costObjectCode: 'SP1' }), L('111', '0', '80000')]);
    const r = await runOk('product_cost', 10, noFlag);
    expect(r.result).toEqual({ masked: true, skipped: false, unchanged: false });
    expect(stepOf(r, 'product_cost')).toMatchObject({ status: 'done', masked: true, vouchers: [] });
    const full = await status(10); expect(stepOf(full, 'product_cost')).toMatchObject({ masked: false }); expect(stepOf(full, 'product_cost').vouchers).toHaveLength(1);
    await pkt('2026-10-12', [L('622', '5000', '0', { costObjectCode: 'SP1' }), L('111', '0', '5000')]);
    expect(stepOf(await status(10, noFlag), 'product_cost')).toMatchObject({ status: 'rerun', masked: true, vouchers: [] });
  });

  it('kỳ khóa cứng: chạy bước → 409 PERIOD_HARD_LOCKED, không ghi nhật ký', async () => {
    await pkt('2026-06-10', [L('622', '60000', '0', { costObjectCode: 'SP1' }), L('111', '0', '60000')]);
    await sql`UPDATE fiscal_period SET status = 'hard_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 6`.execute(ctx.t.admin);
    const r = await run('product_cost', 6); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect(stepOf(await status(6), 'product_cost').status).toBe('pending');
  });
});
const GT = (r: Json) => (r.steps as Json[]).find((s) => s.key === 'product_cost')!.vouchers[0].id as string;
