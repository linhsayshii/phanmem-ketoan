import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

// GĐ7 gói 1: RLS phạm vi chi nhánh phủ cả bảng con có voucher_id (migration 0260), không chỉ bảng voucher.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let tenantId: string; let userId: string; let brA: number; let brB: number;
const ids: Record<string, string> = {};
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const ok = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => {
  const r = await call(method, url, c, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const L = (accountCode: string, debit: string, credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = async (date: string, desc: string, lines: object[], autoPost = true) =>
  (await ok('POST', '/api/vouchers', owner, { voucherType: 'PKT', postingDate: date, documentDate: date, description: desc, autoPost, lines })).id as string;
const working = (branch: 'HO' | number) => ok('PUT', '/api/me/branch', owner, { branch });
const asScope = <T>(scope: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.t.db, { tenantId, userId, branchScope: scope }, fn);

// Bảng có cột voucher_id đã phủ chính sách branch_scope; bảng còn lại liệt kê kèm lý do không phủ.
const COVERED = ['doc_order_link', 'landed_cost_alloc', 'open_item', 'stock_move', 'stocktake_voucher', 'voucher_attachment', 'voucher_balance_pending',
  'voucher_invoice', 'voucher_item_line', 'voucher_line', 'voucher_line_history', 'voucher_pair'];

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner, tenantId, userId } = await bootstrapTenant(ctx, { code: `RL${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  brA = (await ok('POST', '/api/branches', owner, { code: 'CNA', name: 'Chi nhánh A' })).id;
  brB = (await ok('POST', '/api/branches', owner, { code: 'CNB', name: 'Chi nhánh B' })).id;
  for (const p of [{ code: 'KH1', name: 'Khách 1', is_customer: true }, { code: 'NCC1', name: 'Nhà cung cấp 1', is_vendor: true }]) await ok('POST', '/api/catalogs/party', owner, p);
  await call('POST', '/api/catalogs/uom', owner, { code: 'CAI', name: 'Cái' }); // có thể đã có sẵn
  await ok('POST', '/api/catalogs/item', owner, { code: 'SP1', name: 'Hàng 1', base_uom_code: 'CAI', kind: 'goods' });
  await ok('POST', '/api/catalogs/warehouse', owner, { code: 'K1', name: 'Kho chung', inventory_account_code: '156', costing_method: 'avg_moving' });
  const stockIn = async (date: string, qty: string) => {
    const v = await ok('POST', '/api/stock-vouchers', owner, { voucherType: 'PNK', stockKind: 'purchase', postingDate: date, warehouseCode: 'K1', partyCode: 'NCC1', description: 'Nhập kho',
      items: [{ itemCode: 'SP1', uomCode: 'CAI', quantity: qty, unitPrice: '10' }] });
    await ok('POST', `/api/vouchers/${v.id}/post`, owner, {}); return v.id as string;
  };
  await working(brA);
  ids.a = await pkt('2026-01-10', 'Bán chịu A', [L('131', '1000', '0', { partyCode: 'KH1' }), L('511', '0', '1000')]);
  ids.aStock = await stockIn('2026-01-11', '100');
  await working(brB);
  ids.b = await pkt('2026-01-12', 'Bán chịu B', [L('131', '2000', '0', { partyCode: 'KH1' }), L('511', '0', '2000')]);
  ids.bStock = await stockIn('2026-01-13', '50');
  ids.bDraft = await pkt('2026-01-14', 'Nháp B', [L('6422', '10'), L('112', '0', '10')], false);
  await working('HO');
  ids.ho = await pkt('2026-01-15', 'Trụ sở', [L('112', '300'), L('511', '0', '300')]);
}, 180_000);
afterAll(async () => { await ctx?.close(); });

describe('chính sách branch_scope trên bảng con của chứng từ', () => {
  it('mọi bảng có voucher_id hoặc đã phủ branch_scope RESTRICTIVE hoặc nằm trong danh sách không phủ có lý do', async () => {
    const r = await sql<{ t: string; scoped: boolean }>`
      SELECT c.table_name AS t, EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('public.' || c.table_name)::regclass AND p.polname = 'branch_scope' AND NOT p.polpermissive) AS scoped
      FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
      WHERE c.table_schema = 'public' AND c.column_name = 'voucher_id' AND NOT k.relispartition ORDER BY 1`.execute(ctx.t.admin);
    const scoped = r.rows.filter((x) => x.scoped).map((x) => x.t);
    expect(scoped).toEqual(COVERED);
    // Không phủ có chủ ý: bảng của phân hệ mà quyền còn lại của người dùng chi nhánh không chạm tới (xem quyết định 1310).
    const exempt = r.rows.filter((x) => !x.scoped).map((x) => x.t);
    expect(exempt.sort()).toEqual([...EXEMPT].sort());
  });

  it('phạm vi chi nhánh A: mọi bảng con chỉ còn dòng của chứng từ chi nhánh A', async () => {
    for (const t of COVERED) {
      const rows = await asScope(String(brA), async (trx) => (await sql<{ id: string }>`SELECT DISTINCT voucher_id::text AS id FROM ${sql.table(t)}`.execute(trx)).rows);
      const owners = await sql<{ branch_id: number | null }>`SELECT DISTINCT branch_id FROM voucher WHERE id = ANY (${rows.map((x) => x.id)}::uuid[])`.execute(ctx.t.admin);
      expect(owners.rows.every((o) => o.branch_id === brA), t).toBe(true);
    }
    // Có dữ liệu thật để so: A thấy dòng sổ cái, tồn kho, khoản công nợ của mình, và không thấy của B/HO.
    for (const t of ['voucher_line', 'voucher_item_line', 'stock_move', 'open_item']) {
      const all = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t)} WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n;
      const mine = await asScope(String(brA), async (trx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t)}`.execute(trx)).rows[0]!.n);
      expect(mine, t).toBeGreaterThan(0); expect(mine, t).toBeLessThan(all);
    }
  });

  it('phạm vi rỗng thấy toàn công ty; phạm vi chi nhánh không có chứng từ thấy 0 dòng', async () => {
    const count = (scope: string) => asScope(scope, async (trx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_line`.execute(trx)).rows[0]!.n);
    const all = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_line WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n;
    expect(await count('')).toBe(all);
    expect(await count('999999')).toBe(0);
    expect(await count(`${brA},${brB},0`)).toBe(all); // đủ ba đơn vị: thấy hết
  });

  it('phạm vi A không sửa, xóa, chèn được dòng sổ cái của chứng từ đã ghi sổ ở chi nhánh khác (trigger bất biến không bị mở cửa)', async () => {
    const upd = await asScope(String(brA), async (trx) => (await sql`UPDATE voucher_line SET description = 'sửa trộm' WHERE voucher_id = ${ids.b}::uuid`.execute(trx)).numAffectedRows);
    expect(upd).toBe(0n);
    const del = await asScope(String(brA), async (trx) => (await sql`DELETE FROM voucher_line WHERE voucher_id = ${ids.b}::uuid`.execute(trx)).numAffectedRows);
    expect(del).toBe(0n);
    const delItems = await asScope(String(brA), async (trx) => (await sql`DELETE FROM voucher_item_line WHERE voucher_id = ${ids.bStock}::uuid`.execute(trx)).numAffectedRows);
    expect(delItems).toBe(0n);
    await expect(asScope(String(brA), async (trx) => sql`
      INSERT INTO voucher_line (tenant_id, voucher_id, line_no, posting_date, account_id, debit, credit)
      SELECT tenant_id, id, 99, posting_date, (SELECT id FROM account WHERE tenant_id = ${tenantId}::uuid AND code = '111'), 0, 0 FROM voucher WHERE id = ${ids.b}::uuid`.execute(trx))).resolves.toBeDefined();
    const after = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_line WHERE voucher_id = ${ids.b}::uuid`.execute(ctx.t.admin)).rows[0]!.n;
    expect(after).toBe(2); // INSERT ... SELECT từ voucher bị che chèn 0 dòng; dòng cũ còn nguyên
  });

  it('chèn thẳng dòng cho chứng từ chi nhánh khác bị từ chối', async () => {
    await expect(asScope(String(brA), async (trx) => sql`
      INSERT INTO voucher_line (tenant_id, voucher_id, line_no, posting_date, account_id, debit, credit)
      VALUES (${tenantId}::uuid, ${ids.bDraft}::uuid, 99, '2026-01-14', (SELECT id FROM account WHERE tenant_id = ${tenantId}::uuid AND code = '111'), 0, 0)`.execute(trx))).rejects.toThrow(/row-level security|violates|VOUCHER_NOT_FOUND/);
  });

  it('ghi sổ, bỏ ghi sổ, đảo chứng từ trong phạm vi vẫn chạy với người dùng bị giới hạn', async () => {
    // Người dùng bị giới hạn A: quyền qua API đã kiểm ở branches.test.ts; ở đây kiểm thủ tục SQL dưới phiên phạm vi.
    const posted = await asScope(String(brB), async (trx) => {
      await sql`SELECT post_voucher(${ids.bDraft}::uuid)`.execute(trx);
      return (await sql<{ state: string }>`SELECT state FROM voucher WHERE id = ${ids.bDraft}::uuid`.execute(trx)).rows[0]!.state;
    });
    expect(posted).toBe('posted');
    const back = await asScope(String(brB), async (trx) => {
      await sql`SELECT unpost_voucher(${ids.bDraft}::uuid)`.execute(trx);
      return (await sql<{ state: string; n: number }>`SELECT state, (SELECT count(*)::int FROM voucher_line WHERE voucher_id = ${ids.bDraft}::uuid) AS n FROM voucher WHERE id = ${ids.bDraft}::uuid`.execute(trx)).rows[0]!;
    });
    expect(back).toEqual({ state: 'draft', n: 2 });
  });
});

// Phân hệ có quyền không nằm trong BRANCH_SCOPED_PERMISSIONS (lương, giá thành, hợp đồng, phê duyệt, hóa đơn điện tử, ngân hàng, kết chuyển, tài sản): người dùng bị giới hạn không có đường API vào,
// và chứng từ tự sinh phần lớn thuộc trụ sở chính. Bảng có voucher_id nullable (lớp giá, gán giá) mang cả dòng không thuộc chứng từ nào.
const EXEMPT = ['amortization_line', 'approval_request', 'asset_event', 'bank_transaction', 'cash_count', 'closing_run', 'contract_milestone', 'cost_run', 'einvoice', 'inbound_invoice',
  'ledger_voucher_set_item', 'payroll_payment_batch', 'payroll_run', 'payroll_run_voucher', 'period_run', 'project_alloc_run', 'settlement_plan', 'stock_cost_assignment', 'stock_cost_layer'];
