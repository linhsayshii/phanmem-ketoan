import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { D } from '@kt/domain';
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

  it('B01 TT99 31/12/2026: phần dài hạn theo lịch trả gốc, không theo hạn ở dòng; cộng với khoản 3411 chưa có khế ước', async () => {
    const x = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-02-01', documentDate: '2026-02-01', description: 'vay chưa vào khế ước', autoPost: true,
      lines: [{ accountCode: '111', debit: '50000000', credit: '0' }, { accountCode: '3411', debit: '0', credit: '50000000', dueDate: '2029-06-30' }] });
    expect(x.statusCode, x.body).toBe(201);
    const r = await call('GET', '/api/reports/financial/B01?from=2026-01-01&to=2026-12-31'); expect(r.statusCode, r.body).toBe(200);
    const row = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c).current;
    expect(row('338')).toBe('550000000'); expect(row('311')).toBe('500000000');
  });

  it('trả gốc 250tr: dư 750tr; trả vượt dư nợ 409; tất toán khi còn dư nợ 409 LOAN_OUTSTANDING; xóa khi đã có bút toán 409', async () => {
    const id = (await call('GET', '/api/loans')).json().find((x: { code: string }) => x.code === 'VAY01').id as number;
    const p = await call('POST', `/api/loans/${id}/repay`, { date: '2026-06-30', principal: '250000000', bankAccountNo: '0011001' });
    expect(p.statusCode, p.body).toBe(201); expect(p.json().voucherType).toBe('BN');
    expect((await call('POST', `/api/loans/${id}/repay`, { date: '2026-07-01', principal: '900000000', bankAccountNo: '0011001' })).json().error.code).toBe('LOAN_OVERPAY');
    // trả trước ngày giải ngân đầu tiên: dư nợ tại ngày trả bằng 0 nên bị chặn (trước đây nhận và làm lỗi chạy lãi vay)
    const early = await call('POST', `/api/loans/${id}/repay`, { date: '2026-01-10', principal: '1', bankAccountNo: '0011001' });
    expect(early.statusCode).toBe(409); expect(early.json().error.code).toBe('LOAN_OVERPAY');
    // trả lùi ngày: dư nợ ngày 2026-03-01 đủ 800tr nhưng sẽ làm số dư sau lần trả 2026-06-30 âm (750tr) nên bị chặn
    const back = await call('POST', `/api/loans/${id}/repay`, { date: '2026-03-01', principal: '800000000', bankAccountNo: '0011001' });
    expect(back.statusCode).toBe(409); expect(back.json().error.code).toBe('LOAN_OVERPAY');
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
    const c4 = await call('POST', '/api/loans', loan('VAY04', { value: '0', installments: ['2025-06-30', '2025-12-31', '2026-06-30', '2026-12-31', '2027-06-30', '2027-12-31'].map((dueDate) => ({ dueDate, principal: '150000000' })) }));
    expect(c4.statusCode, c4.body).toBe(201);
    const row = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', ...more });
    const bad = await call('PUT', '/api/opening-balance/2026', { rows: [row('111', '300000000', '0', { contractCode: 'VAY03' }), row('3411', '0', '300000000')] });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('OPENING_CONTRACT_NOT_ALLOWED');
    const put = await call('PUT', '/api/opening-balance/2026', { rows: [row('111', '900000000', '0'), row('3411', '0', '300000000', { contractCode: 'VAY03' }), row('3411', '0', '600000000', { contractCode: 'VAY04' })] });
    expect(put.statusCode, put.body).toBe(200);
    expect((await call('POST', '/api/opening-balance/2026/post')).statusCode).toBe(200);
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM voucher_line l JOIN contract c ON c.id = l.contract_id WHERE c.code = 'VAY03' AND c.tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
    // 31/12/2026: hạn cắt 31/12/2027; kỳ 30/06/2027 ngắn hạn (100tr), kỳ 30/06/2028 dài hạn (200tr); cộng VAY01 (dài hạn 500tr, ngắn hạn 250tr sau khi trả 250tr)
    const r = await call('GET', '/api/reports/financial/B01?from=2026-01-01&to=2026-12-31');
    const v = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c).current;
    expect(v('338')).toBe('750000000'); expect(v('311')).toBe('950000000');
    // đầu năm (31/12/2025): VAY04 đã trả hai kỳ trước khi dùng phần mềm (lịch đầy đủ của ngân hàng): ngắn hạn 300tr, dài hạn 300tr; VAY03 dài hạn 300tr
    const prev = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c).previous;
    expect(prev('338')).toBe('600000000'); expect(prev('311')).toBe('300000000');
  });

  it('khế ước nháp không giải ngân; tất toán bị chặn khi chỉ còn lãi phải trả 335', async () => {
    const d = await call('POST', '/api/loans', loan('VAY05', { status: 'draft' })); const id = d.json().id as number;
    const r = await call('POST', `/api/loans/${id}/disburse`, { date: '2026-05-01', amount: '1000', bankAccountNo: '0011001' });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('LOAN_DRAFT');
    await call('PUT', `/api/loans/${id}`, loan('VAY05', { status: 'active' }));
    const x = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-05-31', documentDate: '2026-05-31', description: 'trích lãi', autoPost: true,
      lines: [{ accountCode: '635', debit: '1000000', credit: '0' }, { accountCode: '335', debit: '0', credit: '1000000', partyCode: 'NCC001', contractCode: 'VAY05' }] });
    expect(x.statusCode, x.body).toBe(201);
    const s = await call('POST', `/api/loans/${id}/settle`); expect(s.statusCode).toBe(409); expect(s.json().error.code).toBe('LOAN_OUTSTANDING');
  });

  it('khế ước USD: cần tài khoản bật theo dõi ngoại tệ; giải ngân ghi nguyên tệ + tỷ giá; hạn mức so sánh bằng USD', async () => {
    const usd = loan('USD01', { currencyCode: 'USD', value: '100000', installments: [] });
    const no = await call('POST', '/api/loans', usd); expect(no.statusCode).toBe(400); expect(no.json().error.code).toBe('LOAN_CURRENCY_NOT_TRACKED');
    for (const code of ['3411', '112']) await ctx.t.admin.updateTable('account').set({ track_currency: true }).where('tenant_id', '=', tenantId).where('regime', '=', 'TT99').where('code', '=', code).execute();
    const c = await call('POST', '/api/loans', usd); expect(c.statusCode, c.body).toBe(201); const id = c.json().id as number;
    const d = await call('POST', `/api/loans/${id}/disburse`, { date: '2026-08-01', amount: '60000', fxRate: '25000', bankAccountNo: '0011001' });
    expect(d.statusCode, d.body).toBe(201);
    expect(await lines(d.json().id)).toMatchObject([{ code: '112', debit: '1500000000' }, { code: '3411', credit: '1500000000', contract: 'USD01' }]);
    expect((await call('GET', `/api/loans/${id}`)).json()).toMatchObject({ outstanding: '60000', drawn: '60000' });
    const over = await call('POST', `/api/loans/${id}/disburse`, { date: '2026-08-02', amount: '40001', fxRate: '25000', bankAccountNo: '0011001' });
    expect(over.statusCode).toBe(409); expect(over.json().error.code).toBe('LOAN_LIMIT');
    expect((await call('POST', `/api/loans/${id}/disburse`, { date: '2026-08-02', amount: '40000', fxRate: '25000', bankAccountNo: '0011001' })).statusCode).toBe(201);
    const rp = await call('POST', `/api/loans/${id}/repay`, { date: '2026-09-01', principal: '10000', fxRate: '25100', bankAccountNo: '0011001' });
    expect(rp.statusCode, rp.body).toBe(201);
    expect((await call('GET', `/api/loans/${id}`)).json().outstanding).toBe('90000');
  });

  it('trả nợ khế ước USD: Nợ 3411/335 theo tỷ giá ghi sổ bình quân, Có 112 theo tỷ giá trả, chênh lệch 635/515; trả hết thì 3411 của khế ước về 0 cả VND và nguyên tệ', async () => {
    const c = await call('POST', '/api/loans', loan('USD02', { currencyCode: 'USD', value: '0', installments: [] })); expect(c.statusCode, c.body).toBe(201); const id = c.json().id as number;
    for (const [date, amount, fxRate] of [['2026-08-01', '60000', '25000'], ['2026-08-05', '40000', '25500']]) // bình quân 2.520.000.000 / 100.000 = 25.200
      expect((await call('POST', `/api/loans/${id}/disburse`, { date, amount, fxRate, bankAccountNo: '0011001' })).statusCode).toBe(201);
    const accr = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-08-31', documentDate: '2026-08-31', description: 'trích lãi USD', currencyCode: 'USD', fxRate: '25000', autoPost: true,
      lines: [{ accountCode: '635', debit: '12500000', credit: '0', amountCurrency: '500' }, { accountCode: '335', debit: '0', credit: '12500000', amountCurrency: '-500', partyCode: 'NCC001', contractCode: 'USD02' }] });
    expect(accr.statusCode, accr.body).toBe(201);
    // trả 30.000 gốc + 500 lãi theo 25.300: tiền 771.650.000; ghi sổ 756.000.000 + 12.500.000; lỗ 3.150.000
    const r1 = await call('POST', `/api/loans/${id}/repay`, { date: '2026-09-10', principal: '30000', interest: '500', fxRate: '25300', bankAccountNo: '0011001' });
    expect(r1.statusCode, r1.body).toBe(201);
    expect(await lines(r1.json().id)).toMatchObject([{ code: '3411', debit: '756000000' }, { code: '335', debit: '12500000' }, { code: '112', credit: '771650000' }, { code: '635', debit: '3150000' }]);
    // trả nốt 70.000 theo 25.100: tiền 1.757.000.000; ghi sổ 1.764.000.000; lãi 7.000.000
    const r2 = await call('POST', `/api/loans/${id}/repay`, { date: '2026-09-20', principal: '70000', fxRate: '25100', bankAccountNo: '0011001' });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(await lines(r2.json().id)).toMatchObject([{ code: '3411', debit: '1764000000' }, { code: '112', credit: '1757000000' }, { code: '515', credit: '7000000' }]);
    const left = await sql<{ vnd: string; cur: string }>`SELECT sum(l.credit - l.debit)::text AS vnd, sum(l.amount_currency)::text AS cur FROM voucher_line l JOIN account a ON a.id = l.account_id
      JOIN contract k ON k.id = l.contract_id WHERE k.code = 'USD02' AND k.tenant_id = ${tenantId}::uuid AND a.code IN ('3411', '335')`.execute(ctx.t.admin);
    expect(D(left.rows[0]!.vnd).isZero() && D(left.rows[0]!.cur).isZero()).toBe(true);
    expect((await call('POST', `/api/loans/${id}/settle`)).statusCode).toBe(200);
  });

  it('đánh giá lại 31/12: khế ước USD 100.000 ghi sổ 25.000, tỷ giá 25.400 → Nợ 635 (TT99 không dùng 413) / Có 3411 40.000.000 gắn khế ước', async () => {
    const c = await call('POST', '/api/loans', loan('USD03', { currencyCode: 'USD', value: '0', installments: [] })); expect(c.statusCode, c.body).toBe(201);
    expect((await call('POST', `/api/loans/${c.json().id}/disburse`, { date: '2026-11-02', amount: '100000', fxRate: '25000', bankAccountNo: '0011001' })).statusCode).toBe(201);
    const r = await call('POST', '/api/fx/revaluation', { date: '2026-12-31', rates: { USD: '25400' } }); expect(r.statusCode, r.body).toBe(200);
    const all = await lines(r.json().voucherIds[0]);
    expect(all.filter((l) => l.contract === 'USD03')).toEqual([{ code: '3411', debit: '0', credit: '40000000', contract: 'USD03' }]);
    expect(all.some((l) => l.code === '635' && D(l.debit).gte(40000000))).toBe(true);
    const again = await call('POST', '/api/fx/revaluation', { date: '2026-12-31', rates: { USD: '25400' } }); expect(again.json().unchanged).toBe(true);
  });
});
