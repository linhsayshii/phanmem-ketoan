import { expect } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

export type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let n = 0;

// Công ty mới năm 2026 (12 kỳ tháng), đối tượng NCC001; TSCĐ ghi nguyên giá bằng PKT ngày 01/01, khấu hao từ 01/01/2026.
export async function assetTenant(ctx: TestApp, regime: 'TT99' | 'TT133' | 'TT200' = 'TT133') {
  const { cookie } = await setupLedgerTenant(ctx, `KK${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  const fixed = async (code: string, cost: string, lifeUnits: number) => {
    const a = await ok(call('POST', '/api/assets', { code, name: `TSCĐ ${code}`, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', lifeUnits, depreciationStartDate: '2026-01-01' }), 201);
    await ok(call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
    await ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'mua tài sản', autoPost: true,
      lines: [{ accountCode: '2111', debit: cost, credit: '0', assetCode: code }, { accountCode: '331', debit: '0', credit: cost, partyCode: 'NCC001' }] }), 201);
    return a.id as number;
  };
  const runOk = (periodNo: number) => ok(call('POST', '/api/asset-runs', { kind: 'depreciation', fiscalYear: 2026, periodNo }));
  return { call, ok, fixed, runOk };
}
export { createTestApp };
