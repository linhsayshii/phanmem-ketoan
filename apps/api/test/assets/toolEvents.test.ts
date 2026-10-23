import { D } from '@kt/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];

async function tenant() {
  const { cookie } = await setupLedgerTenant(ctx, `CC${Date.now()}${n++}`, 'TT200');
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  // Thẻ + ghi nguyên giá 242 bằng PKT ngày 01/01/2026; phân bổ Nợ 6273.
  const card = async (kind: 'tool' | 'prepaid', code: string, cost: string, lifeUnits: number, start: string, quantity = '1') => {
    const a = await ok(call('POST', '/api/assets', { code, name: code, kind, assetAccountCode: '242', depreciationStartDate: start, lifeUnits, quantity }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6273', ratio: '100' }] }));
    await ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'mua', autoPost: true,
      lines: [{ accountCode: '242', debit: cost, credit: '0', assetCode: code }, { accountCode: '331', debit: '0', credit: cost, partyCode: 'NCC001' }] }), 201);
    return a.id as number;
  };
  const run = (kind: string, periodNo: number) => ok(call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo }));
  const ev = (id: number, action: string, body: object) => call('POST', `/api/assets/${id}/${action}`, body);
  const sched = async (id: number) => (await ok(call('GET', `/api/assets/${id}/schedule`))) as { fiscalYear: number; periodNo: number; amount: string }[];
  return { call, ok, card, run, ev, sched };
}

