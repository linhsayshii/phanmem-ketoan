import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const K = (accountCode: string, partyCode: string, debit = '0', credit = '0', more: object = {}) => L(accountCode, debit, credit, { partyCode, ...more });
type V = { id: string; voucherNo: string; state: string };
async function pkt(date: string, lines: object[], extra: object = {}): Promise<V> {
  const r = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: `PKT ${date}`, autoPost: true, lines, ...extra });
  expect(r.statusCode, r.body).toBe(201); return r.json();
}
const reverse = async (id: string, postingDate: string): Promise<V> => { const r = await call('POST', `/api/vouchers/${id}/reverse`, { postingDate }); expect(r.statusCode, r.body).toBe(201); return r.json(); };
const stateOf = async (id: string) => (await call('GET', `/api/vouchers/${id}`)).json().state as string;

type Item = { id: number; line_no: number; account: string; party: string; doc_no: string | null; doc_date: string; due_date: string | null; amount: string; amount_currency: string };
const items = async (voucherId: string) => (await sql<Item>`SELECT o.id::int AS id, o.line_no, a.code AS account, p.code AS party, o.doc_no, o.doc_date::text, o.due_date::text, o.amount::text, o.amount_currency::text
  FROM open_item o JOIN account a ON a.id = o.account_id JOIN party p ON p.id = o.party_id WHERE o.voucher_id = ${voucherId}::uuid ORDER BY o.line_no`.execute(ctx.t.admin)).rows;
const residualOf = async (itemId: number, asOf: string) => (await sql<{ r: string }>`SELECT residual::text AS r FROM fn_open_items_at(${tenantId}::uuid, ${asOf}::date) WHERE item_id = ${itemId}`.execute(ctx.t.admin)).rows[0]?.r ?? null;
const settle = (debitItem: number, creditItem: number, amount: string, date: string) =>
  sql`INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id) VALUES (${tenantId}::uuid, ${debitItem}, ${creditItem}, ${amount}::numeric, ${amount}::numeric, ${date}::date, 'manual', gen_random_uuid())`.execute(ctx.t.admin);
