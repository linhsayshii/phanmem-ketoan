import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

// GĐ6 Task 13b: theo dõi thực hiện hợp đồng (phụ lục, đã xuất hóa đơn, đã thu/trả, quá hạn), lãi lỗ theo hợp đồng và vụ việc, cờ nhạy cảm, khóa công ty.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let ctx: TestApp; let cookie: string; let tenantId: string; let seq = 0;
type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) }) as Promise<Res>;
const ok = async (r: Promise<Res>, status = 201) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const get = (url: string, c = cookie) => ok(call('GET', url, undefined, c), 200);
const code = (r: Res) => r.json().error?.code ?? r.json().code;
const M = (n: number) => String(n * 1_000_000);
const hdb = (contractCode: string, amount: number, date: string, more: object = {}) => ({ voucherType: 'HDB', postingDate: date, documentDate: date, partyCode: 'KH001', contractCode, autoPost: true,
  items: [{ description: 'Dịch vụ', accountCode: '511', amountCurrency: M(amount), taxCodes: ['V10'] }], invoice: { serial: 'C26TAA', invoiceNo: `T${seq++}`, invoiceDate: date, invoiceGroupCode: '10' }, ...more });
const pkt = (date: string, lines: object[]) => ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Bút toán', autoPost: true, lines }));
const login = async (perms: string[], flags: string[]) => {
  const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
  await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
  const username = `td_${Date.now()}_${seq++}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: flags })).statusCode).toBe(201);
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
};
let hb1: number; let hm1: number; let loanId: number; let p1: number;
const trackOf = async (asOf: string, c = cookie) => (await get(`/api/contracts/track?asOf=${asOf}`, c)).rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `TD${Date.now()}`, 'TT99'));
  hb1 = (await ok(call('POST', '/api/contracts', { code: 'HB1', name: 'Hợp đồng bán 1', kind: 'sale', partyCode: 'KH001', value: M(100), status: 'active', accountCode: '511', taxCode: 'V10' }))).id;
  hm1 = (await ok(call('POST', '/api/contracts', { code: 'HM1', name: 'Hợp đồng mua 1', kind: 'purchase', partyCode: 'NCC001', value: M(50), status: 'active' }))).id;
  loanId = (await sql<{ id: number }>`INSERT INTO contract(tenant_id, code, name, kind, value, status) VALUES (${tenantId}::uuid, 'KU1', 'Khế ước vay', 'loan', 0, 'active') RETURNING id::int`.execute(ctx.t.admin)).rows[0]!.id;
  for (const [c, n, more] of [['P1', 'Công trình 1', { budget: M(50) }], ['P1A', 'Hạng mục 1A', { parent_code: 'P1' }], ['P2', 'Công trình 2', {}]] as const)
    await ok(call('POST', '/api/catalogs/project', { code: c, name: n, ...more }));
  p1 = (await sql<{ id: number }>`SELECT id::int FROM project WHERE tenant_id = ${tenantId}::uuid AND code = 'P1'`.execute(ctx.t.admin)).rows[0]!.id;

  // Phụ lục: +20 triệu ký 01/02, +5 triệu ký 01/12 (chưa tính tại 30/6).
  await ok(call('PUT', `/api/contracts/${hb1}/amendments`, { amendments: [{ seq: 1, amendmentNo: 'PL01', signedDate: '2026-02-01', description: 'Bổ sung hạng mục', valueChange: M(20) },
    { seq: 2, signedDate: '2026-12-01', description: 'Bổ sung lần 2', valueChange: M(5) }] }), 200);
  // Đợt: 30% (30 triệu) hạn 15/02 — lập hóa đơn; 40 triệu hạn 31/03 — chưa lập (quá hạn tại 30/6); 50 triệu hạn 31/12.
  const ms = (await ok(call('PUT', `/api/contracts/${hb1}/milestones`, { milestones: [{ seq: 1, description: 'Tạm ứng', dueDate: '2026-02-15', percent: '30' },
    { seq: 2, description: 'Nghiệm thu 1', dueDate: '2026-03-31', amount: M(40) }, { seq: 3, description: 'Quyết toán', dueDate: '2026-12-31', amount: M(50) }] }), 200)).milestones;
  const inv = await ok(call('POST', `/api/contracts/${hb1}/milestones/${ms[0].id}/invoice`, { postingDate: '2026-02-10', invoiceGroupCode: '10', invoiceNo: 'D1' }));
  await ok(call('POST', `/api/vouchers/${inv.invoice.id}/post`, {}), 200);
  // HDB thêm 10 triệu hạn 31/12; HDB 5 triệu ghi 20/4 rồi đảo 10/5; HDB nháp không tính.
  await ok(call('POST', '/api/invoices', hdb('HB1', 10, '2026-04-10', { dueDate: '2026-12-31' })));
  const h3 = await ok(call('POST', '/api/invoices', hdb('HB1', 5, '2026-04-20')));
  await ok(call('POST', `/api/vouchers/${h3.id}/reverse`, { postingDate: '2026-05-10' }));
  await ok(call('POST', '/api/invoices', hdb('HB1', 7, '2026-04-25', { autoPost: false })));
  await ok(call('POST', '/api/vouchers', { voucherType: 'PT', postingDate: '2026-03-20', documentDate: '2026-03-20', partyCode: 'KH001', personName: 'A', description: 'Thu tiền hợp đồng', autoPost: true,
    lines: [{ accountCode: '111', debit: M(13) }, { accountCode: '131', credit: M(13), partyCode: 'KH001', contractCode: 'HB1' }] }));
  // Hợp đồng mua: HDM 20 triệu vào 6421 hạn 05/4, trả 5 triệu.
  await ok(call('POST', '/api/invoices', { voucherType: 'HDM', postingDate: '2026-03-05', documentDate: '2026-03-05', partyCode: 'NCC001', contractCode: 'HM1', autoPost: true, dueDate: '2026-04-05',
    items: [{ description: 'Thuê ngoài', accountCode: '6421', amountCurrency: M(20), taxCodes: ['V10'] }], invoice: { serial: 'K26', invoiceNo: 'M1', invoiceDate: '2026-03-05', invoiceGroupCode: '01' } }));
  await ok(call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: '2026-03-25', documentDate: '2026-03-25', partyCode: 'NCC001', personName: 'B', description: 'Trả tiền hợp đồng', autoPost: true,
    lines: [{ accountCode: '331', debit: M(5), partyCode: 'NCC001', contractCode: 'HM1' }, { accountCode: '111', credit: M(5) }] }));
  // Chi phí: giá vốn, bán hàng, giảm trừ, sản xuất theo HB1; 6421 không gắn; 6411 theo khế ước vay (không phải hợp đồng); vụ việc.
  await pkt('2026-04-30', [{ accountCode: '632', debit: M(12), contractCode: 'HB1' }, { accountCode: '6411', debit: M(3), contractCode: 'HB1' }, { accountCode: '521', debit: M(1), contractCode: 'HB1' },
    { accountCode: '621', debit: M(5), contractCode: 'HB1' }, { accountCode: '6421', debit: M(2) }, { accountCode: '6411', debit: '700000', contractCode: 'KU1' }, { accountCode: '111', credit: '23700000' }]);
  await pkt('2026-05-15', [{ accountCode: '111', debit: M(8) }, { accountCode: '511', credit: M(8), projectCode: 'P1A' }]);
  await pkt('2026-05-16', [{ accountCode: '632', debit: M(3), projectCode: 'P1A' }, { accountCode: '6411', debit: M(1), projectCode: 'P1' }, { accountCode: '622', debit: M(2), projectCode: 'P2' },
    { accountCode: '6421', debit: '500000' }, { accountCode: '111', credit: '6500000' }]);
});
afterAll(async () => { await ctx.close(); });

describe('theo dõi thực hiện hợp đồng', () => {
  it('giá trị gồm phụ lục, đã xuất hóa đơn, % thực hiện, đã thu, còn phải thu, quá hạn FIFO, đợt quá hạn; loại khế ước vay', async () => {
    const rows = await trackOf('2026-06-30');
    expect(rows.map((r) => r.code)).toEqual(['HB1', 'HM1']);
    const s = rows[0]!;
    expect(s).toMatchObject({ value: M(100), amendmentTotal: M(20), adjustedValue: M(120), invoiced: M(40), invoicedVnd: M(40), remainingValue: M(80), performedPct: '33.33',
      milestoneTotal: M(120), milestoneInvoiced: M(30), overdueMilestoneCount: 1, overdueMilestoneAmount: M(40), nextDueDate: '2026-12-31',
      debtIncurred: M(44), settled: M(13), outstanding: M(31), overdueDebt: M(20), debtHidden: false });
    expect(rows[1]).toMatchObject({ invoiced: M(20), performedPct: '40.00', debtIncurred: M(22), settled: M(5), outstanding: M(17), overdueDebt: M(17), overdueMilestoneCount: 0 });
    // Kỳ chọn khác: 01/5 hóa đơn đảo ngày 10/5 còn hiệu lực; 20/02 đợt 1 quá hạn thanh toán (hạn đợt 15/02), chưa có PT; 31/01 chưa có phụ lục.
    expect((await trackOf('2026-05-01'))[0]).toMatchObject({ invoiced: M(45), debtIncurred: M(49.5), outstanding: M(36.5) });
    expect((await trackOf('2026-02-20'))[0]).toMatchObject({ invoiced: M(30), outstanding: M(33), overdueDebt: M(33), overdueMilestoneCount: 0, adjustedValue: M(120) });
    expect((await trackOf('2026-01-31'))[0]).toMatchObject({ adjustedValue: M(100), invoiced: '0', performedPct: '0.00' });
    // Khớp sổ cái: còn phải thu HB1 = Σ (Nợ − Có) 131 có contract_id.
    const led = (await sql<{ n: string }>`SELECT sum(l.debit - l.credit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE l.tenant_id = ${tenantId}::uuid AND l.contract_id = ${hb1}::bigint AND a.code = '131' AND v.state IN ('posted','reversed')`.execute(ctx.t.admin)).rows[0]!.n;
    expect(led).toBe(s.outstanding);
    // Một hợp đồng: đợt đánh dấu quá hạn, phụ lục; khế ước vay 404.
    const one = await get(`/api/contracts/${hb1}/track?asOf=2026-06-30`);
    expect(one.milestones.map((m: { seq: number; overdue: boolean; status: string }) => [m.seq, m.status, m.overdue])).toEqual([[1, 'invoiced', false], [2, 'planned', true], [3, 'planned', false]]);
    expect(one.amendments.map((a: { amendmentNo: string | null }) => a.amendmentNo)).toEqual(['PL01', null]);
    expect(one.outstanding).toBe(M(31));
    expect((await call('GET', `/api/contracts/${loanId}/track`)).statusCode).toBe(404);
    // Báo cáo quá hạn: chỉ hợp đồng có quá hạn, xuất Excel.
    expect((await get('/api/contracts/track?asOf=2026-06-30&overdue=true&kind=purchase')).rows.map((r: { code: string }) => r.code)).toEqual(['HM1']);
    const x = await call('GET', '/api/contracts/track?asOf=2026-06-30&overdue=true&format=xlsx');
    expect(x.statusCode, x.body).toBe(200); expect(String(x.headers['content-type'])).toContain('spreadsheetml');
  });

  it('phụ lục: giá trị sau phụ lục âm 400, STT trùng 400, sửa và xóa', async () => {
    expect(code(await call('PUT', `/api/contracts/${hm1}/amendments`, { amendments: [{ seq: 1, signedDate: '2026-02-01', description: 'Giảm', valueChange: M(-51) }] }))).toBe('VALIDATION');
    expect((await call('PUT', `/api/contracts/${hm1}/amendments`, { amendments: [{ seq: 1, signedDate: '2026-02-01', description: 'A', valueChange: '1' }, { seq: 1, signedDate: '2026-02-01', description: 'B', valueChange: '1' }] })).statusCode).toBe(400);
    const a = (await ok(call('PUT', `/api/contracts/${hm1}/amendments`, { amendments: [{ seq: 1, signedDate: '2026-02-01', description: 'Giảm', valueChange: M(-10) }] }), 200)).amendments;
    expect((await trackOf('2026-06-30'))[1]).toMatchObject({ adjustedValue: M(40), performedPct: '50.00' });
    expect((await ok(call('PUT', `/api/contracts/${hm1}/amendments`, { amendments: [{ id: a[0].id, seq: 1, signedDate: '2026-02-01', description: 'Giảm', valueChange: M(-5) }] }), 200)).amendments[0].valueChange).toBe(M(-5));
    expect((await ok(call('PUT', `/api/contracts/${hm1}/amendments`, { amendments: [] }), 200)).amendments).toEqual([]);
    const audit = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'contract_amendment'`.execute(ctx.t.admin);
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(5);
  });
});

