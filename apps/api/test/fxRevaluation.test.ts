import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { D, toVnd } from '@kt/domain';
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
type RunOut = { runId: number; voucherIds: string[]; reversedVoucherIds: string[]; unchanged: boolean; staleRevaluations: string[]; warnings: string[]; rates: object[] };

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
  // Chứng từ CL theo thứ tự lập; đối tượng của các khoản còn dư (cuối năm).
  const cls = async () => (await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'CL' ORDER BY created_at, voucher_no`.execute(ctx.t.admin)).rows.map((r) => r.id);
  const openParties = async () => (await sql<{ p: string }>`SELECT p.code AS p FROM fn_open_items_at(${tenantId}::uuid, '2026-12-31') x JOIN party p ON p.id = x.party_id
    WHERE x.residual <> 0 OR x.residual_currency <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows.map((r) => r.p);
  return { cookie, tenantId, call, cat, pkt, usdInvoice, usdReceipt, usdPurchase, bankAccounts, receive, pay, reval, revalOk, voucher, lines, itemOf, items, residual, settle, sumsMatch, net, activeDg, balance, lock, userWith, cls, openParties };
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
    // hóa đơn vừa đã đánh giá lại vừa đã đối trừ: bỏ ghi sổ báo phải hủy đối trừ trước (đảo cũng cần vậy)
    expect(err(await t.call('POST', `/api/vouchers/${invV.id}/unpost`))).toEqual([409, 'OPEN_ITEM_SETTLED']);
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
    // đánh giá lại ngày 15/01 theo tỷ giá nhập tay bằng tỷ giá ghi sổ: không sinh DG
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
    expect(xq2.json()).toMatchObject({ unchanged: false, staleRevaluations: ['2026-01-15', '2026-01-31'] }); // cả lần không sinh DG: chênh 0 trên số dư cũ cũng thành cũ
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
    const run = await t.revalOk();
    expect(run.warnings).toEqual(dry.warnings);
    expect(run.rates).toEqual(dry.rates); // bản chạy trả cùng tỷ giá áp dụng (kèm ngày tỷ giá) như bản xem trước
    expect((await sql<{ w: string[] }>`SELECT params->'warnings' AS w FROM fx_run WHERE id = ${run.runId}`.execute(ctx.t.admin)).rows[0]!.w).toEqual(dry.warnings);
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
    const { cls } = t;
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
    // chạy lại 31/01 với tỷ giá khác sau khi đảo, có thêm hóa đơn KH002 ghi lùi: được. Khoản gốc đã đảo: khoản con mới bù bản đảo của khoản con cũ,
    // phần chênh thành CL ở ngày đảo (KH001: +700.000 − 500.000 → lỗ 200.000 ngày 10/02; NCC001: −350.000 + 250.000 → lãi 100.000 ngày 12/02)
    await t.usdInvoice('2026-01-20', '200', '25000', 'KH002');
    const again = await t.revalOk({ rates: { USD: '25700' } });
    expect([again.unchanged, again.reversedVoucherIds]).toEqual([false, out.voucherIds]);
    const [, , cl3, cl4] = await cls();
    expect([(await t.voucher(cl3!)).postingDate, await t.lines(cl3!)]).toEqual(['2026-02-10', [['635', null, null, '200000', '0', '200000.0000', null], ['131', 'KH001', null, '0', '200000', '0.0000', null]]]);
    expect([(await t.voucher(cl4!)).postingDate, await t.lines(cl4!)]).toEqual(['2026-02-12', [['331', 'NCC001', null, '100000', '0', '0.0000', null], ['515', null, null, '0', '100000', '-100000.0000', null]]]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25700000', '131/KH002': '5140000', '331/NCC001': '-12850000' });
    expect(await t.sumsMatch('2026-12-31')).toEqual({ '131/KH002': '5140000' });
    expect(await t.openParties()).toEqual(['KH002', 'KH002']); // hóa đơn KH002 và khoản con; mọi khoản của KH001, NCC001 đóng
    expect([await t.net('515'), await t.net('635')]).toEqual(['-840000', '700000']); // ròng lãi 140.000 = KH002 200 × 700
  });

  it('đảo hóa đơn ghi ngày trước ngày DG (sau khi đã chạy DG): CL ngày DG triệt lãi; chạy lại 31/01 với tỷ giá khác được, mọi khoản đóng', async () => {
    const t = await tenant();
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    const first = await t.revalOk(); // +600.000
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-01-20' })).statusCode).toBe(201);
    const [cl1] = await t.cls();
    expect([(await t.voucher(cl1!)).postingDate, await t.lines(cl1!)]).toEqual(['2026-01-31', [['635', null, null, '600000', '0', '600000.0000', null], ['131', 'KH001', null, '0', '600000', '0.0000', null]]]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({});
    // khoản gốc không còn dư tại 31/01: chạy lại đảo DG cũ, không sinh DG mới; bản đảo của khoản con cũ đóng bằng CL lãi 600.000 cùng ngày
    const again = await t.revalOk({ rates: { USD: '25700' } });
    expect([again.unchanged, again.voucherIds, again.reversedVoucherIds]).toEqual([false, [], first.voucherIds]);
    const cl2 = (await t.cls())[1]!;
    expect([(await t.voucher(cl2)).postingDate, await t.lines(cl2)]).toEqual(['2026-01-31', [['131', 'KH001', null, '600000', '0', '0.0000', null], ['515', null, null, '0', '600000', '-600000.0000', null]]]);
    expect([await t.sumsMatch('2026-01-31'), await t.openParties()]).toEqual([{}, []]);
    expect(D(await t.net('515')).plus(await t.net('635')).toFixed(0)).toBe('0');
    expect(await t.revalOk({ rates: { USD: '25700' } })).toMatchObject({ voucherIds: [], unchanged: true });
  });

  it('khoản gốc đã đảo sau ngày đánh giá lại, trước lần chạy: vẫn đánh giá lại tại ngày (tháng 1 lãi), khoản con đóng ngay bằng CL lỗ ngày đảo (tháng 2)', async () => {
    const t = await tenant();
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-02-05' })).statusCode).toBe(201);
    const out = await t.revalOk();
    expect([out.warnings, await t.lines(out.voucherIds[0]!)]).toEqual([[], [['131', 'KH001', null, '600000', '0', '0.0000', null], ['413', null, null, '0', '600000', '-600000.0000', null]]]);
    const [cl] = await t.cls();
    expect([(await t.voucher(cl!)).postingDate, await t.lines(cl!)]).toEqual(['2026-02-05', [['635', null, null, '600000', '0', '600000.0000', null], ['131', 'KH001', null, '0', '600000', '0.0000', null]]]);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25600000' });
    expect([await t.sumsMatch('2026-12-31'), await t.openParties()]).toEqual([{}, []]);
    expect([await t.net('515', '2026-01-31'), await t.net('635', '2026-01-31'), await t.net('635')]).toEqual(['-600000', '0', '600000']);
    expect(await t.revalOk()).toMatchObject({ voucherIds: [], unchanged: true });
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
  // T13-M10: ngày đối trừ mặc định = ngày chứng từ lớn nhất của khoản gốc, không xét ngày ghi sổ của khoản con đánh giá lại; logic giữ nguyên nhưng báo rõ
  // SETTLEMENT_BEFORE_REVALUATION (migration 0040) thay cho lỗi trigger SETTLEMENT_DATE_BEFORE_POSTING khó hiểu.
  it('đối trừ không nêu ngày với khoản đã đánh giá lại ngày 31/01 bằng phiếu thu ngày 20/01 → 409 SETTLEMENT_BEFORE_REVALUATION nêu ngày 31/01, sổ không đổi', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '10', '25000')).id);
    await t.revalOk(); // khoản con ghi sổ 31/01
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '10', '25500')).id);
    const count = async () => (await sql<{ s: number; v: number }>`SELECT (SELECT count(*)::int FROM settlement WHERE tenant_id = ${t.tenantId}::uuid) AS s,
      (SELECT count(*)::int FROM voucher WHERE tenant_id = ${t.tenantId}::uuid) AS v`.execute(ctx.t.admin)).rows[0];
    const [before, sumsBefore] = [await count(), await t.sumsMatch('2026-12-31')];
    const r = await t.call('POST', '/api/settlements', { debitItemId: inv, creditItemId: rcv, amountCurrency: '10' });
    expect([r.statusCode, r.json().error?.code]).toEqual([409, 'SETTLEMENT_BEFORE_REVALUATION']);
    expect(r.json().error.message).toContain('31/01/2026');
    expect([await count(), await t.sumsMatch('2026-12-31')]).toEqual([before, sumsBefore]);
    expect([(await t.residual(inv))?.cur, (await t.residual(rcv))?.cur]).toEqual(['10', '-10']); // cả hai khoản vẫn còn nguyên
  });

  it('đảo một chứng từ có hai khoản đã đánh giá lại: cả hai khoản con đóng, Σ dư open_item = số dư 131 theo từng đối tượng', async () => {
    const t = await tenant();
    const [v1, v2] = [toVnd('1000', '25000'), toVnd('500', '25000')];
    const inv = await t.pkt('2026-01-10', [K('131', 'KH001', v1, '0', { amountCurrency: '1000' }), K('131', 'KH002', v2, '0', { amountCurrency: '500' }),
      L('5113', '0', D(v1).plus(v2).toFixed(0), { amountCurrency: '-1500' })], { currencyCode: 'USD', fxRate: '25000' });
    await t.revalOk(); // hai khoản con: KH001 +600.000, KH002 +300.000
    const children = (await sql<{ id: number }>`SELECT id::int AS id FROM open_item WHERE tenant_id = ${t.tenantId}::uuid AND parent_id IN
      (SELECT id FROM open_item WHERE voucher_id = ${inv.id}::uuid)`.execute(ctx.t.admin)).rows.map((r) => r.id);
    expect(children).toHaveLength(2);
    expect(await t.sumsMatch('2026-01-31')).toEqual({ '131/KH001': '25600000', '131/KH002': '12800000' });
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-02-10' })).statusCode).toBe(201);
    for (const id of [await t.itemOf(inv.id, 1), await t.itemOf(inv.id, 2), ...children]) expect(await t.residual(id)).toEqual({ vnd: '0', cur: '0' });
    expect(await t.sumsMatch('2026-02-10')).toEqual({}); // 131 từng đối tượng về 0 và Σ open_item khớp sổ cái
    expect(await t.openParties()).toEqual([]);
  });

  it('GET /api/fx/runs: nhật ký chạy đánh giá lại kèm số chứng từ sinh ra và đã đảo; lọc theo loại; thiếu fx.run → 403', async () => {
    const t = await tenant();
    await t.usdInvoice('2026-01-10', '1000', '25000');
    const first = await t.revalOk();
    const second = await t.revalOk({ rates: { USD: '25700' } }); // chạy lại cùng ngày: đảo DG lần một
    const list = await t.call('GET', '/api/fx/runs');
    expect(list.statusCode, list.body).toBe(200);
    const runs = list.json() as { id: number; kind: string; fiscalYear: number; periodNo: number; runDate: string; voucherIds: string[]; voucherNos: string[]; reversedVoucherIds: string[]; reversedVoucherNos: string[] }[];
    expect(runs.map((r) => r.id)).toEqual([second.runId, first.runId]); // mới nhất trước
    expect(runs[0]).toMatchObject({ kind: 'revaluation', fiscalYear: 2026, periodNo: 1, runDate: '2026-01-31', voucherIds: second.voucherIds, reversedVoucherIds: first.voucherIds });
    expect(runs[0]!.voucherNos).toEqual([expect.stringMatching(/^DG/), expect.stringMatching(/^DG/)]); // DG chính và DG kết chuyển 413
    expect(runs[0]!.reversedVoucherNos).toEqual(runs[1]!.voucherNos);
    expect((await t.call('GET', '/api/fx/runs?kind=outflow')).json()).toEqual([]);
    expect(((await t.call('GET', '/api/fx/runs?kind=revaluation&limit=1')).json() as unknown[]).length).toBe(1);
    expect(err(await t.call('GET', '/api/fx/runs', undefined, await t.userWith('xem', [])))).toEqual([403, 'FORBIDDEN']);
    expect(runs.every((r) => !('params' in r))).toBe(true); // params có thể mang số chứng từ trong cảnh báo: không lộ ra route đọc
  });

  it('GET /api/fx/runs: công ty khác không thấy nhật ký của công ty này', async () => {
    const a = await tenant(); const b = await tenant();
    await a.usdInvoice('2026-01-10', '1000', '25000');
    const run = await a.revalOk();
    expect(((await a.call('GET', '/api/fx/runs')).json() as { id: number }[]).map((r) => r.id)).toEqual([run.runId]);
    expect((await b.call('GET', '/api/fx/runs')).json()).toEqual([]);
  });
});

