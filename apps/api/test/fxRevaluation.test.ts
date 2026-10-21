import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { toVnd } from '@kt/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const K = (accountCode: string, partyCode: string, debit = '0', credit = '0', more: object = {}) => L(accountCode, debit, credit, { partyCode, ...more });
const BANK1 = '0022001'; const BANK2 = '0022002'; // hai tài khoản ngân hàng USD trên TK 1122 (TT133)
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
type RunOut = { runId: number; voucherIds: string[]; reversedVoucherIds: string[]; unchanged: boolean; staleRevaluations: string[] };

// Mỗi kiểm thử một công ty riêng (năm 2026, TT133 mặc định), đối tượng KH001, KH002, NCC001; tỷ giá chuyển khoản trung bình USD 31/01 = 25.600.
async function tenant(regime: 'TT133' | 'TT99' = 'TT133') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `DG${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
  await cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-31', rate_type: 'transfer_avg', rate: '25600' });
  const pkt = async (date: string, lines: object[], extra: object = {}) => {
    const r = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'kt', autoPost: true, ...extra, lines });
    expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string };
  };
  // Hóa đơn USD Nợ 131 / Có 5113 (TT99: 511); thu USD Nợ 1122 / Có 131; hóa đơn mua USD Nợ 6422 / Có 331.
  const revenue = regime === 'TT99' ? '511' : '5113';
  const usdInvoice = (date: string, qty: string, rate: string, party = 'KH001') => { const v = toVnd(qty, rate);
    return pkt(date, [K('131', party, v, '0', { amountCurrency: qty }), L(revenue, '0', v, { amountCurrency: `-${qty}` })], { currencyCode: 'USD', fxRate: rate }); };
  const usdReceipt = (date: string, qty: string, rate: string, party = 'KH001') => { const v = toVnd(qty, rate);
    return pkt(date, [L('1122', v, '0', { amountCurrency: qty }), K('131', party, '0', v, { amountCurrency: `-${qty}` })], { currencyCode: 'USD', fxRate: rate }); };
  const usdPurchase = (date: string, qty: string, rate: string, party = 'NCC001') => { const v = toVnd(qty, rate);
    return pkt(date, [L('6422', v, '0', { amountCurrency: qty }), K('331', party, '0', v, { amountCurrency: `-${qty}` })], { currencyCode: 'USD', fxRate: rate }); };
  const bankAccounts = async () => {
    await cat('bank', { code: 'VCB', name: 'Vietcombank' });
    for (const no of [BANK1, BANK2]) await cat('bank_account', { bank_code: 'VCB', account_no: no, gl_account_code: '1122', currency_code: 'USD' });
  };
  // Giấy báo Có: nhận `qty` USD tỷ giá `rate` vào tài khoản ngân hàng (đối ứng 4111); giấy báo Nợ: chi (đối ứng 6422).
  const receive = async (bank: string, date: string, qty: string, rate: string) => { const v = toVnd(qty, rate);
    const r = await call('POST', '/api/vouchers', { voucherType: 'BC', postingDate: date, documentDate: date, description: 'nhận', bankAccountNo: bank, currencyCode: 'USD', fxRate: rate, autoPost: true,
      lines: [L('1122', v, '0', { amountCurrency: qty }), L('4111', '0', v, { amountCurrency: `-${qty}` })] }); expect(r.statusCode, r.body).toBe(201); };
  const pay = async (bank: string, date: string, qty: string, rate: string) => { const v = toVnd(qty, rate);
    const r = await call('POST', '/api/vouchers', { voucherType: 'BN', postingDate: date, documentDate: date, description: 'chi', bankAccountNo: bank, currencyCode: 'USD', fxRate: rate, autoPost: true,
      lines: [L('6422', v, '0', { amountCurrency: qty }), L('1122', '0', v, { amountCurrency: `-${qty}` })] }); expect(r.statusCode, r.body).toBe(201); };
  const reval = (body: object = {}, query = '', c = cookie) => call('POST', `/api/fx/revaluation${query}`, { date: '2026-01-31', ...body }, c);
  const revalOk = async (body: object = {}) => { const r = await reval(body); expect(r.statusCode, r.body).toBe(200); return r.json() as RunOut; };
  const voucher = async (id: string) => { const r = await call('GET', `/api/vouchers/${id}`); expect(r.statusCode, r.body).toBe(200); return r.json(); };
  // Dòng chứng từ dạng [TK, đối tượng, số TK ngân hàng, loại tiền, Nợ, Có, nguyên tệ, tỷ giá].
  const lines = async (id: string) => ((await voucher(id)).lines as { accountCode: string; partyCode: string | null; bankAccountNo: string | null; debit: string; credit: string; amountCurrency: string; fxRate: string | null }[])
    .map((l) => [l.accountCode, l.partyCode, l.bankAccountNo, l.debit, l.credit, l.amountCurrency, l.fxRate ?? null]);
  const itemOf = async (voucherId: string, lineNo?: number) => (await sql<{ id: number }>`SELECT id::int AS id FROM open_item WHERE voucher_id = ${voucherId}::uuid
    ${lineNo ? sql`AND line_no = ${lineNo}` : sql``} ORDER BY line_no LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
  const items = async (voucherId: string) => (await sql<{ line: number; parent: number | null; amount: string; cur: string }>`SELECT line_no AS line, parent_id::int AS parent, amount::text,
    trim_scale(amount_currency)::text AS cur FROM open_item WHERE voucher_id = ${voucherId}::uuid ORDER BY line_no`.execute(ctx.t.admin)).rows;
  const residual = async (itemId: number, asOf = '2026-12-31') => (await sql<{ vnd: string; cur: string }>`SELECT residual::text AS vnd, trim_scale(residual_currency)::text AS cur
    FROM fn_open_items_at(${tenantId}::uuid, ${asOf}::date) WHERE item_id = ${itemId}`.execute(ctx.t.admin)).rows[0];
  const settle = async (body: object) => { const r = await call('POST', '/api/settlements', body); expect(r.statusCode, r.body).toBe(201); return r.json() as { groupId: string; fxVoucherId: string | null }; };
  // Σ dư open_item và số dư sổ cái theo (tài khoản, đối tượng) tại cuối ngày; chỉ cặp khác 0.
  const sumsMatch = async (asOf: string) => {
    const it = (await sql<{ k: string; n: string }>`SELECT a.code || '/' || p.code AS k, sum(x.residual)::text AS n FROM fn_open_items_at(${tenantId}::uuid, ${asOf}::date) x
      JOIN account a ON a.id = x.account_id JOIN party p ON p.id = x.party_id GROUP BY 1 HAVING sum(x.residual) <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows;
    const ledger = (await sql<{ k: string; n: string }>`SELECT a.code || '/' || p.code AS k, sum(l.debit - l.credit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
      JOIN account a ON a.id = l.account_id JOIN party p ON p.id = l.party_id WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.reconcile AND l.posting_date <= ${asOf}::date
      GROUP BY 1 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows;
    expect([asOf, it]).toEqual([asOf, ledger]);
    return Object.fromEntries(it.map((r) => [r.k, r.n]));
  };
  // Số phát sinh ròng (Nợ − Có) của tài khoản đến hết ngày, cộng thẳng từ dòng đã ghi sổ (cả chứng từ đã bị đảo và bản đảo).
  const net = async (code: string, asOf = '2026-12-31') => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND a.code = ${code} AND l.posting_date <= ${asOf}::date`.execute(ctx.t.admin)).rows[0]!.n;
  const activeDg = async () => (await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'DG' AND state = 'posted' AND reversal_of_id IS NULL
    ORDER BY voucher_no`.execute(ctx.t.admin)).rows.map((r) => r.id);
  const balance = async (bank: string, asOf = '2026-01-31') => {
    const r = await call('GET', `/api/cash/balance?accountCode=1122&bankAccountNo=${bank}&currency=USD&asOf=${asOf}`); expect(r.statusCode, r.body).toBe(200);
    const { balance: vnd, balanceCurrency } = r.json() as { balance: string; balanceCurrency: string }; return [vnd, balanceCurrency];
  };
  const lock = async (level: 'soft' | 'hard', no = 1) => { const r = await call('POST', `/api/periods/2026/${no}/lock`, { level }); expect(r.statusCode, r.body).toBe(200); };
  const userWith = async (roleCode: string, sensitiveFlags: string[]) => {
    const username = `dg_${roleCode}_${sensitiveFlags.length}_${Date.now()}${n++}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  return { cookie, tenantId, call, cat, pkt, usdInvoice, usdReceipt, usdPurchase, bankAccounts, receive, pay, reval, revalOk, voucher, lines, itemOf, items, residual, settle, sumsMatch, net, activeDg, balance, lock, userWith };
}

describe('đánh giá lại số dư ngoại tệ cuối kỳ', () => {
  it('đánh giá lại 1.000 USD phải thu ghi sổ 25.000 tại 25.600: DG Nợ 131 600.000 / Có 413; kết chuyển 413 → 515', async () => {
    const t = await tenant();
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    const out = await t.revalOk();
    expect(out).toMatchObject({ reversedVoucherIds: [], unchanged: false, staleRevaluations: [] });
    expect(out.voucherIds).toHaveLength(2);
    const [dg, kc] = await Promise.all(out.voucherIds.map((id) => t.voucher(id)));
    expect([dg.voucherType, dg.state, dg.postingDate, dg.sourceDocType, dg.voucherNo !== null]).toEqual(['DG', 'posted', '2026-01-31', 'fx_revaluation', true]);
    expect([kc.voucherType, kc.state, kc.postingDate, kc.sourceDocType, kc.sourceDocId]).toEqual(['DG', 'posted', '2026-01-31', 'fx_revaluation', dg.sourceDocId]);
    expect(dg.sourceDocId).toBe((await sql<{ id: string }>`SELECT md5(${`${t.tenantId}:fx_run:${out.runId}`})::uuid::text AS id`.execute(ctx.t.admin)).rows[0]!.id);
    expect(await t.lines(dg.id)).toEqual([['131', 'KH001', null, '600000', '0', '0.0000', null], ['413', null, null, '0', '600000', '-600000.0000', null]]);
    expect(await t.lines(kc.id)).toEqual([['413', null, null, '600000', '0', '600000.0000', null], ['515', null, null, '0', '600000', '-600000.0000', null]]);
    // khoản của dòng DG là khoản con của hóa đơn; nhóm (gốc + con) = 25.600.000 / 1.000 USD
    const invItem = await t.itemOf(inv.id);
    expect(await t.items(dg.id)).toEqual([{ line: 1, parent: invItem, amount: '600000', cur: '0' }]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25600000' });
    expect([await t.net('413'), await t.net('515')]).toEqual(['0', '-600000']);
    const run = (await sql<{ kind: string; fy: number; pn: number; date: string; ids: string[]; params: { unchanged: boolean } }>`SELECT kind, fiscal_year AS fy, period_no AS pn, run_date::text AS date,
      voucher_ids::text[] AS ids, params FROM fx_run WHERE id = ${out.runId}`.execute(ctx.t.admin)).rows[0]!;
    expect([run.kind, run.fy, run.pn, run.date, run.ids, run.params.unchanged]).toEqual(['revaluation', 2026, 1, '2026-01-31', out.voucherIds, false]);
    // chứng từ hệ thống: không bỏ ghi sổ, không đảo qua route chung, không lập tay
    expect(err(await t.call('POST', `/api/vouchers/${dg.id}/unpost`))).toEqual([409, 'VOUCHER_SYSTEM_GENERATED']);
    expect(err(await t.call('POST', `/api/vouchers/${dg.id}/reverse`, { postingDate: '2026-02-01' }))).toEqual([409, 'VOUCHER_SYSTEM_GENERATED']);
    expect(err(await t.call('POST', '/api/vouchers', { voucherType: 'DG', postingDate: '2026-01-31', documentDate: '2026-01-31', lines: [L('131', '1'), L('413', '0', '1')] }))).toEqual([409, 'VOUCHER_TYPE_SYSTEM']);
  });

  it('đánh giá lại tiền gửi 1122 theo từng tài khoản ngân hàng; nợ phải trả tăng thì lỗ (Nợ 413 / Có 331)', async () => {
    const t = await tenant();
    await t.bankAccounts();
    await t.receive(BANK1, '2026-01-05', '1000', '25000');
    await t.receive(BANK2, '2026-01-06', '2000', '25500');
    await t.pay(BANK2, '2026-01-20', '500', '25500');
    await t.usdPurchase('2026-01-12', '500', '25000');
    const out = await t.revalOk();
    expect(out.voucherIds).toHaveLength(2);
    // BANK1: 1.000 × 600 = +600.000; BANK2: 1.500 × 100 = +150.000; 331: −500 USD × 600 = nợ tăng 300.000
    expect(await t.lines(out.voucherIds[0]!)).toEqual([
      ['1122', null, BANK1, '600000', '0', '0.0000', null], ['1122', null, BANK2, '150000', '0', '0.0000', null], ['331', 'NCC001', null, '0', '300000', '0.0000', null],
      ['413', null, null, '0', '750000', '-750000.0000', null], ['413', null, null, '300000', '0', '300000.0000', null]]);
    expect(await t.lines(out.voucherIds[1]!)).toEqual([['413', null, null, '450000', '0', '450000.0000', null], ['515', null, null, '0', '450000', '-450000.0000', null]]);
    expect(await t.balance(BANK1)).toEqual(['25600000', '1000.0000']);
    expect(await t.balance(BANK2)).toEqual(['38400000', '1500.0000']);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '331/NCC001': '-12800000' });
    expect([await t.net('413'), await t.net('515'), await t.net('635')]).toEqual(['0', '-450000', '0']);
  });

  it('sau đánh giá lại, thu nốt 1.000 USD @25.500: CL lỗ 100.000 (so với 25.600), không phải lãi 500.000 so với tỷ giá gốc', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const dg = (await t.revalOk()).voucherIds[0]!;
    const child = await t.itemOf(dg);
    const rcv = await t.itemOf((await t.usdReceipt('2026-02-10', '1000', '25500')).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    expect(await t.lines(r.fxVoucherId!)).toEqual([['635', null, null, '100000', '0', '100000.0000', null], ['131', 'KH001', null, '0', '100000', '0.0000', null]]);
    for (const id of [inv, child, rcv]) expect(await t.residual(id)).toEqual({ vnd: '0', cur: '0' });
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25600000' });
    expect(await t.sumsMatch('2026-02-10')).toEqual({});
    expect([await t.net('515'), await t.net('635')]).toEqual(['-600000', '100000']); // lãi đánh giá lại 600.000, lỗ thực hiện 100.000: ròng lãi 500.000
  });

  it('thu một phần sau đánh giá lại (999 USD @25.000, đánh giá @25.600,3; thu 333 @25.500,7): khoản con đối trừ theo tỷ lệ, CL lỗ 33.167; thu nốt không lệch', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '999', '25000')).id); // 24.975.000
    const dg = (await t.revalOk({ rates: { USD: '25600.3' } })).voucherIds[0]!;
    const child = await t.itemOf(dg);
    expect(await t.residual(child)).toEqual({ vnd: '599700', cur: '0' }); // round(999 × 25.600,3) = 25.574.700
    const r1 = await t.itemOf((await t.usdReceipt('2026-02-10', '333', '25500.7')).id); // 8.491.733
    const s1 = await t.settle({ debitItemId: inv, creditItemId: r1, amountCurrency: '333' });
    // nhóm 25.574.700 / 999 → phần 333 = 8.524.900, khoản con 199.900, khoản gốc 8.325.000; thu 8.491.733 → lỗ 33.167
    expect(await t.lines(s1.fxVoucherId!)).toEqual([['635', null, null, '33167', '0', '33167.0000', null], ['131', 'KH001', null, '0', '33167', '0.0000', null]]);
    expect(await t.residual(inv)).toEqual({ vnd: '16650000', cur: '666' });
    expect(await t.residual(child)).toEqual({ vnd: '399800', cur: '0' });
    expect(await t.sumsMatch('2026-02-10')).toEqual({ '131/KH001': '17049800' });
    const r2 = await t.itemOf((await t.usdReceipt('2026-02-20', '666', '25600.3')).id); // round(666 × 25.600,3) = 17.049.800 = đúng giá trị ghi sổ còn lại
    const s2 = await t.settle({ debitItemId: inv, creditItemId: r2, amountCurrency: '666' });
    expect(s2.fxVoucherId).toBeNull();
    for (const id of [inv, child, r1, r2]) expect(await t.residual(id)).toEqual({ vnd: '0', cur: '0' });
    expect(await t.sumsMatch('2026-02-20')).toEqual({});
  });

  it('chạy lại cùng ngày đảo DG cũ; tổng dư open_item = số dư 131 theo đối tượng trước và sau', async () => {
    const t = await tenant();
    await t.usdInvoice('2026-01-10', '1000', '25000');
    await t.usdInvoice('2026-01-12', '500', '25200', 'KH002');
    const first = await t.revalOk();
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25600000', '131/KH002': '12800000' });
    // chạy lại cùng tỷ giá: không đổi, không chạm sổ
    expect(await t.revalOk()).toMatchObject({ voucherIds: [], reversedVoucherIds: [], unchanged: true });
    expect(await t.activeDg()).toEqual(first.voucherIds);
    // tỷ giá nhập tay 25.700: đảo hai DG cũ cùng ngày 31/01, sinh DG mới
    const second = await t.revalOk({ rates: { USD: '25700' } });
    expect([second.unchanged, second.reversedVoucherIds]).toEqual([false, first.voucherIds]);
    for (const id of first.voucherIds) {
      const v = await t.voucher(id);
      expect([v.state, (await t.voucher(v.reversedById)).postingDate]).toEqual(['reversed', '2026-01-31']);
    }
    expect(await t.activeDg()).toEqual(second.voucherIds);
    expect(await t.lines(second.voucherIds[0]!)).toEqual([['131', 'KH001', null, '700000', '0', '0.0000', null], ['131', 'KH002', null, '250000', '0', '0.0000', null], ['413', null, null, '0', '950000', '-950000.0000', null]]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25700000', '131/KH002': '12850000' });
    expect([await t.net('413'), await t.net('515')]).toEqual(['0', '-950000']);
    const runs = (await sql<{ ids: string[]; rev: string[]; unchanged: boolean; note: string | null }>`SELECT voucher_ids::text[] AS ids, reversed_voucher_ids::text[] AS rev,
      (params->>'unchanged')::boolean AS unchanged, params->>'note' AS note FROM fx_run WHERE tenant_id = ${t.tenantId}::uuid AND kind = 'revaluation' ORDER BY id`.execute(ctx.t.admin)).rows;
    expect(runs).toEqual([{ ids: first.voucherIds, rev: [], unchanged: false, note: null }, { ids: [], rev: [], unchanged: true, note: 'không đổi' },
      { ids: second.voucherIds, rev: first.voucherIds, unchanged: false, note: null }]);
  });

  it('chạy lại khi khoản con đã được đối trừ → 409 FX_REVALUATION_SETTLED, không đổi gì; hủy đối trừ thì chạy lại được', async () => {
    const t = await tenant();
    const invV = await t.usdInvoice('2026-01-10', '1000', '25000');
    const inv = await t.itemOf(invV.id);
    const first = await t.revalOk();
    const rcv = await t.itemOf((await t.usdReceipt('2026-02-10', '400', '25500')).id);
    const s = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '400' });
    const blocked = await t.reval({ rates: { USD: '25700' } });
    expect(err(blocked)).toEqual([409, 'FX_REVALUATION_SETTLED']);
    expect(blocked.json().error.message).toContain('hủy đối trừ');
    expect(blocked.json().error.message).toContain((await t.voucher(invV.id)).voucherNo);
    expect(await t.activeDg()).toEqual(first.voucherIds);
    expect(err(await t.reval({ rates: { USD: '25700' } }, '?dryRun=true'))).toEqual([409, 'FX_REVALUATION_SETTLED']);
    // người có fx.run nhưng không có cờ xem công nợ phải thu: thông báo không nêu số chứng từ
    const role = ((await t.call('GET', '/api/roles')).json() as { id: string; code: string; permissions: string[] }[]).find((r) => r.code === 'ketoan_vien')!;
    expect((await t.call('PUT', `/api/roles/${role.id}/permissions`, { permissions: [...role.permissions, 'fx.run'] })).statusCode).toBe(200);
    const hidden = await t.reval({ rates: { USD: '25700' } }, '', await t.userWith('ketoan_vien', []));
    expect([...err(hidden), hidden.json().error.message]).toEqual([409, 'FX_REVALUATION_SETTLED',
      'Khoản điều chỉnh đánh giá lại ngày 31/01/2026 đã được đối trừ: hãy hủy đối trừ các khoản đó trước rồi chạy lại đánh giá lại']);
    expect((await t.revalOk()).unchanged).toBe(true); // không đổi thì không phải đảo: chạy được
    expect((await t.call('DELETE', `/api/settlements/groups/${s.groupId}`)).statusCode).toBe(204);
    const again = await t.revalOk({ rates: { USD: '25700' } });
    expect(again.reversedVoucherIds).toEqual(first.voucherIds);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25700000' });
  });

  it('dryRun trả dòng dự kiến, không ghi; kết quả bằng lần chạy thật; thiếu cờ xem công nợ → 403', async () => {
    const t = await tenant();
    await t.bankAccounts();
    await t.receive(BANK1, '2026-01-05', '1000', '25000');
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    await t.usdInvoice('2026-01-11', '200', '25600', 'KH002'); // đúng tỷ giá đánh giá lại: chênh 0
    const dry = await t.reval({}, '?dryRun=true');
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toEqual({ dryRun: true, date: '2026-01-31', fiscalYear: 2026, periodNo: 1, unchanged: false, totals: { gain: '1200000', loss: '0', net: '1200000' },
      rates: [{ currency: 'USD', rateType: 'transfer_avg', rate: '25600.0000000000', rateDate: '2026-01-31' }], warnings: [],
      lines: [
        { kind: 'bank', accountCode: '1122', bankAccountNo: BANK1, partyCode: null, openItemId: null, docNo: null, currency: 'USD', balanceCurrency: '1000.0000', balance: '25000000', rateType: 'transfer_avg', rate: '25600.0000000000', revalued: '25600000', difference: '600000' },
        { kind: 'receivable', accountCode: '131', bankAccountNo: null, partyCode: 'KH001', openItemId: inv, docNo: expect.any(String), currency: 'USD', balanceCurrency: '1000.0000', balance: '25000000', rateType: 'transfer_avg', rate: '25600.0000000000', revalued: '25600000', difference: '600000' },
        { kind: 'receivable', accountCode: '131', bankAccountNo: null, partyCode: 'KH002', openItemId: expect.any(Number), docNo: expect.any(String), currency: 'USD', balanceCurrency: '200.0000', balance: '5120000', rateType: 'transfer_avg', rate: '25600.0000000000', revalued: '5120000', difference: '0' }] });
    expect(await t.activeDg()).toEqual([]);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM fx_run WHERE tenant_id = ${t.tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
    const out = await t.revalOk();
    const dgLines = (await t.lines(out.voucherIds[0]!)).filter((l) => l[0] !== '413').map((l) => [l[0], l[1], l[2], l[3]]);
    expect(dgLines).toEqual((dry.json().lines as { accountCode: string; partyCode: string | null; bankAccountNo: string | null; difference: string }[])
      .filter((l) => l.difference !== '0').map((l) => [l.accountCode, l.partyCode, l.bankAccountNo, l.difference]));
    // kế toán viên có fx.run nhưng không có cờ xem công nợ phải thu: xem trước bị chặn vì có dòng 131
    const role = ((await t.call('GET', '/api/roles')).json() as { id: string; code: string; permissions: string[] }[]).find((r) => r.code === 'ketoan_vien')!;
    expect((await t.call('PUT', `/api/roles/${role.id}/permissions`, { permissions: [...role.permissions, 'fx.run'] })).statusCode).toBe(200);
    const noFlag = await t.userWith('ketoan_vien', []);
    const forbidden = await t.reval({}, '?dryRun=true', noFlag);
    expect([...err(forbidden), forbidden.json().error.message]).toEqual([403, 'FORBIDDEN', 'Không có quyền xem công nợ phải thu']);
    expect((await t.reval({}, '?dryRun=true', await t.userWith('ketoan_vien', ['view_receivable']))).statusCode).toBe(200);
    expect(err(await t.reval({}, '?dryRun=true', await t.userWith('xem', ['view_receivable'])))).toEqual([403, 'FORBIDDEN']); // không có fx.run
  });

  it('XQ bỏ qua DG trong kỳ (cùng ngày cuối kỳ có phiếu chi); XQ đổi sổ thì báo staleRevaluations, chạy lại DG theo số dư mới', async () => {
    const t = await tenant();
    await t.bankAccounts();
    await t.receive(BANK1, '2026-01-05', '1000', '25000');
    await t.pay(BANK1, '2026-01-31', '500', '25000'); // đúng bình quân
    // đánh giá lại ngày 15/01 theo tỷ giá nhập tay bằng tỷ giá ghi sổ: không sinh DG, nên không bao giờ bị báo cũ
    expect(await t.revalOk({ date: '2026-01-15', rates: { USD: '25000' } })).toMatchObject({ voucherIds: [], unchanged: true });
    const dg1 = await t.revalOk();
    expect(await t.lines(dg1.voucherIds[0]!)).toEqual([['1122', null, BANK1, '300000', '0', '0.0000', null], ['413', null, null, '0', '300000', '-300000.0000', null]]);
    // DG Nợ 1122 ngày 31/01 đứng trước phiếu chi cùng ngày (Nợ trước Có): nếu duyệt, XQ sẽ sinh lỗ 150.000 giả
    const xq1 = await t.call('POST', '/api/fx/outflow-adjust', { fiscalYear: 2026, periodNo: 1 });
    expect(xq1.statusCode, xq1.body).toBe(200);
    expect(xq1.json()).toMatchObject({ voucherIds: [], unchanged: true, staleRevaluations: [] });
    // ghi lùi giấy báo Có 10/01 1.000 USD @26.000: bình quân lúc chi 31/01 là 25.500 → XQ lỗ 250.000; DG ngày 31/01 thành cũ
    await t.receive(BANK1, '2026-01-10', '1000', '26000');
    const xq2 = await t.call('POST', '/api/fx/outflow-adjust', { fiscalYear: 2026, periodNo: 1 });
    expect(xq2.statusCode, xq2.body).toBe(200);
    expect(xq2.json()).toMatchObject({ unchanged: false, staleRevaluations: ['2026-01-31'] });
    expect(await t.lines(xq2.json().voucherIds[0])).toEqual([['1122', null, BANK1, '0', '250000', '0.0000', null], ['635', null, null, '250000', '0', '250000.0000', null]]);
    // chạy lại DG: 1.500 USD × 25.600 = 38.400.000; số dư 25.000.000 + 26.000.000 − 12.500.000 − 250.000 = 38.250.000 → +150.000
    const dg2 = await t.revalOk();
    expect(dg2.reversedVoucherIds).toEqual(dg1.voucherIds);
    expect(await t.lines(dg2.voucherIds[0]!)).toEqual([['1122', null, BANK1, '150000', '0', '0.0000', null], ['413', null, null, '0', '150000', '-150000.0000', null]]);
    expect(await t.balance(BANK1)).toEqual(['38400000', '1500.0000']);
    // XQ chạy lại sau DG: không đổi, DG không cũ
    expect((await t.call('POST', '/api/fx/outflow-adjust', { fiscalYear: 2026, periodNo: 1 })).json()).toMatchObject({ voucherIds: [], unchanged: true, staleRevaluations: [] });
  });

  it('kỳ khóa mềm: chạy lại đảo DG cũ và ghi DG mới cùng ngày (cần quyền ghi lùi); khóa cứng → 409 PERIOD_HARD_LOCKED; đầu vào sai', async () => {
    const t = await tenant();
    await t.usdInvoice('2026-01-10', '1000', '25000');
    const first = await t.revalOk();
    await t.lock('soft');
    expect(await t.revalOk()).toMatchObject({ voucherIds: [], reversedVoucherIds: [], unchanged: true });
    const role = ((await t.call('GET', '/api/roles')).json() as { id: string; code: string; permissions: string[] }[]).find((r) => r.code === 'ketoan_vien')!;
    expect((await t.call('PUT', `/api/roles/${role.id}/permissions`, { permissions: [...role.permissions, 'fx.run'] })).statusCode).toBe(200);
    expect(err(await t.reval({ rates: { USD: '25700' } }, '', await t.userWith('ketoan_vien', ['view_receivable'])))).toEqual([409, 'PERIOD_SOFT_LOCKED']);
    const second = await t.revalOk({ rates: { USD: '25700' } }); // admin có quyền ghi lùi
    expect(second.reversedVoucherIds).toEqual(first.voucherIds);
    for (const id of [...second.voucherIds, (await t.voucher(first.voucherIds[0]!)).reversedById]) expect((await t.voucher(id)).postingDate).toBe('2026-01-31');
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25700000' });
    expect([await t.net('515', '2026-01-31'), await t.net('515')]).toEqual(['-700000', '-700000']);
    await t.lock('hard', 0); await t.lock('hard');
    expect(err(await t.reval({ rates: { USD: '25800' } }))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(await t.activeDg()).toEqual(second.voucherIds);
    expect(err(await t.reval({ date: '2027-01-31' }))).toEqual([404, 'PERIOD_NOT_FOUND']);
    expect((await t.reval({ date: '2026-02-30' })).statusCode).toBe(400);
    expect((await t.reval({ date: '2026-02-28', rates: { USD: '0' } })).statusCode).toBe(400);
    expect((await t.reval({ date: '2026-02-28', rates: { usd: '25000' } })).statusCode).toBe(400);
  });

  it('loại tỷ giá theo cài đặt fx_reval_rate_asset/fx_reval_rate_liability: tài sản theo tỷ giá mua, nợ phải trả theo tỷ giá bán; thiếu tỷ giá → 409 FX_RATE_MISSING', async () => {
    const t = await tenant();
    await t.usdInvoice('2026-01-10', '1000', '25000');
    await t.usdPurchase('2026-01-12', '100', '25000');
    expect((await t.call('PUT', '/api/settings', { fx_reval_rate_asset: 'buy', fx_reval_rate_liability: 'sell' })).statusCode).toBe(200);
    expect((await t.call('PUT', '/api/settings', { fx_reval_rate_asset: 'mid' })).statusCode).toBe(400);
    const miss = await t.reval();
    expect([...err(miss), miss.json().error.message]).toEqual([409, 'FX_RATE_MISSING', 'Chưa có tỷ giá mua của USD đến ngày 31/01/2026']);
    await t.cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-30', rate_type: 'buy', rate: '25500' });
    await t.cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-30', rate_type: 'sell', rate: '25800' });
    const dry = (await t.reval({}, '?dryRun=true')).json() as { lines: { partyCode: string; rateType: string; rate: string; difference: string }[]; rates: object[]; warnings: string[] };
    expect(dry.lines.map((l) => [l.partyCode, l.rateType, l.rate, l.difference])).toEqual([['KH001', 'buy', '25500.0000000000', '500000'], ['NCC001', 'sell', '25800.0000000000', '-80000']]);
    // tỷ giá lấy ngày trước ngày đánh giá lại: cảnh báo, không chặn
    expect([dry.rates, dry.warnings]).toEqual([[{ currency: 'USD', rateType: 'buy', rate: '25500.0000000000', rateDate: '2026-01-30' }, { currency: 'USD', rateType: 'sell', rate: '25800.0000000000', rateDate: '2026-01-30' }],
      ['Tỷ giá mua của USD lấy ngày 30/01/2026, trước ngày đánh giá lại 31/01/2026', 'Tỷ giá bán của USD lấy ngày 30/01/2026, trước ngày đánh giá lại 31/01/2026']]);
    // tỷ giá nhập tay của loại tiền dùng cho cả tài sản và nợ phải trả
    const given = (await t.reval({ rates: { USD: '25100' } }, '?dryRun=true')).json() as { lines: { rateType: string; difference: string }[]; rates: object[]; warnings: string[] };
    expect(given.lines.map((l) => [l.rateType, l.difference])).toEqual([['input', '100000'], ['input', '-10000']]);
    expect([given.rates, given.warnings]).toEqual([[{ currency: 'USD', rateType: 'input', rate: '25100', rateDate: null }], []]);
  });

  it('TT99: ghi thẳng Nợ 131 / Có 515, không qua 413, một chứng từ DG', async () => {
    const t = await tenant('TT99');
    await t.usdInvoice('2026-01-10', '1000', '25000');
    await t.usdPurchase('2026-01-12', '100', '25700');
    const out = await t.revalOk();
    expect(out.voucherIds).toHaveLength(1);
    expect(await t.lines(out.voucherIds[0]!)).toEqual([['131', 'KH001', null, '600000', '0', '0.0000', null], ['331', 'NCC001', null, '10000', '0', '0.0000', null],
      ['515', null, null, '0', '610000', '-610000.0000', null]]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25600000', '331/NCC001': '-2560000' });
  });

  it('đối trừ ghi sau ngày đánh giá lại nhưng lập trước lần chạy → 409 FX_REVALUATION_SETTLED_AFTER (không lãi khống); hủy đối trừ, đánh giá lại, đối trừ lại thì đúng', async () => {
    const t = await tenant();
    const invV = await t.usdInvoice('2026-01-10', '1000', '25000');
    const inv = await t.itemOf(invV.id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-02-03', '1000', '25500')).id);
    const s = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' }); // CL lãi 500.000 ngày 03/02
    const fix = 'hủy đối trừ các chứng từ sau ngày 31/01/2026, chạy đánh giá lại, rồi đối trừ lại';
    for (const q of ['', '?dryRun=true']) {
      const blocked = await t.reval({}, q);
      expect([...err(blocked), blocked.json().error.message]).toEqual([409, 'FX_REVALUATION_SETTLED_AFTER',
        `Khoản công nợ của chứng từ ${(await t.voucher(invV.id)).voucherNo} đã được đối trừ sau ngày 31/01/2026: ${fix}`]);
    }
    expect([await t.activeDg(), await t.net('515')]).toEqual([[], '-500000']);
    // thiếu cờ xem công nợ phải thu: không nêu số chứng từ
    const role = ((await t.call('GET', '/api/roles')).json() as { id: string; code: string; permissions: string[] }[]).find((r) => r.code === 'ketoan_vien')!;
    expect((await t.call('PUT', `/api/roles/${role.id}/permissions`, { permissions: [...role.permissions, 'fx.run'] })).statusCode).toBe(200);
    const hidden = await t.reval({}, '', await t.userWith('ketoan_vien', []));
    expect([...err(hidden), hidden.json().error.message]).toEqual([409, 'FX_REVALUATION_SETTLED_AFTER', `Có khoản công nợ đã được đối trừ sau ngày 31/01/2026: ${fix}`]);
    // làm theo hướng dẫn: lãi đánh giá lại tháng 1 600.000, lỗ thực hiện tháng 2 100.000 → ròng lãi 500.000
    expect((await t.call('DELETE', `/api/settlements/groups/${s.groupId}`)).statusCode).toBe(204);
    await t.revalOk();
    const again = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    expect(await t.lines(again.fxVoucherId!)).toEqual([['635', null, null, '100000', '0', '100000.0000', null], ['131', 'KH001', null, '0', '100000', '0.0000', null]]);
    expect([await t.net('515'), await t.net('635')]).toEqual(['-600000', '100000']);
    expect(await t.sumsMatch('2026-02-03')).toEqual({});
  });

  it('khoản đã đánh giá lại: bỏ ghi sổ → 409 OPEN_ITEM_REVALUED; đảo ở kỳ sau đóng cả nhóm, phần dư khoản con thành chứng từ CL (131 lỗ, 331 lãi)', async () => {
    const t = await tenant();
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    const pur = await t.usdPurchase('2026-01-12', '500', '25000');
    const out = await t.revalOk({ rates: { USD: '25500' } }); // 131 KH001 +500.000, 331 NCC001 nợ tăng 250.000
    const dgNo = (await t.voucher(out.voucherIds[0]!)).voucherNo;
    const unpost = await t.call('POST', `/api/vouchers/${inv.id}/unpost`);
    expect([...err(unpost), unpost.json().error.message]).toEqual([409, 'OPEN_ITEM_REVALUED',
      `Khoản công nợ đã đánh giá lại tỷ giá ở chứng từ ${dgNo} ngày 31/01/2026: không bỏ ghi sổ được, hãy dùng Đảo chứng từ`]);
    await t.lock('soft');
    const cls = async () => (await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${t.tenantId}::uuid AND voucher_type = 'CL' ORDER BY voucher_no`.execute(ctx.t.admin)).rows.map((r) => r.id);
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-02-10' })).statusCode).toBe(201);
    const [cl1] = await cls();
    const v1 = await t.voucher(cl1!);
    expect([v1.postingDate, v1.sourceDocType, v1.state]).toEqual(['2026-02-10', 'settlement_fx', 'posted']);
    expect(await t.lines(cl1!)).toEqual([['635', null, null, '500000', '0', '500000.0000', null], ['131', 'KH001', null, '0', '500000', '0.0000', null]]);
    expect((await t.call('POST', `/api/vouchers/${pur.id}/reverse`, { postingDate: '2026-02-12' })).statusCode).toBe(201);
    const cl2 = (await cls())[1]!;
    expect(await t.lines(cl2)).toEqual([['331', 'NCC001', null, '250000', '0', '0.0000', null], ['515', null, null, '0', '250000', '-250000.0000', null]]);
    // mọi khoản công nợ đóng; 131, 331 của đối tượng về 0; lãi lỗ tỷ giá ròng 0
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM fn_open_items_at(${t.tenantId}::uuid, '2026-12-31') WHERE residual <> 0 OR residual_currency <> 0`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
    expect(await t.sumsMatch('2026-02-12')).toEqual({});
    expect([await t.net('515'), await t.net('635')]).toEqual(['-500000', '500000']);
    // khoản con đã đóng do đảo: chạy lại cùng tỷ giá vẫn "không đổi"
    expect(await t.revalOk({ rates: { USD: '25500' } })).toMatchObject({ voucherIds: [], unchanged: true });
  });

  it('khoản gốc đã đảo sau ngày đánh giá lại, trước lần chạy: không đánh giá lại (không sinh khoản con mồ côi), xem trước cảnh báo', async () => {
    const t = await tenant();
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-02-05' })).statusCode).toBe(201);
    const dry = (await t.reval({}, '?dryRun=true')).json() as { lines: object[]; warnings: string[] };
    expect([dry.lines, dry.warnings]).toEqual([[], [`Khoản công nợ của chứng từ ${(await t.voucher(inv.id)).voucherNo} đã đảo sau ngày 31/01/2026: không đánh giá lại`]]);
    expect(await t.revalOk()).toMatchObject({ voucherIds: [], unchanged: true });
    expect(await t.sumsMatch('2026-12-31')).toEqual({});
  });

  it('khoản ứng trước (131 dư Có, 331 dư Nợ) không đánh giá lại; mọi khoản của đối tượng theo một loại tỷ giá, theo dư thuần', async () => {
    const t = await tenant();
    await t.usdReceipt('2026-01-08', '400', '25000', 'KH002'); // KH002 chỉ trả trước
    await t.usdInvoice('2026-01-10', '1000', '25000');
    await t.usdReceipt('2026-01-11', '300', '25000'); // KH001 trả trước 300 chưa đối trừ: dư thuần Nợ 700
    const v = toVnd('200', '25000'); // trả trước cho NCC001
    await t.pkt('2026-01-12', [K('331', 'NCC001', v, '0', { amountCurrency: '200' }), L('1122', '0', v, { amountCurrency: '-200' })], { currencyCode: 'USD', fxRate: '25000' });
    expect((await t.call('PUT', '/api/settings', { fx_reval_rate_asset: 'buy', fx_reval_rate_liability: 'sell' })).statusCode).toBe(200);
    await t.cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-31', rate_type: 'buy', rate: '25500' });
    await t.cat('exchange_rate', { currency_code: 'USD', rate_date: '2026-01-31', rate_type: 'sell', rate: '25800' });
    const dry = (await t.reval({}, '?dryRun=true')).json() as { lines: { accountCode: string; partyCode: string; balanceCurrency: string; rateType: string; difference: string }[] };
    expect(dry.lines.map((l) => [l.accountCode, l.partyCode, l.balanceCurrency, l.rateType, l.difference])).toEqual([
      ['1122', null, '500.0000', 'buy', '250000'], ['131', 'KH001', '1000.0000', 'buy', '500000'], ['131', 'KH001', '-300.0000', 'buy', '-150000']]);
    const out = await t.revalOk();
    expect(await t.lines(out.voucherIds[0]!)).toEqual([['1122', null, null, '250000', '0', '0.0000', null], ['131', 'KH001', null, '500000', '0', '0.0000', null],
      ['131', 'KH001', null, '0', '150000', '0.0000', null], ['413', null, null, '0', '750000', '-750000.0000', null], ['413', null, null, '150000', '0', '150000.0000', null]]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '17850000', '131/KH002': '-10000000', '331/NCC001': '5000000' }); // KH001: 700 × 25.500
  });

  it('tỷ giá xuất quỹ đích danh: nhóm tiền hết nguyên tệ còn dư VND được kết chuyển hết', async () => {
    const t = await tenant();
    await t.bankAccounts();
    expect((await t.call('PUT', '/api/settings', { fx_outflow_method: 'specific' })).statusCode).toBe(200);
    await t.receive(BANK1, '2026-01-05', '1000', '25000');
    await t.pay(BANK1, '2026-01-20', '1000', '25300'); // chi đích danh tỷ giá 25.300: còn 0 USD, −300.000 VND
    const out = await t.revalOk();
    expect(await t.lines(out.voucherIds[0]!)).toEqual([['1122', null, BANK1, '300000', '0', '0.0000', null], ['413', null, null, '0', '300000', '-300000.0000', null]]);
    expect(await t.balance(BANK1)).toEqual(['0', '0.0000']);
    expect(await t.net('515')).toBe('-300000');
  });

  it('thu một phần không chia hết (997 USD @25.001, đánh giá @25.600,7; thu 333 @25.500): phần khoản con làm tròn, CL lỗ 33.533; thu nốt CL lỗ 465, mọi khoản về 0', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '997', '25001')).id); // 24.925.997
    const dg = (await t.revalOk({ rates: { USD: '25600.7' } })).voucherIds[0]!;
    const child = await t.itemOf(dg);
    expect(await t.residual(child)).toEqual({ vnd: '597901', cur: '0' }); // round(997 × 25.600,7) = 25.523.898
    const r1 = await t.itemOf((await t.usdReceipt('2026-02-10', '333', '25500')).id); // 8.491.500
    const s1 = await t.settle({ debitItemId: inv, creditItemId: r1, amountCurrency: '333' });
    // nhóm 25.523.898 / 997 → phần 333 = 8.525.033; khoản con 597.901 × 333 / 997 → 199.700 (199.700,13); khoản gốc 8.325.333
    expect(await t.lines(s1.fxVoucherId!)).toEqual([['635', null, null, '33533', '0', '33533.0000', null], ['131', 'KH001', null, '0', '33533', '0.0000', null]]);
    expect(await t.residual(inv)).toEqual({ vnd: '16600664', cur: '664' });
    expect(await t.residual(child)).toEqual({ vnd: '398201', cur: '0' });
    const r2 = await t.itemOf((await t.usdReceipt('2026-02-20', '664', '25600')).id); // 16.998.400
    const s2 = await t.settle({ debitItemId: inv, creditItemId: r2, amountCurrency: '664' });
    expect(await t.lines(s2.fxVoucherId!)).toEqual([['635', null, null, '465', '0', '465.0000', null], ['131', 'KH001', null, '0', '465', '0.0000', null]]);
    for (const id of [inv, child, r1, r2]) expect(await t.residual(id)).toEqual({ vnd: '0', cur: '0' });
    expect(await t.sumsMatch('2026-02-20')).toEqual({});
  });
});
