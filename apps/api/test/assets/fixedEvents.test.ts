import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Line = { accountCode: string; debit: string; credit: string; assetCode?: string | null; departmentCode?: string | null };
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const nợ = (account: string, debit: string, more: object = {}) => ({ accountCode: account, debit, credit: '0', ...more });
const có = (account: string, credit: string, more: object = {}) => ({ accountCode: account, debit: '0', credit, ...more });
const lineKey = (l: Line) => `${l.accountCode}|${l.debit}|${l.credit}|${l.assetCode ?? ''}|${l.departmentCode ?? ''}`;

// Năm 2026 (12 kỳ tháng), đối tượng NCC001; chế độ mặc định TT133.
async function tenant(regime: 'TT133' | 'TT200' = 'TT133') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `BD${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  const pkt = (date: string, lines: object[]) => ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'mua tài sản', autoPost: true, lines }), 201);
  const card = async (code: string, lifeUnits: number, more: object = {}, alloc: object[] = [{ expenseAccountCode: '6422', ratio: '100' }]) => {
    const a = await ok(call('POST', '/api/assets', { code, name: `TSCĐ ${code}`, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', lifeUnits, ...more }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: alloc }));
    return a.id as number;
  };
  // Thẻ bắt đầu khấu hao 01/01/2026, nguyên giá ghi bằng PKT ngày 01/01.
  const fixed = async (code: string, cost: string, lifeUnits: number, alloc?: object[]) => {
    const id = await card(code, lifeUnits, { depreciationStartDate: '2026-01-01' }, alloc);
    await pkt('2026-01-01', [nợ('2111', cost, { assetCode: code }), có('331', cost, { partyCode: 'NCC001' })]);
    return id;
  };
  const runOk = (periodNo: number, kind = 'depreciation') => ok(call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo }));
  const runs = async (kind = 'depreciation') => ((await ok(call('GET', `/api/asset-runs?kind=${kind}&year=2026`))) as { periodNo: number; status: string; voucherId: string | null; result: { lines: unknown[] } }[])
    .filter((r) => r.status === 'active');
  const voucher = (id: string) => ok(call('GET', `/api/vouchers/${id}`));
  const lines = async (id: string) => ((await voucher(id)).lines as Line[]).map(lineKey);
  const asset = (id: number) => ok(call('GET', `/api/assets/${id}`));
  const ev = (id: number, action: string, body: object) => call('POST', `/api/assets/${id}/${action}`, body);
  const values = async (id: number, date: string) => (await sql<{ cost: string; accumulated: string }>`SELECT cost::text, accumulated::text FROM fn_asset_values_at(${tenantId}::uuid, ${date}::date) WHERE asset_id = ${id}`.execute(ctx.t.admin)).rows[0];
  const count = async (q: string) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.raw(q)} AND tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n);
  return { cookie, tenantId, call, ok, pkt, card, fixed, runOk, runs, voucher, lines, asset, ev, values, count };
}

describe('biến động TSCĐ', () => {
  it('ghi tăng XDCB TS02 Nợ 2111 / Có 2412 240.000.000 ngày 10/01, 48 tháng: KH tháng 1 = round(240.000.000 × (22/31) / 48) = 3.548.387', async () => {
    const t = await tenant();
    const id = await t.card('TS02', 48);
    expect(err(await t.ev(id, 'increase', { date: '2026-01-10', reason: 'purchase', counterAccountCode: '331', amount: '240000000' }))).toEqual([400, 'VALIDATION']);
    expect((await t.ev(id, 'increase', { date: '2026-01-10', reason: 'stock', counterAccountCode: '152', amount: '240000000' })).json().error.message).toContain('Phiếu xuất kho');
    const r = await t.ok(t.ev(id, 'increase', { date: '2026-01-10', reason: 'construction', counterAccountCode: '2412', amount: '240000000' }));
    const v = await t.voucher(r.voucherId);
    expect(v).toMatchObject({ voucherType: 'TS', state: 'posted', postingDate: '2026-01-10' });
    expect(v.lines.map(lineKey)).toEqual(['2111|240000000|0|TS02|', '2412|0|240000000||']);
    expect(await t.asset(id)).toMatchObject({ useDate: '2026-01-10', depreciationStartDate: '2026-01-10', status: 'active' });
    expect((await t.runOk(1)).lines).toEqual([{ assetCode: 'TS02', amount: '3548387' }]);
    const evs = await t.ok(t.call('GET', `/api/assets/${id}/events`));
    expect(evs).toMatchObject([{ id: r.eventId, kind: 'increase', eventDate: '2026-01-10', voucherId: r.voucherId, state: 'active' }]);
    expect(await t.count(`audit_event WHERE entity = 'asset_event'`)).toBe(1);
  });

  it('ghi giảm TS01 ngày 16/03 khi KH tháng 3, 4 đã chạy: KH 3 và 4 chạy lại không còn TS01; TS gồm khấu hao 15/31 tháng 3 = 967.742; sau đó cost = acc = 0 cho TS01', async () => {
    const t = await tenant();
    const id = await t.fixed('TS01', '120000000', 60); await t.fixed('TS02', '36000000', 36);
    for (const p of [1, 2, 3, 4]) await t.runOk(p);
    const before = await t.runs();
    const r = await t.ok(t.ev(id, 'decrease', { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }));
    // 120.000.000 × 15/31 / 60 = 967.741,9 → 967.742; hao mòn đến 15/03 = 4.000.000 (KH 1, 2) + 967.742; giá trị còn lại 115.032.258.
    expect(r.partialDepreciation).toBe('967742');
    expect(await t.lines(r.voucherId)).toEqual(['6422|967742|0||', '2141|0|967742|TS01|', '2141|4967742|0|TS01|', '811|115032258|0||', '2111|0|120000000|TS01|']);
    const after = await t.runs();
    for (const p of [3, 4]) {
      expect(after.find((x) => x.periodNo === p)!.result.lines).toEqual([{ assetCode: 'TS02', amount: '1000000' }]);
      expect((await t.voucher(before.find((x) => x.periodNo === p)!.voucherId!)).state).toBe('reversed');
    }
    expect(after.find((x) => x.periodNo === 2)!.voucherId).toBe(before.find((x) => x.periodNo === 2)!.voucherId);
    expect(await t.values(id, '2026-12-31')).toEqual({ cost: '0', accumulated: '0' });
    expect(await t.asset(id)).toMatchObject({ status: 'decreased', decreaseDate: '2026-03-16' });
    expect(err(await t.ev(id, 'decrease', { date: '2026-04-01', reason: 'liquidation', counterAccountCode: '811' }))).toEqual([409, 'ASSET_DECREASED']);
    // Chứng từ TS là chứng từ hệ thống: không bỏ ghi sổ qua route chung.
    expect(err(await t.call('POST', `/api/vouchers/${r.voucherId}/unpost`))).toEqual([409, 'VOUCHER_SYSTEM_GENERATED']);
  });

  it('chế độ month: ghi giảm 16/03 không khấu hao tháng 3, TS không có dòng khấu hao', async () => {
    const t = await tenant();
    await t.ok(t.call('PUT', '/api/settings', { fa_proration: 'month' }));
    const id = await t.fixed('TS01', '120000000', 60);
    for (const p of [1, 2, 3]) await t.runOk(p);
    const r = await t.ok(t.ev(id, 'decrease', { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }));
    expect(r.partialDepreciation).toBe('0');
    expect(await t.lines(r.voucherId)).toEqual(['2141|4000000|0|TS01|', '811|116000000|0||', '2111|0|120000000|TS01|']);
    expect((await t.runs()).find((x) => x.periodNo === 3)).toMatchObject({ voucherId: null, result: { lines: [] } });
    expect(await t.values(id, '2026-12-31')).toEqual({ cost: '0', accumulated: '0' });
  });

  it('ghi giảm chuyển CCDC: Nợ 242 thẻ CC mới bằng giá trị còn lại; CC mới phân bổ từ kỳ sau', async () => {
    const t = await tenant();
    const id = await t.fixed('TS01', '120000000', 60);
    for (const p of [1, 2]) await t.runOk(p);
    const r = await t.ok(t.ev(id, 'decrease', { date: '2026-03-16', reason: 'to_tool',
      toolCard: { code: 'CC09', name: 'Máy chuyển thành CCDC', periods: 12, allocations: [{ expenseAccountCode: '6422', ratio: '100' }] } }));
    expect(await t.lines(r.voucherId)).toEqual(['6422|967742|0||', '2141|0|967742|TS01|', '2141|4967742|0|TS01|', '242|115032258|0|CC09|', '2111|0|120000000|TS01|']);
    const cc = (await t.ok(t.call('GET', '/api/assets?kind=tool')))[0];
    expect(cc).toMatchObject({ code: 'CC09', assetAccountCode: '242', depreciationStartDate: '2026-04-01', lifeUnits: 12, allocationFrom: { year: 2026, period: 4 } });
    expect((await t.runOk(3, 'tool')).lines).toEqual([]);
    // 115.032.258 / 12 = 9.586.021,5 → làm tròn nửa lên 9.586.022.
    expect((await t.runOk(4, 'tool')).lines).toEqual([{ assetCode: 'CC09', amount: '9586022' }]);
  });

  it('đánh giá lại tăng nguyên giá 12.000.000, hao mòn 2.000.000, đối ứng 412: Nợ 2111 12.000.000 / Có 2141 2.000.000 / Có 412 10.000.000; kỳ đó phiên bản mới', async () => {
    const t = await tenant('TT200');
    const id = await t.fixed('TS01', '120000000', 60);
    for (const p of [1, 2, 3]) await t.runOk(p);
    // Hao mòn tại 01/03 = 4.000.000 (KH 1, 2): đánh giá lại nguyên giá 132.000.000, hao mòn 6.000.000.
    const r = await t.ok(t.ev(id, 'revalue', { date: '2026-03-01', newCost: '132000000', newAccumulated: '6000000', counterAccountCode: '412' }));
    expect(await t.lines(r.voucherId)).toEqual(['2111|12000000|0|TS01|', '2141|0|2000000|TS01|', '412|0|10000000||']);
    // KH 3 chạy lại: phiên bản mới eff 3/2026 ledger_change, B = 132.000.000 − 6.000.000 = 126.000.000, U = 58 → 2.172.413,8 → 2.172.414.
    expect((await t.runs()).find((x) => x.periodNo === 3)!.result.lines).toEqual([{ assetCode: 'TS01', amount: '2172414' }]);
    const v = (await sql<{ eff_period: number; reason: string; units: string }>`SELECT eff_period, reason, units::text FROM asset_schedule WHERE asset_id = ${id} AND superseded_at IS NULL ORDER BY version`.execute(ctx.t.admin)).rows;
    expect(v.map((x) => [x.eff_period, x.reason, Number(x.units)])).toEqual([[1, 'initial', 60], [3, 'ledger_change', 58]]);
    // Điều chỉnh thời gian còn lại 29 tháng từ kỳ 4: phiên bản life_change, KH 4 = (132.000.000 − 8.172.414) / 29 = 4.269.916,76 → 4.269.917.
    await t.runOk(4);
    const life = await t.ok(t.ev(id, 'life', { date: '2026-04-01', remainingUnits: '29' }));
    expect((await t.runs()).find((x) => x.periodNo === 4)!.result.lines).toEqual([{ assetCode: 'TS01', amount: '4269917' }]);
    expect((await sql<{ reason: string }>`SELECT reason FROM asset_schedule WHERE asset_id = ${id} AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`.execute(ctx.t.admin)).rows[0]!.reason).toBe('life_change');
    // Hủy điều chỉnh: KH 4 về lịch cũ 2.172.414; hủy đánh giá lại: KH 3, 4 về 2.000.000.
    await t.ok(t.call('POST', `/api/asset-events/${life.eventId}/cancel`));
    expect((await t.runs()).find((x) => x.periodNo === 4)!.result.lines).toEqual([{ assetCode: 'TS01', amount: '2172414' }]);
    await t.ok(t.call('POST', `/api/asset-events/${r.eventId}/cancel`));
    expect((await t.runs()).filter((x) => x.periodNo >= 3).map((x) => x.result.lines)).toEqual([[{ assetCode: 'TS01', amount: '2000000' }], [{ assetCode: 'TS01', amount: '2000000' }]]);
    expect((await t.voucher(r.voucherId)).state).toBe('reversed');
  });

  it('dừng khấu hao 01/04, tiếp tục 01/06: tháng 4, 5 không khấu hao; tổng đời vẫn bằng nguyên giá', async () => {
    const t = await tenant();
    const id = await t.fixed('TS01', '120000000', 60);
    for (const p of [1, 2, 3, 4]) await t.runOk(p);
    await t.ok(t.ev(id, 'suspend', { date: '2026-04-01', reason: 'Sửa chữa lớn' }));
    expect(err(await t.ev(id, 'suspend', { date: '2026-04-10', reason: 'x' }))).toEqual([409, 'ASSET_SUSPENDED']);
    expect((await t.runs()).find((x) => x.periodNo === 4)).toMatchObject({ voucherId: null, result: { lines: [] } });
    expect(err(await t.ev(id, 'resume', { date: '2026-04-01' }))).toEqual([400, 'ASSET_PAUSE_ORDER']);
    await t.ok(t.ev(id, 'resume', { date: '2026-06-01' }));
    expect((await t.runOk(5)).lines).toEqual([]);
    expect((await t.runOk(6)).lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }]);
    const sch = await t.ok(t.call('GET', `/api/assets/${id}/schedule`)) as { fiscalYear: number; periodNo: number; amount: string }[];
    expect(sch.reduce((s, l) => s + Number(l.amount), 0)).toBe(120_000_000);
    expect(sch.filter((l) => l.fiscalYear === 2026 && [4, 5].includes(l.periodNo))).toEqual([]);
    expect(sch.at(-1)).toMatchObject({ fiscalYear: 2031, periodNo: 2 });
  });

  it('điều chuyển bộ phận 01/05: KH tháng 5 Nợ theo phân bổ mới; tháng 4 giữ phân bổ cũ', async () => {
    const t = await tenant();
    for (const [code, name] of [['PB1', 'Bộ phận 1'], ['PB2', 'Bộ phận 2']]) await t.ok(t.call('POST', '/api/catalogs/department', { code, name }), 201);
    const id = await t.fixed('TS01', '120000000', 60, [{ expenseAccountCode: '6422', departmentCode: 'PB1', ratio: '100' }]);
    for (const p of [1, 2, 3, 4, 5]) await t.runOk(p);
    const before = await t.runs();
    const tr = await t.ok(t.ev(id, 'transfer', { date: '2026-05-01', departmentCode: 'PB2', allocations: [{ expenseAccountCode: '6421', departmentCode: 'PB2', ratio: '100' }] }));
    const after = await t.runs();
    expect(after.find((x) => x.periodNo === 4)!.voucherId).toBe(before.find((x) => x.periodNo === 4)!.voucherId);
    expect(await t.lines(after.find((x) => x.periodNo === 4)!.voucherId!)).toEqual(['6422|2000000|0||PB1', '2141|0|2000000|TS01|']);
    expect(await t.lines(after.find((x) => x.periodNo === 5)!.voucherId!)).toEqual(['6421|2000000|0||PB2', '2141|0|2000000|TS01|']);
    expect(await t.asset(id)).toMatchObject({ departmentCode: 'PB2', allocationFrom: { year: 2026, period: 5 } });
    // Biến động muộn hơn còn hiệu lực: không hủy được điều chuyển trước khi hủy biến động đó.
    const sp = await t.ok(t.ev(id, 'suspend', { date: '2026-06-01', reason: 'x' }));
    expect(err(await t.call('POST', `/api/asset-events/${tr.eventId}/cancel`))).toEqual([409, 'ASSET_EVENT_ORDER']);
    await t.ok(t.call('POST', `/api/asset-events/${sp.eventId}/cancel`));
    await t.ok(t.call('POST', `/api/asset-events/${tr.eventId}/cancel`));
    expect(await t.asset(id)).toMatchObject({ departmentCode: null, allocationFrom: { year: 2026, period: 1 } });
    expect(await t.lines((await t.runs()).find((x) => x.periodNo === 5)!.voucherId!)).toEqual(['6422|2000000|0||PB1', '2141|0|2000000|TS01|']);
    expect(err(await t.call('POST', `/api/asset-events/${tr.eventId}/cancel`))).toEqual([409, 'ASSET_EVENT_CANCELLED']);
  });

  it('hủy ghi giảm: đảo TS, tài sản active, KH các kỳ sau chạy lại có lại tài sản', async () => {
    const t = await tenant();
    const id = await t.fixed('TS01', '120000000', 60); await t.fixed('TS02', '36000000', 36);
    for (const p of [1, 2, 3, 4]) await t.runOk(p);
    const r = await t.ok(t.ev(id, 'decrease', { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }));
    await t.ok(t.call('POST', `/api/asset-events/${r.eventId}/cancel`));
    const v = await t.voucher(r.voucherId);
    expect(v.state).toBe('reversed');
    expect(await t.count(`voucher WHERE voucher_type = 'TS' AND posting_date = '2026-03-16'`)).toBe(2);
    expect(await t.asset(id)).toMatchObject({ status: 'active', decreaseDate: null });
    for (const p of [3, 4]) expect((await t.runs()).find((x) => x.periodNo === p)!.result.lines).toEqual([{ assetCode: 'TS01', amount: '2000000' }, { assetCode: 'TS02', amount: '1000000' }]);
    expect(await t.values(id, '2026-04-30')).toEqual({ cost: '120000000', accumulated: '8000000' });
    expect(await t.ok(t.call('GET', `/api/assets/${id}/events`))).toMatchObject([{ kind: 'decrease', state: 'cancelled' }]);
  });

  it('kỳ của ngày ghi giảm đã khóa cứng → 409 PERIOD_HARD_LOCKED, không chứng từ nào được ghi', async () => {
    const t = await tenant();
    const id = await t.fixed('TS01', '120000000', 60);
    for (const p of [1, 2, 3]) await t.runOk(p);
    for (const p of [0, 1, 2, 3]) await t.ok(t.call('POST', `/api/periods/2026/${p}/lock`, { level: 'hard' }));
    expect(err(await t.ev(id, 'decrease', { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(await t.count(`voucher WHERE voucher_type = 'TS'`)).toBe(0);
    expect(await t.count(`asset_event WHERE true`)).toBe(0);
    expect(await t.asset(id)).toMatchObject({ status: 'active', decreaseDate: null });
  });
});
