import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { proportionalVnd, toVnd } from '@kt/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const K = (accountCode: string, partyCode: string, debit = '0', credit = '0', more: object = {}) => L(accountCode, debit, credit, { partyCode, ...more });
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

// Mỗi kiểm thử một công ty riêng: năm 2026 theo TT133, đối tượng KH001, KH002, NCC001 (vừa là khách hàng vừa là nhà cung cấp).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `ST${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const voucher = async (body: object, autoPost = true) => {
    const r = await call('POST', '/api/vouchers', { voucherType: 'PKT', description: 'kt', autoPost, ...body }); expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; voucherNo: string; state: string; version: number; lines: { lineNo: number; settle?: unknown }[] };
  };
  const pkt = (date: string, lines: object[], extra: object = {}) => voucher({ postingDate: date, documentDate: date, lines, ...extra });
  // Hóa đơn USD: Nợ 131 / Có 5113; thu USD: Nợ 1122 / Có 131 (VND = nguyên tệ × tỷ giá).
  const usdInvoice = (date: string, qty: string, rate: string, party = 'KH001') => { const v = toVnd(qty, rate);
    return pkt(date, [K('131', party, v, '0', { amountCurrency: qty }), L('5113', '0', v, { amountCurrency: `-${qty}` })], { currencyCode: 'USD', fxRate: rate }); };
  const usdReceipt = (date: string, qty: string, rate: string, party = 'KH001') => { const v = toVnd(qty, rate);
    return pkt(date, [L('1122', v, '0', { amountCurrency: qty }), K('131', party, '0', v, { amountCurrency: `-${qty}` })], { currencyCode: 'USD', fxRate: rate }); };
  const vndInvoice = (date: string, amount: string, party = 'KH001', more: object = {}) => pkt(date, [K('131', party, amount, '0', more), L('5113', '0', amount)]);
  const vndReceipt = (date: string, amount: string, party = 'KH001') => pkt(date, [L('1111', amount), K('131', party, '0', amount)]);
  // Khoản công nợ của dòng (mặc định dòng đầu tiên trên tài khoản công nợ).
  const itemOf = async (voucherId: string, lineNo?: number) => (await sql<{ id: number }>`SELECT id::int AS id FROM open_item WHERE voucher_id = ${voucherId}::uuid
    ${lineNo ? sql`AND line_no = ${lineNo}` : sql``} ORDER BY line_no LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
  const settle = async (body: object, c = cookie) => { const r = await call('POST', '/api/settlements', body, c); expect(r.statusCode, r.body).toBe(201);
    return r.json() as { groupId: string; settlementIds: number[]; fxVoucherId: string | null }; };
  const residual = async (itemId: number) => (await sql<{ vnd: string; cur: string }>`SELECT residual::text AS vnd, trim_scale(residual_currency)::text AS cur
    FROM fn_open_items_at(${tenantId}::uuid, '2026-12-31') WHERE item_id = ${itemId}`.execute(ctx.t.admin)).rows[0];
  const fxVoucherLines = async (id: string | null) => (await sql<{ account: string; debit: string; credit: string }>`SELECT a.code AS account, l.debit::text, l.credit::text
    FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = ${id}::uuid ORDER BY l.line_no`.execute(ctx.t.admin)).rows
    .map((l) => (l.debit !== '0' ? { account: l.account, debit: l.debit } : { account: l.account, credit: l.credit }));
  const rows = async (groupId: string) => (await sql<{ d: number; c: number; amount: string; cur: string; date: string; kind: string; fx: string | null }>`SELECT debit_item_id::int AS d, credit_item_id::int AS c,
    amount::text, trim_scale(amount_currency)::text AS cur, settle_date::text AS date, kind, fx_voucher_id::text AS fx FROM settlement WHERE group_id = ${groupId}::uuid ORDER BY id`.execute(ctx.t.admin)).rows;
  // Σ dư open_item và số dư sổ cái theo (tài khoản, đối tượng) tại cuối ngày; chỉ cặp khác 0.
  const sumsMatch = async (asOf: string) => {
    const items = (await sql<{ k: string; n: string }>`SELECT a.code || '/' || p.code AS k, sum(x.residual)::text AS n FROM fn_open_items_at(${tenantId}::uuid, ${asOf}::date) x
      JOIN account a ON a.id = x.account_id JOIN party p ON p.id = x.party_id GROUP BY 1 HAVING sum(x.residual) <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows;
    const ledger = (await sql<{ k: string; n: string }>`SELECT a.code || '/' || p.code AS k, sum(l.debit - l.credit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
      JOIN account a ON a.id = l.account_id JOIN party p ON p.id = l.party_id WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.reconcile AND l.posting_date <= ${asOf}::date
      GROUP BY 1 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows;
    expect([asOf, items]).toEqual([asOf, ledger]);
  };
  const userWith = async (roleCode: string, sensitiveFlags: string[]) => {
    const username = `st_${roleCode}_${sensitiveFlags.length}_${Date.now()}${n++}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  const lock = async (level: 'soft' | 'hard', no = 1) => { const r = await call('POST', `/api/periods/2026/${no}/lock`, { level }); expect(r.statusCode, r.body).toBe(200); };
  return { cookie, tenantId, call, voucher, pkt, usdInvoice, usdReceipt, vndInvoice, vndReceipt, itemOf, settle, residual, fxVoucherLines, rows, sumsMatch, userWith, lock };
}
const err = (r: Res) => [r.statusCode, r.json().error?.code];

describe('đối trừ ngoại tệ và chênh lệch tỷ giá thực hiện', () => {
  it('thu đủ 1.000 USD ghi sổ 25.000 bằng 25.400: CL lãi 400.000, mọi khoản về 0', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '1000', '25400')).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    expect(await t.fxVoucherLines(r.fxVoucherId)).toEqual([{ account: '131', debit: '400000' }, { account: '515', credit: '400000' }]);
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' }); expect(await t.residual(rcv)).toEqual({ vnd: '0', cur: '0' });
    // chứng từ CL thật: có số, ghi sổ ngày đối trừ (ngày của khoản sau), nguồn là nhóm đối trừ
    const cl = (await t.call('GET', `/api/vouchers/${r.fxVoucherId}`)).json();
    expect([cl.voucherType, cl.state, cl.postingDate, cl.sourceDocType, cl.sourceDocId, cl.voucherNo !== null]).toEqual(['CL', 'posted', '2026-01-20', 'settlement_fx', r.groupId, true]);
    const clItem = await t.itemOf(r.fxVoucherId!);
    expect(await t.rows(r.groupId)).toEqual([
      { d: inv, c: rcv, amount: '25000000', cur: '1000', date: '2026-01-20', kind: 'manual', fx: r.fxVoucherId },
      { d: clItem, c: rcv, amount: '400000', cur: '0', date: '2026-01-20', kind: 'fx', fx: r.fxVoucherId }]);
    expect(r.settlementIds).toHaveLength(2);
    await t.sumsMatch('2026-01-19'); await t.sumsMatch('2026-01-20');
    // danh sách đối trừ
    const list = await t.call('GET', '/api/settlements?accountCode=131&partyCode=KH001&from=2026-01-01&to=2026-01-31');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ groupId: r.groupId, kind: 'manual', settleDate: '2026-01-20', accountCode: '131', partyCode: 'KH001', currency: 'USD', debitItemId: inv, creditItemId: rcv, amount: '25000000', amountCurrency: '1000.0000', fxVoucherId: r.fxVoucherId, fxVoucherNo: cl.voucherNo }),
      expect.objectContaining({ groupId: r.groupId, kind: 'fx', debitItemId: clItem, amount: '400000', amountCurrency: '0.0000' })]);
    expect((await t.call('GET', '/api/settlements?accountCode=131&from=2026-02-01&to=2026-02-28')).json()).toEqual([]);
  });

  it('thu một phần 500 USD @25.400: lãi 200.000; khoản HĐ còn 12.500.000 / 500 USD; thu nốt 500 USD @24.000: lỗ 500.000', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '500', '25400')).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '500' });
    expect(await t.fxVoucherLines(r.fxVoucherId)).toEqual([{ account: '131', debit: '200000' }, { account: '515', credit: '200000' }]);
    expect(await t.residual(inv)).toEqual({ vnd: '12500000', cur: '500' }); expect(await t.residual(rcv)).toEqual({ vnd: '0', cur: '0' });
    const rcv2 = await t.itemOf((await t.usdReceipt('2026-02-05', '500', '24000')).id);
    const r2 = await t.settle({ debitItemId: inv, creditItemId: rcv2, amountCurrency: '500' });
    expect(await t.fxVoucherLines(r2.fxVoucherId)).toEqual([{ account: '635', debit: '500000' }, { account: '131', credit: '500000' }]);
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' }); expect(await t.residual(rcv2)).toEqual({ vnd: '0', cur: '0' });
    await t.sumsMatch('2026-01-31'); await t.sumsMatch('2026-02-28');
  });

  it('tỷ giá giảm: thu 1.000 USD @24.800 → CL lỗ 200.000 Nợ 635', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '1000', '24800')).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000', date: '2026-01-25' });
    expect(await t.fxVoucherLines(r.fxVoucherId)).toEqual([{ account: '635', debit: '200000' }, { account: '131', credit: '200000' }]);
    const clItem = await t.itemOf(r.fxVoucherId!);
    expect(await t.rows(r.groupId)).toEqual([
      { d: inv, c: rcv, amount: '24800000', cur: '1000', date: '2026-01-25', kind: 'manual', fx: r.fxVoucherId },
      { d: inv, c: clItem, amount: '200000', cur: '0', date: '2026-01-25', kind: 'fx', fx: r.fxVoucherId }]);
    for (const i of [inv, rcv, clItem]) expect(await t.residual(i)).toEqual({ vnd: '0', cur: '0' });
    await t.sumsMatch('2026-01-25');
  });

  it('khoản có khoản con (điều chỉnh đánh giá lại): dư VND gồm cả khoản con, khoản con đối trừ trước theo tỷ lệ', async () => {
    const t = await tenant();
    const invV = await t.usdInvoice('2026-01-10', '1000', '25000'); const inv = await t.itemOf(invV.id);
    // điều chỉnh +200.000 trên 131 USD nguyên tệ 0 (như chứng từ DG của Task 13), gắn làm khoản con
    const adj = await t.pkt('2026-01-31', [K('131', 'KH001', '200000', '0', { amountCurrency: '0' }), L('413', '0', '200000', { amountCurrency: '0' })], { currencyCode: 'USD' });
    const child = await t.itemOf(adj.id);
    await sql`UPDATE open_item SET parent_id = ${inv} WHERE id = ${child}`.execute(ctx.t.admin);
    const rcv = await t.itemOf((await t.usdReceipt('2026-02-05', '500', '25400')).id);
    // không đối trừ riêng khoản con
    expect(err(await t.call('POST', '/api/settlements', { debitItemId: child, creditItemId: rcv, amountCurrency: '1' }))).toEqual([409, 'SETTLEMENT_MISMATCH']);
    // 500/1000: khoản con 100.000; aD = 12.600.000 (gốc 12.500.000), aC = 12.700.000 → lãi 100.000
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '500' });
    expect(await t.fxVoucherLines(r.fxVoucherId)).toEqual([{ account: '131', debit: '100000' }, { account: '515', credit: '100000' }]);
    const clItem = await t.itemOf(r.fxVoucherId!);
    expect(await t.rows(r.groupId)).toEqual([
      { d: inv, c: rcv, amount: '12500000', cur: '500', date: '2026-02-05', kind: 'manual', fx: r.fxVoucherId },
      { d: child, c: rcv, amount: '100000', cur: '0', date: '2026-02-05', kind: 'manual', fx: r.fxVoucherId },
      { d: clItem, c: rcv, amount: '100000', cur: '0', date: '2026-02-05', kind: 'fx', fx: r.fxVoucherId }]);
    expect([await t.residual(inv), await t.residual(child), await t.residual(rcv)]).toEqual([{ vnd: '12500000', cur: '500' }, { vnd: '100000', cur: '0' }, { vnd: '0', cur: '0' }]);
    // thu nốt 500 @25.000: aD = hết dư nhóm 12.600.000, aC = 12.500.000 → lỗ 100.000; mọi khoản về 0
    const rcv2 = await t.itemOf((await t.usdReceipt('2026-02-10', '500', '25000')).id);
    const r2 = await t.settle({ debitItemId: inv, creditItemId: rcv2, amountCurrency: '500' });
    expect(await t.fxVoucherLines(r2.fxVoucherId)).toEqual([{ account: '635', debit: '100000' }, { account: '131', credit: '100000' }]);
    for (const i of [inv, child, rcv2, await t.itemOf(r2.fxVoucherId!)]) expect(await t.residual(i)).toEqual({ vnd: '0', cur: '0' });
    await t.sumsMatch('2026-02-10');
  });

  it('công thức tỷ lệ trong SQL trùng proportionalVnd của domain trên cùng bộ số', async () => {
    const fixed: [string, string, string][] = [['37900000', '1500', '500'], ['37900000', '1500', '1500'], ['1', '3', '3.0000'], ['2', '3', '1'], ['25000000', '1000', '333.3333'],
      ['999999999999999', '0.0001', '0.0001'], ['123456789012345', '9876543.2109', '1234.5678'], ['200000', '1000', '500'], ['5', '7', '3.5'],
      // phép chia numeric mặc định (khoảng 16 chữ số có nghĩa) làm tròn hai lần ra lệch 1 đồng ở hai bộ này
      ['987653870729397', '1308.5014', '1039.9338'], ['987653742647491', '1329.5276', '1051.2556']];
    const random = fc.sample(fc.tuple(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.integer({ min: 1, max: 10 ** 9 }), fc.integer({ min: 1, max: 10 ** 9 }))
      .map(([v, c, p]) => [v.toString(), (c / 10_000).toFixed(4), (Math.min(p, c) / 10_000).toFixed(4)] as [string, string, string]), { numRuns: 300, seed: 12 });
    const all = [...fixed, ...random];
    const r = await sql<{ i: number; a: string }>`SELECT i::int AS i, fn_proportional_vnd(v, c, p)::text AS a FROM unnest(${all.map((x) => x[0])}::numeric[], ${all.map((x) => x[1])}::numeric[], ${all.map((x) => x[2])}::numeric[]) WITH ORDINALITY AS u(v, c, p, i) ORDER BY i`.execute(ctx.t.admin);
    expect(r.rows.map((x) => x.a)).toEqual(all.map(([v, c, p]) => proportionalVnd(v, c, p)));
  });

  it('phía phải trả: HĐ Có 331 1.000 USD @25.000, trả Nợ 331 @25.400 → CL lỗ Nợ 635 / Có 331 400.000, dư về 0', async () => {
    const t = await tenant();
    const v = toVnd('1000', '25000'); const v2 = toVnd('1000', '25400');
    const inv = await t.itemOf((await t.pkt('2026-01-10', [L('6421', v, '0', { amountCurrency: '1000' }), K('331', 'NCC001', '0', v, { amountCurrency: '-1000' })], { currencyCode: 'USD', fxRate: '25000' })).id);
    await t.usdReceipt('2026-01-15', '1000', '25400', 'KH002'); // có USD trong 1122 để chi
    const pay = await t.itemOf((await t.pkt('2026-01-20', [K('331', 'NCC001', v2, '0', { amountCurrency: '1000' }), L('1122', '0', v2, { amountCurrency: '-1000' })], { currencyCode: 'USD', fxRate: '25400' })).id);
    const r = await t.settle({ debitItemId: pay, creditItemId: inv, amountCurrency: '1000' });
    expect(await t.fxVoucherLines(r.fxVoucherId)).toEqual([{ account: '635', debit: '400000' }, { account: '331', credit: '400000' }]);
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' }); expect(await t.residual(pay)).toEqual({ vnd: '0', cur: '0' });
    await t.sumsMatch('2026-01-20');
  });
});

