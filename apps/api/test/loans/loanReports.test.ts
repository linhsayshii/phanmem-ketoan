import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `LR${Date.now()}`, 'TT99'));
  for (const [name, payload] of [['bank', { code: 'VCB', name: 'Vietcombank' }], ['bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '112' }]] as const) {
    const r = await call('POST', `/api/catalogs/${name}`, payload); if (r.statusCode !== 201) throw new Error(r.body);
  }
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('sổ theo dõi khế ước vay', () => {
  it('đầu kỳ, giải ngân, trả gốc, lãi LV, lãi đã trả, kỳ trả kế tiếp; tổng VND khớp 3411/335 có contract_id; xuất Excel', async () => {
    const c = await call('POST', '/api/loans', { code: 'VAYR', name: 'Vay R', partyCode: 'NCC001', value: '0', signedDate: '2026-01-01', rates: [{ validFrom: '2026-01-01', annualRate: '9' }],
      installments: [{ dueDate: '2026-12-31', principal: '400000000' }] });
    expect(c.statusCode, c.body).toBe(201); const id = c.json().id as number;
    expect((await call('POST', `/api/loans/${id}/disburse`, { date: '2026-01-11', amount: '1000000000', bankAccountNo: '0011001' })).statusCode).toBe(201);
    expect((await call('POST', '/api/loan-runs', { fiscalYear: 2026, periodNo: 1 })).statusCode).toBe(200);
    expect((await call('POST', `/api/loans/${id}/repay`, { date: '2026-02-10', principal: '200000000', interest: '1000000', bankAccountNo: '0011001' })).statusCode).toBe(201);

    const r = await call('GET', '/api/loans/report?from=2026-02-01&to=2026-02-28'); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rows).toEqual([expect.objectContaining({ code: 'VAYR', openingVnd: '1000000000', drawnVnd: '0', repaidVnd: '200000000', closingVnd: '800000000', closingCur: '800000000',
      interestOpening: '5178082', interestEstimated: '0', interestPaid: '1000000', interestClosing: '4178082', nextDueDate: '2026-12-31', nextDuePrincipal: '400000000' })]);
    const jan = (await call('GET', '/api/loans/report?from=2026-01-01&to=2026-01-31')).json();
    expect(jan.rows[0]).toMatchObject({ openingVnd: '0', drawnVnd: '1000000000', repaidVnd: '0', closingVnd: '1000000000', interestEstimated: '5178082', interestClosing: '5178082' });

    const t = (await call('GET', '/api/loans/report?from=2026-01-01&to=2026-12-31')).json().totals;
    const led = (await sql<{ code: string; bal: string }>`SELECT a.code, sum(l.credit - l.debit)::text AS bal FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed')
      JOIN account a ON a.id = l.account_id WHERE l.tenant_id = ${tenantId}::uuid AND l.contract_id IS NOT NULL AND a.code IN ('3411', '335') GROUP BY a.code`.execute(ctx.t.admin)).rows;
    expect(t.closingVnd).toBe(led.find((x) => x.code === '3411')!.bal); expect(t.interestClosing).toBe(led.find((x) => x.code === '335')!.bal);

    const x = await call('GET', '/api/loans/report?from=2026-01-01&to=2026-12-31&format=xlsx'); expect(x.statusCode, x.body).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
  });

  it('từ ngày sau đến ngày: 400', async () => { expect((await call('GET', '/api/loans/report?from=2026-03-01&to=2026-02-01')).statusCode).toBe(400); });
});
