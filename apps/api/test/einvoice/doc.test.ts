import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { buildEInvoiceDoc } from '../../src/modules/einvoice/doc.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

async function tenant() {
  const { cookie, tenantId, userId } = await setupLedgerTenant(ctx, `ED${Date.now()}${n++}`);
  const admin = ctx.t.admin;
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name) VALUES (${tenantId}::uuid, 'fake', 'Giả lập') RETURNING id::int`.execute(admin)).rows[0]!.id;
  const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year, provider_template) VALUES (${tenantId}::uuid, ${providerId}, '1', 'C26TAA', 2026, '1/001') RETURNING id::int`.execute(admin)).rows[0]!.id;
  await sql`UPDATE tenant SET tax_code = '0100109106', address = 'Hà Nội' WHERE id = ${tenantId}::uuid`.execute(admin);
  const create = async (voucherType: string, items: object[], inv: object = {}, more: object = {}) => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/invoices', headers: { cookie }, payload: { voucherType, postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001', autoPost: true,
      items, invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '10', einvoiceSeriesId: seriesId, ...inv }, ...more } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; invoices: { id: number }[] };
  };
  const einvoice = async (voucherId: string, extra: { relation?: string; originalId?: number; adjustKind?: string; status?: string; no?: string } = {}) => (await sql<{ id: number }>`
    INSERT INTO einvoice (tenant_id, voucher_id, series_id, provider_id, status, transaction_uuid, relation, original_id, adjust_kind, invoice_no, issue_date)
    VALUES (${tenantId}::uuid, ${voucherId}::uuid, ${seriesId}, ${providerId}, ${extra.status ?? 'draft'}, gen_random_uuid(), ${extra.relation ?? 'original'}, ${extra.originalId ?? null}, ${extra.adjustKind ?? null},
      ${extra.no ?? null}, ${extra.no ? '2026-03-10' : null}::date) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const build = (id: number) => withTenant(ctx.t.db, { tenantId, userId }, (trx) => buildEInvoiceDoc(trx, id));
  return { create, einvoice, build, admin, tenantId };
}

describe('buildEInvoiceDoc', () => {
  it('HDB 2 dòng 10% + 1 dòng 8%: taxGroups khớp voucher_invoice, totals.total = Σ dòng + thuế, tiền bằng chữ tiếng Việt', async () => {
    const t = await tenant();
    const v = await t.create('HDB', [
      { description: 'Tư vấn', accountCode: '5113', amountCurrency: '10000000', discountCurrency: '500000', taxCodes: ['V10'] },
      { description: 'Thiết kế', accountCode: '5113', amountCurrency: '2000000', taxCodes: ['V10'] },
      { description: 'Đào tạo', accountCode: '5113', amountCurrency: '5000000', discountCurrency: '250000', taxCodes: ['V8'] }]);
    const doc = await t.build(await t.einvoice(v.id));
    const vi_ = (await sql<{ rate: string; base: string; tax: string }>`SELECT c.rate::text AS rate, i.base_amount::text AS base, i.tax_amount::text AS tax FROM voucher_invoice i JOIN tax_code c ON c.id = i.tax_code_id WHERE i.voucher_id = ${v.id}::uuid ORDER BY c.rate DESC`.execute(t.admin)).rows;
    expect(doc.taxGroups.map((g) => [g.taxRate, g.base, g.tax])).toEqual(vi_.map((r) => [String(Number(r.rate)), r.base, r.tax]));
    expect(doc.taxGroups).toEqual([{ taxRate: '10', base: '11500000', tax: '1150000' }, { taxRate: '8', base: '4750000', tax: '380000' }]);
    expect(doc.lines.map((l) => [l.name, l.amount, l.discountAmount, l.taxRate, l.taxAmount, l.total])).toEqual([
      ['Tư vấn', '10000000', '500000', '10', '950000', '10450000'], ['Thiết kế', '2000000', '0', '10', '200000', '2200000'], ['Đào tạo', '5000000', '250000', '8', '380000', '5130000']]);
    expect(doc.totals).toMatchObject({ beforeTax: '16250000', tax: '1530000', discount: '750000', total: '17780000' });
    expect(doc.totals.total).toBe(doc.lines.reduce((s, l) => s + Number(l.total), 0).toString());
    expect(doc.totals.totalInWords).toBe('Mười bảy triệu bảy trăm tám mươi nghìn đồng');
    expect(doc).toMatchObject({ currency: 'VND', fxRate: '1', formNo: '1', serial: 'C26TAA', providerTemplate: '1/001', issueDate: '2026-03-10', relation: { kind: 'original' },
      seller: { taxCode: '0100109106', address: 'Hà Nội' }, buyer: { name: 'Khách 1' } });
  });

  it('HDB USD tỷ giá 25.000: currency USD, dòng và tổng theo nguyên tệ, fxRate "25000"', async () => {
    const t = await tenant();
    const v = await t.create('HDB', [{ description: 'Dịch vụ', accountCode: '5113', amountCurrency: '100.50', taxCodes: ['V10'] }], {}, { currencyCode: 'USD', fxRate: '25000' });
    const doc = await t.build(await t.einvoice(v.id));
    expect(doc).toMatchObject({ currency: 'USD', fxRate: '25000' });
    expect(doc.lines[0]).toMatchObject({ amount: '100.50', taxRate: '10', taxAmount: '10.05', total: '110.55' });
    expect(doc.totals).toMatchObject({ beforeTax: '100.50', tax: '10.05', total: '110.55' });
    expect(doc.totals.totalInWords).toContain('đô la Mỹ');
  });

  it('GGB điều chỉnh giảm trỏ hóa đơn gốc: relation adjustment decrease, original lấy số của gốc; gốc chưa phát hành → 409', async () => {
    const t = await tenant();
    const base = await t.create('HDB', [{ description: 'Dịch vụ', accountCode: '5113', amountCurrency: '10000000', taxCodes: ['V10'] }]);
    const origId = await t.einvoice(base.id);
    const ggb = await t.create('GGB', [{ description: 'Giảm giá', accountCode: '5113', amountCurrency: '1000000', taxCodes: ['V10'] }], { adjustsInvoiceId: base.invoices[0]!.id });
    const adjId = await t.einvoice(ggb.id, { relation: 'adjustment', originalId: origId, adjustKind: 'increase' });
    await expect(t.build(adjId)).rejects.toMatchObject({ code: 'EINVOICE_ORIGINAL_NOT_ISSUED' });
    await sql`UPDATE einvoice SET status = 'issued', invoice_no = '0000042', issue_date = '2026-03-10', provider_ref = '{"k":1}' WHERE id = ${origId}`.execute(t.admin);
    const doc = await t.build(adjId);
    expect(doc.relation).toMatchObject({ kind: 'adjustment', adjust: 'decrease', original: { formNo: '1', serial: 'C26TAA', invoiceNo: '0000042', issueDate: '2026-03-10', providerRef: { k: 1 } } });
    expect(doc.totals.total).toBe('1100000');
  });
});
