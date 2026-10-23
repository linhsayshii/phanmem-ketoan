import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string; let loanId: number;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });
const run = (periodNo: number) => call('POST', '/api/loan-runs', { fiscalYear: 2026, periodNo });
const lines = async (voucherId: string) => (await sql<{ code: string; debit: string; credit: string; cur: string; ac: string; contract: string | null; party: string | null }>`
  SELECT a.code, l.debit::text, l.credit::text, l.currency_code AS cur, l.amount_currency::text AS ac, c.code AS contract, p.code AS party
  FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN contract c ON c.id = l.contract_id LEFT JOIN party p ON p.id = l.party_id
  WHERE l.voucher_id = ${voucherId}::uuid ORDER BY l.line_no`.execute(ctx.t.admin)).rows;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `LI${Date.now()}`, 'TT99'));
  for (const [name, payload] of [['bank', { code: 'VCB', name: 'Vietcombank' }], ['bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '112' }]] as const) {
    const r = await call('POST', `/api/catalogs/${name}`, payload); if (r.statusCode !== 201) throw new Error(r.body);
  }
  const c = await call('POST', '/api/loans', { code: 'VAYA', name: 'Vay A', partyCode: 'NCC001', value: '2000000000', signedDate: '2026-01-01',
    rates: [{ validFrom: '2026-01-01', annualRate: '9' }, { validFrom: '2026-02-16', annualRate: '10' }], installments: [{ dueDate: '2026-12-31', principal: '900000000' }] });
  if (c.statusCode !== 201) throw new Error(c.body);
  loanId = c.json().id;
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('lãi vay theo kỳ (LV)', () => {
  it('giải ngân 1.000.000.000 ngày 11/01, lãi 9%/năm, 365: lãi tháng 1 = round(1e9 × 0,09 × 21/365) = 5.178.082', async () => {
    expect((await call('POST', `/api/loans/${loanId}/disburse`, { date: '2026-01-11', amount: '1000000000', bankAccountNo: '0011001' })).statusCode).toBe(201);
    const r = await run(1); expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ unchanged: false, reversedVoucherIds: [], lines: [{ loanCode: 'VAYA', interest: '5178082', interestVnd: '5178082' }] });
    const v = await ctx.t.admin.selectFrom('voucher').select(['voucher_type', 'posting_date', 'state', 'source_doc_type']).where('id', '=', r.json().voucherId).executeTakeFirstOrThrow();
    expect(v).toMatchObject({ voucher_type: 'LV', posting_date: '2026-01-31', state: 'posted', source_doc_type: 'loan_interest' });
    expect(await lines(r.json().voucherId)).toMatchObject([
      { code: '635', debit: '5178082', credit: '0', contract: null }, { code: '335', debit: '0', credit: '5178082', contract: 'VAYA', party: 'NCC001' }]);
  });

  it('chạy lại tháng 1 không đổi → unchanged; ghi lùi giải ngân thêm ngày 25/01 → chạy lại đảo LV cũ sinh mới', async () => {
    const first = (await run(1)).json();
    const again = await run(1); expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ unchanged: true, voucherId: first.voucherId, reversedVoucherIds: [] });
    expect((await call('POST', `/api/loans/${loanId}/disburse`, { date: '2026-01-25', amount: '100000000', bankAccountNo: '0011001' })).statusCode).toBe(201);
    // (1e9 × 9% × 21 + 1e8 × 9% × 7) / 365 = 1.953.000.000 / 365 = 5.350.684,93
    const re = await run(1); expect(re.statusCode, re.body).toBe(200);
    expect(re.json()).toMatchObject({ unchanged: false, reversedVoucherIds: [first.voucherId], lines: [{ loanCode: 'VAYA', interest: '5350685' }] });
    const old = await ctx.t.admin.selectFrom('voucher').select('state').where('id', '=', first.voucherId).executeTakeFirstOrThrow();
    expect(old.state).toBe('reversed');
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM period_run WHERE tenant_id = ${tenantId}::uuid AND kind = 'loan_interest' AND period_no = 1 AND status = 'active'`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
  });

  it('khế ước USD 100.000 lãi 6%, 360, tỷ giá 31/01 25.000: Có 335 nguyên tệ 500,00 (30 ngày từ 02/01), VND 12.500.000', async () => {
    for (const code of ['3411', '112']) await ctx.t.admin.updateTable('account').set({ track_currency: true }).where('tenant_id', '=', tenantId).where('regime', '=', 'TT99').where('code', '=', code).execute();
    const c = await call('POST', '/api/loans', { code: 'USDA', name: 'Vay USD', partyCode: 'NCC001', currencyCode: 'USD', dayBasis: 360, rates: [{ validFrom: '2026-01-01', annualRate: '6' }] });
    expect(c.statusCode, c.body).toBe(201);
    expect((await call('POST', `/api/loans/${c.json().id}/disburse`, { date: '2026-01-02', amount: '100000', fxRate: '24800', bankAccountNo: '0011001' })).statusCode).toBe(201);
    const miss = await run(1); expect(miss.statusCode).toBe(409); expect(miss.json().error.code).toBe('FX_RATE_MISSING');
    expect((await call('POST', '/api/catalogs/exchange_rate', { currency_code: 'USD', rate_date: '2026-01-31', rate_type: 'transfer_avg', rate: '25000' })).statusCode).toBe(201);
    const r = await run(1); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().lines).toEqual([{ loanCode: 'USDA', interest: '500.00', interestVnd: '12500000' }, { loanCode: 'VAYA', interest: '5350685', interestVnd: '5350685' }]);
    const usd = (await lines(r.json().voucherId)).filter((l) => l.contract === 'USDA' || l.debit === '12500000');
    expect(usd).toMatchObject([{ code: '635', debit: '12500000', cur: 'VND' }, { code: '335', credit: '12500000', cur: 'USD', ac: '-500.0000', contract: 'USDA' }]);
  });

  it('chạy tháng 3 khi tháng 2 chưa chạy mà có dư nợ → 409 PERIOD_RUN_GAP', async () => {
    const gap = await run(3); expect(gap.statusCode).toBe(409); expect(gap.json().error.code).toBe('PERIOD_RUN_GAP');
    // lãi suất đổi 9% → 10% từ 16/02, trả 200tr ngày 20/02: (1,1e9 × 9% × 15 + 1,1e9 × 10% × 4 + 9e8 × 10% × 9) / 365 = 7.493.150,68
    expect((await call('POST', `/api/loans/${loanId}/repay`, { date: '2026-02-20', principal: '200000000', bankAccountNo: '0011001' })).statusCode).toBe(201);
    const feb = await run(2); expect(feb.statusCode, feb.body).toBe(200);
    expect(feb.json().lines).toContainEqual({ loanCode: 'VAYA', interest: '7493151', interestVnd: '7493151' });
    expect((await run(3)).statusCode).toBe(200);
  });

  it('lãi dự tính theo lịch: tháng đã qua bằng số đã tính; kỳ trả gốc còn lại 700tr (900tr − 200tr đã trả) trừ dư nợ từ 31/12', async () => {
    const r = await call('GET', `/api/loans/${loanId}/interest-preview?from=2026-01-01&to=2026-12-31`); expect(r.statusCode, r.body).toBe(200);
    const m = r.json().months as { from: string; interest: string }[];
    expect(m.map((x) => x.interest).slice(0, 2)).toEqual(['5350685', '7493151']);
    // tháng 12: (9e8 × 10% × 30 + 2e8 × 10% × 1) / 365 = 7.452.054,79
    expect(m[11]).toMatchObject({ from: '2026-12-01', interest: '7452055' });
  });
});