// Task 27b: B02 TT99 mã 22/23 trình bày số thuần chênh lệch đánh giá lại (DG và CL gỡ đánh giá lại khi đảo); chênh lệch thực hiện vẫn gộp.
describe('B02 TT99: số thuần chênh lệch đánh giá lại', () => {
  type T = Awaited<ReturnType<typeof tenant>>;
  const b02 = async (t: T, from = '2026-01-01', to = '2026-12-31') => {
    const r = await t.call('GET', `/api/reports/financial/B02?from=${from}&to=${to}`); expect(r.statusCode, r.body).toBe(200);
    return Object.fromEntries((r.json().rows as { lineCode: string; current: string }[]).map((x) => [x.lineCode, x.current]));
  };
  const other = async (t: T) => { // 515 khác 50.000 và 635 khác 30.000 (không phải chênh lệch tỷ giá)
    await t.pkt('2026-01-15', [L('111', '50000'), L('515', '0', '50000')]); await t.pkt('2026-01-16', [L('635', '30000'), L('111', '0', '30000')]);
  };

  it('lãi 1.000.000 (131) và lỗ 400.000 (331) cùng lần chạy: mã 22 = 515 khác + 600.000, mã 23 = 635 khác; mã 30 không đổi; truy xuất mã 22 cộng lại bằng mã 22', async () => {
    const t = await tenant('TT99'); await other(t);
    await t.usdInvoice('2026-01-10', '1000', '24600'); await t.usdPurchase('2026-01-12', '100', '21600');
    const dg = await t.revalOk(); expect(dg.voucherIds).toHaveLength(1);
    const gross = [D(await t.net('515')).neg(), D(await t.net('635'))]; // gộp: Có 515 = 1.050.000, Nợ 635 = 430.000
    expect(gross.map(String)).toEqual(['1050000', '430000']);
    const r = await b02(t);
    expect([r['22'], r['23']]).toEqual(['650000', '30000']);
    expect(D(r['22']!).minus(r['23']!).toString()).toBe(gross[0]!.minus(gross[1]!).toString()); // chênh 22 - 23 (nên cả mã 30) bằng cách trình bày gộp cũ
    expect(r['30']).toBe('23060000'); // số cố định, bằng kết quả cách trình bày gộp cũ: 24.600.000 − 2.160.000 + (1.050.000 − 430.000)
    for (const [code, total] of [['22', '650000'], ['23', '30000']] as const) {
      const d = await t.call('GET', `/api/reports/financial/B02/lines/${code}?from=2026-01-01&to=2026-12-31`); expect(d.statusCode, d.body).toBe(200);
      const rows = d.json().accounts as { kind?: string; accountCode: string; accountName: string; amount: string }[];
      // dòng số thuần có kind riêng, không lẫn với dòng tài khoản 515/635 thật (giao diện không mở sổ Cái cho dòng này)
      expect(rows.map((x) => [x.kind ?? null, x.accountCode, x.amount])).toEqual(code === '22' ? [[null, '515', '50000'], ['reval_net', '515', '600000']] : [[null, '635', '30000']]);
      expect(rows.reduce((s, x) => s.plus(x.amount), D(0)).toString()).toBe(total);
    }
  });

  it('tổng lỗ đánh giá lại lớn hơn lãi: mã 23 nhận lỗ thuần, mã 22 không có phần đánh giá lại', async () => {
    const t = await tenant('TT99');
    await t.usdInvoice('2026-01-10', '1000', '25500'); await t.usdPurchase('2026-01-12', '500', '25000'); // lãi 100.000, lỗ 300.000
    await t.revalOk();
    const r = await b02(t); expect([r['22'], r['23']]).toEqual(['0', '200000']);
    const d = (await t.call('GET', '/api/reports/financial/B02/lines/23?from=2026-01-01&to=2026-12-31')).json().accounts as { kind?: string; accountCode: string; amount: string }[];
    expect(d.map((x) => [x.kind, x.accountCode, x.amount])).toEqual([['reval_net', '635', '200000']]);
    expect((await t.call('GET', '/api/reports/financial/B02/lines/22?from=2026-01-01&to=2026-12-31')).json().accounts).toEqual([]);
  });

  it('chạy lại đánh giá lại (đảo DG cũ, sinh DG mới) chỉ tính số thuần của trạng thái cuối', async () => {
    const t = await tenant('TT99');
    await t.usdInvoice('2026-01-10', '1000', '25000'); await t.usdPurchase('2026-01-12', '100', '25000');
    await t.revalOk(); // @25.600: lãi 600.000, lỗ 60.000
    let r = await b02(t); expect([r['22'], r['23']]).toEqual(['540000', '0']);
    const again = await t.revalOk({ rates: { USD: '25700' } }); // lãi 700.000, lỗ 70.000
    expect(again.reversedVoucherIds).toHaveLength(1);
    r = await b02(t); expect([r['22'], r['23']]).toEqual(['630000', '0']);
  });

  it('đảo khoản công nợ đã đánh giá lại ghi ngày trước ngày DG: lãi 600.000 và lỗ 600.000 cùng ngày, mã 22 và 23 không có phần đánh giá lại', async () => {
    const t = await tenant('TT99');
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    await t.revalOk();
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-01-20' })).statusCode).toBe(201);
    const [cl] = await t.cls();
    expect(await t.lines(cl!)).toEqual([['635', null, null, '600000', '0', '600000.0000', null], ['131', 'KH001', null, '0', '600000', '0.0000', null]]);
    expect([await t.net('515'), await t.net('635')]).toEqual(['-600000', '600000']); // gộp cũ: 22 = 600.000 và 23 = 600.000
    const r = await b02(t); expect([r['22'], r['23']]).toEqual(['0', '0']);
  });

  it('đảo khoản gốc ngày 10/02 rồi chạy lại đánh giá lại 31/01: DG2 đánh giá lại cả KH001 (700.000) và KH002 (140.000), CL2 lỗ 100.000; B02 mã 22 = 140.000, mã 23 = 0', async () => {
    const t = await tenant('TT99');
    const inv = await t.usdInvoice('2026-01-10', '1000', '25000');
    const first = await t.revalOk(); // @25.600: lãi 600.000 (DG1)
    await t.lock('soft');
    expect((await t.call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-02-10' })).statusCode).toBe(201); // CL1: lỗ 600.000
    await t.usdInvoice('2026-01-20', '200', '25000', 'KH002');
    const again = await t.revalOk({ rates: { USD: '25700' } }); // đảo DG1, ghi DG2 (KH001 700.000 + KH002 140.000), thêm CL2
    expect(again.reversedVoucherIds).toEqual(first.voucherIds);
    expect(await t.cls()).toHaveLength(2);
    // khoản gốc KH001 còn mở ngày 31/01 (bản đảo ngày 10/02) nên DG2 đánh giá lại cả KH001 lẫn KH002; 515 chỉ một dòng tổng, chi tiết theo đối tượng nằm ở các dòng 131
    expect(await t.lines(again.voucherIds[0]!)).toEqual([['131', 'KH001', null, '700000', '0', '0.0000', null], ['131', 'KH002', null, '140000', '0', '0.0000', null], ['515', null, null, '0', '840000', '-840000.0000', null]]);
    // CL2 = lỗ 100.000: số dư khoản con KH001 −600.000 (DG1 đã đảo) + 700.000 (DG2)
    expect(await t.lines((await t.cls())[1]!)).toEqual([['635', null, null, '100000', '0', '100000.0000', null], ['131', 'KH001', null, '0', '100000', '0.0000', null]]);
    expect([await t.net('515'), await t.net('635')]).toEqual(['-840000', '700000']); // gộp (cùng số với kịch bản ở trên): chênh ròng 140.000 = lãi KH002; các khoản của KH001 tự bù
    const r = await b02(t); expect([r['22'], r['23']]).toEqual(['140000', '0']);
  });

  it('chênh lệch thực hiện CL của đối trừ thông thường vẫn trình bày gộp ở 22/23 (đánh giá lại 600.000 lãi, thu nốt lỗ 100.000)', async () => {
    const t = await tenant('TT99');
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    await t.revalOk();
    // TT99 không có 1122: tiền gửi USD ghi vào 112.
    const rcv = await t.itemOf((await t.pkt('2026-02-10', [L('112', '25500000', '0', { amountCurrency: '1000' }), K('131', 'KH001', '0', '25500000', { amountCurrency: '-1000' })], { currencyCode: 'USD', fxRate: '25500' })).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    expect(await t.lines(r.fxVoucherId!)).toEqual([['635', null, null, '100000', '0', '100000.0000', null], ['131', 'KH001', null, '0', '100000', '0.0000', null]]);
    const b = await b02(t); expect([b['22'], b['23']]).toEqual(['600000', '100000']);
  });

  it('!REVAL và REVAL_* chỉ lưu được trên dòng phát sinh (movement): dòng số dư → 400 FORMULA_INVALID', async () => {
    const t = await tenant('TT99');
    const def = (source: string, formula: string) => t.call('PUT', '/api/report-defs/B02', { regime: 'TT99', lines: [{ lineCode: '22', label: 'x', parentLineCode: null, source, side: 'net_credit', formula }] });
    expect((await def('movement', '515!REVAL + REVAL_GAIN')).statusCode).toBe(200);
    for (const f of ['515!REVAL', 'REVAL_LOSS']) { const r = await def('balance', f); expect([r.statusCode, r.json().error.code]).toEqual([400, 'FORMULA_INVALID']); }
  });

  it('TT133: B02 không đổi (không dùng REVAL; đánh giá lại đi qua 413)', async () => {
    const t = await tenant('TT133');
    await t.usdInvoice('2026-01-10', '1000', '25000'); await t.revalOk();
    const defs = (await t.call('GET', '/api/report-defs/B02?regime=TT133')).json().lines as { formula: string | null }[];
    expect(defs.some((l) => /REVAL/.test(l.formula ?? ''))).toBe(false);
    const rows = (await t.call('GET', '/api/reports/financial/B02?from=2026-01-01&to=2026-12-31')).json().rows as { lineCode: string; current: string }[];
    expect(rows.find((x) => x.lineCode === '21')!.current).toBe('600000'); // 515 TT133 (mã 21) vẫn lấy gộp: DG thứ hai kết chuyển 413 sang 515
  });
});
