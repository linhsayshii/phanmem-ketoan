import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { MONEY_RE, parseInvoiceXml, stripBom, type InvoiceWarning, type ParsedInvoice } from './parseXml.js';
import { taxCheckWarnings, type TaxLookupResult } from './taxCodeLookup.js';
import { normTaxCode } from './verify.js';

export interface StoreMeta { receivedBy?: string | null; apiKeyId?: string | null; parsed?: ParsedInvoice; taxCheck?: TaxLookupResult | { error: string } | null }
export interface StoreResult { id: number; status: 'new' | 'duplicate'; existing?: number }

// Parser đã loại số sai dạng/quá cột (null + blocked); ở đây chỉ đề phòng thêm, không bao giờ đổi số hỏng thành 0.
const QTY_RE = /^-?\d{1,16}(\.\d{1,6})?$/;
const FX_RE = /^\d{1,10}(\.\d{1,10})?$/;
const pick = (s: string | null, re: RegExp): string | null => (s !== null && re.test(s) ? s : null);
export const sha256Of = (xml: string): string => createHash('sha256').update(stripBom(xml), 'utf8').digest('hex');

// Lưu hóa đơn đầu vào. Trùng băm SHA-256 của XML → trả bản cũ, không chèn. Trùng (MST người bán, ký hiệu, số) với hóa đơn đầu vào khác → chèn với status 'duplicate'.
// Trùng với hóa đơn mua đã nhập thành chứng từ → vẫn nhận, kèm cảnh báo VOUCHER_EXISTS. Không MST người bán thì không so khóa (dễ trùng nhầm), chỉ so băm.
export async function storeInbound(trx: Transaction<Database>, ctx: { tenantId: string }, rawXml: string, source: 'upload' | 'api' | 'email', meta: StoreMeta = {}): Promise<StoreResult> {
  const xml = stripBom(rawXml); const sha = sha256Of(xml);
  await sql`SELECT pg_advisory_xact_lock(hashtext('inbound_invoice'), hashtext(${ctx.tenantId}))`.execute(trx);
  const same = await trx.selectFrom('inbound_invoice').select('id').where('xml_sha256', '=', sha).executeTakeFirst();
  if (same) return { id: same.id, status: 'duplicate', existing: same.id };

  const p = meta.parsed ?? parseInvoiceXml(xml);
  const warnings: InvoiceWarning[] = [...p.warnings];
  const tenant = await trx.selectFrom('tenant').select('tax_code').where('id', '=', ctx.tenantId).executeTakeFirstOrThrow();
  let buyerMatches: boolean | null = null;
  if (p.buyer.taxCode && tenant.tax_code) {
    buyerMatches = normTaxCode(p.buyer.taxCode) === normTaxCode(tenant.tax_code);
    if (!buyerMatches) warnings.push({ code: 'BUYER_MISMATCH', message: `MST người mua (${p.buyer.taxCode}) khác MST công ty (${tenant.tax_code})` });
  }

  let duplicateOf: number | null = null; let partyId: string | null = null;
  const mst = p.seller.taxCode;
  if (mst) {
    const key = sql<string>`fn_invoice_key(${mst})`;
    const dup = await trx.selectFrom('inbound_invoice').select('id')
      .where(sql<string>`fn_invoice_key(seller_tax_code)`, '=', key).where(sql<string>`fn_invoice_key(serial)`, '=', sql<string>`fn_invoice_key(${p.serial})`)
      .where(sql<string>`fn_invoice_key(invoice_no)`, '=', sql<string>`fn_invoice_key(${p.invoiceNo})`).where('status', '<>', 'duplicate').orderBy('id').limit(1).executeTakeFirst();
    duplicateOf = dup?.id ?? null;
    const vi = await trx.selectFrom('voucher_invoice as vi').innerJoin('voucher as v', (j) => j.onRef('v.tenant_id', '=', 'vi.tenant_id').onRef('v.id', '=', 'vi.voucher_id'))
      .select(['v.id as voucher_id', 'v.voucher_no', 'v.voucher_type']).where('vi.direction', '=', 'purchase').where('v.state', 'in', ['draft', 'posted'])
      .where(sql<string>`fn_invoice_key(vi.party_tax_code)`, '=', key).where(sql<string>`fn_invoice_key(vi.serial)`, '=', sql<string>`fn_invoice_key(${p.serial})`)
      .where(sql<string>`fn_invoice_key(vi.invoice_no)`, '=', sql<string>`fn_invoice_key(${p.invoiceNo})`).orderBy('v.created_at').limit(1).executeTakeFirst();
    if (vi) warnings.push({ code: 'VOUCHER_EXISTS', message: `Hóa đơn này đã được nhập thành chứng từ ${vi.voucher_no ?? '(nháp)'}`, voucherId: vi.voucher_id, voucherNo: vi.voucher_no });
    const parties = await trx.selectFrom('party').select('id').where(sql<string>`fn_invoice_key(tax_code)`, '=', key).where('is_active', '=', true).limit(2).execute();
    if (parties.length === 1) partyId = parties[0]!.id;
  }
  if (meta.taxCheck) warnings.push(...taxCheckWarnings(p.seller.name, meta.taxCheck));

  const row = await trx.insertInto('inbound_invoice').values({
    tenant_id: ctx.tenantId, source, received_by: meta.receivedBy ?? null, api_key_id: meta.apiKeyId ?? null, xml, xml_sha256: sha,
    form_no: p.formNo, serial: p.serial, invoice_no: p.invoiceNo, issue_date: p.issueDate, seller_tax_code: mst, seller_name: p.seller.name, seller_address: p.seller.address,
    buyer_tax_code: p.buyer.taxCode, buyer_name: p.buyer.name, currency: p.currency, fx_rate: pick(p.fxRate, FX_RE),
    total_before_tax: pick(p.totals.beforeTax, MONEY_RE), total_tax: pick(p.totals.tax, MONEY_RE), total: pick(p.totals.total, MONEY_RE), cqt_code: p.cqtCode,
    seller_sig: p.signatures.seller ? JSON.stringify(p.signatures.seller) : null, cqt_sig: p.signatures.cqt ? JSON.stringify(p.signatures.cqt) : null,
    buyer_matches: buyerMatches, blocked: p.blocked, tax_code_check: meta.taxCheck ? JSON.stringify(meta.taxCheck) : null, warnings: JSON.stringify(warnings),
    status: duplicateOf ? 'duplicate' : 'new', duplicate_of: duplicateOf, party_id: partyId,
  }).returning('id').executeTakeFirstOrThrow();
  if (p.lines.length) {
    await trx.insertInto('inbound_invoice_line').values(p.lines.map((l) => ({
      tenant_id: ctx.tenantId, invoice_id: row.id, line_no: l.lineNo, kind: l.kind, code: l.code, name: l.name || '(không tên)', uom: l.uom,
      quantity: pick(l.quantity, QTY_RE), unit_price: pick(l.unitPrice, QTY_RE), discount_amount: pick(l.discountAmount, MONEY_RE), amount: pick(l.amount, MONEY_RE), tax_rate: l.taxRate,
    }))).execute();
  }
  return duplicateOf ? { id: row.id, status: 'duplicate', existing: duplicateOf } : { id: row.id, status: 'new' };
}
