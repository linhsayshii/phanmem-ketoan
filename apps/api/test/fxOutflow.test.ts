import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { todayVn, toVnd } from '@kt/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const BANK = '0022001'; // tài khoản ngân hàng ngoại tệ trên TK 1122 (TT133)

// Mỗi kiểm thử một công ty riêng: năm 2026 theo TT133, ngân hàng VCB, tài khoản 0022001 trên 1122.
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `FX${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  await cat('bank', { code: 'VCB', name: 'Vietcombank' });
  await cat('bank_account', { bank_code: 'VCB', account_no: BANK, gl_account_code: '1122', currency_code: 'USD' });
  const post = async (body: object) => { const r = await call('POST', '/api/vouchers', { ...body, autoPost: true }); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; state: string }; };
  // Giấy báo Có: nhận `qty` nguyên tệ tỷ giá `rate` vào 0022001 (đối ứng 4111).
  const receive = (date: string, qty: string, rate: string, currencyCode = 'USD') => {
    const vnd = toVnd(qty, rate);
    return post({ voucherType: 'BC', postingDate: date, documentDate: date, description: `Nhận ${qty} ${currencyCode}`, bankAccountNo: BANK, currencyCode, fxRate: rate,
      lines: [L('1122', vnd, '0', { amountCurrency: qty }), L('4111', '0', vnd, { amountCurrency: `-${qty}` })] });
  };
  // Giấy báo Nợ: chi `qty` nguyên tệ tỷ giá `rate` từ 0022001 (đối ứng 6422).
  const pay = (date: string, qty: string, rate: string, currencyCode = 'USD') => {
    const vnd = toVnd(qty, rate);
    return post({ voucherType: 'BN', postingDate: date, documentDate: date, description: `Chi ${qty} ${currencyCode}`, bankAccountNo: BANK, currencyCode, fxRate: rate,
      lines: [L('6422', vnd, '0', { amountCurrency: qty }), L('1122', '0', vnd, { amountCurrency: `-${qty}` })] });
  };
  const run = (fiscalYear = 2026, periodNo = 1) => call('POST', '/api/fx/outflow-adjust', { fiscalYear, periodNo });
  const runOk = async (periodNo = 1) => { const r = await run(2026, periodNo); expect(r.statusCode, r.body).toBe(200); return r.json() as { runId: number; voucherIds: string[]; reversedVoucherIds: string[] }; };
  const voucher = async (id: string) => (await call('GET', `/api/vouchers/${id}`)).json();
  // Số dư VND và nguyên tệ của 1122 / 0022001 theo loại tiền cuối ngày `asOf`.
  const balance = async (asOf: string, currency = 'USD') => {
    const r = await call('GET', `/api/cash/balance?accountCode=1122&bankAccountNo=${BANK}&currency=${currency}&asOf=${asOf}`);
    expect(r.statusCode, r.body).toBe(200); const { balance: vnd, balanceCurrency } = r.json() as { balance: string; balanceCurrency: string }; return { balance: vnd, balanceCurrency };
  };
  const activeXq = async () => (await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'XQ' AND state = 'posted' AND reversal_of_id IS NULL`.execute(ctx.t.admin)).rows.map((r) => r.id);
  return { cookie, tenantId, call, cat, post, receive, pay, run, runOk, voucher, balance, activeXq };
}
type Line = { accountCode: string; debit: string; credit: string; amountCurrency?: string; fxRate?: string; bankAccountNo?: string | null };
const lines = (v: { lines: Line[] }) => v.lines.map((l) => [l.accountCode, l.debit, l.credit, l.amountCurrency, l.fxRate ?? null, l.bankAccountNo ?? null]);

// Nhập 1.000 USD @25.000 (05/01), 1.000 USD @25.400 (15/01), chi 500 USD @25.200 (20/01, đúng bình quân lúc nhập), rồi ghi lùi chi 500 USD @25.000 ngày 10/01
// (bình quân tại ngày 10/01). Bình quân đúng sau 15/01: (12.500.000 + 25.400.000) / 1.500 = 25.266,6666666667 → phiếu chi 20/01 đúng ra 12.633.333 (đã ghi 12.600.000).
async function backdatedScenario(t: Awaited<ReturnType<typeof tenant>>) {
  await t.receive('2026-01-05', '1000', '25000');
  await t.receive('2026-01-15', '1000', '25400');
  await t.pay('2026-01-20', '500', '25200');
  return t.pay('2026-01-10', '500', '25000');
}

