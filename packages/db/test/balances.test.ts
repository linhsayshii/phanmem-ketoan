import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import fc from 'fast-check';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { generateAccountsSql, insertFiscalYear } from '../src/seed/common.js';

let t: TestDb; let tenantId: string; let userId: string;
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const ctx = () => ({ tenantId, userId });
const accId = async (code: string) => (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tenantId}::uuid AND code = ${code}`.execute(t.admin)).rows[0]!.id;

async function postPkt(date: string, debitCode: string, creditCode: string, amount: string) {
  return withTenant(t.db, ctx(), async (trx) => {
    const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: date, document_date: date, created_by: userId }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('voucher_line').values([
      { tenant_id: tenantId, voucher_id: v.id, line_no: 1, account_id: await accId(debitCode), posting_date: date, debit: amount, credit: '0', amount_currency: amount },
      { tenant_id: tenantId, voucher_id: v.id, line_no: 2, account_id: await accId(creditCode), posting_date: date, debit: '0', credit: amount, amount_currency: `-${amount}` }]).execute();
    await sql`SELECT post_voucher(${v.id}::uuid)`.execute(trx);
    return v.id;
  });
}
const recompute = () => withTenant(t.db, ctx(), (trx) => sql`SELECT recompute_balances(${tenantId}::uuid)`.execute(trx));
async function fromLines(asOf: string) {
  const r = await sql<{ code: string; net: string }>`SELECT a.code, sum(l.debit - l.credit)::text AS net FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND l.posting_date <= ${asOf}::date GROUP BY a.code HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`.execute(t.admin);
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}
async function fromSnapshot(asOf: string) {
  const r = await withTenant(t.db, ctx(), (trx) => sql<{ code: string; net: string }>`SELECT a.code, sum(b.debit - b.credit)::text AS net FROM fn_balances_at(${tenantId}::uuid, ${asOf}::date) b JOIN account a ON a.id = b.account_id GROUP BY a.code HAVING sum(b.debit - b.credit) <> 0 ORDER BY a.code`.execute(trx));
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}

// Các kiểm thử sau đây dùng công ty riêng (đặt lại tenantId/userId): trạng thái bẩn của mỗi kiểm thử không lẫn vào nhau.
async function useTenant(code: string, years: { fiscalYear: number; dateFrom: string }[] = [{ fiscalYear: 2026, dateFrom: '2026-01-01' }]) {
  tenantId = await createTestTenant(t.admin, { code: `${code}${Date.now()}`, name: 'Số dư' });
  userId = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows[0]!.user_id;
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenantId]);
  for (const y of years) await insertFiscalYear(admin, tenantId, { ...y, months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, tenantId, 'TT133');
}
const staleOf = async (id = tenantId) => (await sql<{ stale_year: number; stale_period: number }>`SELECT stale_year, stale_period FROM balance_stale WHERE tenant_id = ${id}::uuid`.execute(t.admin)).rows[0];
const periodsOf = async (value: unknown) => (value as { rows: { recompute_balances: number }[] }).rows[0]!.recompute_balances;

beforeAll(async () => {
  t = await setupTestDb(); await admin.connect();
  tenantId = await createTestTenant(t.admin, { code: `BL${Date.now()}`, name: 'Số dư' });
  userId = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows[0]!.user_id;
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenantId]);
  await insertFiscalYear(admin, tenantId, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, tenantId, 'TT133');
}, 60_000);
afterAll(async () => { await admin.end(); await t.close(); });

describe('số dư theo kỳ', () => {
  it('ghi sổ làm bẩn từ kỳ hiệu lực; tính lại cho snapshot bằng tổng dòng ở mọi cuối tháng; ghi lùi ngày chỉ làm bẩn từ kỳ đó', async () => {
    await postPkt('2026-01-10', '1111', '5113', '1000'); await postPkt('2026-02-10', '6422', '1111', '300'); await postPkt('2026-03-10', '1121', '5113', '5000');
    let st = await sql<{ stale_period: number }>`SELECT stale_period FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin);
    expect(st.rows[0]!.stale_period).toBe(1);
    await recompute();
    expect((await sql`SELECT 1 FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows).toHaveLength(0);
    for (const d of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-06-30']) expect(await fromSnapshot(d), d).toEqual(await fromLines(d));
    const snap = await sql<{ period_no: number; opening_debit: string; period_debit: string; closing_debit: string }>`SELECT b.period_no, b.opening_debit, b.period_debit, b.closing_debit FROM account_period_balance b JOIN account a ON a.id = b.account_id WHERE b.tenant_id = ${tenantId}::uuid AND a.code = '1111' ORDER BY period_no`.execute(t.admin);
    expect(snap.rows.map((r) => [r.period_no, r.opening_debit, r.period_debit, r.closing_debit])).toEqual(expect.arrayContaining([[1, '0', '1000', '1000'], [2, '1000', '0', '700'], [3, '700', '0', '700']]));
    await postPkt('2026-02-20', '1111', '5113', '50');
    st = await sql<{ stale_period: number }>`SELECT stale_period FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin);
    expect(st.rows[0]!.stale_period).toBe(2);
    expect(await fromSnapshot('2026-03-31')).toEqual(await fromLines('2026-03-31')); // đường chậm khi bẩn vẫn đúng
    await recompute();
    expect(await fromSnapshot('2026-12-31')).toEqual(await fromLines('2026-12-31'));
  }, 30_000);

  it('tính chất: với chuỗi chứng từ ngẫu nhiên, snapshot sau tính lại bằng tổng dòng tại mọi ngày', async () => {
    const codes = ['1111', '1121', '5113', '6421', '6422', '33311'];
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ d: fc.integer({ min: 1, max: 28 }), m: fc.integer({ min: 1, max: 12 }), i: fc.nat(5), j: fc.nat(5), amt: fc.integer({ min: 1, max: 1_000_000 }) }), { minLength: 1, maxLength: 8 }), async (ops) => {
      for (const o of ops) {
        if (o.i === o.j) continue;
        const date = `2026-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`;
        await postPkt(date, codes[o.i]!, codes[o.j]!, String(o.amt));
      }
      await recompute();
      for (const d of ['2026-01-31', '2026-05-15', '2026-12-31']) expect(await fromSnapshot(d)).toEqual(await fromLines(d));
    }), { numRuns: 5 });
  }, 120_000);
});

