import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestTenant, setupTestDb, type TestDb } from '@kt/db/testing';
import { runEInvoiceReconcile } from '../src/jobs/einvoiceReconcile.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); }, 60_000);
afterAll(async () => { await t.close(); });

// Hàng `sending` dựng thẳng bằng SQL (luồng phát hành đầy đủ kiểm ở apps/api/test/einvoice/issue.test.ts): nhà cung cấp giả lập từ chối → failed.
async function sending(tenantId: string, providerId: number, seriesId: number, ageSec: number) {
  const v = (await sql<{ id: string }>`INSERT INTO voucher (tenant_id, voucher_type, posting_date, document_date, created_by)
    SELECT ${tenantId}::uuid, 'PKT', '2026-03-10', '2026-03-10', user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid RETURNING id`.execute(t.admin)).rows[0]!.id;
  const doc = { transactionUuid: crypto.randomUUID(), formNo: '1', serial: 'C26TAA', issueDate: '2026-03-10', seller: { name: 'A', taxCode: null, address: null } };
  return (await sql<{ id: number }>`INSERT INTO einvoice (tenant_id, voucher_id, series_id, provider_id, status, transaction_uuid, payload, last_attempt_at)
    VALUES (${tenantId}::uuid, ${v}::uuid, ${seriesId}, ${providerId}, 'sending', ${doc.transactionUuid}::uuid, ${JSON.stringify(doc)}::jsonb, now() - make_interval(secs => ${ageSec}))
    RETURNING id::int`.execute(t.admin)).rows[0]!.id;
}

describe('job đối soát hóa đơn điện tử', () => {
  it('chỉ thử lại hàng sending quá 120 giây, chạy dưới RLS từng công ty; lỗi nghiệp vụ → failed', async () => {
    const tenantId = await createTestTenant(t.admin, { code: `WE${Date.now()}`, name: 'Worker HĐĐT' });
    await sql`INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES (${tenantId}::uuid, 2026, 3, '2026-03-01', '2026-03-31', 'TT133')`.execute(t.admin);
    const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name, options) VALUES (${tenantId}::uuid, 'fake', 'Giả lập', '{"mode":"reject"}') RETURNING id::int`.execute(t.admin)).rows[0]!.id;
    const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${providerId}, '1', 'C26TAA', 2026) RETURNING id::int`.execute(t.admin)).rows[0]!.id;
    const old = await sending(tenantId, providerId, seriesId, 300);
    const fresh = await sending(tenantId, providerId, seriesId, 10);

    expect(await runEInvoiceReconcile(t.db)).toEqual({ checked: 1, issued: 0, failed: 1, errors: 0 });
    const rows = (await sql<{ id: number; status: string; error_code: string | null }>`SELECT id::int, status, error_code FROM einvoice WHERE tenant_id = ${tenantId}::uuid ORDER BY id`.execute(t.admin)).rows;
    expect(rows).toEqual([{ id: old, status: 'failed', error_code: 'FAKE_REJECT' }, { id: fresh, status: 'sending', error_code: null }]);
    // nhật ký gọi nhà cung cấp ghi dưới công ty của hóa đơn
    expect((await sql`SELECT 1 FROM einvoice_log WHERE tenant_id = ${tenantId}::uuid AND einvoice_id = ${old} AND action = 'create'`.execute(t.admin)).rows).toHaveLength(1);
    expect(await runEInvoiceReconcile(t.db)).toEqual({ checked: 0, issued: 0, failed: 0, errors: 0 });
  });
});