describe('biến động CCDC, chi phí trả trước', () => {
  it('10 CCDC 12.000.000, 12 kỳ; sau 3 kỳ giảm 4 cái: ghi giảm 3.600.000; kỳ sau phân bổ 5.400.000 / 9; hủy khôi phục', async () => {
    const t = await tenant();
    const id = await t.card('tool', 'CC01', '12000000', 12, '2026-01-01', '10');
    for (const p of [1, 2, 3]) await t.run('tool', p);
    const r = await t.ok(t.ev(id, 'decrease-tool', { date: '2026-04-10', quantity: '4', counterAccountCode: '811' }));
    expect(r.value).toBe('3600000');
    const v = await t.ok(t.call('GET', `/api/vouchers/${r.voucherId}`));
    expect(v.lines.map((l: any) => [l.accountCode, l.debit, l.credit, l.assetCode])).toEqual([['811', '3600000', '0', null], ['242', '0', '3600000', 'CC01']]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await t.ok(t.call('GET', `/api/assets/${id}`))).toMatchObject({ quantity: '6.0000', status: 'active' });
    expect((await t.run('tool', 4)).lines).toEqual([{ assetCode: 'CC01', amount: '600000' }]);
    const sch = await t.sched(id);
    expect(sch.slice(0, 3).map((l) => l.amount)).toEqual(['1000000', '1000000', '1000000']);
    expect(sch.slice(3).map((l) => l.amount)).toEqual(Array(9).fill('600000'));
    // Hủy: số lượng về 10; kỳ 4 chạy lại 1.000.000.
    await t.ok(t.call('POST', `/api/asset-events/${r.eventId}/cancel`));
    expect(await t.ok(t.call('GET', `/api/assets/${id}`))).toMatchObject({ quantity: '10.0000' });
    expect((await t.ok(t.call('GET', '/api/asset-runs?kind=tool&year=2026')) as { periodNo: number; status: string; result: { lines: unknown[] } }[]).find((x) => x.periodNo === 4 && x.status === 'active')!.result.lines).toEqual([{ assetCode: 'CC01', amount: '1000000' }]);
  });

  it('CPTT tiền thuê 36.000.000, 12 kỳ từ kỳ 2: kỳ 1 không phân bổ; kỳ 2/2026 đến kỳ 1/2027 mỗi kỳ 3.000.000', async () => {
    const t = await tenant();
    const id = await t.card('prepaid', 'TT01', '36000000', 12, '2026-02-01');
    expect(await t.run('prepaid', 1)).toMatchObject({ voucherId: null, lines: [] });
    for (const p of [2, 3]) expect((await t.run('prepaid', p)).lines).toEqual([{ assetCode: 'TT01', amount: '3000000' }]);
    const sch = await t.sched(id);
    expect(sch).toHaveLength(12);
    expect(sch.every((l) => l.amount === '3000000')).toBe(true);
    expect(sch[0]).toMatchObject({ fiscalYear: 2026, periodNo: 2 });
    expect(sch.at(-1)).toMatchObject({ fiscalYear: 2027, periodNo: 1 });
    expect(err(await t.ev(id, 'decrease-tool', { date: '2026-04-10', quantity: '1', counterAccountCode: '811' }))).toEqual([400, 'VALIDATION']);
  });

  it('điều chỉnh tăng 600.000 ở kỳ 4 còn 9 kỳ: phiên bản mới, tổng phân bổ = tổng giá trị; giảm quá mức → 400', async () => {
    const t = await tenant();
    const id = await t.card('tool', 'CC01', '12000000', 12, '2026-01-01');
    for (const p of [1, 2, 3]) await t.run('tool', p);
    const adj = await t.ok(t.ev(id, 'adjust-value', { date: '2026-04-05', delta: '600000', counterAccountCode: '331', partyCode: 'NCC001' }));
    const side = async (vid: string) => (await t.ok(t.call('GET', `/api/vouchers/${vid}`))).lines.map((l: any) => [l.accountCode, l.debit, l.credit, l.assetCode]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await side(adj.voucherId)).toEqual([['242', '600000', '0', 'CC01'], ['331', '0', '600000', null]]);
    expect((await t.run('tool', 4)).lines).toEqual([{ assetCode: 'CC01', amount: '1066667' }]); // (9.000.000 + 600.000) / 9
    expect((await t.sched(id)).reduce((s, l) => s.plus(l.amount), D(0)).toFixed(0)).toBe('12600000');
    const neg = await t.ok(t.ev(id, 'adjust-value', { date: '2026-04-06', delta: '-100000', counterAccountCode: '1111' }));
    expect(await side(neg.voucherId)).toEqual([['242', '0', '100000', 'CC01'], ['1111', '100000', '0', null]]);
    expect(err(await t.ev(id, 'adjust-value', { date: '2026-04-06', delta: '-9500001', counterAccountCode: '1111' }))).toEqual([400, 'VALIDATION']);
  });

  it('điều chỉnh khi kỳ trước chưa chạy PB → 409 PERIOD_RUN_GAP; lịch đã hết kỳ mà tăng giá trị → 400 ASSET_SCHEDULE_ENDED; số lượng 0 → 400', async () => {
    const t = await tenant();
    const id = await t.card('tool', 'CC01', '12000000', 12, '2026-01-01', '10');
    expect(err(await t.ev(id, 'adjust-value', { date: '2026-02-05', delta: '-1000', counterAccountCode: '1111' }))).toEqual([409, 'PERIOD_RUN_GAP']);
    expect(err(await t.ev(id, 'decrease-tool', { date: '2026-02-05', quantity: '0', counterAccountCode: '811' }))).toEqual([400, 'VALIDATION']);
    const s = await tenant();
    const sid = await s.card('tool', 'CC02', '3000000', 3, '2026-01-01');
    for (const p of [1, 2, 3]) await s.run('tool', p);
    expect(err(await s.ev(sid, 'adjust-value', { date: '2026-04-05', delta: '1000', counterAccountCode: '1111' }))).toEqual([400, 'ASSET_SCHEDULE_ENDED']);
  });

  it('giảm 11 cái khi còn 10 → 400 ASSET_QUANTITY; giảm hết → thẻ đã giảm', async () => {
    const t = await tenant();
    const id = await t.card('tool', 'CC01', '12000000', 12, '2026-01-01', '10');
    expect(err(await t.ev(id, 'decrease-tool', { date: '2026-01-20', quantity: '11', counterAccountCode: '811' }))).toEqual([400, 'ASSET_QUANTITY']);
    const r = await t.ok(t.ev(id, 'decrease-tool', { date: '2026-01-20', counterAccountCode: '811' }));
    expect(r.value).toBe('12000000');
    expect(await t.ok(t.call('GET', `/api/assets/${id}`))).toMatchObject({ status: 'decreased', decreaseDate: '2026-01-20' });
  });

  it('hủy ghi giảm chuyển CCDC bị chặn (409) khi thẻ CCDC đã có biến động', async () => {
    const t = await tenant();
    const fx = await t.ok(t.call('POST', '/api/assets', { code: 'TS01', name: 'TS', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', lifeUnits: 60, depreciationStartDate: '2026-01-01' }), 201);
    await t.ok(t.call('PUT', `/api/assets/${fx.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
    await t.ok(t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'mua', autoPost: true,
      lines: [{ accountCode: '2111', debit: '12000000', credit: '0', assetCode: 'TS01' }, { accountCode: '331', debit: '0', credit: '12000000', partyCode: 'NCC001' }] }), 201);
    await t.run('depreciation', 1);
    const d = await t.ok(t.ev(fx.id, 'decrease', { date: '2026-02-10', reason: 'to_tool', toolCard: { code: 'CC09', name: 'CC', periods: 12, allocations: [{ expenseAccountCode: '6422', ratio: '100' }] } }));
    const cc = (await t.ok(t.call('GET', '/api/assets?kind=tool')))[0];
    await t.ok(t.ev(cc.id, 'adjust-value', { date: '2026-03-05', delta: '1000', counterAccountCode: '1111' }));
    expect(err(await t.call('POST', `/api/asset-events/${d.eventId}/cancel`))).toEqual([409, 'ASSET_EVENT_ORDER']);
  });
});
