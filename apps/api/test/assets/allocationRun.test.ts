import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('phân bổ công cụ dụng cụ, chi phí trả trước theo kỳ (PB)', () => {
  it('CCDC CC01 Nợ 242 6.000.000, 3 kỳ từ kỳ 1: PB kỳ 1–3 mỗi kỳ 2.000.000 Nợ 6273 / Có 242 CC01; kỳ 4 không còn', async () => {
    const { cookie } = await setupLedgerTenant(ctx, `PB${Date.now()}`, 'TT200');
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
    const a = await ok(call('POST', '/api/assets', { code: 'CC01', name: 'Máy khoan', kind: 'tool', assetAccountCode: '242', depreciationStartDate: '2026-01-05', lifeUnits: 3 }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6273', ratio: '100' }] }));
    await ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'mua CCDC', autoPost: true,
      lines: [{ accountCode: '242', debit: '6000000', credit: '0', assetCode: 'CC01' }, { accountCode: '331', debit: '0', credit: '6000000', partyCode: 'NCC001' }] }), 201);
    const run = (kind: string, periodNo: number) => ok(call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo }));
    for (const p of [1, 2, 3]) {
      const r = await run('tool', p);
      expect(r.lines).toEqual([{ assetCode: 'CC01', amount: '2000000' }]);
      const v = await ok(call('GET', `/api/vouchers/${r.voucherId}`));
      expect(v).toMatchObject({ voucherType: 'PB', state: 'posted' });
      expect(v.lines.map((l: { accountCode: string; debit: string; credit: string; assetCode: string | null }) => [l.accountCode, l.debit, l.credit, l.assetCode]))
        .toEqual([['6273', '2000000', '0', null], ['242', '0', '2000000', 'CC01']]);
    }
    expect(await run('tool', 4)).toMatchObject({ voucherId: null, lines: [] });
    expect(await run('prepaid', 1)).toMatchObject({ voucherId: null, lines: [] }); // CCDC không thuộc lần chạy chi phí trả trước
    const sch = await ok(call('GET', `/api/assets/${a.id}/schedule`));
    expect(sch.map((l: { periodNo: number; amount: string; accumulated: string }) => [l.periodNo, l.amount, l.accumulated])).toEqual([[1, '2000000', '2000000'], [2, '2000000', '4000000'], [3, '2000000', '6000000']]);
  });
});