describe('đường nhanh (snapshot) bằng đường chậm (tổng dòng) sau ghi sổ, bỏ ghi sổ và đảo', () => {
  beforeAll(() => useTenant('BM'), 60_000);
  // giữa kỳ (12/4, 9/5), cuối kỳ (30/4, 31/5), ngày đảo (10/5), và cuối năm
  const DATES = ['2026-04-12', '2026-04-30', '2026-05-09', '2026-05-10', '2026-05-31', '2026-12-31'];
  const same = async (label: string) => { for (const d of DATES) expect(await fromSnapshot(d), `${label} ${d}`).toEqual(await fromLines(d)); };

  it('mỗi thao tác làm bẩn đúng kỳ của chứng từ; trước và sau tính lại đều bằng tổng dòng; chứng từ gốc đã đảo vẫn được tính', async () => {
    const v1 = await postPkt('2026-04-05', '1111', '5113', '700'); const v2 = await postPkt('2026-04-20', '6422', '1111', '200');
    expect(await staleOf()).toMatchObject({ stale_year: 2026, stale_period: 4 });
    await same('sau ghi sổ, chưa tính lại'); await recompute(); expect(await staleOf()).toBeUndefined(); await same('sau ghi sổ');
    expect(await fromSnapshot('2026-04-30')).toEqual({ 1111: '500', 5113: '-700', 6422: '200' });

    await withTenant(t.db, ctx(), (trx) => sql`SELECT unpost_voucher(${v2}::uuid)`.execute(trx));
    expect(await staleOf()).toMatchObject({ stale_period: 4 });
    await same('sau bỏ ghi sổ, chưa tính lại'); await recompute(); await same('sau bỏ ghi sổ');
    expect(await fromSnapshot('2026-04-30')).toEqual({ 1111: '700', 5113: '-700' });

    // đảo ngày 10/5: trước ngày đảo chỉ có chứng từ gốc, từ ngày đảo hai chứng từ triệt tiêu (cả hai đều được tính: 'posted' và 'reversed')
    await withTenant(t.db, ctx(), (trx) => sql`SELECT reverse_voucher(${v1}::uuid, ${'2026-05-10'}::date, NULL)`.execute(trx));
    expect(await staleOf()).toMatchObject({ stale_period: 5 });
    expect(await fromSnapshot('2026-05-09')).toEqual({ 1111: '700', 5113: '-700' });
    await same('sau đảo, chưa tính lại'); await recompute(); await same('sau đảo');
    expect(await fromSnapshot('2026-05-09')).toEqual({ 1111: '700', 5113: '-700' });
    expect(await fromSnapshot('2026-05-31')).toEqual({});
    expect(await staleOf()).toBeUndefined();
  }, 30_000);
});

