import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

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

  it('khế ước USD: dòng có loại tiền và dư nợ nguyên tệ + VND; số dư đầu kỳ (DK) tính vào đầu kỳ', async () => {
    for (const code of ['3411', '112']) await ctx.t.admin.updateTable('account').set({ track_currency: true }).where('tenant_id', '=', tenantId).where('regime', '=', 'TT99').where('code', '=', code).execute();
    const u = await call('POST', '/api/loans', { code: 'USDR', name: 'Vay USD R', partyCode: 'NCC001', currencyCode: 'USD', value: '0', signedDate: '2026-01-01', rates: [{ validFrom: '2026-01-01', annualRate: '6' }] });
    expect(u.statusCode, u.body).toBe(201);
    expect((await call('POST', `/api/loans/${u.json().id}/disburse`, { date: '2026-01-02', amount: '100000', fxRate: '24800', bankAccountNo: '0011001' })).statusCode).toBe(201);
    const d = await call('POST', '/api/loans', { code: 'VAYD', name: 'Vay DK', partyCode: 'NCC001', value: '0', signedDate: '2025-01-01' }); expect(d.statusCode, d.body).toBe(201);
    const row = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', ...more });
    expect((await call('PUT', '/api/opening-balance/2026', { rows: [row('111', '300000000', '0'), row('3411', '0', '300000000', { contractCode: 'VAYD' })] })).statusCode).toBe(200);
    expect((await call('POST', '/api/opening-balance/2026/post')).statusCode).toBe(200);
    const rows = (await call('GET', '/api/loans/report?from=2026-01-01&to=2026-01-31')).json().rows as Record<string, string>[];
    const usd = rows.find((x) => x.code === 'USDR')!; const dk = rows.find((x) => x.code === 'VAYD')!;
    expect(usd).toMatchObject({ currency: 'USD', openingVnd: '0', drawnVnd: '2480000000', closingVnd: '2480000000' });
    expect(Number(usd.drawnCur)).toBe(100000); expect(Number(usd.closingCur)).toBe(100000);
    expect(dk).toMatchObject({ openingVnd: '300000000', drawnVnd: '0', closingVnd: '300000000' });
  });

  it('người dùng không có view_payable: 403 trên báo cáo và danh sách khế ước', async () => {
    const username = `lr_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    for (const url of ['/api/loans/report?from=2026-01-01&to=2026-01-31', '/api/loans']) {
      const r = await ctx.app.inject({ method: 'GET', url, headers: { cookie: c } }); expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error.message).toContain('công nợ phải trả');
    }
  });

  it('từ ngày sau đến ngày: 400', async () => { expect((await call('GET', '/api/loans/report?from=2026-03-01&to=2026-02-01')).statusCode).toBe(400); });
});
