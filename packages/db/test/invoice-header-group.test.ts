import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import { createTestTenant, newId, setupTestDb, type TestDb } from '../src/testing.js';
import { insertFiscalYear } from '../src/seed/common.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

// Điền bù của migration 0036: chạy lại đúng đoạn điền bù (từ dòng DISABLE TRIGGER) trên dữ liệu có header_group_id rỗng.
const backfill = readFileSync(new URL('../migrations/0036_nhom_dau_hoa_don.sql', import.meta.url), 'utf8').split('ALTER TABLE voucher_invoice DISABLE TRIGGER USER;')[1]!;

describe('migration 0036: điền bù header_group_id', () => {
  it('hóa đơn mua khai trên PC giữ nhóm riêng từng dòng; hóa đơn bán ra lấy nhóm của dòng đầu', async () => {
    const tenant = await createTestTenant(t.admin, { code: `HG${Date.now()}`, name: 'Nhóm đầu' });
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await c.connect();
    await c.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenant]);
    await insertFiscalYear(c, tenant, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' }); await c.end();
    const owner = (await sql<{ id: string }>`SELECT user_id AS id FROM tenant_user WHERE tenant_id = ${tenant}::uuid LIMIT 1`.execute(t.admin)).rows[0]!.id;
    const grp = async (scope: string, code: string) => (await sql<{ id: string }>`SELECT id::text AS id FROM invoice_group WHERE tenant_id = ${tenant} AND scope = ${scope} AND code = ${code}`.execute(t.admin)).rows[0]!.id;
    const [p01, p03, s10, sKct] = [await grp('purchase', '01'), await grp('purchase', '03'), await grp('sale', '10'), await grp('sale', 'KCT')];
    const voucher = async (type: string) => { const id = newId();
      await sql`INSERT INTO voucher (id, tenant_id, voucher_type, posting_date, document_date, state, description, currency_code, created_by) VALUES (${id}, ${tenant}, ${type}, '2026-07-05', '2026-07-05', 'draft', 'test', 'VND', ${owner})`.execute(t.admin); return id; };
    const row = (v: string, direction: string, no: string, group: string) => sql`INSERT INTO voucher_invoice (tenant_id, voucher_id, direction, invoice_no, invoice_date, invoice_group_id, base_amount, tax_amount) VALUES (${tenant}, ${v}, ${direction}, ${no}, '2026-07-05', ${group}, 1000, 100)`.execute(t.admin);
    const pc = await voucher('PC'); const hdb = await voucher('HDB');
    await row(pc, 'purchase', 'M1', p01); await row(pc, 'purchase', 'M2', p03); // hai hóa đơn mua, hai nhóm
    await row(hdb, 'sale', 'B1', s10); await row(hdb, 'sale', 'B2', sKct);       // một hóa đơn bán, dòng V10 trước dòng KCT

    await sql`ALTER TABLE voucher_invoice DISABLE TRIGGER USER`.execute(t.admin);
    await sql`UPDATE voucher_invoice SET header_group_id = NULL WHERE tenant_id = ${tenant}`.execute(t.admin);
    await sql`ALTER TABLE voucher_invoice ENABLE TRIGGER USER`.execute(t.admin);
    await sql.raw(`ALTER TABLE voucher_invoice DISABLE TRIGGER USER;${backfill}`).execute(t.admin);

    const got = (await sql<{ invoice_no: string; header_group_id: string }>`SELECT invoice_no, header_group_id::text FROM voucher_invoice WHERE tenant_id = ${tenant} ORDER BY invoice_no`.execute(t.admin)).rows;
    expect(got).toEqual([{ invoice_no: 'B1', header_group_id: s10 }, { invoice_no: 'B2', header_group_id: s10 }, { invoice_no: 'M1', header_group_id: p01 }, { invoice_no: 'M2', header_group_id: p03 }]);
  });
});
