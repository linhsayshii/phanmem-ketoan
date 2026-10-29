import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

interface Dist { code: string; document_type: string; scope: string; line_type: string; factor_percent: string; account_code: string | null; report_tag: string | null }
const dists = async (tenant: string) => (await sql<Dist>`SELECT c.code, d.document_type, d.scope, d.line_type, d.factor_percent::text, d.account_code, d.report_tag
  FROM tax_distribution d JOIN tax_code c ON c.id = d.tax_code_id WHERE d.tenant_id = ${tenant} ORDER BY c.code, d.document_type, d.scope`.execute(t.admin)).rows;
const expected = (): Dist[] => [
  ...['TNCN_KT'].flatMap((code) => ['invoice', 'refund'].map((document_type) => ({ code, document_type, scope: 'purchase', line_type: 'tax', factor_percent: '-100.0000', account_code: '3335', report_tag: null }))),
  ...['V0', 'V10', 'V5', 'V8'].flatMap((code) => ['invoice', 'refund'].flatMap((document_type) => [
    { code, document_type, scope: 'purchase', line_type: 'tax', factor_percent: '100.0000', account_code: '1331', report_tag: 'purchase_tax' },
    { code, document_type, scope: 'sale', line_type: 'tax', factor_percent: '100.0000', account_code: '33311', report_tag: 'sale_tax' }])),
].sort((a, b) => a.code.localeCompare(b.code) || a.document_type.localeCompare(b.document_type) || a.scope.localeCompare(b.scope));
// Như legalParam() ở apps/api/src/modules/core/legal.ts: dòng có [valid_from, valid_to] chứa ngày.
const param = async (code: string, date: string) => (await sql<{ value: unknown }>`SELECT value FROM legal_param WHERE code = ${code} AND valid_from <= ${date}::date AND (valid_to IS NULL OR valid_to >= ${date}::date)`.execute(t.db)).rows.map((r) => r.value);