describe('lãi lỗ theo hợp đồng và vụ việc', () => {
  it('hợp đồng: doanh thu khớp Có 511 có contract_id, giá vốn, chi phí, lãi; khế ước vay và dòng không gắn vào chi phí chung; tổng khớp sổ cái', async () => {
    const r = await get('/api/contracts/pnl?from=2026-01-01&to=2026-06-30');
    const hb = r.rows.find((x: { code: string }) => x.code === 'HB1');
    expect(hb).toMatchObject({ revenue: M(40), deduction: M(1), netRevenue: M(39), cogs: M(12), grossProfit: M(27), selling: M(3), admin: '0', profit: M(24), production: M(5), value: M(120), valuePct: '32.50' });
    expect(r.rows.find((x: { code: string }) => x.code === 'HM1')).toMatchObject({ admin: M(20), profit: M(-20), valuePct: null });
    expect(r.rows.map((x: { code: string }) => x.code)).toEqual(['HB1', 'HM1']);
    expect(r.unassigned).toMatchObject({ revenue: M(8), cogs: M(3), selling: '1700000', admin: '2500000', production: M(2) });
    const led = async (prefix: string, withContract: boolean) => (await sql<{ n: string | null }>`SELECT sum(l.credit - l.debit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
      JOIN account a ON a.id = l.account_id LEFT JOIN contract c ON c.id = l.contract_id
      WHERE l.tenant_id = ${tenantId}::uuid AND starts_with(a.code, ${prefix}) AND v.state IN ('posted','reversed') AND l.posting_date BETWEEN '2026-01-01' AND '2026-06-30'
        AND (NOT ${withContract}::boolean OR (l.contract_id IS NOT NULL AND c.kind <> 'loan'))`.execute(ctx.t.admin)).rows[0]!.n ?? '0';
    expect(await led('511', true)).toBe(hb.revenue);
    expect(r.totals.revenue).toBe(await led('511', false));
    expect(r.totals.selling).toBe(String(-Number(await led('641', false))));
    expect(r.totals.profit).toBe(String(48 * 1e6 - 1e6 - 15e6 - 4.7e6 - 22.5e6));
    // Khoảng ngày khác: từ 01/4 bỏ hóa đơn tháng 2; một hợp đồng.
    expect((await get(`/api/contracts/pnl?from=2026-04-01&to=2026-06-30&contractId=${hb1}`)).rows[0]).toMatchObject({ revenue: M(10), profit: M(-6) });
    expect((await call('GET', `/api/contracts/pnl?from=2026-01-01&to=2026-06-30&contractId=${loanId}`)).statusCode).toBe(404);
  });

  it('vụ việc: cây cha cộng con, dự toán, chi phí chung chưa phân bổ; tổng khớp lãi lỗ hợp đồng (cùng sổ cái)', async () => {
    const r = await get('/api/projects/pnl?from=2026-01-01&to=2026-06-30');
    expect(r.rows.map((x: { code: string; level: number }) => [x.code, x.level])).toEqual([['P1', 1], ['P1A', 2], ['P2', 1]]);
    expect(r.rows[0]).toMatchObject({ revenue: M(8), cogs: M(3), selling: M(1), profit: M(4), budget: M(50), costTotal: M(4), budgetPct: '8.00', hasChildren: true });
    expect(r.rows[1]).toMatchObject({ revenue: M(8), cogs: M(3), selling: '0', profit: M(5), parentCode: 'P1' });
    expect(r.rows[2]).toMatchObject({ production: M(2), profit: '0' });
    const c = await get('/api/contracts/pnl?from=2026-01-01&to=2026-06-30');
    expect(r.totals).toEqual(c.totals);
    expect(r.unassigned.selling).toBe('3700000'); // 6411 theo HB1 và khế ước vay
    const one = await get(`/api/projects/pnl?from=2026-01-01&to=2026-06-30&projectId=${p1}`);
    expect(one.rows.map((x: { code: string }) => x.code)).toEqual(['P1', 'P1A']); expect(one.totals.profit).toBe(M(4));
    const x = await call('GET', '/api/projects/pnl?from=2026-01-01&to=2026-06-30&format=xlsx');
    expect(x.statusCode, x.body).toBe(200);
  });
  it('kết chuyển cuối kỳ (KC sang 911) không làm đổi lãi lỗ hợp đồng/vụ việc', async () => {
    const before = [await get('/api/contracts/pnl?from=2026-01-01&to=2026-06-30'), await get('/api/projects/pnl?from=2026-01-01&to=2026-06-30')];
    await ok(call('POST', '/api/closing/run-all', { postingDate: '2026-06-30' }), 200);
    const kc = await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND is_closing AND state = 'posted'`.execute(ctx.t.admin);
    expect(kc.rows[0]!.n).toBeGreaterThan(0);
    expect([await get('/api/contracts/pnl?from=2026-01-01&to=2026-06-30'), await get('/api/projects/pnl?from=2026-01-01&to=2026-06-30')]).toEqual(before);
  });
});

describe('quyền, cờ nhạy cảm và khóa công ty', () => {
  it('thiếu contract_track.view 403; thiếu cờ công nợ thì ẩn số công nợ, báo cáo quá hạn 403; lãi lỗ cần view_cost', async () => {
    const none = await login(['order.view'], []);
    expect((await call('GET', '/api/contracts/track', undefined, none)).statusCode).toBe(403);
    const noFlag = await login(['contract_track.view'], []);
    const rows = await trackOf('2026-06-30', noFlag);
    expect(rows[0]).toMatchObject({ code: 'HB1', invoiced: M(40), outstanding: null, settled: null, debtIncurred: null, overdueDebt: null, debtHidden: true });
    expect((await call('GET', '/api/contracts/track?overdue=true', undefined, noFlag)).statusCode).toBe(403);
    expect((await call('GET', `/api/contracts/${hb1}/track`, undefined, noFlag)).json().outstanding).toBeNull();
    for (const u of ['/api/contracts/pnl', '/api/projects/pnl']) expect((await call('GET', `${u}?from=2026-01-01&to=2026-06-30`, undefined, noFlag)).statusCode).toBe(403);
    const recv = await login(['contract_track.view'], ['view_receivable', 'view_cost']);
    const r2 = await trackOf('2026-06-30', recv);
    expect([r2[0]!.outstanding, r2[1]!.outstanding, r2[1]!.debtHidden]).toEqual([M(31), null, true]);
    expect((await call('GET', '/api/contracts/track?overdue=true&kind=sale', undefined, recv)).statusCode).toBe(200);
    expect((await call('GET', '/api/contracts/track?overdue=true', undefined, recv)).statusCode).toBe(403);
    expect((await call('GET', '/api/contracts/pnl?from=2026-01-01&to=2026-06-30', undefined, recv)).statusCode).toBe(200);
    // Xuất Excel cần report.print.
    expect((await call('GET', '/api/contracts/track?format=xlsx', undefined, recv)).statusCode).toBe(403);
  });

  it('công ty khác không thấy hợp đồng, vụ việc, phụ lục của công ty này', async () => {
    const other = (await setupLedgerTenant(ctx, `TO${Date.now()}`, 'TT99')).cookie;
    expect((await get('/api/contracts/track', other)).rows).toEqual([]);
    expect((await call('GET', `/api/contracts/${hb1}/track`, undefined, other)).statusCode).toBe(404);
    expect((await call('PUT', `/api/contracts/${hb1}/amendments`, { amendments: [] }, other)).statusCode).toBe(404);
    const p = await get('/api/projects/pnl?from=2026-01-01&to=2026-06-30', other);
    expect([p.rows, p.totals.revenue]).toEqual([[], '0']);
    expect((await call('GET', `/api/projects/pnl?from=2026-01-01&to=2026-06-30&projectId=${p1}`, undefined, other)).statusCode).toBe(404);
  });
});
