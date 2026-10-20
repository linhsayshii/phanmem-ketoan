import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, assertBalanceSheet, postVoucher, setupLedgerTenant } from './helpers.js';

let ctx: TestApp; let cookie: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie } = await setupLedgerTenant(ctx, `I4${Date.now()}`)); }, 60_000);
afterAll(async () => { await ctx.close(); });

describe('Bất biến 4: Tài sản = Nợ phải trả + Vốn chủ sở hữu', () => {
  it('chuỗi 20 chứng từ ngẫu nhiên cân tại mọi ngày kiểm tra; sau kết chuyển 911 và loại 5–9 về 0', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(arbDate2026, arbBalancedLines), { minLength: 20, maxLength: 20 }), async (vouchers) => {
      for (const [date, lines] of vouchers) { const r = await postVoucher(ctx, cookie, date, lines); expect(r.statusCode, r.body).toBe(201); }
      for (const d of ['2026-01-15', '2026-03-31', '2026-07-31', '2026-12-31']) await assertBalanceSheet(ctx, cookie, d);
    }), { numRuns: 4 });

    const run = await ctx.app.inject({ method: 'POST', url: '/api/closing/run-all', headers: { cookie }, payload: { postingDate: '2026-12-31' } });
    expect(run.statusCode, run.body).toBe(200);
    const end = await ctx.app.inject({ method: 'GET', url: '/api/balances?asOf=2026-12-31', headers: { cookie } });
    const codes = (end.json().rows as { accountCode: string }[]).map((x) => x.accountCode);
    expect(codes.filter((c) => c === '911' || /^[5-9]/.test(c))).toEqual([]);
    const { assets, liab, equity, pnl } = await assertBalanceSheet(ctx, cookie, '2026-12-31');
    expect(pnl).toBe(0n); expect(assets).toBe(liab + equity);
  }, 180_000);
});