// Tổng dư còn lại của open_item và số dư sổ cái theo (tài khoản, đối tượng) tại cuối ngày asOf; chỉ cặp khác 0.
const residualSums = async (asOf: string) => (await sql<{ k: string; n: string }>`SELECT a.code || '/' || p.code AS k, sum(x.residual)::text AS n FROM fn_open_items_at(${tenantId}::uuid, ${asOf}::date) x
  JOIN account a ON a.id = x.account_id JOIN party p ON p.id = x.party_id GROUP BY 1 HAVING sum(x.residual) <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows;
const ledgerSums = async (asOf: string) => (await sql<{ k: string; n: string }>`SELECT a.code || '/' || p.code AS k, sum(l.debit - l.credit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
  JOIN account a ON a.id = l.account_id JOIN party p ON p.id = l.party_id
  WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.reconcile AND l.posting_date <= ${asOf}::date GROUP BY 1 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1`.execute(ctx.t.admin)).rows;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `OI${Date.now()}` }));
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  for (const p of [{ code: 'KH001', name: 'Khách 1', is_customer: true, payment_term_days: 30 }, { code: 'KH002', name: 'Khách 2', is_customer: true }, { code: 'NCC001', name: 'Nhà cung cấp 1', is_vendor: true }])
    expect((await call('POST', '/api/catalogs/party', p)).statusCode).toBe(201);
});
afterAll(async () => { await ctx.close(); });

describe('công nợ theo chứng từ (open_item)', () => {
  it('tài khoản công nợ của công ty mới có reconcile = true', async () => {
    const r = await sql<{ code: string; reconcile: boolean }>`SELECT code, reconcile FROM account WHERE tenant_id = ${tenantId}::uuid AND code IN ('131', '331', '1111') ORDER BY code`.execute(ctx.t.admin);
    expect(r.rows).toEqual([{ code: '1111', reconcile: false }, { code: '131', reconcile: true }, { code: '331', reconcile: true }]);
  });

  it('ghi sổ chứng từ có dòng 131 sinh một open_item mỗi dòng; bỏ ghi sổ xóa', async () => {
    const v = await pkt('2026-01-05', [K('131', 'KH001', '100', '0', { dueDate: '2026-03-01' }), K('131', 'KH001', '50'), K('131', 'KH002', '20'), L('5113', '0', '170')], { documentDate: '2026-01-03' });
    // hạn: hạn của dòng, không có thì hạn của chứng từ, không có thì ngày chứng từ + số ngày được nợ của đối tượng (KH002 không khai thì để trống)
    expect(await items(v.id)).toEqual([
      expect.objectContaining({ line_no: 1, account: '131', party: 'KH001', doc_no: v.voucherNo, doc_date: '2026-01-03', due_date: '2026-03-01', amount: '100', amount_currency: '100.0000' }),
      expect.objectContaining({ line_no: 2, party: 'KH001', due_date: '2026-02-02', amount: '50' }),
      expect.objectContaining({ line_no: 3, party: 'KH002', due_date: null, amount: '20' })]);
    const h = await pkt('2026-01-06', [L('6421', '40'), K('331', 'NCC001', '0', '40')], { dueDate: '2026-04-30' });
    expect(await items(h.id)).toEqual([expect.objectContaining({ line_no: 2, account: '331', party: 'NCC001', due_date: '2026-04-30', amount: '-40', amount_currency: '-40.0000' })]); // khoản Có mang số âm
    // sửa hạn của dòng sau khi ghi sổ: hạn của khoản đi theo; bỏ hạn dòng thì về hạn theo số ngày được nợ
    const version = () => call('GET', `/api/vouchers/${v.id}`).then((r) => r.json().version as number);
    expect((await call('PUT', `/api/vouchers/${v.id}`, { version: await version(), lines: [{ lineNo: 2, dueDate: '2026-02-20' }, { lineNo: 1, dueDate: null }] })).statusCode).toBe(200);
    expect((await items(v.id)).map((i) => i.due_date)).toEqual(['2026-02-02', '2026-02-20', null]);
    const un = await call('POST', `/api/vouchers/${v.id}/unpost`); expect(un.statusCode, un.body).toBe(200);
    expect(await items(v.id)).toEqual([]);
    expect((await call('POST', `/api/vouchers/${v.id}/post`)).statusCode).toBe(200); // ghi sổ lại sinh lại
    expect((await items(v.id)).map((i) => i.amount)).toEqual(['100', '50', '20']);
  });

  it('chứng từ đã đối trừ: bỏ ghi sổ và đảo đều 409 OPEN_ITEM_SETTLED, không đổi trạng thái', async () => {
    const inv = await pkt('2026-02-01', [K('131', 'KH001', '300'), L('5113', '0', '300')]);
    const rec = await pkt('2026-02-05', [L('1111', '300'), K('131', 'KH001', '0', '300')]);
    const [d] = await items(inv.id); const [c] = await items(rec.id);
    await settle(d!.id, c!.id, '300', '2026-02-05');
    for (const [what, r] of [['bỏ ghi sổ HĐ', await call('POST', `/api/vouchers/${inv.id}/unpost`)], ['bỏ ghi sổ PT', await call('POST', `/api/vouchers/${rec.id}/unpost`)],
      ['đảo HĐ', await call('POST', `/api/vouchers/${inv.id}/reverse`, { postingDate: '2026-02-10' })]] as const)
      expect([what, r.statusCode, r.json().error.code, r.json().error.message]).toEqual([what, 409, 'OPEN_ITEM_SETTLED', 'chứng từ đã đối trừ công nợ, hãy hủy đối trừ trước']);
    expect([await stateOf(inv.id), await stateOf(rec.id)]).toEqual(['posted', 'posted']);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher WHERE reversal_of_id = ${inv.id}::uuid`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
    expect(await residualOf(d!.id, '2026-02-05')).toBe('0');
    // hủy đối trừ rồi thì bỏ ghi sổ được
    await sql`DELETE FROM settlement WHERE debit_item_id = ${d!.id}`.execute(ctx.t.admin);
    expect((await call('POST', `/api/vouchers/${inv.id}/unpost`)).statusCode).toBe(200);
    expect(await items(inv.id)).toEqual([]);
  });

  it('đảo chứng từ chưa đối trừ: khoản gốc và khoản đảo tự đối trừ, dư còn lại 0', async () => {
    const v = await pkt('2026-03-02', [K('131', 'KH001', '100'), K('131', 'KH002', '50'), L('5113', '0', '150')]);
    const r = await reverse(v.id, '2026-03-12');
    const orig = await items(v.id); const rev = await items(r.id);
    expect(rev.map((i) => [i.line_no, i.party, i.amount])).toEqual([[1, 'KH001', '-100'], [2, 'KH002', '-50']]);
    const s = await sql<{ d: number; c: number; amount: string; amount_currency: string; settle_date: string; kind: string; g: string }>`SELECT s.debit_item_id::int AS d, s.credit_item_id::int AS c, s.amount::text, s.amount_currency::text, s.settle_date::text, s.kind, s.group_id::text AS g
      FROM settlement s JOIN open_item o ON o.id = s.debit_item_id WHERE s.debit_item_id = ANY(${orig.map((i) => i.id)}::bigint[]) ORDER BY o.line_no`.execute(ctx.t.admin);
    expect(s.rows.map(({ g: _g, ...x }) => x)).toEqual([
      { d: orig[0]!.id, c: rev[0]!.id, amount: '100', amount_currency: '100.0000', settle_date: '2026-03-12', kind: 'reversal' },
      { d: orig[1]!.id, c: rev[1]!.id, amount: '50', amount_currency: '50.0000', settle_date: '2026-03-12', kind: 'reversal' }]);
    expect(new Set(s.rows.map((x) => x.g)).size).toBe(1); // một lần đảo là một nhóm đối trừ
    for (const i of [...orig, ...rev]) expect(await residualOf(i.id, '2026-03-12')).toBe('0');
    expect(await residualOf(orig[0]!.id, '2026-03-11')).toBe('100'); // trước ngày đảo khoản gốc còn nguyên
    // đảo lại bản đảo: chứng từ mới mang lại công nợ (khoản mở), hai khoản đã đối trừ giữ nguyên
    const again = await reverse(r.id, '2026-03-13');
    const back = await items(again.id);
    expect(back.map((i) => i.amount)).toEqual(['100', '50']);
    for (const i of back) expect(await residualOf(i.id, '2026-03-13')).toBe(i.amount);
    for (const i of [...orig, ...rev]) expect(await residualOf(i.id, '2026-03-13')).toBe('0');
  });

  it('tổng dư open_item = số dư 131/331 theo đối tượng tại mỗi cuối tháng sau một chuỗi thao tác cố định', async () => {
    const { tenantId: t2, cookie: c2 } = await bootstrapTenant(ctx, { code: `OJ${Date.now()}` });
    const saved = { tenantId, cookie }; tenantId = t2; cookie = c2;
    try {
      expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
      for (const p of [{ code: 'KH001', name: 'Khách 1', is_customer: true, payment_term_days: 30 }, { code: 'KH002', name: 'Khách 2', is_customer: true }, { code: 'NCC001', name: 'Nhà cung cấp 1', is_vendor: true }])
        expect((await call('POST', '/api/catalogs/party', p)).statusCode).toBe(201);
      const inv = await pkt('2026-01-05', [K('131', 'KH001', '110'), L('5113', '0', '100'), L('33311', '0', '10')], { documentDate: '2026-01-03' });
      const buy = await pkt('2026-01-10', [L('6421', '50'), K('331', 'NCC001', '0', '50')]);
      const rec = await pkt('2026-01-20', [L('1121', '60'), K('131', 'KH001', '0', '60')]);
      const wrong = await pkt('2026-01-25', [K('131', 'KH002', '200'), L('5113', '0', '200')]);
      await reverse(wrong.id, '2026-02-03');
      await pkt('2026-02-02', [K('131', 'KH002', '15'), L('5113', '0', '15')], { documentDate: '2026-01-30' }); // ngày chứng từ tháng 1, ghi sổ tháng 2: chưa vào số dư 31/01
      const pay = await pkt('2026-02-10', [K('331', 'NCC001', '50'), L('1121', '0', '50')]);
      await settle((await items(pay.id))[0]!.id, (await items(buy.id))[0]!.id, '50', '2026-02-10');
      const redo = await pkt('2026-02-15', [K('131', 'KH001', '30'), K('131', 'KH002', '40'), L('5113', '0', '70')]);
      expect((await call('POST', `/api/vouchers/${redo.id}/unpost`)).statusCode).toBe(200);
      expect((await call('POST', `/api/vouchers/${redo.id}/post`)).statusCode).toBe(200);
      await settle((await items(inv.id))[0]!.id, (await items(rec.id))[0]!.id, '60', '2026-03-05');
      await pkt('2026-03-20', [L('1111', '30'), K('131', 'KH001', '0', '30')]);
      const expected: Record<string, [string, string][]> = {
        '2026-01-31': [['131/KH001', '50'], ['131/KH002', '200'], ['331/NCC001', '-50']],
        '2026-02-28': [['131/KH001', '80'], ['131/KH002', '55']],
        '2026-03-31': [['131/KH001', '50'], ['131/KH002', '55']],
      };
      for (const [asOf, want] of Object.entries(expected)) {
        const ledger = await ledgerSums(asOf);
        expect([asOf, ledger.map((x) => [x.k, x.n])]).toEqual([asOf, want]);
        expect([asOf, await residualSums(asOf)]).toEqual([asOf, ledger]);
      }
      // khoản hóa đơn 05/01 còn 50 sau khi thu 60 (đối trừ ngày 05/03), trước ngày đối trừ còn nguyên 110
      const invItem = (await items(inv.id))[0]!.id;
      expect([await residualOf(invItem, '2026-03-04'), await residualOf(invItem, '2026-03-05')]).toEqual(['110', '50']);
    } finally { ({ tenantId, cookie } = saved); }
  }, 60_000);

  it('GET /api/open-items: dư còn lại theo đối tượng tại ngày, onlyOpen bỏ khoản đã hết dư', async () => {
    const v = await pkt('2026-04-01', [K('131', 'KH002', '700'), L('5113', '0', '700')]);
    const p = await pkt('2026-04-05', [L('1111', '700'), K('131', 'KH002', '0', '700')]);
    await settle((await items(v.id))[0]!.id, (await items(p.id))[0]!.id, '250', '2026-04-06');
    const get = async (qs: string) => { const r = await call('GET', `/api/open-items?${qs}`); expect(r.statusCode, r.body).toBe(200); return r.json() as Record<string, unknown>[]; };
    const at = await get('accountCode=131&partyCode=KH002&asOf=2026-04-06');
    const inv = at.find((x) => x.voucherId === v.id);
    expect(inv).toEqual({ id: expect.any(Number), voucherId: v.id, voucherNo: v.voucherNo, voucherType: 'PKT', accountCode: '131', partyCode: 'KH002', docNo: v.voucherNo, docDate: '2026-04-01', dueDate: null,
      currency: 'VND', amount: '700', amountCurrency: '700.0000', residual: '450', residualCurrency: '450.0000' });
    expect(at.find((x) => x.voucherId === p.id)).toMatchObject({ amount: '-700', residual: '-450' });
    expect(at.every((x) => x.residual !== '0')).toBe(true);
    const before = await get('accountCode=131&partyCode=KH002&asOf=2026-04-02'); // phiếu thu 05/04 chưa ghi sổ tại ngày 02/04
    expect(before.find((x) => x.voucherId === p.id)).toBeUndefined();
    expect(before.find((x) => x.voucherId === v.id)).toMatchObject({ residual: '700' });
    const all = await get('accountCode=131&partyCode=KH002&asOf=2026-04-30&onlyOpen=false');
    expect(all.length).toBeGreaterThan((await get('accountCode=131&partyCode=KH002&asOf=2026-04-30')).length); // gồm cả khoản đã hết dư
    expect((await call('GET', '/api/open-items?accountCode=9999&asOf=2026-04-30')).statusCode).toBe(404);
    expect((await call('GET', '/api/open-items?accountCode=131&partyCode=KHONGCO&asOf=2026-04-30')).statusCode).toBe(404);
  });

  it('người không có view_receivable không xem được open-items của 131', async () => {
    const userWith = async (roleCode: string, sensitiveFlags: string[]) => {
      const username = `oi_${roleCode}_${sensitiveFlags.join('_')}_${Date.now()}`;
      expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags })).statusCode).toBe(201);
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
      return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    };
    const none = await userWith('ketoan_vien', []); const recv = await userWith('ketoan_vien', ['view_receivable']);
    const get = (account: string, c: string) => call('GET', `/api/open-items?accountCode=${account}&asOf=2026-12-31`, undefined, c);
    const denied = await get('131', none);
    expect([denied.statusCode, denied.json().error.code, denied.json().error.message]).toEqual([403, 'FORBIDDEN', 'Không có quyền xem công nợ phải thu']);
    expect((await get('131', recv)).statusCode).toBe(200);
    const payable = await get('331', recv);
    expect([payable.statusCode, payable.json().error.message]).toEqual([403, 'Không có quyền xem công nợ phải trả']);
    // thiếu quyền settlement.view
    const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
    expect((await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: ['voucher.view'] })).statusCode).toBe(200);
    const viewer = await userWith('xem', ['view_receivable', 'view_payable']);
    expect((await get('131', viewer)).statusCode).toBe(403);
  });

  it('chứng từ 5.000 dòng công nợ tạo và ghi sổ dưới 5 giây, mỗi dòng 131 một open_item', async () => {
    const lines = Array.from({ length: 2500 }, () => [K('131', 'KH001', '10'), L('5113', '0', '10')]).flat();
    const t0 = Date.now();
    const c = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-05-20', documentDate: '2026-05-20', lines }); expect(c.statusCode, c.body.slice(0, 200)).toBe(201);
    const p = await call('POST', `/api/vouchers/${c.json().id}/post`); expect(p.statusCode, p.body.slice(0, 200)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM open_item WHERE voucher_id = ${c.json().id}::uuid`.execute(ctx.t.admin)).rows[0]!.n).toBe(2500);
  }, 60_000);
});
