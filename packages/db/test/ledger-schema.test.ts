import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { insertFiscalYear, generateAccountsSql } from '../src/seed/common.js';
import type { Database } from '../src/types.js';

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
const run = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(t.db, ctx(), fn);
// Như thủ tục ghi sổ ở Task 15: bật app.state_change trong chính giao dịch rồi đổi state.
const setState = (id: string, state: string) => run(async (trx) => {
  await sql`SELECT set_config('app.state_change', 'on', true)`.execute(trx);
  await trx.updateTable('voucher').set({ state }).where('id', '=', id).execute();
});
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
    const r = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; npol: number }>`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname)::int AS npol
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'voucher_line'::regclass AND c.relname LIKE 'voucher_line_y2026%' ORDER BY 1`.execute(t.admin);
    expect(r.rows.map((x) => x.relname)).toEqual(expect.arrayContaining(['voucher_line_y2026m01', 'voucher_line_y2026m12']));
    expect(r.rows.every((x) => x.relrowsecurity && x.relforcerowsecurity && x.npol > 0)).toBe(true);
    // kỳ 0 (mở sổ) là ngày 31/12 của năm trước nên cũng có partition tháng 12/2025
    expect((await sql<{ n: number }>`SELECT count(*) AS n FROM pg_class WHERE relname = 'voucher_line_y2025m12'`.execute(t.admin)).rows[0]!.n).toBe(1);
  });

  it('công ty mới có đủ loại chứng từ hệ thống; app_user không gọi được hàm seed và hàm tạo partition', async () => {
    const types = await sql<{ code: string }>`SELECT code FROM voucher_type WHERE tenant_id = ${tenantId}::uuid ORDER BY 1`.execute(t.admin);
    expect(types.rows.map((x) => x.code)).toEqual(['DK', 'KC', 'PB', 'PKT']);
    const p = await sql<{ a: boolean; b: boolean; c: boolean }>`SELECT has_function_privilege('app_user', 'seed_tenant_defaults(uuid)', 'EXECUTE') AS a,
      has_function_privilege('app_user', 'seed_voucher_types(uuid)', 'EXECUTE') AS b, has_function_privilege('app_user', 'ensure_line_partitions(date, date)', 'EXECUTE') AS c`.execute(t.admin);
    expect(p.rows[0]).toEqual({ a: false, b: false, c: false });
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

  it('đã ghi sổ (qua app.state_change): header và dòng chỉ sửa được diễn giải, nhật ký dòng có balance', async () => {
    const id = await newVoucher('2026-06-01', [{ code: '1111', debit: '8' }, { code: '5113', credit: '8' }]);
    await setState(id, 'posted');
    await expect(run((trx) => trx.updateTable('voucher').set({ document_date: '2026-06-02' }).where('id', '=', id).execute())).rejects.toThrow(/VOUCHER_IMMUTABLE/);
    await expect(run((trx) => trx.updateTable('voucher_line').set({ debit: '9' }).where('voucher_id', '=', id).where('line_no', '=', 1).execute())).rejects.toThrow(/LINE_IMMUTABLE/);
    await run(async (trx) => {
      await trx.updateTable('voucher').set({ description: 'sửa diễn giải' }).where('id', '=', id).execute();
      await trx.updateTable('voucher_line').set({ description: 'sửa dòng' }).where('voucher_id', '=', id).where('line_no', '=', 1).execute();
    });
    const a = await sql<{ b: string }>`SELECT after->>'balance' AS b FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'voucher_line' ORDER BY id DESC LIMIT 1`.execute(t.admin);
    expect(a.rows[0]!.b).toBe('8');
  });

  it('không chuyển dòng sang chứng từ đã ghi sổ bằng cách đổi voucher_id', async () => {
    const posted = await newVoucher('2026-06-02', [{ code: '1111', debit: '3' }, { code: '5113', credit: '3' }]);
    await setState(posted, 'posted');
    const draft = await newVoucher('2026-06-02', [{ code: '1111', debit: '4' }, { code: '5113', credit: '4' }]);
    // line_no + 10 để không vướng UNIQUE (voucher_id, line_no, posting_date): chỉ trigger mới chặn được
    await expect(run((trx) => trx.updateTable('voucher_line').set({ voucher_id: posted, line_no: sql<number>`line_no + 10` }).where('voucher_id', '=', draft).execute())).rejects.toThrow(/không chuyển dòng/);
  });

  it('dòng đã ghi sổ vẫn sửa được diễn giải và chiều phân tích khi tài khoản đã ngừng dùng; dòng mới thì bị chặn', async () => {
    const id = await newVoucher('2026-06-03', [{ code: '1111', debit: '2' }, { code: '5113', credit: '2' }]);
    await setState(id, 'posted');
    const dept = await t.admin.insertInto('department').values({ tenant_id: tenantId, code: 'PB1', name: 'Phòng 1' }).returning('id').executeTakeFirstOrThrow();
    const a1111 = await acc('1111');
    await t.admin.updateTable('account').set({ is_active: false }).where('id', '=', a1111).execute();
    try {
      await run((trx) => trx.updateTable('voucher_line').set({ description: 'tài khoản đã ngừng', department_id: dept.id }).where('voucher_id', '=', id).where('line_no', '=', 1).execute());
      await expect(newVoucher('2026-06-03', [{ code: '1111', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/ACCOUNT_INACTIVE/);
    } finally {
      await t.admin.updateTable('account').set({ is_active: true }).where('id', '=', a1111).execute();
    }
  });

  it('đổi ngày ghi sổ của chứng từ nháp thì dòng đi theo sang partition của tháng mới', async () => {
    const id = await newVoucher('2026-03-15', [{ code: '1111', debit: '6' }, { code: '5113', credit: '6' }]);
    await run((trx) => trx.updateTable('voucher').set({ posting_date: '2026-04-20' }).where('id', '=', id).execute());
    const r = await run((trx) => sql<{ posting_date: string; part: string }>`SELECT posting_date, tableoid::regclass::text AS part FROM voucher_line WHERE voucher_id = ${id}::uuid ORDER BY line_no`.execute(trx));
    const moved = { posting_date: '2026-04-20', part: 'voucher_line_y2026m04' };
    expect(r.rows).toEqual([moved, moved]);
  });

  it('hủy chứng từ nháp rỗng (draft → cancelled) được; ghi sổ chứng từ rỗng thì VOUCHER_EMPTY', async () => {
    await setState(await newVoucher('2026-06-04', []), 'cancelled');
    await expect(setState(await newVoucher('2026-06-04', []), 'posted')).rejects.toThrow(/VOUCHER_EMPTY/);
  });

  it('tài khoản đã có phát sinh: đổi mã hay xóa bị chặn, SET code = code thì không', async () => {
    await newVoucher('2026-06-05', [{ code: '1111', debit: '1' }, { code: '5113', credit: '1' }]);
    const id = await acc('1111');
    await expect(t.admin.updateTable('account').set({ code: '1111X' }).where('id', '=', id).execute()).rejects.toThrow(/ACCOUNT_IN_USE/);
    await expect(t.admin.deleteFrom('account').where('id', '=', id).execute()).rejects.toThrow(/ACCOUNT_IN_USE/);
    await sql`UPDATE account SET code = code WHERE id = ${id}`.execute(t.admin);
  });

  it('ensure_line_partitions từ chối khoảng bất thường', async () => {
    for (const [from, to] of [['2026-02-01', '2026-01-01'], ['2026-01-01', '2028-01-01'], ['1980-01-01', '1980-02-01'], ['2026-01-01', '2300-01-01']])
      await expect(sql`SELECT ensure_line_partitions(${from}::date, ${to}::date)`.execute(t.admin), `${from}..${to}`).rejects.toThrow(/PARTITION_RANGE_INVALID/);
  });

  it('hai công ty cùng thêm kỳ cho một tháng chưa có partition đồng thời đều thành công', async () => {
    await sql`DROP TABLE IF EXISTS voucher_line_y2150m01`.execute(t.admin);
    const ta = await createTestTenant(t.admin, { code: `PA${Date.now()}`, name: 'Partition A' });
    const tb = await createTestTenant(t.admin, { code: `PB${Date.now()}`, name: 'Partition B' });
    const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL }); const b = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await Promise.all([a.connect(), b.connect()]);
    const ins = (c: pg.Client, tenant: string) => c.query(`INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES ($1, 2150, 1, '2150-01-01', '2150-01-31', 'TT133')`, [tenant]);
    try {
      await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
      await ins(a, ta); // A tạo partition nhưng chưa commit: B phải chờ khóa chứ không đua tới "already exists"
      const pb = ins(b, tb).then(() => null, (e: Error) => e);
      await new Promise((r) => setTimeout(r, 300));
      await a.query('COMMIT');
      expect(await pb).toBeNull();
      await b.query('COMMIT');
      expect((await sql<{ n: number }>`SELECT count(*) AS n FROM fiscal_period WHERE tenant_id IN (${ta}::uuid, ${tb}::uuid)`.execute(t.admin)).rows[0]!.n).toBe(2);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined); await b.query('ROLLBACK').catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
      await sql`DROP TABLE IF EXISTS voucher_line_y2150m01`.execute(t.admin);
    }
  });

  it('chỉ giữ khóa tạo partition khi thật sự tạo tháng mới (tháng đã có thì không khóa)', async () => {
    const tn = await createTestTenant(t.admin, { code: `PL${Date.now()}`, name: 'Partition khóa' });
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await c.connect();
    const locks = async () => (await c.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`)).rows[0].n as number;
    const ins = (y: number, m: string) => c.query(`INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES ($1, $2, 1, $3, $3, 'TT133')`, [tn, y, `${y}-${m}-01`]);
    try {
      await c.query('BEGIN'); await ins(2026, '01'); // đã có partition từ năm tài chính 2026
      expect(await locks()).toBe(0);
      await ins(2150, '02'); // tháng chưa có: tạo trong giao dịch này (ROLLBACK ngay sau đó) nên phải khóa
      expect(await locks()).toBe(1);
    } finally { await c.query('ROLLBACK'); await c.end(); }
  });

  it('tài khoản khác chế độ kế toán của kỳ bị từ chối', async () => {
    await generateAccountsSql(admin, tenantId, 'TT200'); // công ty giữ cả hai hệ tài khoản, nhưng năm 2026 dùng TT133
    await expect(newVoucher('2026-04-01', [{ code: '1111', debit: '1', regime: 'TT200' }, { code: '5113', credit: '1' }])).rejects.toThrow(/ACCOUNT_REGIME_MISMATCH/);
  });
  describe('kiểm cân bằng theo câu lệnh (hàng đợi voucher_balance_pending)', () => {
    const lineRow = (voucherId: string, no: number, code: string, debit: string, credit: string, date = '2026-05-10') =>
      acc(code).then((account_id) => ({ tenant_id: tenantId, voucher_id: voucherId, line_no: no, account_id, posting_date: date, currency_code: 'VND', debit, credit, amount_currency: debit !== '0' ? debit : `-${credit}` }));
    const header = (trx: Transaction<Database>, date = '2026-05-10') => trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: date, document_date: date, state: 'draft', description: 't', currency_code: 'VND', created_by: userId }).returning('id').executeTakeFirstOrThrow();
    const pending = (trx: Transaction<Database>) => sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_balance_pending`.execute(trx).then((r) => r.rows[0]!.n);

    it('nhiều câu lệnh trong một giao dịch: lệch ở trạng thái cuối bị bắt, cân ở trạng thái cuối thì qua; hàng đợi rỗng sau đó', async () => {
      await expect(run(async (trx) => {
        const v = await header(trx);
        await trx.insertInto('voucher_line').values([await lineRow(v.id, 1, '1111', '100', '0'), await lineRow(v.id, 2, '5113', '0', '100')]).execute();
        await trx.insertInto('voucher_line').values(await lineRow(v.id, 3, '5113', '0', '30')).execute();
        await trx.deleteFrom('voucher_line').where('voucher_id', '=', v.id).where('line_no', '=', 3).execute();
        await trx.insertInto('voucher_line').values(await lineRow(v.id, 4, '5113', '0', '7')).execute(); // lệch ở trạng thái cuối
      })).rejects.toThrow(/VOUCHER_UNBALANCED/);
      await run(async (trx) => {
        const v = await header(trx);
        await trx.insertInto('voucher_line').values(await lineRow(v.id, 1, '1111', '100', '0')).execute(); // lệch tạm thời
        await trx.insertInto('voucher_line').values(await lineRow(v.id, 2, '5113', '0', '100')).execute();
        expect(await pending(trx)).toBe(1); // hai câu lệnh, một dòng hàng đợi
      });
      expect(Number((await admin.query('SELECT count(*) FROM voucher_balance_pending')).rows[0].count)).toBe(0);
    });

    it('chứng từ nháp bị xóa cùng giao dịch sau khi sửa dòng: kiểm im lặng; app_user và quản trị đều chạy trigger', async () => {
      await run(async (trx) => {
        const v = await header(trx);
        await trx.insertInto('voucher_line').values(await lineRow(v.id, 1, '1111', '100', '0')).execute();
        await trx.deleteFrom('voucher_line').where('voucher_id', '=', v.id).execute();
        await trx.deleteFrom('voucher').where('id', '=', v.id).execute();
      });
      // quản trị (không qua withTenant): vẫn có trigger và hàng đợi
      await admin.query('BEGIN');
      try {
        const v = (await admin.query(`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, state, description, currency_code, created_by) VALUES ($1,'PKT','2026-05-10','2026-05-10','draft','t','VND',$2) RETURNING id`, [tenantId, userId])).rows[0].id;
        await admin.query(`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, debit, credit, amount_currency) VALUES ($1,$2,1,$3,'2026-05-10','VND',50,0,50)`, [tenantId, v, await acc('1111')]);
        await expect(admin.query('COMMIT')).rejects.toThrow(/VOUCHER_UNBALANCED/);
      } finally { await admin.query('ROLLBACK'); }
    });

    it('UPDATE dòng trên bảng gốc làm dòng chuyển partition vẫn vào hàng đợi; SET CONSTRAINTS IMMEDIATE giữa giao dịch kiểm ngay rồi tiếp tục theo dõi', async () => {
      const id = await newVoucher('2026-05-10', [{ code: '1111', debit: '10' }, { code: '5113', credit: '10' }]);
      await expect(run(async (trx) => {
        await trx.updateTable('voucher_line').set({ posting_date: '2026-06-10', debit: '11', amount_currency: '11' }).where('voucher_id', '=', id).where('line_no', '=', 1).execute();
        expect(await pending(trx)).toBe(1);
      })).rejects.toThrow(/VOUCHER_UNBALANCED/);
      await run(async (trx) => {
        await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx);
        const parts = await sql<{ part: string }>`SELECT tableoid::regclass::text AS part FROM voucher_line WHERE voucher_id = ${id}::uuid ORDER BY line_no`.execute(trx);
        expect(parts.rows.length).toBe(2);
        await expect(trx.insertInto('voucher_line').values(await lineRow(id, 3, '1111', '5', '0')).execute()).rejects.toThrow(/VOUCHER_UNBALANCED/);
      });
      await run(async (trx) => { // sau IMMEDIATE, tạm lệch rồi cân lại vẫn phải kiểm ngay: chèn một dòng lệch bị bắt tức thì
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
        await trx.insertInto('voucher_line').values(await lineRow(id, 4, '1111', '5', '0')).execute();
        await trx.insertInto('voucher_line').values(await lineRow(id, 5, '5113', '0', '5')).execute();
      });
    });

    it('app_user không ghi thẳng vào partition (kể cả partition mới tạo); đọc qua bảng gốc vẫn chạy', async () => {
      const id = await newVoucher('2026-05-12', [{ code: '1111', debit: '4' }, { code: '5113', credit: '4' }]);
      await expect(run((trx) => sql`DELETE FROM voucher_line_y2026m05 WHERE voucher_id = ${id}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
      await expect(run((trx) => sql`INSERT INTO voucher_line_y2026m05(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, debit, credit, amount_currency) SELECT tenant_id, voucher_id, 99, account_id, posting_date, currency_code, debit, credit, amount_currency FROM voucher_line WHERE voucher_id = ${id}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
      await admin.query(`SELECT ensure_line_partitions('2027-01-01','2027-01-31')`);
      const g = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'app_user' AND table_name LIKE 'voucher_line_y%'`.execute(t.admin);
      expect(g.rows[0]!.n).toBe(0);
      expect((await run((trx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_line WHERE voucher_id = ${id}::uuid`.execute(trx))).rows[0]!.n).toBe(2);
    });

    it('COPY qua bảng gốc: chứng từ lệch bị bắt khi commit (trigger cấp câu lệnh chạy với COPY)', async () => {
      await admin.query('BEGIN');
      try {
        const v = (await admin.query(`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, state, description, currency_code, created_by) VALUES ($1,'PKT','2026-05-10','2026-05-10','draft','t','VND',$2) RETURNING id`, [tenantId, userId])).rows[0].id;
        const row = [tenantId, v, 1, await acc('1111'), '2026-05-10', 'VND', 9, 0, 9].join('\\t');
        await admin.query(`COPY voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, debit, credit, amount_currency) FROM PROGRAM 'printf "${row}\\n"'`);
        await expect(admin.query('COMMIT')).rejects.toThrow(/VOUCHER_UNBALANCED/);
      } finally { await admin.query('ROLLBACK'); }
    });

    it('app_user không xóa trực tiếp được hàng đợi; trigger hoãn (definer) vẫn dọn', async () => {
      await expect(run(async (trx) => { await sql`DELETE FROM voucher_balance_pending`.execute(trx); })).rejects.toThrow(/permission denied/);
      const id = await newVoucher('2026-05-12', [{ code: '1111', debit: '4' }, { code: '5113', credit: '4' }]);
      expect(id).toBeTruthy();
      expect(Number((await admin.query('SELECT count(*) FROM voucher_balance_pending')).rows[0].count)).toBe(0);
    });

    it('chứng từ đã ghi sổ: xóa dòng bị chặn và hàng đợi rỗng sau giao dịch lỗi', async () => {
      const id = await newVoucher('2026-05-11', [{ code: '1111', debit: '3' }, { code: '5113', credit: '3' }]);
      await setState(id, 'posted');
      await expect(run(async (trx) => { await sql`SELECT set_config('app.state_change','on',true)`.execute(trx); await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute(); })).rejects.toThrow();
      expect(await run((trx) => pending(trx))).toBe(0);
    });
  });
});
