import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { insertFiscalYear, generateAccountsSql } from '../src/seed/common.js';
import type { Database } from '../src/types.js';

let t: TestDb; let tenantA: string; let tenantB: string; let userA: string;
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const runA = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(t.db, { tenantId: tenantA, userId: userA }, fn);

async function setup(code: string) {
  const id = await createTestTenant(t.admin, { code, name: code });
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [id]);
  await insertFiscalYear(admin, id, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, id, 'TT133');
  return id;
}
const mkItem = (trx: Transaction<Database>, tenant: string, code: string, uom: number) =>
  trx.insertInto('item').values({ tenant_id: tenant, code, name: code, base_uom_id: uom }).returning('id').executeTakeFirstOrThrow();
const uomOf = async (tenant: string) => (await sql<{ id: number }>`SELECT id FROM uom WHERE tenant_id = ${tenant}::uuid AND code = 'CAI'`.execute(t.admin)).rows[0]!.id;
// Dòng chứng từ nháp (2 dòng cân) tham chiếu hàng; trả về id chứng từ.
async function lineWithItem(tenant: string, userId: string, itemId: number) {
  const acc = async (c: string) => (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tenant}::uuid AND regime = 'TT133' AND code = ${c}`.execute(t.admin)).rows[0]!.id;
  const [a1, a2] = [await acc('1111'), await acc('5113')];
  return withTenant(t.db, { tenantId: tenant, userId }, async (trx) => {
    const v = await trx.insertInto('voucher').values({ tenant_id: tenant, voucher_type: 'PKT', posting_date: '2026-03-10', document_date: '2026-03-10', state: 'draft', description: 't', currency_code: 'VND', created_by: userId }).returning('id').executeTakeFirstOrThrow();
    const base = { tenant_id: tenant, voucher_id: v.id, posting_date: '2026-03-10', currency_code: 'VND' };
    await trx.insertInto('voucher_line').values({ ...base, line_no: 1, account_id: a1, debit: '100', credit: '0', amount_currency: '100', item_id: itemId }).execute();
    await trx.insertInto('voucher_line').values({ ...base, line_no: 2, account_id: a2, debit: '0', credit: '100', amount_currency: '-100' }).execute();
  });
}

beforeAll(async () => {
  t = await setupTestDb(); await admin.connect();
  tenantA = await setup(`VA${Date.now()}`); tenantB = await setup(`VB${Date.now()}`);
  userA = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantA}::uuid`.execute(t.admin)).rows[0]!.user_id;
});
afterAll(async () => { await admin.end(); await t.close(); });

describe('lược đồ VTHH, kho', () => {
  it('tạo hàng tự sinh ĐVT cơ sở factor 1; không xóa/sửa được dòng cơ sở; đổi ĐVT cơ sở khi chưa phát sinh thì dòng theo', async () => {
    const cai = await uomOf(tenantA);
    const kg = (await runA((trx) => trx.insertInto('uom').values({ tenant_id: tenantA, code: 'KGX', name: 'Kg' }).returning('id').executeTakeFirstOrThrow())).id;
    const it1 = await runA((trx) => mkItem(trx, tenantA, 'H1', cai));
    const rows = () => runA((trx) => trx.selectFrom('item_uom').select(['uom_id', 'factor']).where('item_id', '=', it1.id).execute());
    expect(await rows()).toEqual([{ uom_id: cai, factor: '1.000000' }]);
    await expect(runA((trx) => trx.deleteFrom('item_uom').where('item_id', '=', it1.id).execute())).rejects.toThrow(/ITEM_UOM_BASE/);
    await expect(runA((trx) => trx.updateTable('item_uom').set({ factor: '2' }).where('item_id', '=', it1.id).execute())).rejects.toThrow(/ITEM_UOM_BASE/);
    await runA((trx) => trx.updateTable('item').set({ base_uom_id: kg }).where('id', '=', it1.id).execute());
    expect(await rows()).toEqual([{ uom_id: kg, factor: '1.000000' }]);
    await expect(runA((trx) => trx.insertInto('item_uom').values({ tenant_id: tenantA, item_id: it1.id, uom_id: cai, factor: '0' }).execute())).rejects.toThrow();
  });

  it('dòng chứng từ không tham chiếu được hàng/kho của công ty khác; hàng đã dùng bị khóa ĐVT, theo dõi lô, xóa', async () => {
    const itB = await withTenant(t.db, { tenantId: tenantB, userId: userA }, (trx) => uomOf(tenantB).then((u) => mkItem(trx, tenantB, 'HB', u)));
    await expect(lineWithItem(tenantA, userA, itB.id)).rejects.toThrow(/foreign key|violates/);
    const cai = await uomOf(tenantA);
    const it2 = await runA((trx) => mkItem(trx, tenantA, 'H2', cai));
    await lineWithItem(tenantA, userA, it2.id);
    const upd = (v: Record<string, unknown>) => runA((trx) => trx.updateTable('item').set(v).where('id', '=', it2.id).execute());
    await expect(upd({ tracking: 'lot' })).rejects.toThrow(/ITEM_TRACKING_LOCKED/);
    await expect(upd({ base_uom_id: (await sql<{ id: number }>`SELECT id FROM uom WHERE tenant_id = ${tenantA}::uuid AND code = 'BO'`.execute(t.admin)).rows[0]!.id })).rejects.toThrow(/ITEM_UOM_LOCKED/);
    await expect(runA((trx) => trx.deleteFrom('item').where('id', '=', it2.id).execute())).rejects.toThrow(/ITEM_IN_USE/);
    await upd({ is_active: false });
  });
});
