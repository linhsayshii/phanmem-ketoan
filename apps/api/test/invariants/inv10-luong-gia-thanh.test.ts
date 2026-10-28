import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { assertBalanceSheet, runs, timeoutFor } from './helpers.js';

// Bất biến 10 (GĐ6): lương, giá thành, phân bổ chi phí chung vào vụ việc. Mỗi thuộc tính một công ty mới, năm 2026 TT133; tham số lương là dữ liệu minh họa (payroll-20.json).
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

// Số thao tác thành công theo loại (qua mọi lần chạy): chuỗi ngẫu nhiên phải thật sự đổi lương, tính, hạch toán, chạy lại, hủy, chạy giá thành, phân bổ.
const done = new Map<string, number>();
const bump = (k: string) => done.set(k, (done.get(k) ?? 0) + 1);
const day = (m: number, d: number) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const eom = (m: number) => day(m, new Date(Date.UTC(2026, m, 0)).getUTCDate());

async function tenant(prefix: string) {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `${prefix}${Date.now()}${n++}` });
  const call = (m: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method: m, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const must = async (m: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => { const r = await call(m, url, payload); expect(r.statusCode, `${m} ${url}: ${r.body}`).toBeLessThan(300); return r.json() as Json; };
  await must('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  const rows = async <T>(s: ReturnType<typeof sql<T>>) => (await s.execute(ctx.t.admin)).rows;
  // Số dư ròng (Nợ − Có) lũy kế đến ngày `to` của các tài khoản có mã bắt đầu bằng `prefix`, từ dòng đã ghi sổ (cả chứng từ bị đảo và bản đảo).
  const bal = async (acc: string, to = '2026-12-31', from = '2026-01-01') => BigInt((await rows<{ n: string }>(sql`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    JOIN account a ON a.id = l.account_id WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND starts_with(a.code, ${acc}) AND l.posting_date BETWEEN ${from}::date AND ${to}::date`))[0]!.n);
  // Bất biến 4 trên mọi chuỗi: Σ Nợ = Σ Có toàn sổ và cân đối kế toán đến cuối tháng m.
  const ledgerBalanced = async (m: number) => {
    const t = (await rows<{ dr: string; cr: string }>(sql`SELECT coalesce(sum(l.debit), 0)::text AS dr, coalesce(sum(l.credit), 0)::text AS cr FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed')`))[0]!;
    expect(t.dr, 'Σ Nợ = Σ Có').toBe(t.cr);
    await assertBalanceSheet(ctx, cookie, eom(m));
  };
  return { cookie, tenantId, call, must, rows, bal, ledgerBalanced };
}
type T = Awaited<ReturnType<typeof tenant>>;
const pkt = async (t: T, date: string, lines: object[]) => (await t.must('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'inv10', lines, autoPost: true })).id as string;
const reverse = (t: T, id: string, date: string) => t.must('POST', `/api/vouchers/${id}/reverse`, { postingDate: date });

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// (1) Lương: đổi lương, người phụ thuộc, chấm công, tính, hạch toán, chạy lại, hủy hạch toán.
type PayOp =
  | { k: 'salary'; e: number; amount: number; m: number; d: number } | { k: 'dep'; e: number; m: number } | { k: 'att'; e: number; m: number; days: number }
  | { k: 'calc'; m: number } | { k: 'post'; m: number } | { k: 'repost'; m: number } | { k: 'unpost'; m: number };
const arbMonth = fc.constantFrom(10, 11);
const arbEmp = fc.integer({ min: 0, max: 3 });
const arbPayOp: fc.Arbitrary<PayOp> = fc.oneof(
  fc.record({ k: fc.constant('salary' as const), e: arbEmp, amount: fc.integer({ min: 10, max: 200 }).map((x) => x * 500_000), m: arbMonth, d: fc.integer({ min: 1, max: 28 }) }),
  fc.record({ k: fc.constant('dep' as const), e: arbEmp, m: arbMonth }),
  fc.record({ k: fc.constant('att' as const), e: arbEmp, m: arbMonth, days: fc.integer({ min: 1, max: 16 }) }),
  fc.record({ k: fc.constant('calc' as const), m: arbMonth }), fc.record({ k: fc.constant('post' as const), m: arbMonth }),
  fc.record({ k: fc.constant('repost' as const), m: arbMonth }), fc.record({ k: fc.constant('unpost' as const), m: arbMonth }));

async function payrollTenant() {
  const t = await tenant('I10P');
  await t.must('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await t.must('PUT', '/api/payroll/params', { code, validFrom: '2026-01-01', value, source: fx.source });
  const id = async (table: string, body: object) => Number((await t.must('POST', `/api/catalogs/${table}`, body)).id);
  const dept = { SX: await id('department', { code: 'SX', name: 'Sản xuất' }), BH: await id('department', { code: 'BH', name: 'Bán hàng' }), QL: await id('department', { code: 'QL', name: 'Quản lý' }) };
  await id('project', { code: 'P1', name: 'Vụ việc 1' });
  const nc = await id('cost_item', { code: 'NC', name: 'Nhân công' });
  const obj = Number((await t.must('POST', '/api/costing/objects', { code: 'OBJ1', name: 'Vụ việc P1', kind: 'project', projectCode: 'P1' })).id);
  await t.must('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dept.SX, kind: 'payroll', role: 'direct', costItemId: nc, costObjectId: obj },
    { departmentId: dept.BH, kind: 'payroll', role: 'selling' }, { departmentId: dept.QL, kind: 'payroll', role: 'admin' }] });
  const emp: number[] = [];
  for (const [i, d] of (['SX', 'BH', 'QL', 'QL'] as const).entries()) {
    const e = Number((await t.must('POST', '/api/catalogs/employee', { code: `E${i + 1}`, name: `Nhân viên ${i + 1}`, department_code: d })).id);
    await t.must('PUT', `/api/payroll/profiles/${e}`, { taxResidency: 'resident', contractType: 'long', region: 'I', siSalary: null, startDate: null, endDate: null, siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, defaultProjectId: null });
    await t.must('POST', `/api/payroll/profiles/${e}/salary-history`, { validFrom: '2026-01-01', monthlySalary: String((10 + 7 * i) * 1_000_000) });
    emp.push(e);
  }
  const cells = (e: number, m: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => ({ employeeId: emp[e]!, date: day(m, from + k), entries: [{ kind: 'work_day', qty: '1' }] }));
  for (const m of [10, 11]) await t.must('PUT', `/api/attendance?year=2026&month=${m}`, { cells: emp.flatMap((_, e) => cells(e, m, 1, 10)) });
  return { ...t, emp, cells };
}
type PT = Awaited<ReturnType<typeof payrollTenant>>;

// Sau mỗi thao tác: LU cân; bảng chưa hạch toán không còn số trên sổ; bảng đã hạch toán: chi phí = gross + BH doanh nghiệp, Có 334 = thực lĩnh, Có 3383/3384/3385/3335 đúng;
// dư Có 334 từng nhân viên = Σ thực lĩnh của các bảng đã hạch toán (chưa chi); LU hiện hành của bảng là chứng từ đã ghi sổ.
async function checkPayroll(t: PT) {
  const bad = await t.rows<{ id: string }>(sql`SELECT v.id FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE v.tenant_id = ${t.tenantId}::uuid AND v.voucher_type = 'LU' GROUP BY v.id HAVING sum(l.debit) <> sum(l.credit)`);
  expect(bad, 'LU lệch Nợ/Có').toEqual([]);
  const list = (await t.must('GET', '/api/payroll/runs?year=2026')) as unknown as Json[];
  const net = new Map<string, bigint>();
  for (const r of list) {
    const net_ = async (codes: string[]) => (await t.rows<{ code: string; n: string }>(sql`SELECT a.code, sum(l.credit - l.debit)::text AS n FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${t.tenantId}::uuid AND v.voucher_type = 'LU' AND v.source_doc_id = md5(${`${t.tenantId}:payroll_run:${r.id}`})::uuid AND v.state IN ('posted','reversed') GROUP BY 1`)).filter((x) => codes.includes(x.code));
    const by = Object.fromEntries((await net_(['154', '6421', '6422', '334', '3383', '3384', '3385', '3335', '3388'])).map((x) => [x.code, BigInt(x.n)]));
    if (r.status !== 'posted') { expect(Object.values(by).every((v) => v === 0n), `bảng ${r.month} chưa hạch toán (${r.status}) còn số trên sổ: ${JSON.stringify(by, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`).toBe(true); continue; }
    const run = (await t.must('GET', `/api/payroll/runs/${r.id}`)) as Json; const L = run.lines as Json[];
    const S = (f: (l: Json) => string | undefined) => L.reduce((s, l) => s + BigInt(f(l) ?? '0'), 0n);
    expect((await t.rows<{ s: string }>(sql`SELECT state AS s FROM voucher WHERE id = ${run.voucherId}::uuid`))[0]?.s, `LU hiện hành của bảng ${r.month}`).toBe('posted');
    expect(-(by['154'] ?? 0n) - (by['6421'] ?? 0n) - (by['6422'] ?? 0n), `chi phí bảng ${r.month}`).toBe(S((l) => String(BigInt(l.gross) + BigInt(l.siEr) + BigInt(l.values.union_er ?? '0'))));
    expect(by['334'], `Có 334 bảng ${r.month}`).toBe(S((l) => l.net));
    expect(by['3335'] ?? 0n, `3335 bảng ${r.month}`).toBe(S((l) => l.values.pit));
    expect(by['3388'] ?? 0n, `3388 bảng ${r.month}`).toBe(S((l) => l.values.other_withholding));
    expect(by['3383'], `3383 bảng ${r.month}`).toBe(S((l) => String(BigInt(l.values.si_er_si) + BigInt(l.values.si_er_occ) + BigInt(l.values.si_emp_si))));
    for (const l of L) net.set(l.employeeCode, (net.get(l.employeeCode) ?? 0n) + BigInt(l.net));
  }
  const ledger = await t.rows<{ code: string; n: string }>(sql`SELECT e.code, sum(l.credit - l.debit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id JOIN employee e ON e.id = l.employee_id
    WHERE v.tenant_id = ${t.tenantId}::uuid AND v.state IN ('posted','reversed') AND a.code = '334' GROUP BY 1 HAVING sum(l.credit - l.debit) <> 0 ORDER BY 1`);
  expect(Object.fromEntries(ledger.map((x) => [x.code, x.n])), '334 theo nhân viên = Σ thực lĩnh chưa chi').toEqual(Object.fromEntries([...net].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]).sort()));
}

async function payOp(t: PT, op: PayOp) {
  const accept = async (r: Awaited<ReturnType<PT['call']>>, kind: string) => { if (r.statusCode < 300) bump(kind); else expect(r.statusCode, `${kind}: ${r.body}`).toBeLessThan(500); }; // từ chối nghiệp vụ (4xx) hợp lệ, lỗi máy chủ thì không
  const run = async (m: number) => ((await t.must('GET', '/api/payroll/runs?year=2026&month=' + m)) as unknown as Json[])[0];
  switch (op.k) {
    case 'salary': return accept(await t.call('POST', `/api/payroll/profiles/${t.emp[op.e]}/salary-history`, { validFrom: day(op.m, op.d), monthlySalary: String(op.amount) }), 'salary');
    case 'dep': return accept(await t.call('POST', `/api/payroll/profiles/${t.emp[op.e]}/dependents`, { name: 'Người phụ thuộc', relationship: 'child', fromMonth: `2026-${op.m}`, toMonth: null }), 'dep');
    case 'att': return accept(await t.call('PUT', `/api/attendance?year=2026&month=${op.m}`, { cells: t.cells(op.e, op.m, 11, 10 + op.days) }), 'att');
    case 'calc': {
      const r = await run(op.m);
      if (!r) return accept(await t.call('POST', '/api/payroll/runs', { year: 2026, month: op.m, employeeIds: t.emp }).then(async (c) => (c.statusCode < 300 ? t.call('POST', `/api/payroll/runs/${c.json().id}/calculate`) : c)), 'calc');
      return accept(await t.call('POST', `/api/payroll/runs/${r.id}/calculate`), 'calc');
    }
    default: { const r = await run(op.m); if (!r) return; return accept(await t.call('POST', `/api/payroll/runs/${r.id}/${op.k}`), op.k); }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// (2) Giá thành: ghi chi phí NVL, nhân công trực tiếp (154 theo khoản mục), nhập thành phẩm, chạy giá thành, chạy giá vốn, chạy lại, đảo chi phí.
type CostOp = { k: 'cost'; nc: boolean; amt: number } | { k: 'receipt'; qty: number } | { k: 'rev' } | { k: 'run' };
type Block = { first: { qty: number; nvl: number; nc: number; wip: number }; ops: CostOp[] };
const arbCostOp: fc.Arbitrary<CostOp> = fc.oneof(
  fc.record({ k: fc.constant('cost' as const), nc: fc.boolean(), amt: fc.integer({ min: 1, max: 5000 }).map((x) => x * 100) }),
  fc.record({ k: fc.constant('receipt' as const), qty: fc.integer({ min: 1, max: 40 }) }), fc.record({ k: fc.constant('rev' as const) }), fc.record({ k: fc.constant('run' as const) }));
const arbBlock: fc.Arbitrary<Block> = fc.record({
  first: fc.record({ qty: fc.integer({ min: 1, max: 60 }), nvl: fc.integer({ min: 1, max: 9000 }).map((x) => x * 100), nc: fc.integer({ min: 1, max: 9000 }).map((x) => x * 100), wip: fc.integer({ min: 0, max: 30 }) }),
  ops: fc.array(arbCostOp, { maxLength: 5 }) });

async function costTenant() {
  const t = await tenant('I10C');
  for (const [name, body] of [['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }],
    ['cost_item', { code: 'KM-NVL', name: 'Nguyên vật liệu', cost_element: 'material' }], ['cost_item', { code: 'KM-NC', name: 'Nhân công', cost_element: 'labor' }]] as const)
    await t.must('POST', `/api/catalogs/${name}`, body);
  await t.must('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
  return t;
}
const costVoucher = (t: T, m: number, nc: boolean, amt: number) => pkt(t, day(m, 10), [
  { accountCode: '154', debit: String(amt), credit: '0', costItemCode: nc ? 'KM-NC' : 'KM-NVL', costObjectCode: 'SP1' }, { accountCode: '1111', debit: '0', credit: String(amt) }]);
const receipt = async (t: T, m: number, qty: number) => {
  const v = await t.must('POST', '/api/stock-vouchers', { description: 'inv10', voucherType: 'PNK', stockKind: 'finished', postingDate: day(m, 20), warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: String(qty), unitPrice: '1000' }] });
  await t.must('POST', `/api/vouchers/${v.id}/post`, {});
};

// Chạy giá thành rồi giá vốn tháng m (thứ tự kỳ: giá thành điều chỉnh lớp giá nhập, giá vốn ghi Nợ 155 / Có 154 phần chênh); chạy lại lần hai không đổi.
async function runMonth(t: T, m: number, wip: number, live: number) {
  const params = { objects: [{ objectCode: 'SP1', wip: wip > 0 ? 'direct_material' : 'none', outputs: [wip > 0 ? { wipQty: String(wip) } : {}] }] };
  const r = await t.must('POST', '/api/costing/runs', { year: 2026, month: m, params });
  await t.must('POST', '/api/inventory/costing-runs', { periodFrom: day(m, 1), periodTo: eom(m) });
  const again = await t.must('POST', '/api/costing/runs', { year: 2026, month: m, params });
  expect(again.unchanged, `chạy lại giá thành tháng ${m} phải không đổi`).toBe(true);
  expect((await t.must('POST', '/api/inventory/costing-runs', { periodFrom: day(m, 1), periodTo: eom(m) })).voucherIds, `chạy lại giá vốn tháng ${m} không sinh GV`).toEqual([]);
  const wipValue = (r.objects as Json[]).reduce((s, o) => s + BigInt(o.closing.material) + BigInt(o.closing.labor) + BigInt(o.closing.overhead), 0n);
  const b154 = await t.bal('154', eom(m));
  expect(b154, `154 cuối tháng ${m} = dở dang cuối kỳ`).toBe(wipValue);
  expect(b154 + await t.bal('155', eom(m)), `154 + 155 cuối tháng ${m} = tổng chi phí còn hiệu lực`).toBe(BigInt(live));
  bump('run');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// (3) Phân bổ chi phí chung 641/642 vào vụ việc theo chi phí trực tiếp: tổng của công ty không đổi.
type AllocOp = { k: 'cost'; acc: '6421' | '6422'; proj: 'P1' | 'P2' | null; amt: number } | { k: 'rev' } | { k: 'alloc' };
type AllocBlock = { first: { p1: number; p2: number }; ops: AllocOp[] };
const arbAllocOp: fc.Arbitrary<AllocOp> = fc.oneof(
  fc.record({ k: fc.constant('cost' as const), acc: fc.constantFrom('6421' as const, '6422' as const), proj: fc.constantFrom('P1' as const, 'P2' as const, null, null), amt: fc.integer({ min: 1, max: 9999 }).map((x) => x * 7) }),
  fc.record({ k: fc.constant('rev' as const) }), fc.record({ k: fc.constant('alloc' as const) }));
const arbAllocBlock: fc.Arbitrary<AllocBlock> = fc.record({ first: fc.record({ p1: fc.integer({ min: 1, max: 9999 }).map((x) => x * 13), p2: fc.integer({ min: 1, max: 9999 }).map((x) => x * 11) }), ops: fc.array(arbAllocOp, { maxLength: 6 }) });

describe('Bất biến 10: lương, giá thành, phân bổ vụ việc', () => {
  it('chuỗi đổi lương/phụ thuộc/chấm công/tính/hạch toán/chạy lại/hủy: LU cân, 334 từng nhân viên = Σ thực lĩnh chưa chi, LU hiện hành khớp bảng; hủy hết thì sổ về 0', async () => {
    await fc.assert(fc.asyncProperty(fc.array(arbPayOp, { minLength: 6, maxLength: 18 }), async (ops) => {
      const t = await payrollTenant();
      for (const op of ops) { await payOp(t, op); await checkPayroll(t); }
      for (const op of [{ k: 'calc', m: 10 }, { k: 'post', m: 10 }, { k: 'calc', m: 11 }, { k: 'post', m: 11 }, { k: 'repost', m: 10 }, { k: 'repost', m: 11 }] as PayOp[]) { await payOp(t, op); await checkPayroll(t); }
      await t.ledgerBalanced(11);
      for (const m of [10, 11]) await payOp(t, { k: 'unpost', m });
      await checkPayroll(t);
      for (const code of ['334', '3383', '3384', '3385', '3335', '3388', '154', '6421', '6422']) expect(await t.bal(code), `${code} sau khi hủy hạch toán hết`).toBe(0n);
    }), { numRuns: runs(6), examples: [[[{ k: 'calc', m: 10 }, { k: 'post', m: 10 }, { k: 'salary', e: 0, amount: 30_000_000, m: 10, d: 5 }, { k: 'att', e: 1, m: 10, days: 9 }, { k: 'repost', m: 10 },
      { k: 'dep', e: 2, m: 10 }, { k: 'calc', m: 11 }, { k: 'post', m: 11 }, { k: 'unpost', m: 10 }, { k: 'post', m: 10 }] as PayOp[]]] });
    for (const k of ['salary', 'dep', 'att', 'calc', 'post', 'repost', 'unpost']) expect(done.get(k) ?? 0, `thao tác ${k} phải từng thành công`).toBeGreaterThan(0);
  }, timeoutFor(900_000));

  it('chuỗi chi phí/nhập thành phẩm/chạy giá thành/chạy lại/đảo chi phí: 154 cuối kỳ = dở dang cuối kỳ, 154 + 155 = chi phí còn hiệu lực; đảo hết chi phí rồi chạy lại thì 154, 155 về 0', async () => {
    await fc.assert(fc.asyncProperty(fc.array(arbBlock, { minLength: 1, maxLength: 3 }), async (blocks) => {
      const t = await costTenant(); const months: { m: number; wip: number }[] = [];
      const live = new Map<string, number>(); const optional: string[] = []; // chứng từ chi phí còn hiệu lực (id → số tiền) và những chứng từ được phép đảo
      const total = () => [...live.values()].reduce((a, b) => a + b, 0);
      for (const [i, b] of blocks.entries()) {
        const m = i + 1; months.push({ m, wip: b.first.wip });
        live.set(await costVoucher(t, m, false, b.first.nvl), b.first.nvl); live.set(await costVoucher(t, m, true, b.first.nc), b.first.nc);
        await receipt(t, m, b.first.qty);
        for (const op of b.ops) {
          if (op.k === 'cost') { const id = await costVoucher(t, m, op.nc, op.amt); live.set(id, op.amt); optional.push(id); }
          else if (op.k === 'receipt') await receipt(t, m, op.qty);
          else if (op.k === 'rev') { const id = optional.pop(); if (id) { await reverse(t, id, day(m, 10)); live.delete(id); bump('rev'); } }
          else await runMonth(t, m, b.first.wip, total());
        }
        await runMonth(t, m, b.first.wip, total());
        await t.ledgerBalanced(m);
      }
      // Đảo mọi chi phí rồi chạy lại từng tháng theo thứ tự: không còn chi phí nên 154, 155 về 0.
      for (const id of [...live.keys()]) { await reverse(t, id, day(months[months.length - 1]!.m, 10)); live.delete(id); }
      for (const { m } of months) {
        await t.must('POST', '/api/costing/runs', { year: 2026, month: m, params: { objects: [{ objectCode: 'SP1', wip: 'none', outputs: [{}] }] } });
        await t.must('POST', '/api/inventory/costing-runs', { periodFrom: day(m, 1), periodTo: eom(m) });
      }
      const last = months[months.length - 1]!.m;
      expect(await t.bal('154', eom(last)), '154 sau khi đảo hết chi phí và chạy lại').toBe(0n);
      expect(await t.bal('155', eom(last)), '155 sau khi đảo hết chi phí và chạy lại').toBe(0n);
      await t.ledgerBalanced(last);
    }), { numRuns: runs(6), examples: [[[{ first: { qty: 10, nvl: 600_000, nc: 300_000, wip: 3 }, ops: [{ k: 'cost', nc: true, amt: 50_000 }, { k: 'run' }, { k: 'rev' }, { k: 'receipt', qty: 5 }] }, { first: { qty: 8, nvl: 200_000, nc: 100_000, wip: 0 }, ops: [] }] as Block[]]] });
    expect(done.get('run') ?? 0, 'chạy giá thành phải từng thành công').toBeGreaterThan(0);
  }, timeoutFor(900_000));

  it('chuỗi chi phí 641/642 chưa gắn vụ việc, chi phí trực tiếp, đảo, phân bổ, chạy lại: tổng 6421, 6422 của công ty = Σ chi phí còn hiệu lực; sau phân bổ phần chưa gắn về 0; chạy lại không đổi', async () => {
    await fc.assert(fc.asyncProperty(fc.array(arbAllocBlock, { minLength: 1, maxLength: 2 }), async (blocks) => {
      const t = await tenant('I10A'); const live = new Map<string, { acc: string; amt: number }>(); const optional: string[] = [];
      for (const c of ['P1', 'P2']) await t.must('POST', '/api/catalogs/project', { code: c, name: `Vụ việc ${c}` });
      const cost = async (m: number, acc: string, proj: string | null, amt: number) => {
        const id = await pkt(t, day(m, 10), [{ accountCode: acc, debit: String(amt), credit: '0', ...(proj && { projectCode: proj }) }, { accountCode: '1111', debit: '0', credit: String(amt) }]);
        live.set(id, { acc, amt }); return id;
      };
      const totals = async (to: string) => { for (const acc of ['6421', '6422']) expect(await t.bal(acc, to), `tổng ${acc} của công ty`).toBe(BigInt([...live.values()].filter((x) => x.acc === acc).reduce((s, x) => s + x.amt, 0))); };
      for (const [i, b] of blocks.entries()) {
        const m = i + 1; await cost(m, '6422', 'P1', b.first.p1); await cost(m, '6421', 'P2', b.first.p2);
        for (const op of b.ops) {
          if (op.k === 'cost') optional.push(await cost(m, op.acc, op.proj, op.amt));
          else if (op.k === 'rev') { const id = optional.pop(); if (id) { await reverse(t, id, day(m, 10)); live.delete(id); bump('revA'); } }
          else {
            const body = { kind: 'alloc', year: 2026, month: m, params: { basis: 'direct_cost' } };
            const r = await t.must('POST', '/api/projects/alloc', body);
            expect((await t.must('POST', '/api/projects/alloc', body)).unchanged, `chạy lại phân bổ tháng ${m} phải không đổi`).toBe(true);
            const untagged = await t.rows<{ acc: string; n: string }>(sql`SELECT a.code AS acc, coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
              WHERE v.tenant_id = ${t.tenantId}::uuid AND v.state IN ('posted','reversed') AND l.project_id IS NULL AND a.code IN ('6421', '6422') AND l.posting_date BETWEEN ${day(m, 1)}::date AND ${eom(m)}::date GROUP BY 1`);
            expect(untagged.filter((x) => x.n !== '0'), `phần chưa gắn vụ việc tháng ${m} sau phân bổ (${JSON.stringify(r.result)})`).toEqual([]);
            bump('alloc');
          }
          await totals(eom(m));
        }
        await totals(eom(m)); await t.ledgerBalanced(m);
      }
    }), { numRuns: runs(6), examples: [[[{ first: { p1: 51_900, p2: 91_300 }, ops: [{ k: 'cost', acc: '6421', proj: null, amt: 195_853 }, { k: 'cost', acc: '6422', proj: null, amt: 473_745 }, { k: 'alloc' }, { k: 'cost', acc: '6422', proj: null, amt: 7 }, { k: 'alloc' }, { k: 'rev' }, { k: 'alloc' }] }] as AllocBlock[]]] });
    expect(done.get('alloc') ?? 0, 'phân bổ phải từng thành công').toBeGreaterThan(0);
  }, timeoutFor(900_000));
});
