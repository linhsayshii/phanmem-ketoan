import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { insertFiscalYear, generateAccountsSql } from '../src/seed/common.js';

let t: TestDb; let tenantId: string; let userId: string;
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
async function acc(code: string, regime = 'TT133') {
  return (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tenantId}::uuid AND regime = ${regime} AND code = ${code}`.execute(t.admin)).rows[0]!.id;
}

beforeAll(async () => {
  t = await setupTestDb(); await admin.connect();
  tenantId = await createTestTenant(t.admin, { code: `LS${Date.now()}`, name: 'Lược đồ sổ cái' });
  userId = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows[0]!.user_id;
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenantId]);
  await insertFiscalYear(admin, tenantId, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, tenantId, 'TT133');
});
afterAll(async () => { await admin.end(); await t.close(); });

const ctx = () => ({ tenantId, userId });
type Line = { code: string; debit?: string; credit?: string; party?: string | null; regime?: string };
async function newVoucher(date: string, lines: Line[], type = 'PKT') {
  return withTenant(t.db, ctx(), async (trx) => {
    const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: type, posting_date: date, document_date: date, state: 'draft', description: 'test', currency_code: 'VND', created_by: userId })
      .returning('id').executeTakeFirstOrThrow();
    let n = 0;
    for (const l of lines) {
      await trx.insertInto('voucher_line').values({ tenant_id: tenantId, voucher_id: v.id, line_no: ++n, account_id: await acc(l.code, l.regime), posting_date: date, currency_code: 'VND',
        debit: l.debit ?? '0', credit: l.credit ?? '0', amount_currency: l.debit ? l.debit : `-${l.credit}`, party_id: l.party ?? null }).execute();
    }
    return v.id;
  });
}

describe('lược đồ sổ cái', () => {
  it('partition theo tháng được tạo cho năm tài chính và có RLS', async () => {
    const r = await sql<{ relname: string; relrowsecurity: boolean }>`SELECT c.relname, c.relrowsecurity FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'voucher_line'::regclass AND c.relname LIKE 'voucher_line_y2026%' ORDER BY 1`.execute(t.admin);
    expect(r.rows.map((x) => x.relname)).toEqual(expect.arrayContaining(['voucher_line_y2026m01', 'voucher_line_y2026m12']));
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    // kỳ 0 (mở sổ) là ngày 31/12 của năm trước nên cũng có partition tháng 12/2025
    expect((await sql<{ n: number }>`SELECT count(*) AS n FROM pg_class WHERE relname = 'voucher_line_y2025m12'`.execute(t.admin)).rows[0]!.n).toBe(1);
  });

  it('công ty mới có đủ loại chứng từ hệ thống; app_user không gọi được hàm seed', async () => {
    const types = await sql<{ code: string }>`SELECT code FROM voucher_type WHERE tenant_id = ${tenantId}::uuid ORDER BY 1`.execute(t.admin);
    expect(types.rows.map((x) => x.code)).toEqual(['DK', 'KC', 'PB', 'PKT']);
    const p = await sql<{ a: boolean; b: boolean }>`SELECT has_function_privilege('app_user', 'seed_tenant_defaults(uuid)', 'EXECUTE') AS a, has_function_privilege('app_user', 'seed_voucher_types(uuid)', 'EXECUTE') AS b`.execute(t.admin);
    expect(p.rows[0]).toEqual({ a: false, b: false });
  });

  it('chứng từ lệch bị từ chối khi commit; cân thì ghi được và trigger điền fiscal_year/period_no', async () => {
    await expect(newVoucher('2026-03-10', [{ code: '1111', debit: '100' }, { code: '5113', credit: '90' }])).rejects.toThrow(/VOUCHER_UNBALANCED/);
    const id = await newVoucher('2026-03-10', [{ code: '1111', debit: '100' }, { code: '5113', credit: '100' }]);
    const v = await withTenant(t.db, ctx(), (trx) => trx.selectFrom('voucher').select(['fiscal_year', 'period_no', 'state']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(v).toEqual({ fiscal_year: 2026, period_no: 3, state: 'draft' });
  });

  it('ngày ngoài năm tài chính, tài khoản tổng hợp, thiếu đối tượng trên 131 đều bị từ chối', async () => {
    await expect(newVoucher('2027-01-05', [{ code: '1111', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/PERIOD_NOT_FOUND/);
    await expect(newVoucher('2026-01-05', [{ code: '111', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/ACCOUNT_IS_GROUP/);
    await expect(newVoucher('2026-01-05', [{ code: '131', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/LINE_PARTY_REQUIRED/);
  });

  it('đối tượng của công ty khác bị khóa ngoại từ chối dù id tồn tại', async () => {
    const other = await createTestTenant(t.admin, { code: `LO${Date.now()}`, name: 'Công ty khác' });
    const p = await t.admin.insertInto('party').values({ tenant_id: other, code: 'KH1', name: 'Khách công ty khác' }).returning('id').executeTakeFirstOrThrow();
    await expect(newVoucher('2026-01-06', [{ code: '1111', debit: '1', party: p.id }, { code: '5113', credit: '1' }])).rejects.toMatchObject({ code: '23503' });
  });

  it('đổi state trực tiếp bị chặn; xóa chứng từ draft chưa có số thì được', async () => {
    const id = await newVoucher('2026-02-01', [{ code: '1111', debit: '5' }, { code: '5113', credit: '5' }]);
    await expect(withTenant(t.db, ctx(), (trx) => trx.updateTable('voucher').set({ state: 'posted' }).where('id', '=', id).execute())).rejects.toThrow(/STATE_CHANGE_VIA_PROC/);
    await withTenant(t.db, ctx(), async (trx) => { await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute(); await trx.deleteFrom('voucher').where('id', '=', id).execute(); });
  });

  it('fn_build_pairs ghép n–n tham lam theo thứ tự dòng: tổng từng dòng khớp, không mất đồng nào', async () => {
    const id = await newVoucher('2026-02-02', [{ code: '6421', debit: '70' }, { code: '6422', debit: '30' }, { code: '1111', credit: '33' }, { code: '1121', credit: '67' }]);
    await sql`SELECT fn_build_pairs(${id}::uuid)`.execute(t.admin);
    const pairs = await sql<{ dr: string; cr: string; amount: string }>`SELECT da.code AS dr, ca.code AS cr, p.amount FROM voucher_pair p
      JOIN account da ON da.id = p.debit_account_id JOIN account ca ON ca.id = p.credit_account_id WHERE p.voucher_id = ${id}::uuid`.execute(t.admin);
    const sumBy = (key: 'dr' | 'cr') => pairs.rows.reduce<Record<string, number>>((s, p) => ({ ...s, [p[key]]: (s[p[key]] ?? 0) + Number(p.amount) }), {});
    expect(pairs.rows.reduce((s, p) => s + Number(p.amount), 0)).toBe(100);
    expect(sumBy('dr')).toEqual({ 6421: 70, 6422: 30 });
    expect(sumBy('cr')).toEqual({ 1111: 33, 1121: 67 });
    expect(pairs.rows).toHaveLength(3);
  });

  it('tài khoản khác chế độ kế toán của kỳ bị từ chối', async () => {
    await generateAccountsSql(admin, tenantId, 'TT200'); // công ty giữ cả hai hệ tài khoản, nhưng năm 2026 dùng TT133
    await expect(newVoucher('2026-04-01', [{ code: '1111', debit: '1', regime: 'TT200' }, { code: '5113', credit: '1' }])).rejects.toThrow(/ACCOUNT_REGIME_MISMATCH/);
  });
});