describe('mốc bẩn đặt trong lúc tính lại', () => {
  beforeAll(() => useTenant('BS'), 60_000);

  it('không bị xóa: tính lại chỉ xóa mốc nó đã đọc; mốc mới đặt (kỳ đến sau) giữ lại, lần tính sau xóa', async () => {
    await postPkt('2026-07-10', '1111', '5113', '10');
    expect(await staleOf()).toMatchObject({ stale_period: 7 });
    const x = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await x.connect();
    try {
      // Phiên X đặt mốc bẩn nhưng chưa commit: nó giữ khóa dòng balance_stale. Bản tính lại chạy tới câu DELETE mốc ở cuối thì phải chờ.
      await x.query('BEGIN'); await x.query(`SELECT mark_balance_stale($1::uuid, 2026, 9)`, [tenantId]);
      let settled = false; const run = recompute().finally(() => { settled = true; }); run.catch(() => undefined); // lỗi vẫn ném ở await run bên dưới
      let waiting = false;
      for (let i = 0; i < 400 && !waiting && !settled; i++) {
        waiting = ((await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%recompute_balances%' AND pid <> pg_backend_pid()`)).rowCount ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting, 'recompute_balances phải đang chờ khóa dòng balance_stale').toBe(true);
      await x.query('COMMIT'); await run;
    } finally { await x.end(); }
    expect(await staleOf(), 'mốc đặt trong lúc tính lại không bị xóa').toMatchObject({ stale_period: 7 });
    await recompute();
    expect(await staleOf()).toBeUndefined();
    for (const d of ['2026-07-31', '2026-12-31']) expect(await fromSnapshot(d), d).toEqual(await fromLines(d));
  }, 30_000);
});

describe('số dư theo đối tượng', () => {
  let a: string; let b: string;
  beforeAll(async () => {
    await useTenant('BP');
    await sql`INSERT INTO party(tenant_id, code, name, is_customer) VALUES (${tenantId}::uuid, 'KH001', 'Khách A', true), (${tenantId}::uuid, 'KH002', 'Khách B', true)`.execute(t.admin);
    const ids = await sql<{ code: string; id: string }>`SELECT code, id FROM party WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin);
    a = ids.rows.find((r) => r.code === 'KH001')!.id; b = ids.rows.find((r) => r.code === 'KH002')!.id;
  }, 60_000);

  type L = { code: string; d?: string; c?: string; party?: string };
  async function postLines(date: string, lines: L[]) {
    return withTenant(t.db, ctx(), async (trx) => {
      const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: date, document_date: date, created_by: userId }).returning('id').executeTakeFirstOrThrow();
      let n = 0;
      for (const l of lines) await trx.insertInto('voucher_line').values({ tenant_id: tenantId, voucher_id: v.id, line_no: ++n, account_id: await accId(l.code), posting_date: date,
        debit: l.d ?? '0', credit: l.c ?? '0', amount_currency: l.d ?? `-${l.c}`, party_id: l.party ?? null }).execute();
      await sql`SELECT post_voucher(${v.id}::uuid)`.execute(trx);
    });
  }
  const by131 = async (asOf: string) => (await withTenant(t.db, ctx(), (trx) => sql<{ party: string | null; debit: string; credit: string }>`SELECT p.code AS party, b.debit::text AS debit, b.credit::text AS credit
    FROM fn_balances_at(${tenantId}::uuid, ${asOf}::date) b JOIN account x ON x.id = b.account_id LEFT JOIN party p ON p.id = b.party_id WHERE x.code = '131' ORDER BY p.code`.execute(trx))).rows;

  it('tài khoản 131 tách theo từng đối tượng (mỗi đối tượng một bên), cả đường chậm lẫn snapshot; dòng không đối tượng dùng sentinel', async () => {
    await postLines('2026-03-05', [{ code: '131', d: '1000', party: a }, { code: '5113', c: '1000' }]);
    await postLines('2026-03-06', [{ code: '131', d: '500', party: b }, { code: '5113', c: '500' }]);
    await postLines('2026-04-10', [{ code: '1111', d: '1500' }, { code: '131', c: '1500', party: a }]);
    const expected = { '2026-03-31': [{ party: 'KH001', debit: '1000', credit: '0' }, { party: 'KH002', debit: '500', credit: '0' }],
      '2026-04-30': [{ party: 'KH001', debit: '0', credit: '500' }, { party: 'KH002', debit: '500', credit: '0' }] };
    for (const [d, rows] of Object.entries(expected)) expect(await by131(d), `đường chậm ${d}`).toEqual(rows);
    await recompute();
    for (const [d, rows] of Object.entries(expected)) expect(await by131(d), `snapshot ${d}`).toEqual(rows);
    // tổng của tài khoản 131 vẫn bằng tổng các đối tượng (500 - 500 = 0 nên không còn trong số dư ròng)
    expect(await fromSnapshot('2026-04-30')).toEqual(await fromLines('2026-04-30'));
    const keys = await sql<{ code: string; party_id: string }>`SELECT DISTINCT x.code, b.party_id FROM account_period_balance b JOIN account x ON x.id = b.account_id WHERE b.tenant_id = ${tenantId}::uuid AND b.period_no = 4 ORDER BY 1, 2`.execute(t.admin);
    const nil = '00000000-0000-0000-0000-000000000000';
    expect(keys.rows).toEqual(expect.arrayContaining([{ code: '131', party_id: a }, { code: '131', party_id: b }, { code: '1111', party_id: nil }, { code: '5113', party_id: nil }]));
  }, 30_000);
});

describe('kỳ chưa từng tính và cách ly công ty', () => {
  beforeAll(() => useTenant('BY', [{ fiscalYear: 2026, dateFrom: '2026-01-01' }]), 60_000);

  it('năm tài chính tạo sau lần tính trước nhận số dư kết chuyển, dù có hay không có mốc bẩn; tính lại lần nữa trả 0', async () => {
    await postPkt('2026-12-10', '1111', '5113', '1000');
    expect(await periodsOf(await recompute())).toBeGreaterThan(0);
    expect(await periodsOf(await recompute())).toBe(0);
    await insertFiscalYear(admin, tenantId, { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT133' });
    // năm 2027 chưa có snapshot nên không được đọc snapshot rỗng: số dư 2026 phải kết chuyển sang
    for (const d of ['2027-02-15', '2027-12-31']) expect(await fromSnapshot(d), `chưa tính ${d}`).toEqual(await fromLines(d));
    expect(await fromSnapshot('2027-02-15')).toEqual({ 1111: '1000', 5113: '-1000' });
    await postPkt('2027-03-10', '6422', '1111', '300');      // mốc bẩn ở kỳ 3/2027, nhưng kỳ 1-2/2027 cũng chưa có snapshot
    await recompute();
    expect(await staleOf()).toBeUndefined();
    for (const d of ['2027-02-15', '2027-03-31', '2027-12-31']) expect(await fromSnapshot(d), d).toEqual(await fromLines(d));
    expect(await fromSnapshot('2027-03-31')).toEqual({ 1111: '700', 5113: '-1000', 6422: '300' });
    expect(await periodsOf(await recompute())).toBe(0);
  }, 30_000);

  it('hàm chạy bằng quyền người gọi: không tính lại hay đọc số dư của công ty khác', async () => {
    const other = await createTestTenant(t.admin, { code: `BZ${Date.now()}`, name: 'Công ty khác' });
    await insertFiscalYear(admin, other, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
    await sql`INSERT INTO balance_stale(tenant_id, stale_year, stale_period) VALUES (${other}::uuid, 2026, 1)`.execute(t.admin);
    const n = await withTenant(t.db, ctx(), async (trx) => (await sql<{ n: number }>`SELECT recompute_balances(${other}::uuid) AS n`.execute(trx)).rows[0]!.n);
    expect(n).toBe(0);
    expect(await staleOf(other)).toMatchObject({ stale_period: 1 });
    expect((await sql`SELECT 1 FROM account_period_balance WHERE tenant_id = ${other}::uuid`.execute(t.admin)).rows).toHaveLength(0);
    const rows = await withTenant(t.db, ctx(), (trx) => sql`SELECT * FROM fn_balances_at(${other}::uuid, ${'2026-12-31'}::date)`.execute(trx));
    expect(rows.rows).toHaveLength(0);
  }, 30_000);
});