describe('hủy đối trừ', () => {
  it('hủy đối trừ: xóa settlement, đảo CL, dư trở lại như trước; ghi audit_event', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '1000', '25400')).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    const ids = (await t.rows(r.groupId)).length;
    const del = await t.call('DELETE', `/api/settlements/groups/${r.groupId}`); expect(del.statusCode, del.body).toBe(204);
    expect(await t.rows(r.groupId)).toEqual([]);
    expect(await t.residual(inv)).toEqual({ vnd: '25000000', cur: '1000' }); expect(await t.residual(rcv)).toEqual({ vnd: '-25400000', cur: '-1000' });
    // CL đã đảo cùng ngày đối trừ; khoản của bản đảo tự đối trừ với khoản CL (kiểu reversal)
    const cl = (await t.call('GET', `/api/vouchers/${r.fxVoucherId}`)).json();
    const rev = (await t.call('GET', `/api/vouchers/${cl.reversedById}`)).json();
    expect([cl.state, rev.state, rev.postingDate, rev.voucherType]).toEqual(['reversed', 'posted', '2026-01-20', 'CL']);
    const clItem = await t.itemOf(cl.id); const revItem = await t.itemOf(rev.id);
    expect([await t.residual(clItem), await t.residual(revItem)]).toEqual([{ vnd: '0', cur: '0' }, { vnd: '0', cur: '0' }]);
    const revGroup = (await sql<{ g: string; kind: string }>`SELECT group_id::text AS g, kind FROM settlement WHERE debit_item_id = ${clItem}`.execute(ctx.t.admin)).rows;
    expect(revGroup.map((x) => x.kind)).toEqual(['reversal']);
    // nhật ký: mỗi dòng đối trừ bị xóa một bản ghi có trạng thái trước
    const audit = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'settlement' AND action = 'delete'
      AND before->>'group_id' = ${r.groupId} AND after IS NULL`.execute(ctx.t.admin);
    expect(audit.rows[0]!.n).toBe(ids);
    await t.sumsMatch('2026-01-20');
    // nhóm không còn → 404; nhóm do đảo chứng từ sinh ra → 409
    expect(err(await t.call('DELETE', `/api/settlements/groups/${r.groupId}`))).toEqual([404, 'SETTLEMENT_NOT_FOUND']);
    expect(err(await t.call('DELETE', `/api/settlements/groups/${revGroup[0]!.g}`))).toEqual([409, 'SETTLEMENT_REVERSAL_LOCKED']);
    // đối trừ lại được, đã hủy đối trừ thì bỏ ghi sổ chứng từ được
    const again = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' });
    expect((await t.call('DELETE', `/api/settlements/groups/${again.groupId}`)).statusCode).toBe(204);
    const invVoucher = (await sql<{ v: string }>`SELECT voucher_id::text AS v FROM open_item WHERE id = ${inv}`.execute(ctx.t.admin)).rows[0]!.v;
    expect((await t.call('POST', `/api/vouchers/${invVoucher}/unpost`)).statusCode).toBe(200);
  });
});

describe('đối trừ tự động', () => {
  it('đối trừ tự động theo hạn thanh toán sớm nhất trước', async () => {
    const t = await tenant();
    const a = await t.itemOf((await t.vndInvoice('2026-02-01', '100', 'KH001', { dueDate: '2026-03-31' })).id);
    const b = await t.itemOf((await t.vndInvoice('2026-02-05', '200', 'KH001', { dueDate: '2026-02-20' })).id);
    const c = await t.itemOf((await t.vndInvoice('2026-02-03', '300')).id); // không có hạn: theo ngày chứng từ 03/02
    const usd = await t.itemOf((await t.usdInvoice('2026-02-02', '10', '25000')).id); // khác loại tiền: không ghép
    const r1 = await t.itemOf((await t.vndReceipt('2026-02-10', '250')).id);
    const r2 = await t.itemOf((await t.vndReceipt('2026-02-12', '400')).id);
    const r3 = await t.itemOf((await t.vndReceipt('2026-03-05', '100')).id); // sau ngày đối trừ: không ghép
    const k2i = await t.itemOf((await t.vndInvoice('2026-02-01', '70', 'KH002')).id);
    const k2r = await t.itemOf((await t.vndReceipt('2026-02-02', '70', 'KH002')).id);
    const auto = (body: object) => t.call('POST', '/api/settlements/auto', body);
    const one = await auto({ accountCode: '131', partyCode: 'KH001', date: '2026-02-28' }); expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toEqual({ groups: 4, more: false });
    const s = (await sql<{ d: number; c: number; amount: string; date: string; kind: string; g: string }>`SELECT s.debit_item_id::int AS d, s.credit_item_id::int AS c, s.amount::text, s.settle_date::text AS date, s.kind, s.group_id::text AS g
      FROM settlement s JOIN open_item o ON o.id = s.debit_item_id JOIN party p ON p.id = o.party_id WHERE s.tenant_id = ${t.tenantId}::uuid AND p.code = 'KH001' ORDER BY s.id`.execute(ctx.t.admin)).rows;
    expect(s.map(({ g: _g, ...x }) => x)).toEqual([
      { d: c, c: r1, amount: '250', date: '2026-02-28', kind: 'auto' }, { d: c, c: r2, amount: '50', date: '2026-02-28', kind: 'auto' },
      { d: b, c: r2, amount: '200', date: '2026-02-28', kind: 'auto' }, { d: a, c: r2, amount: '100', date: '2026-02-28', kind: 'auto' }]);
    expect(new Set(s.map((x) => x.g)).size).toBe(4); // mỗi cặp một nhóm
    expect([await t.residual(r2), await t.residual(r3), await t.residual(usd), await t.residual(k2i)]).toEqual([{ vnd: '-50', cur: '-50' }, { vnd: '-100', cur: '-100' }, { vnd: '250000', cur: '10' }, { vnd: '70', cur: '70' }]);
    expect((await auto({ accountCode: '131', date: '2026-02-28' })).json()).toEqual({ groups: 1, more: false }); // KH002
    expect(await t.residual(k2r)).toEqual({ vnd: '0', cur: '0' });
    expect((await auto({ accountCode: '131', date: '2026-02-28' })).json()).toEqual({ groups: 0, more: false });
    await t.sumsMatch('2026-02-28');
    expect(err(await auto({ accountCode: '9999', date: '2026-02-28' }))).toEqual([404, 'ACCOUNT_NOT_FOUND']);
    expect(err(await auto({ accountCode: '131', partyCode: 'KHONGCO', date: '2026-02-28' }))).toEqual([404, 'PARTY_NOT_FOUND']);
  });
});

describe('kế hoạch đối trừ gửi kèm chứng từ', () => {
  it('phiếu thu từ hóa đơn: ghi sổ áp kế hoạch; bỏ ghi sổ sau đó bị chặn vì đã đối trừ', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.vndInvoice('2026-03-01', '1000')).id);
    const body = (amount: string, more: object = {}) => ({ voucherType: 'PT', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001',
      lines: [L('1111', amount), K('131', 'KH001', '0', amount, { settle: [{ openItemId: inv, amount }] })], ...more });
    const draft = await t.voucher(body('600'), false);
    expect(draft.lines[1]!.settle).toEqual([{ openItemId: inv, amount: '600' }]);
    // sửa nháp thay kế hoạch
    const upd = await t.call('PUT', `/api/vouchers/${draft.id}`, { version: draft.version, ...body('500') }); expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().lines[1].settle).toEqual([{ openItemId: inv, amount: '500' }]);
    const post = await t.call('POST', `/api/vouchers/${draft.id}/post`); expect(post.statusCode, post.body).toBe(200);
    const rec = await t.itemOf(draft.id);
    const s = await sql<{ d: number; c: number; amount: string; date: string; kind: string }>`SELECT debit_item_id::int AS d, credit_item_id::int AS c, amount::text, settle_date::text AS date, kind
      FROM settlement WHERE credit_item_id = ${rec}`.execute(ctx.t.admin);
    expect(s.rows).toEqual([{ d: inv, c: rec, amount: '500', date: '2026-03-10', kind: 'plan' }]);
    expect(await t.residual(inv)).toEqual({ vnd: '500', cur: '500' });
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM settlement_plan WHERE voucher_id = ${draft.id}::uuid`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
    expect(err(await t.call('POST', `/api/vouchers/${draft.id}/unpost`))).toEqual([409, 'OPEN_ITEM_SETTLED']);
    // kế hoạch chỉ ghi được khi chứng từ còn nháp (trigger fn_voucher_child_guard)
    await expect(sql`INSERT INTO settlement_plan(tenant_id, voucher_id, line_no, open_item_id, amount) VALUES (${t.tenantId}::uuid, ${draft.id}::uuid, 2, ${inv}, 1)`.execute(ctx.t.admin))
      .rejects.toThrow(/VOUCHER_POSTED_EDIT/);
    await t.sumsMatch('2026-03-10');
    // đầu vào: thiếu số tiền, khoản không có, dòng không phải công nợ
    expect(err(await t.call('POST', '/api/vouchers', { ...body('100'), lines: [L('1111', '100'), K('131', 'KH001', '0', '100', { settle: [{ openItemId: inv }] })] }))).toEqual([400, 'VALIDATION']);
    expect(err(await t.call('POST', '/api/vouchers', { ...body('100'), lines: [L('1111', '100'), K('131', 'KH001', '0', '100', { settle: [{ openItemId: 987654321, amount: '100' }] })] }))).toEqual([404, 'OPEN_ITEM_NOT_FOUND']);
    for (const s of [{ openItemId: inv, amount: '0' }, { openItemId: inv, amountCurrency: '-5' }, { openItemId: inv, amountCurrency: '0.0000' }, { openItemId: 0, amount: '100' }])
      expect(err(await t.call('POST', '/api/vouchers', { ...body('100'), lines: [L('1111', '100'), K('131', 'KH001', '0', '100', { settle: [s] })] }))).toEqual([400, 'VALIDATION']);
    const bad = await t.call('POST', '/api/vouchers', { ...body('100'), autoPost: true, lines: [L('1111', '100', '0', { settle: [{ openItemId: inv, amount: '100' }] }), K('131', 'KH001', '0', '100')] });
    expect(err(bad)).toEqual([409, 'SETTLEMENT_PLAN_LINE_INVALID']);
    // xóa nháp có kế hoạch được
    const d2 = await t.voucher(body('100'), false);
    expect((await t.call('DELETE', `/api/vouchers/${d2.id}`)).statusCode).toBe(204);
    // khoản đang được chứng từ nháp chọn: bỏ ghi sổ chứng từ của khoản báo rõ; hủy nháp thì bỏ kế hoạch, bỏ ghi sổ được
    const inv2V = await t.vndInvoice('2026-03-02', '300'); const inv2 = await t.itemOf(inv2V.id);
    const d3 = await t.voucher({ ...body('300'), lines: [L('1111', '300'), K('131', 'KH001', '0', '300', { settle: [{ openItemId: inv2, amount: '300' }] })] }, false);
    const blocked = await t.call('POST', `/api/vouchers/${inv2V.id}/unpost`);
    expect([...err(blocked), blocked.json().error.message]).toEqual([409, 'OPEN_ITEM_PLANNED', 'khoản công nợ của chứng từ đang được chọn đối trừ ở chứng từ nháp PT ngày 10/03/2026, hãy bỏ chọn ở chứng từ đó trước']);
    // đảo chứng từ của khoản đang được chọn cũng bị chặn như bỏ ghi sổ
    expect(err(await t.call('POST', `/api/vouchers/${inv2V.id}/reverse`, { postingDate: '2026-03-20' }))).toEqual([409, 'OPEN_ITEM_PLANNED']);
    expect((await t.call('POST', `/api/vouchers/${d3.id}/discard`)).statusCode).toBe(200);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM settlement_plan WHERE voucher_id = ${d3.id}::uuid`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
    expect((await t.call('POST', `/api/vouchers/${inv2V.id}/unpost`)).statusCode).toBe(200);
  });

  it('bù trừ công nợ: khách hàng đồng thời là NCC, BT Nợ 331 / Có 131 có settle cả hai phía', async () => {
    const t = await tenant();
    const sale = await t.itemOf((await t.vndInvoice('2026-04-01', '1000000')).id);
    const buy = await t.itemOf((await t.pkt('2026-04-02', [L('6421', '600000'), K('331', 'KH001', '0', '600000')])).id);
    const bt = await t.voucher({ voucherType: 'BT', postingDate: '2026-04-15', documentDate: '2026-04-15', partyCode: 'KH001',
      lines: [K('331', 'KH001', '600000', '0', { settle: [{ openItemId: buy, amount: '600000' }] }), K('131', 'KH001', '0', '600000', { settle: [{ openItemId: sale, amount: '600000' }] })] });
    expect(bt.state).toBe('posted');
    expect([await t.residual(sale), await t.residual(buy), await t.residual(await t.itemOf(bt.id, 1)), await t.residual(await t.itemOf(bt.id, 2))])
      .toEqual([{ vnd: '400000', cur: '400000' }, { vnd: '0', cur: '0' }, { vnd: '0', cur: '0' }, { vnd: '0', cur: '0' }]);
    expect((await sql<{ kind: string }>`SELECT kind FROM settlement WHERE tenant_id = ${t.tenantId}::uuid ORDER BY id`.execute(ctx.t.admin)).rows.map((x) => x.kind)).toEqual(['plan', 'plan']);
    await t.sumsMatch('2026-04-30');
  });

  it('kế hoạch đối trừ cần quyền settlement.create và cờ nhạy cảm của tài khoản khoản, như POST /api/settlements', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.vndInvoice('2026-03-01', '1000')).id);
    const body = (settle?: object[]) => ({ voucherType: 'PT', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001',
      lines: [L('1111', '400'), K('131', 'KH001', '0', '400', settle ? { settle } : {})] });
    const plan = [{ openItemId: inv, amount: '400' }];
    const noFlag = await t.userWith('ketoan_vien', []);
    const forbidden = await t.call('POST', '/api/vouchers', { ...body(plan), autoPost: true }, noFlag);
    expect([...err(forbidden), forbidden.json().error.message]).toEqual([403, 'FORBIDDEN', 'Không có quyền xem công nợ phải thu']);
    const draft = await t.call('POST', '/api/vouchers', body(), noFlag); expect(draft.statusCode, draft.body).toBe(201); // không kèm kế hoạch thì được
    expect(err(await t.call('PUT', `/api/vouchers/${draft.json().id}`, { version: draft.json().version, ...body(plan) }, noFlag))).toEqual([403, 'FORBIDDEN']);
    const withFlag = await t.userWith('ketoan_vien', ['view_receivable']);
    expect((await t.call('POST', '/api/vouchers', body(plan), withFlag)).statusCode).toBe(201);
    // vai trò mất settlement.create: kế hoạch bị chặn, chứng từ không kèm kế hoạch vẫn lập được
    const role = ((await t.call('GET', '/api/roles')).json() as { id: string; code: string; permissions: string[] }[]).find((r) => r.code === 'ketoan_vien')!;
    expect((await t.call('PUT', `/api/roles/${role.id}/permissions`, { permissions: role.permissions.filter((x) => x !== 'settlement.create') })).statusCode).toBe(200);
    const noPerm = await t.call('POST', '/api/vouchers', body(plan), withFlag);
    expect([...err(noPerm), noPerm.json().error.message]).toEqual([403, 'FORBIDDEN', 'Thiếu quyền settlement.create']);
    expect((await t.call('POST', '/api/vouchers', body(), withFlag)).statusCode).toBe(201);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM settlement_plan sp JOIN voucher v ON v.id = sp.voucher_id WHERE v.tenant_id = ${t.tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n).toBe(1);
  });

  it('kế hoạch trên khoản ngoại tệ: chứng từ CL sinh và ghi sổ ngay trong lúc ghi sổ chứng từ thu', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const v = toVnd('1000', '25400');
    const rcv = await t.pkt('2026-01-20', [L('1122', v, '0', { amountCurrency: '1000' }), K('131', 'KH001', '0', v, { amountCurrency: '-1000', settle: [{ openItemId: inv, amountCurrency: '1000' }] })],
      { currencyCode: 'USD', fxRate: '25400' });
    expect(rcv.state).toBe('posted');
    const rcvItem = await t.itemOf(rcv.id);
    const g = (await sql<{ g: string; fx: string }>`SELECT group_id::text AS g, fx_voucher_id::text AS fx FROM settlement WHERE credit_item_id = ${rcvItem} AND kind = 'plan'`.execute(ctx.t.admin)).rows[0]!;
    expect(await t.fxVoucherLines(g.fx)).toEqual([{ account: '131', debit: '400000' }, { account: '515', credit: '400000' }]);
    const cl = (await t.call('GET', `/api/vouchers/${g.fx}`)).json();
    expect([cl.voucherType, cl.state, cl.postingDate, cl.sourceDocType, cl.sourceDocId]).toEqual(['CL', 'posted', '2026-01-20', 'settlement_fx', g.g]);
    expect((await t.rows(g.g)).map((r) => r.kind)).toEqual(['plan', 'fx']);
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' }); expect(await t.residual(rcvItem)).toEqual({ vnd: '0', cur: '0' });
    await t.sumsMatch('2026-01-20');
  });

  it('khoản đã bị đối trừ hết trước khi nháp ghi sổ: 409 SETTLEMENT_EXCEEDS_RESIDUAL, nháp vẫn là nháp, giữ kế hoạch', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.vndInvoice('2026-03-01', '1000')).id);
    const draft = await t.voucher({ voucherType: 'PT', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001',
      lines: [L('1111', '1000'), K('131', 'KH001', '0', '1000', { settle: [{ openItemId: inv, amount: '1000' }] })] }, false);
    const rcv = await t.itemOf((await t.vndReceipt('2026-03-05', '1000')).id);
    await t.settle({ debitItemId: inv, creditItemId: rcv, amount: '1000' });
    expect(err(await t.call('POST', `/api/vouchers/${draft.id}/post`))).toEqual([409, 'SETTLEMENT_EXCEEDS_RESIDUAL']);
    const after = (await t.call('GET', `/api/vouchers/${draft.id}`)).json();
    expect([after.state, after.lines[1].settle]).toEqual(['draft', [{ openItemId: inv, amount: '1000' }]]);
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' });
    await t.sumsMatch('2026-03-10');
  });
});

describe('từ chối đối trừ sai', () => {
  it('đối trừ khác loại tiền, vượt dư, kỳ khóa: 409 với mã riêng', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.vndInvoice('2026-01-10', '1000000')).id);
    const rcv = await t.itemOf((await t.vndReceipt('2026-01-20', '1000000')).id);
    const usdRcv = await t.itemOf((await t.usdReceipt('2026-01-20', '40', '25000')).id);
    const k2 = await t.itemOf((await t.vndReceipt('2026-01-20', '1000000', 'KH002')).id);
    const post = (body: object, c?: string) => t.call('POST', '/api/settlements', body, c);
    expect(err(await post({ debitItemId: inv, creditItemId: usdRcv, amount: '100' }))).toEqual([409, 'SETTLEMENT_MISMATCH']);
    expect(err(await post({ debitItemId: inv, creditItemId: k2, amount: '100' }))).toEqual([409, 'SETTLEMENT_MISMATCH']); // khác đối tượng
    expect(err(await post({ debitItemId: rcv, creditItemId: inv, amount: '100' }))).toEqual([409, 'SETTLEMENT_MISMATCH']); // ngược chiều
    expect(err(await post({ debitItemId: inv, creditItemId: rcv, amount: '1000001' }))).toEqual([409, 'SETTLEMENT_EXCEEDS_RESIDUAL']);
    expect(err(await post({ debitItemId: inv, creditItemId: rcv }))).toEqual([400, 'VALIDATION']); // khoản VND phải có số tiền
    expect(err(await post({ debitItemId: inv, creditItemId: rcv, amount: '0' }))).toEqual([400, 'VALIDATION']);
    expect(err(await post({ debitItemId: inv, creditItemId: rcv, amount: '1.5' }))).toEqual([400, 'VALIDATION']);
    expect(err(await post({ debitItemId: inv, creditItemId: 987654321, amount: '1' }))).toEqual([404, 'OPEN_ITEM_NOT_FOUND']);
    const usdInv = await t.itemOf((await t.usdInvoice('2026-01-10', '30', '25000')).id);
    expect(err(await post({ debitItemId: usdInv, creditItemId: usdRcv, amountCurrency: '31' }))).toEqual([409, 'SETTLEMENT_EXCEEDS_RESIDUAL']);
    // cờ nhạy cảm: thiếu view_receivable thì không đối trừ được trên 131
    const vien = await t.userWith('ketoan_vien', []);
    const denied = await post({ debitItemId: inv, creditItemId: rcv, amount: '100' }, vien);
    expect([denied.statusCode, denied.json().error.code, denied.json().error.message]).toEqual([403, 'FORBIDDEN', 'Không có quyền xem công nợ phải thu']);
    // cùng tỷ giá: không sinh CL
    expect((await t.settle({ debitItemId: usdInv, creditItemId: usdRcv, amountCurrency: '30' })).fxVoucherId).toBeNull();
    expect(await t.residual(usdRcv)).toEqual({ vnd: '-250000', cur: '-10' });
    // kỳ khóa: đối trừ đã có rồi khóa sổ kỳ 1
    const vienR = await t.userWith('ketoan_vien', ['view_receivable']);
    const g = await t.settle({ debitItemId: inv, creditItemId: rcv, amount: '400000' });
    await t.lock('soft');
    expect(err(await post({ debitItemId: inv, creditItemId: rcv, amount: '100' }, vienR))).toEqual([409, 'PERIOD_SOFT_LOCKED']);
    expect(err(await t.call('DELETE', `/api/settlements/groups/${g.groupId}`, undefined, vienR))).toEqual([409, 'PERIOD_SOFT_LOCKED']);
    expect((await post({ debitItemId: inv, creditItemId: rcv, amount: '100', date: '2026-02-03' }, vienR)).statusCode).toBe(201); // ngày đối trừ ở kỳ mở
    await t.lock('hard', 0); await t.lock('hard');
    expect(err(await post({ debitItemId: inv, creditItemId: rcv, amount: '100' }))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(err(await t.call('DELETE', `/api/settlements/groups/${g.groupId}`))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(await t.residual(inv)).toEqual({ vnd: '599900', cur: '599900' });
  });

  it('id khoản và nhóm đối trừ của công ty khác: 404, không chạm dữ liệu của công ty đó', async () => {
    const a = await tenant(); const b = await tenant();
    const inv = await a.itemOf((await a.vndInvoice('2026-02-01', '1000')).id);
    const rcv = await a.itemOf((await a.vndReceipt('2026-02-05', '600')).id);
    const g = await a.settle({ debitItemId: inv, creditItemId: rcv, amount: '600' });
    const inv2 = await a.itemOf((await a.vndInvoice('2026-02-02', '500')).id);
    const rcv2 = await a.itemOf((await a.vndReceipt('2026-02-06', '500')).id);
    expect(err(await b.call('POST', '/api/settlements', { debitItemId: inv2, creditItemId: rcv2, amount: '500' }))).toEqual([404, 'OPEN_ITEM_NOT_FOUND']);
    expect(err(await b.call('DELETE', `/api/settlements/groups/${g.groupId}`))).toEqual([404, 'SETTLEMENT_NOT_FOUND']);
    expect((await a.rows(g.groupId)).length).toBe(1);
    expect(await a.residual(inv2)).toEqual({ vnd: '500', cur: '500' });
  });

  it('kỳ khóa sổ: hủy đối trừ có CL cần quyền ghi lùi, đảo CL đúng ngày đối trừ', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '1000', '25400')).id);
    const r = await t.settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
    await t.lock('soft');
    const vien = await t.userWith('ketoan_vien', ['view_receivable']);
    expect(err(await t.call('DELETE', `/api/settlements/groups/${r.groupId}`, undefined, vien))).toEqual([409, 'PERIOD_SOFT_LOCKED']);
    expect(await t.residual(inv)).toEqual({ vnd: '0', cur: '0' });
    expect((await t.call('DELETE', `/api/settlements/groups/${r.groupId}`)).statusCode).toBe(204); // admin có voucher.backdate_locked
    const cl = (await t.call('GET', `/api/vouchers/${r.fxVoucherId}`)).json();
    expect([cl.state, (await t.call('GET', `/api/vouchers/${cl.reversedById}`)).json().postingDate]).toEqual(['reversed', '2026-01-20']);
    expect(await t.residual(inv)).toEqual({ vnd: '25000000', cur: '1000' });
  });

  it('thiếu quy tắc tỷ giá của chế độ: 409 FX_RULES_MISSING, không ghi gì', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.usdInvoice('2026-01-10', '1000', '25000')).id);
    const rcv = await t.itemOf((await t.usdReceipt('2026-01-20', '1000', '25400')).id);
    const saved = (await sql<{ rules: unknown }>`SELECT rules FROM fx_rule WHERE regime = 'TT133'`.execute(ctx.t.admin)).rows[0]!.rules;
    await sql`DELETE FROM fx_rule WHERE regime = 'TT133'`.execute(ctx.t.admin);
    try {
      expect(err(await t.call('POST', '/api/settlements', { debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' }))).toEqual([409, 'FX_RULES_MISSING']);
    } finally { await sql`INSERT INTO fx_rule(regime, rules) VALUES ('TT133', ${JSON.stringify(saved)}::jsonb)`.execute(ctx.t.admin); }
    expect(await t.residual(inv)).toEqual({ vnd: '25000000', cur: '1000' });
    expect(saved).toEqual(expect.objectContaining({ gainAccount: '515', lossAccount: '635' })); // nạp từ fx-rules.json
  });
});

describe('bất biến của bảng settlement và các sửa của Task 11', () => {
  it('trigger fn_settlement_guard chặn INSERT trực tiếp vi phạm từng quy tắc', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.vndInvoice('2026-01-10', '1000')).id);
    const rcv = await t.itemOf((await t.vndReceipt('2026-01-20', '1000')).id);
    const k2 = await t.itemOf((await t.vndReceipt('2026-01-20', '1000', 'KH002')).id);
    const ins = (d: number, c: number, amount: string, cur: string, date: string) => sql`INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id)
      VALUES (${t.tenantId}::uuid, ${d}, ${c}, ${amount}::numeric, ${cur}::numeric, ${date}::date, 'manual', gen_random_uuid())`.execute(ctx.t.admin);
    await expect(ins(inv, k2, '1', '1', '2026-01-20')).rejects.toThrow(/SETTLEMENT_MISMATCH/); // khác đối tượng
    await expect(ins(rcv, inv, '1', '1', '2026-01-20')).rejects.toThrow(/SETTLEMENT_MISMATCH/); // khoản Nợ mang số âm
    await expect(ins(inv, rcv, '1', '1', '2026-01-19')).rejects.toThrow(/SETTLEMENT_DATE_BEFORE_POSTING/);
    await expect(ins(inv, rcv, '1', '2', '2026-01-20')).rejects.toThrow(/SETTLEMENT_VND_CURRENCY/);
    await ins(inv, rcv, '1', '1', '2026-01-20');
    expect(await t.residual(inv)).toEqual({ vnd: '999', cur: '999' });
  });

  it('hai đối trừ đồng thời trên cùng một khoản không vượt dư (khóa FOR UPDATE)', async () => {
    const t = await tenant();
    const inv = await t.itemOf((await t.vndInvoice('2026-01-10', '1000')).id);
    const r1 = await t.itemOf((await t.vndReceipt('2026-01-20', '600')).id);
    const r2 = await t.itemOf((await t.vndReceipt('2026-01-21', '600')).id);
    const call = (c: number) => sql`SELECT settle_open_items(${inv}, ${c}, NULL, 600, NULL, 'manual', gen_random_uuid())`;
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    let firstDone!: () => void; const first = new Promise<void>((res) => { firstDone = res; });
    const t1 = ctx.t.admin.transaction().execute(async (trx) => { await call(r1).execute(trx); firstDone(); await gate; });
    await first;
    let second: 'pending' | 'ok' | string = 'pending';
    const t2 = ctx.t.admin.transaction().execute(async (trx) => { await call(r2).execute(trx); })
      .then(() => { second = 'ok'; }, (e: Error) => { second = e.message; });
    await new Promise((res) => setTimeout(res, 500));
    expect(second).toBe('pending'); // đang chờ khóa của giao dịch 1
    release(); await t1; await t2;
    expect(second).toMatch(/^SETTLEMENT_EXCEEDS_RESIDUAL/);
    expect(await t.residual(inv)).toEqual({ vnd: '400', cur: '400' });
  });

  it('đánh lại số chứng từ cập nhật số chứng từ của khoản công nợ', async () => {
    const t = await tenant();
    const a = await t.vndInvoice('2026-03-10', '100'); const b = await t.vndInvoice('2026-03-05', '200'); // b ghi sổ sau nhưng ngày trước
    const r = await t.call('POST', '/api/vouchers/renumber', { voucherType: 'PKT', fiscalYear: 2026 }); expect(r.statusCode, r.body).toBe(200);
    const docs = await sql<{ doc_no: string; voucher_no: string }>`SELECT o.doc_no, v.voucher_no FROM open_item o JOIN voucher v ON v.id = o.voucher_id WHERE o.voucher_id IN (${a.id}::uuid, ${b.id}::uuid) ORDER BY v.posting_date`.execute(ctx.t.admin);
    expect(docs.rows.map((x) => x.doc_no)).toEqual(docs.rows.map((x) => x.voucher_no));
    expect(docs.rows.map((x) => x.doc_no)).toEqual([a.voucherNo, b.voucherNo]); // b nhận số cũ của a (ngày trước), a nhận số cũ của b
  });

  it('fn_open_items_create chỉ cho chứng từ đã ghi sổ; fn_open_items_settle_reversal chỉ cho đúng cặp gốc/đảo', async () => {
    const t = await tenant();
    const draft = await t.voucher({ postingDate: '2026-01-10', documentDate: '2026-01-10', lines: [K('131', 'KH001', '100'), L('5113', '0', '100')] }, false);
    expect((await sql<{ n: number }>`SELECT fn_open_items_create(${draft.id}::uuid) AS n`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
    const a = await t.vndInvoice('2026-01-10', '100'); const b = await t.vndInvoice('2026-01-11', '100');
    expect((await sql<{ n: number }>`SELECT fn_open_items_settle_reversal(${a.id}::uuid, ${b.id}::uuid) AS n`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
  });
});
