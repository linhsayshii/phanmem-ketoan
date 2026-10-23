import { D } from '@kt/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any; rawPayload: Buffer; headers: Record<string, unknown> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const pkt = { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'mua', autoPost: true };

async function tenant(regime: 'TT133' | 'TT99' | 'TT200' = 'TT133') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `BC${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  const card = async (kind: 'fixed' | 'tool' | 'prepaid', code: string, cost: string, lifeUnits: number, acct = '2111', quantity = '1') => {
    const a = await ok(call('POST', '/api/assets', { code, name: `Tài sản ${code}`, kind, assetAccountCode: acct, ...(kind === 'fixed' ? { depreciationAccountCode: '2141' } : { quantity }), depreciationStartDate: '2026-01-01', lifeUnits }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: kind === 'fixed' ? '6422' : '6273', ratio: '100' }] }));
    await ok(call('POST', '/api/vouchers', { ...pkt, lines: [{ accountCode: acct, debit: cost, credit: '0', assetCode: code }, { accountCode: '331', debit: '0', credit: cost, partyCode: 'NCC001' }] }), 201);
    return a.id as number;
  };
  const run = (kind: string, periodNo: number) => ok(call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo }));
  const sum = async (accounts: string[], to: string, side: 'debit' | 'credit', onlyAsset = false) => (await sql<{ s: string }>`
    SELECT COALESCE(sum(l.${sql.raw(side)}), 0)::text AS s FROM voucher_line l JOIN voucher v ON v.tenant_id = l.tenant_id AND v.id = l.voucher_id
    JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND v.posting_date <= ${to}::date AND a.code IN (${sql.join(accounts)}) AND (${onlyAsset} = false OR l.asset_id IS NOT NULL)`.execute(ctx.t.admin)).rows[0]!.s;
  return { call, ok, card, run, sum, tenantId };
}

describe('sổ, thẻ, bảng và báo cáo tài sản', () => {
  it('báo cáo tăng giảm: tổng còn lại cuối kỳ = số dư 2111 − 2141 tại ngày cuối', async () => {
    const t = await tenant();
    await t.card('fixed', 'TS01', '120000000', 60); await t.card('fixed', 'TS02', '36000000', 36);
    for (const p of [1, 2, 3]) await t.run('depreciation', p);
    const r = await t.ok(t.call('GET', '/api/asset-reports/movement?kind=fixed&from=2026-01-01&to=2026-03-31'));
    const cost = D(await t.sum(['2111'], '2026-03-31', 'debit')).minus(await t.sum(['2111'], '2026-03-31', 'credit'));
    const acc = D(await t.sum(['2141'], '2026-03-31', 'credit')).minus(await t.sum(['2141'], '2026-03-31', 'debit'));
    expect(r.totals.closingCost).toBe(cost.toFixed(0));
    expect(r.totals.closingAccumulated).toBe(acc.toFixed(0));
    expect(r.totals.closingNet).toBe(cost.minus(acc).toFixed(0));
    expect(r.totals.openingNet).toBe('0');
  });

  it('06-TSCĐ kỳ 3: tổng = Có 2141 của chứng từ KH kỳ 3; phần giảm có TS01 khi bị ghi giảm', async () => {
    const t = await tenant();
    const id = await t.card('fixed', 'TS01', '120000000', 60); await t.card('fixed', 'TS02', '36000000', 36);
    for (const p of [1, 2]) await t.run('depreciation', p);
    await t.ok(t.call('POST', `/api/assets/${id}/decrease`, { date: '2026-03-16', reason: 'liquidation', counterAccountCode: '811' }));
    await t.run('depreciation', 3);
    const runs = (await t.ok(t.call('GET', '/api/asset-runs?kind=depreciation&year=2026'))) as { periodNo: number; status: string; voucherId: string }[];
    const v = await t.ok(t.call('GET', `/api/vouchers/${runs.find((x) => x.periodNo === 3 && x.status === 'active')!.voucherId}`));
    const credit = (v.lines as { accountCode: string; credit: string }[]).filter((l) => l.accountCode === '2141').reduce((s, l) => s.plus(l.credit), D(0));
    const s = await t.ok(t.call('GET', '/api/asset-reports/depreciation-sheet?fiscalYear=2026&periodNo=3'));
    expect(s.total).toBe(credit.toFixed(0));
    expect(s.rows[3].depreciation).toBe(s.total);
    expect(s.decreases.map((x: { assetCode: string }) => x.assetCode)).toContain('TS01');
    // I + II − III = IV
    const [prev, inc, dec, cur] = s.rows.map((x: { depreciation: string }) => D(x.depreciation));
    expect(prev.plus(inc).minus(dec).toFixed(0)).toBe(cur.toFixed(0));
  });

  it('in sổ TSCĐ: TT99 có "Mẫu số S21-DN", TT133 "S09-DNN", TT200 không có dòng "Mẫu số"; xlsx và quyền', async () => {
    const q = '/api/asset-reports/register?kind=fixed&from=2026-01-01&to=2026-12-31&format=html';
    const t99 = await tenant('TT99');
    expect((await t99.call('GET', q)).body).toContain('Mẫu số S21-DN');
    const t133 = await tenant('TT133');
    expect((await t133.call('GET', q)).body).toContain('Mẫu số S09-DNN');
    const t200 = await tenant('TT200');
    const h = await t200.call('GET', q);
    expect(h.statusCode, h.body).toBe(200);
    expect(h.body).not.toContain('Mẫu số');
    const x = await t200.call('GET', q.replace('html', 'xlsx'));
    expect(x.statusCode).toBe(200);
    expect(String(x.headers['content-type'])).toContain('spreadsheetml');
  });

  it('sổ CCDC: còn lại cuối kỳ = Σ dòng 242 có asset_id; các báo cáo còn lại trả JSON và in được', async () => {
    const t = await tenant('TT200');
    await t.card('tool', 'CC01', '12000000', 12, '242', '10'); await t.card('prepaid', 'CP01', '6000000', 6, '242');
    for (const p of [1, 2, 3]) { await t.run('tool', p); await t.run('prepaid', p); }
    const r = await t.ok(t.call('GET', '/api/asset-reports/tool-register?kind=tool&from=2026-01-01&to=2026-03-31'));
    const left = D(await t.sum(['242'], '2026-03-31', 'debit', true)).minus(await t.sum(['242'], '2026-03-31', 'credit', true));
    const p = await t.ok(t.call('GET', '/api/asset-reports/tool-register?kind=prepaid&from=2026-01-01&to=2026-03-31'));
    expect(D(r.totals.remaining).plus(p.totals.remaining).toFixed(0)).toBe(left.toFixed(0));
    expect(r.rows[0]).toMatchObject({ assetCode: 'CC01', initial: '12000000', allocatedPeriod: '3000000', allocatedTotal: '3000000' });
    const sh = await t.ok(t.call('GET', '/api/asset-reports/allocation-sheet?fiscalYear=2026&periodNo=3'));
    expect(sh.totals.total).toBe('2000000'); // CCDC 1.000.000 + CPTT 1.000.000
    for (const u of ['allocation-sheet?fiscalYear=2026&periodNo=3', 'movement?kind=tool&from=2026-01-01&to=2026-03-31', 'tool-register?kind=tool&from=2026-01-01&to=2026-03-31', 'by-location?from=2026-01-01&to=2026-03-31', 'register?kind=fixed&from=2026-01-01&to=2026-03-31', 'depreciation-sheet?fiscalYear=2026&periodNo=3'])
      for (const f of ['html', 'xlsx']) expect((await t.call('GET', `/api/asset-reports/${u}&format=${f}`)).statusCode, u + f).toBe(200);
  });

  it('thẻ TSCĐ: JSON và in', async () => {
    const t = await tenant('TT133');
    const id = await t.card('fixed', 'TS01', '120000000', 60);
    await t.run('depreciation', 1);
    const c = await t.ok(t.call('GET', `/api/asset-reports/card/${id}?to=2026-03-31`));
    expect(c.asset.code).toBe('TS01');
    const h = await t.call('GET', `/api/asset-reports/card/${id}?to=2026-03-31&format=html`);
    expect(h.body).toContain('Mẫu số S11-DNN');
  });
});