describe('động cơ thuế: dữ liệu mặc định', () => {
  it('công ty mới có phân bổ thuế mặc định; legalParam vat_return_template ngày 2026-06-30 = TT80, 2026-07-01 = TT89', async () => {
    const a = await createTestTenant(t.admin, { code: `TX${Date.now()}`, name: 'Thuế' });
    expect(await dists(a)).toEqual(expected());
    const codes = (await sql<{ code: string; kind: string; rate: string | null; scope: string; method: string; price_include: boolean; in_declaration: boolean }>`SELECT code, kind, rate, scope, method, price_include, in_declaration FROM tax_code WHERE tenant_id = ${a} ORDER BY code`.execute(t.admin)).rows;
    // TNCN không lên tờ khai GTGT (như NK, TTĐB)
    expect(codes.find((c) => c.code === 'TNCN_KT')).toEqual({ code: 'TNCN_KT', kind: 'pit', rate: null, scope: 'purchase', method: 'deduct', price_include: false, in_declaration: false });
    expect(codes.filter((c) => c.method === 'none').map((c) => c.code)).toEqual(['KCT', 'KKK']); // không chịu thuế, không kê khai: thuế 0
    expect(codes.find((c) => c.code === 'V10')).toMatchObject({ rate: '10.00', scope: 'both', method: 'deduct', price_include: false });
    expect(await param('vat_return_template', '2026-06-30')).toEqual(['TT80']);
    expect(await param('vat_return_template', '2026-07-01')).toEqual(['TT89']);
    expect(await param('vat_reduced_rate', '2026-12-31')).toEqual([{ from: 10, to: 8 }]);
    expect(await param('vat_reduced_rate', '2027-01-01')).toEqual([]);
    expect(await param('vat_noncash_threshold', '2025-06-30')).toEqual([]);
    expect(await param('vat_noncash_threshold', '2030-01-01')).toEqual(['5000000']);
  });

  it('chèn bù cho công ty có sẵn (gỡ phân bổ và TNCN_KT rồi gọi lại seed_tax_defaults): đủ như công ty mới, gọi lần hai không nhân đôi; app_user không gọi được', async () => {
    const a = await createTestTenant(t.admin, { code: `TB${Date.now()}`, name: 'Thuế bù' });
    await sql`ALTER TABLE tax_distribution DISABLE TRIGGER trg_audit`.execute(t.admin);
    await sql`ALTER TABLE tax_code DISABLE TRIGGER trg_audit`.execute(t.admin);
    try {
      await sql`DELETE FROM tax_distribution WHERE tenant_id = ${a}`.execute(t.admin);
      await sql`DELETE FROM tax_code WHERE tenant_id = ${a} AND code = 'TNCN_KT'`.execute(t.admin);
    } finally {
      await sql`ALTER TABLE tax_distribution ENABLE TRIGGER trg_audit`.execute(t.admin);
      await sql`ALTER TABLE tax_code ENABLE TRIGGER trg_audit`.execute(t.admin);
    }
    await sql`SELECT seed_tax_defaults(${a}::uuid)`.execute(t.admin);
    await sql`SELECT seed_tax_defaults(${a}::uuid)`.execute(t.admin);
    expect(await dists(a)).toEqual(expected());
    await expect(withTenant(t.db, { tenantId: a }, (trx) => sql`SELECT seed_tax_defaults(${a}::uuid)`.execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('dòng thuế phải có tài khoản; dòng cơ sở không tài khoản không trùng được; phân bổ của công ty chỉ công ty đó thấy', async () => {
    const a = await createTestTenant(t.admin, { code: `TC${Date.now()}`, name: 'Ràng buộc' });
    const b = await createTestTenant(t.admin, { code: `TD${Date.now()}`, name: 'Khác' });
    const v10 = (await sql<{ id: string }>`SELECT id FROM tax_code WHERE tenant_id = ${a} AND code = 'V10'`.execute(t.admin)).rows[0]!.id;
    const ins = (line: string, account: string | null) => withTenant(t.db, { tenantId: a }, (trx) =>
      sql`INSERT INTO tax_distribution(tenant_id, tax_code_id, document_type, scope, line_type, factor_percent, account_code) VALUES (${a}, ${v10}, 'invoice', 'sale', ${line}, 100, ${account})`.execute(trx));
    await expect(ins('tax', null)).rejects.toThrow(/check constraint/);
    await ins('base', null);
    await expect(ins('base', null)).rejects.toThrow(/duplicate key/);
    const factor = (f: string) => withTenant(t.db, { tenantId: a }, (trx) =>
      sql`INSERT INTO tax_distribution(tenant_id, tax_code_id, document_type, scope, line_type, factor_percent, account_code) VALUES (${a}, ${v10}, 'refund', 'sale', 'tax', ${f}::numeric, '6422')`.execute(trx));
    await expect(factor('150')).rejects.toThrow(/tax_distribution_factor_percent_check/);
    await expect(factor('-100.0001')).rejects.toThrow(/tax_distribution_factor_percent_check/);
    const seen = await withTenant(t.db, { tenantId: b }, (trx) => sql<{ n: string }>`SELECT count(*) AS n FROM tax_distribution WHERE tenant_id = ${a}`.execute(trx));
    expect(Number(seen.rows[0]!.n)).toBe(0);
    const audit = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${a} AND entity = 'tax_distribution' AND action = 'insert' AND after->>'line_type' = 'base'`.execute(t.admin);
    expect(Number(audit.rows[0]!.n)).toBe(1); // thêm phân bổ ghi audit_event
  });

  it('mã không chịu thuế phải không tính thuế; TNCN luôn khấu trừ, không giá đã gồm thuế', async () => {
    const a = await createTestTenant(t.admin, { code: `TE${Date.now()}`, name: 'Ràng buộc mã' });
    const add = (code: string, kind: string, isExempt: boolean, method: string, priceInclude = false) => withTenant(t.db, { tenantId: a }, (trx) =>
      sql`INSERT INTO tax_code(tenant_id, code, name, kind, rate, is_exempt, method, price_include) VALUES (${a}, ${code}, ${code}, ${kind}, NULL, ${isExempt}, ${method}, ${priceInclude})`.execute(trx));
    await expect(add('X1', 'vat', true, 'deduct')).rejects.toThrow(/tax_code_exempt_method_check/);
    await expect(add('X2', 'vat', true, 'direct')).rejects.toThrow(/tax_code_exempt_method_check/);
    await add('X3', 'vat', true, 'none');
    await expect(add('P1', 'pit', false, 'direct')).rejects.toThrow(/tax_code_pit_check/);
    await expect(add('P2', 'pit', false, 'none')).rejects.toThrow(/tax_code_pit_check/);
    await expect(add('P3', 'pit', false, 'deduct', true)).rejects.toThrow(/tax_code_pit_check/);
    await add('P4', 'pit', false, 'deduct');
  });

  it('tờ khai kỳ năm (03/TNDN): period_kind year chỉ có period 1; tham số thuế TNDN nạp vào legal_param theo ngày hiệu lực', async () => {
    const a = await createTestTenant(t.admin, { code: `TY${Date.now()}`, name: 'Thuế năm' });
    const ins = (kind: string, period: number) => sql`INSERT INTO tax_return(tenant_id, form_code, template_version, period_kind, year, period, values) VALUES (${a}, '03/TNDN', 'TT89', ${kind}, 2026, ${period}, '{}')`.execute(t.admin);
    await ins('year', 1);
    await expect(ins('year', 2)).rejects.toThrow(/tax_return_check/);
    await expect(ins('half', 1)).rejects.toThrow(/tax_return_period_kind_check/);
    await ins('quarter', 4); await expect(ins('quarter', 5)).rejects.toThrow(/tax_return_check/);
    expect(await param('cit_rate', '2025-01-01')).toEqual([{ standard: 20, tiers: [{ maxRevenue: '3000000000', rate: 15 }, { maxRevenue: '50000000000', rate: 17 }] }]);
    expect(await param('cit_rate', '2024-12-31')).toEqual([]);
    expect(await param('cit_exempt_revenue', '2025-12-31')).toEqual([]);
    expect(await param('cit_exempt_revenue', '2026-01-01')).toEqual(['1000000000']);
    expect(await param('cit_reduction', '2027-01-01')).toEqual([{ rate: 30, maxRevenue: '10000000000', revenueOf: 'current_year' }]);
    expect(await param('cit_reduction', '2028-01-01')).toEqual([]);
    expect(await param('cit_prepay_min_ratio', '2026-12-31')).toEqual([80]);
    expect(await param('cit_return_template', '2026-12-31')).toEqual(['TT89']);
    expect(await param('cit_return_template', '2026-06-30')).toEqual(['TT80']);
    expect(await param('cit_return_template', '2021-12-30')).toEqual([]);
  });
});
