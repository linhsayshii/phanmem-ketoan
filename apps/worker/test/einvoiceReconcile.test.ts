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
  it('chỉ thử lại hàng sending quá ngưỡng chặn thử lại chồng (150 giây), chạy dưới RLS từng công ty; lỗi nghiệp vụ → failed', async () => {
    const tenantId = await createTestTenant(t.admin, { code: `WE${Date.now()}`, name: 'Worker HĐĐT' });
    await sql`INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES (${tenantId}::uuid, 2026, 3, '2026-03-01', '2026-03-31', 'TT133')`.execute(t.admin);
    const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name, options) VALUES (${tenantId}::uuid, 'fake', 'Giả lập', '{"mode":"reject"}') RETURNING id::int`.execute(t.admin)).rows[0]!.id;
    const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${providerId}, '1', 'C26TAA', 2026) RETURNING id::int`.execute(t.admin)).rows[0]!.id;
    const old = await sending(tenantId, providerId, seriesId, 300);
    const fresh = await sending(tenantId, providerId, seriesId, 130); // cũ hơn 120 giây nhưng chưa quá 150: lần gửi có thể còn chạy

    // `pnpm test` ở gốc dùng chung DB tạm với kiểm thử API: hàng `sending` của công ty khác cũng được đối soát, nên chỉ xét công ty này
    const mine = (r: Awaited<ReturnType<typeof runEInvoiceReconcile>>) => [...r.errorDetails, ...r.notices].filter((d) => d.tenantId === tenantId);
    const first = await runEInvoiceReconcile(t.db);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(mine(first)).toEqual([]);
    const rows = (await sql<{ id: number; status: string; error_code: string | null }>`SELECT id::int, status, error_code FROM einvoice WHERE tenant_id = ${tenantId}::uuid ORDER BY id`.execute(t.admin)).rows;
    expect(rows).toEqual([{ id: old, status: 'failed', error_code: 'FAKE_REJECT' }, { id: fresh, status: 'sending', error_code: null }]);
    // nhật ký gọi nhà cung cấp ghi dưới công ty của hóa đơn
    expect((await sql`SELECT 1 FROM einvoice_log WHERE tenant_id = ${tenantId}::uuid AND einvoice_id = ${old} AND action = 'create'`.execute(t.admin)).rows).toHaveLength(1);
    // hàm SECURITY DEFINER chỉ cấp cho app_user, không cho PUBLIC
    const acl = (await sql<{ acl: string }>`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'fn_einvoice_pending_tenants'`.execute(t.admin)).rows[0]!.acl;
    expect(acl).toContain('app_user=X/');
    expect(acl).not.toMatch(/[{,]=X\//);
    // lần chạy sau không gọi lại nhà cung cấp cho hóa đơn đã failed, không đụng hàng chưa quá ngưỡng
    const logs = async () => (await sql`SELECT 1 FROM einvoice_log WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows.length;
    const before = await logs();
    expect(mine(await runEInvoiceReconcile(t.db))).toEqual([]);
    expect(await logs()).toBe(before);
    expect((await sql<{ status: string }>`SELECT status FROM einvoice WHERE id = ${fresh}`.execute(t.admin)).rows[0]!.status).toBe('sending');
  });
});
