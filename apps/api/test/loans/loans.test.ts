import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });
const loan = (code: string, more: object = {}) => ({
  code, name: `Vay ${code}`, partyCode: 'NCC001', value: '2000000000', signedDate: '2026-01-01', validTo: '2028-12-31',
  rates: [{ validFrom: '2026-01-01', annualRate: '9.5' }],
  installments: ['2027-03-31', '2027-12-31', '2028-03-31', '2028-12-31'].map((dueDate) => ({ dueDate, principal: '250000000' })), ...more,
});
const lines = async (voucherId: string) => (await sql<{ code: string; debit: string; credit: string; contract: string | null }>`SELECT a.code, l.debit::text, l.credit::text, c.code AS contract
  FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN contract c ON c.id = l.contract_id WHERE l.voucher_id = ${voucherId}::uuid ORDER BY l.line_no`.execute(ctx.t.admin)).rows;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `LN${Date.now()}`, 'TT99'));
  for (const [name, payload] of [['bank', { code: 'VCB', name: 'Vietcombank' }], ['bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '112' }]] as const) {
    const r = await call('POST', `/api/catalogs/${name}`, payload); if (r.statusCode !== 201) throw new Error(r.body);
  }
  const def = [
    { lineCode: '311', label: 'Vay ngắn hạn', parentLineCode: null, source: 'balance', side: 'net_credit', formula: '3411-LT(3411)' },
    { lineCode: '338', label: 'Vay dài hạn', parentLineCode: null, source: 'balance', side: 'net_credit', formula: 'LT(3411)' },
  ];
  const r = await call('PUT', '/api/report-defs/B01', { regime: 'TT99', lines: def }); if (r.statusCode !== 200) throw new Error(r.body);
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('khế ước vay', () => {
  it('giải ngân 1 tỷ qua ngân hàng: BC Nợ 112 / Có 3411 gắn khế ước; vượt hạn mức 409 LOAN_LIMIT', async () => {
    const c = await call('POST', '/api/loans', loan('VAY01')); expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as number;
    const d = await call('POST', `/api/loans/${id}/disburse`, { date: '2026-01-15', amount: '1000000000', bankAccountNo: '0011001' });
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json()).toMatchObject({ voucherType: 'BC', state: 'posted' });
    expect(await lines(d.json().id)).toEqual([
      { code: '112', debit: '1000000000', credit: '0', contract: null }, { code: '3411', debit: '0', credit: '1000000000', contract: 'VAY01' }]);
    const over = await call('POST', `/api/loans/${id}/disburse`, { date: '2026-01-20', amount: '1000000001', bankAccountNo: '0011001' });
    expect(over.statusCode).toBe(409); expect(over.json().error.code).toBe('LOAN_LIMIT');
    expect((await call('GET', `/api/loans/${id}`)).json()).toMatchObject({ outstanding: '1000000000', drawn: '1000000000' });
    expect((await call('GET', '/api/lookups/contracts?kind=loan&q=VAY')).json().map((x: { code: string }) => x.code)).toContain('VAY01');
  });

  it('B01 TT99 31/12/2026: phần dài hạn theo lịch trả gốc, không theo hạn ở dòng', async () => {
    const r = await call('GET', '/api/reports/financial/B01?from=2026-01-01&to=2026-12-31'); expect(r.statusCode, r.body).toBe(200);
    const row = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c).current;
    expect(row('338')).toBe('500000000'); expect(row('311')).toBe('500000000');
  });

  it('trả gốc 250tr: dư 750tr; trả vượt dư nợ 409; tất toán khi còn dư nợ 409 LOAN_OUTSTANDING; xóa khi đã có bút toán 409', async () => {
    const id = (await call('GET', '/api/loans')).json().find((x: { code: string }) => x.code === 'VAY01').id as number;
    const p = await call('POST', `/api/loans/${id}/repay`, { date: '2026-06-30', principal: '250000000', bankAccountNo: '0011001' });
    expect(p.statusCode, p.body).toBe(201); expect(p.json().voucherType).toBe('BN');
    expect((await call('POST', `/api/loans/${id}/repay`, { date: '2026-07-01', principal: '900000000', bankAccountNo: '0011001' })).json().error.code).toBe('LOAN_OVERPAY');
    expect((await call('GET', `/api/loans/${id}`)).json().outstanding).toBe('750000000');
    const s = await call('POST', `/api/loans/${id}/settle`); expect(s.statusCode).toBe(409); expect(s.json().error.code).toBe('LOAN_OUTSTANDING');
    const del = await call('DELETE', `/api/loans/${id}`); expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('LOAN_IN_USE');
  });

  it('tất toán khi hết nợ: status terminated, không giải ngân thêm', async () => {
    const c = await call('POST', '/api/loans', loan('VAY02', { value: '0', installments: [] })); const id = c.json().id as number;
    await call('POST', `/api/loans/${id}/disburse`, { date: '2026-02-01', amount: '100000000', bankAccountNo: '0011001' });
    await call('POST', `/api/loans/${id}/repay`, { date: '2026-03-01', principal: '100000000', bankAccountNo: '0011001' });
    const s = await call('POST', `/api/loans/${id}/settle`); expect(s.statusCode, s.body).toBe(200); expect(s.json().status).toBe('terminated');
    expect((await call('POST', `/api/loans/${id}/disburse`, { date: '2026-04-01', amount: '1', bankAccountNo: '0011001' })).json().error.code).toBe('LOAN_TERMINATED');
  });

  it('số dư đầu kỳ 3411 gắn khế ước: dòng DK có contract_id; B01 tách theo lịch', async () => {
    const c = await call('POST', '/api/loans', loan('VAY03', { value: '0', installments: [{ dueDate: '2027-06-30', principal: '100000000' }, { dueDate: '2028-06-30', principal: '200000000' }] }));
    expect(c.statusCode, c.body).toBe(201);
    const row = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', ...more });
    const bad = await call('PUT', '/api/opening-balance/2026', { rows: [row('111', '300000000', '0', { contractCode: 'VAY03' }), row('3411', '0', '300000000')] });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('OPENING_CONTRACT_NOT_ALLOWED');
    const put = await call('PUT', '/api/opening-balance/2026', { rows: [row('111', '300000000', '0'), row('3411', '0', '300000000', { contractCode: 'VAY03' })] });
    expect(put.statusCode, put.body).toBe(200);
    expect((await call('POST', '/api/opening-balance/2026/post')).statusCode).toBe(200);
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM voucher_line l JOIN contract c ON c.id = l.contract_id WHERE c.code = 'VAY03' AND c.tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
    // 31/12/2026: hạn cắt 31/12/2027; kỳ 30/06/2027 ngắn hạn (100tr), kỳ 30/06/2028 dài hạn (200tr); cộng VAY01 (dài hạn 500tr, ngắn hạn 250tr sau khi trả 250tr)
    const r = await call('GET', '/api/reports/financial/B01?from=2026-01-01&to=2026-12-31');
    const v = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c).current;
    expect(v('338')).toBe('700000000'); expect(v('311')).toBe('350000000');
  });
});