describe('tỷ giá theo ngày', () => {
  it('thiếu tỷ giá ngày → 409 FX_RATE_MISSING; có thì lấy tỷ giá ngày gần nhất không sau ngày hỏi', async () => {
    const t = await tenant();
    const rate = (q: string) => t.call('GET', `/api/fx/rate?${q}`);
    const miss = await rate('currency=USD&date=2026-01-20&type=transfer_avg');
    expect(miss.statusCode).toBe(409); expect(miss.json().error.code).toBe('FX_RATE_MISSING');
    await t.cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-02', rate_type: 'transfer_avg', rate: '25350' });
    await t.cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-15', rate_type: 'transfer_avg', rate: '25400.5' });
    const at = async (q: string) => { const r = await rate(q); expect(r.statusCode, r.body).toBe(200); return r.json(); };
    expect(await at('currency=USD&date=2026-01-20&type=transfer_avg')).toEqual({ currency: 'USD', type: 'transfer_avg', rateDate: '2026-01-15', rate: '25400.5000000000' });
    expect((await at('currency=USD&date=2026-01-14')).rate).toBe('25350.0000000000'); // mặc định loại tỷ giá ghi sổ trong cài đặt (transfer_avg)
    expect((await rate('currency=USD&date=2026-01-01&type=transfer_avg')).statusCode).toBe(409); // trước tỷ giá đầu tiên
    expect((await rate('currency=USD&date=2026-01-20&type=buy')).json().error.code).toBe('FX_RATE_MISSING');
    expect((await rate('currency=USD&date=2026-13-01')).statusCode).toBe(400);
  }, 60_000);
});

describe('tỷ giá xuất quỹ bình quân di động', () => {
  it('bình quân di động tại ngày: nhập 1000 USD @25.000, 1000 USD @25.400 → xuất @25.200', async () => {
    const t = await tenant();
    const rate = async (date: string) => { const r = await t.call('GET', `/api/fx/outflow-rate?accountCode=1122&bankAccountNo=${BANK}&currency=USD&date=${date}`); expect(r.statusCode, r.body).toBe(200); return r.json(); };
    expect(await rate('2026-01-04')).toEqual({ rate: null, balance: '0', balanceCurrency: '0.0000' }); // chưa có nguyên tệ: không chia
    await t.receive('2026-01-05', '1000', '25000');
    await t.receive('2026-01-15', '1000', '25400');
    expect(await rate('2026-01-10')).toEqual({ rate: '25000.0000000000', balance: '25000000', balanceCurrency: '1000.0000' });
    expect(await rate('2026-01-15')).toEqual({ rate: '25200.0000000000', balance: '50400000', balanceCurrency: '2000.0000' });
    expect(await t.call('GET', '/api/settings').then((r) => r.json().fx_outflow_method)).toBe('moving_average');
    await t.pay('2026-01-20', '500', '25200');
    expect(await rate('2026-01-20')).toEqual({ rate: '25200.0000000000', balance: '37800000', balanceCurrency: '1500.0000' }); // xuất theo bình quân không đổi bình quân
    // chi đúng bình quân: không lệch, không sinh chứng từ
    expect((await t.runOk()).voucherIds).toEqual([]);
  }, 60_000);

  it('phiếu chi ghi lùi ngày trước phiếu chi đã có: chạy tính lại sinh XQ, sau đó số dư VND 1122 = Σ nguyên tệ × bình quân cuối', async () => {
    const t = await tenant();
    await backdatedScenario(t);
    expect(await t.balance('2026-01-31')).toEqual({ balance: '25300000', balanceCurrency: '1000.0000' }); // trước điều chỉnh: lệch bình quân
    const r = await t.runOk();
    expect(r.voucherIds).toHaveLength(1); expect(r.reversedVoucherIds).toEqual([]);
    const xq = await t.voucher(r.voucherIds[0]!);
    expect(xq).toMatchObject({ voucherType: 'XQ', state: 'posted', postingDate: '2026-01-31', sourceDocType: 'fx_outflow', currencyCode: 'VND' });
    expect(xq.voucherNo).toEqual(expect.any(String)); expect(xq.sourceDocId).toEqual(expect.any(String));
    // ghi Có 1122 thiếu 33.333 (12.600.000 so với 12.633.333): lỗ tỷ giá Nợ 635 / Có 1122, dòng tiền nguyên tệ 0, không tỷ giá, đúng tài khoản ngân hàng
    expect(lines(xq)).toEqual([['1122', '0', '33333', '0.0000', null, BANK], ['635', '33333', '0', '33333.0000', null, null]]);
    // 1.000 USD × (12.500.000 + 25.400.000) / 1.500 = 25.266.666,67 → 25.266.667
    expect(await t.balance('2026-01-31')).toEqual({ balance: '25266667', balanceCurrency: '1000.0000' });
    const audit = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'fx_run'`.execute(ctx.t.admin);
    expect(Number(audit.rows[0]!.n)).toBeGreaterThan(0);
    // kỳ sau: bình quân mang sang đã tính cả XQ kỳ trước; chi hết 1.000 USD theo bình quân thì số dư VND về đúng 0
    expect((await t.call('GET', `/api/fx/outflow-rate?accountCode=1122&bankAccountNo=${BANK}&currency=USD&date=2026-02-01`)).json().rate).toBe('25266.6670000000');
    await t.pay('2026-02-10', '1000', '25266.667');
    expect((await t.runOk(2)).voucherIds).toEqual([]);
    expect(await t.balance('2026-02-28')).toEqual({ balance: '0', balanceCurrency: '0.0000' });
  }, 60_000);

  it('chạy lại cùng kỳ đảo XQ cũ, chỉ còn một XQ hiệu lực; không lệch thì không sinh chứng từ', async () => {
    const t = await tenant();
    const backdated = await backdatedScenario(t);
    const first = await t.runOk();
    const second = await t.runOk();
    expect(second.reversedVoucherIds).toEqual(first.voucherIds);
    expect(second.voucherIds).toHaveLength(1); expect(second.voucherIds[0]).not.toBe(first.voucherIds[0]);
    expect(await t.activeXq()).toEqual(second.voucherIds);
    const old = await t.voucher(first.voucherIds[0]!);
    expect(old.state).toBe('reversed');
    const rev = await t.voucher(old.reversedById);
    expect(rev).toMatchObject({ voucherType: 'XQ', postingDate: '2026-01-31', sourceDocType: 'fx_outflow' }); // kỳ mở: đảo ngày cuối kỳ
    expect(lines(await t.voucher(second.voucherIds[0]!))).toEqual(lines(await t.voucher(first.voucherIds[0]!)));
    expect(await t.balance('2026-01-31')).toEqual({ balance: '25266667', balanceCurrency: '1000.0000' });
    const runs = await sql<{ voucher_ids: string[]; reversed_voucher_ids: string[]; kind: string; period_no: number; run_date: string }>`
      SELECT voucher_ids, reversed_voucher_ids, kind, period_no, run_date::text FROM fx_run WHERE tenant_id = ${t.tenantId}::uuid ORDER BY id`.execute(ctx.t.admin);
    expect(runs.rows).toEqual([
      { voucher_ids: first.voucherIds, reversed_voucher_ids: [], kind: 'outflow', period_no: 1, run_date: '2026-01-31' },
      { voucher_ids: second.voucherIds, reversed_voucher_ids: first.voucherIds, kind: 'outflow', period_no: 1, run_date: '2026-01-31' }]);

    // bỏ phiếu chi ghi lùi: bình quân trở về 25.200 = tỷ giá đã ghi ở phiếu chi 20/01 → chạy lại chỉ đảo XQ cũ, không sinh mới
    const un = await t.call('POST', `/api/vouchers/${backdated.id}/unpost`);
    expect(un.statusCode, un.body).toBe(200);
    const third = await t.runOk();
    expect(third).toMatchObject({ voucherIds: [], reversedVoucherIds: second.voucherIds });
    expect(await t.activeXq()).toEqual([]);
    expect(await t.balance('2026-01-31')).toEqual({ balance: '37800000', balanceCurrency: '1500.0000' });

    // phiếu chi sai tỷ giá rồi đảo trong cùng kỳ: cặp chứng từ triệt tiêu, không sinh lãi/lỗ tỷ giá
    const wrong = await t.pay('2026-01-25', '100', '26000');
    expect((await t.call('POST', `/api/vouchers/${wrong.id}/reverse`, { postingDate: '2026-01-26' })).statusCode).toBe(201);
    expect((await t.runOk()).voucherIds).toEqual([]);
  }, 60_000);

  it('hai loại tiền USD, EUR trên cùng tài khoản ngân hàng điều chỉnh riêng; lệch dương ghi Nợ tiền / Có 515', async () => {
    const t = await tenant();
    await t.cat('currency', { code: 'EUR', name: 'Euro' });
    await backdatedScenario(t); // USD: thiếu 33.333 (lỗ)
    // EUR: 1.000 @27.000, 1.000 @28.000 → bình quân 27.500; chi 400 ghi @28.000 = 11.200.000, đúng 11.000.000 → ghi Có thừa 200.000 (lãi)
    await t.receive('2026-01-05', '1000', '27000', 'EUR');
    await t.receive('2026-01-10', '1000', '28000', 'EUR');
    await t.pay('2026-01-20', '400', '28000', 'EUR');
    const r = await t.runOk();
    expect(r.voucherIds).toHaveLength(1);
    const xq = await t.voucher(r.voucherIds[0]!);
    // mỗi nhóm (tài khoản, tài khoản ngân hàng, loại tiền) một cặp dòng, theo thứ tự mã loại tiền
    expect(lines(xq)).toEqual([
      ['1122', '200000', '0', '0.0000', null, BANK], ['515', '0', '200000', '-200000.0000', null, null],
      ['1122', '0', '33333', '0.0000', null, BANK], ['635', '33333', '0', '33333.0000', null, null]]);
    const cur = await sql<{ line_no: number; currency_code: string }>`SELECT line_no, currency_code FROM voucher_line WHERE voucher_id = ${xq.id}::uuid ORDER BY line_no`.execute(ctx.t.admin);
    expect(cur.rows.map((x) => x.currency_code)).toEqual(['EUR', 'VND', 'USD', 'VND']);
    expect(await t.balance('2026-01-31', 'USD')).toEqual({ balance: '25266667', balanceCurrency: '1000.0000' });
    expect(await t.balance('2026-01-31', 'EUR')).toEqual({ balance: '44000000', balanceCurrency: '1600.0000' }); // 1.600 × 27.500
  }, 60_000);

  it('XQ không bỏ ghi sổ/hủy được qua route chung', async () => {
    const t = await tenant();
    await backdatedScenario(t);
    const [id] = (await t.runOk()).voucherIds;
    for (const act of ['unpost', 'discard']) {
      const r = await t.call('POST', `/api/vouchers/${id}/${act}`);
      expect(r.statusCode, act).toBe(409); expect(r.json().error.code, act).toBe('VOUCHER_SYSTEM_GENERATED');
    }
    const manual = await t.call('POST', '/api/vouchers', { voucherType: 'XQ', postingDate: '2026-01-31', documentDate: '2026-01-31', lines: [L('635', '1'), L('1121', '0', '1')] });
    expect(manual.statusCode).toBe(409); expect(manual.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
    expect((await t.voucher(id!)).state).toBe('posted');
  }, 60_000);

  it('kỳ khóa mềm: đảo XQ cũ ngày hôm nay, XQ mới vẫn ngày cuối kỳ; kỳ khóa cứng → 409 PERIOD_HARD_LOCKED; phương pháp đích danh không chạy', async () => {
    const t = await tenant();
    await backdatedScenario(t);
    const first = await t.runOk();
    const lock = async (level: string, no = 1) => { const r = await t.call('POST', `/api/periods/2026/${no}/lock`, { level }); expect(r.statusCode, r.body).toBe(200); };
    await lock('soft');
    const second = await t.runOk();
    const rev = await t.voucher((await t.voucher(first.voucherIds[0]!)).reversedById);
    expect(rev.postingDate).toBe(todayVn() > '2026-01-31' ? todayVn() : '2026-01-31');
    expect((await t.voucher(second.voucherIds[0]!)).postingDate).toBe('2026-01-31');
    expect(await t.activeXq()).toEqual(second.voucherIds);

    await lock('hard', 0); await lock('hard'); // khóa cứng theo thứ tự, kỳ 0 (số dư đầu kỳ) trước
    const hard = await t.run();
    expect(hard.statusCode).toBe(409); expect(hard.json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect(await t.activeXq()).toEqual(second.voucherIds);

    expect((await t.run(2026, 0)).statusCode).toBe(400);
    expect((await t.run(2027, 1)).statusCode).toBe(404);
    expect((await t.call('PUT', '/api/settings', { fx_outflow_method: 'specific' })).statusCode).toBe(200);
    const specific = await t.run(2026, 2);
    expect(specific.statusCode).toBe(409); expect(specific.json().error.code).toBe('FX_OUTFLOW_METHOD_SPECIFIC');
    expect((await t.call('PUT', '/api/settings', { fx_outflow_method: 'fifo' })).statusCode).toBe(400); // FIFO không làm
  }, 60_000);
});

