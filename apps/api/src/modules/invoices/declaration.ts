import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { TAX_CODE_RE, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';

// Kê khai hóa đơn (bảng voucher_invoice): dùng chung cho hóa đơn dịch vụ (/api/invoices) và hóa đơn đầu vào trả tiền ngay trên PC, BN, PKT (không sinh bút toán, chỉ lưu để kê khai).
// Tệp này không import vouchers.service để tránh vòng phụ thuộc (vouchers.service dựng lược đồ zod khi nạp mô-đun).
type Trx = Transaction<Database>;

// Loại chứng từ tiền, phiếu kế toán được kèm hóa đơn đầu vào đã trả ngay; hóa đơn mua chưa trả lập ở HDM. Chi phí mua hàng (CPM) kèm hóa đơn của dịch vụ vận chuyển, bốc xếp...
export const DECLARING_TYPES: readonly string[] = ['PC', 'BN', 'PKT', 'CPM'];

const optText = (max: number) => z.string().max(max).nullable().optional();
// Ghi đè thông tin đối tượng trên hóa đơn: mã số thuế đúng định dạng danh mục; chuỗi rỗng hoặc null là không ghi đè.
export const partyOverride = {
  partyTaxCode: z.string().trim().regex(TAX_CODE_RE, 'Mã số thuế gồm 10 số hoặc 10 số-3 số').or(z.literal('')).nullable().optional(), partyName: optText(300), partyAddress: optText(500),
};
export const voucherInvoiceInput = z.object({
  formNo: optText(20), serial: optText(20), invoiceNo: z.string().trim().min(1).max(30), invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partyCode: z.string().nullable().optional(), // bỏ trống: lấy đối tượng của chứng từ
  invoiceGroupCode: z.string().min(1), taxCode: z.string().min(1),
  baseAmount: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG), taxAmount: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG),
  isImport: z.boolean().optional(), note: optText(500), ...partyOverride,
});
export type VoucherInvoiceInput = z.infer<typeof voucherInvoiceInput>;

export interface VoucherInvoiceDto {
  id: number; direction: 'purchase' | 'sale'; formNo: string | null; serial: string | null; invoiceNo: string | null; einvoicePending: boolean; einvoiceSeriesId: number | null; invoiceDate: string;
  partyCode: string | null; partyName: string | null; partyTaxCode: string | null; partyAddress: string | null; invoiceGroupCode: string | null; headerGroupCode: string | null; taxCode: string | null;
  baseAmount: string; taxAmount: string; isImport: boolean; adjustsInvoiceId: number | null; declareYear: number | null; declarePeriod: number | null; note: string | null;
}

// Dòng sẵn sàng ghi: đã đổi mã sang id.
export interface InvoiceRow {
  direction: 'purchase' | 'sale'; formNo: string | null | undefined; serial: string | null | undefined; invoiceNo: string | null; invoiceDate: string; partyId: string | null;
  einvoiceSeriesId?: number | null; // có: hóa đơn bán chờ số (invoiceNo null), số do nhà cung cấp hóa đơn điện tử cấp sau
  invoiceGroupId: number | null; headerGroupId?: number | null; taxCodeId: number | null; baseAmount: string; taxAmount: string; isImport?: boolean | undefined; adjustsInvoiceId?: number | null; note?: string | null | undefined;
  // Ghi đè thông tin đối tượng trên hóa đơn (bỏ trống: lấy từ danh mục); kiểm trùng và khóa tư vấn dùng mã số thuế đã ghi đè.
  partyTaxCode?: string | null | undefined; partyName?: string | null | undefined; partyAddress?: string | null | undefined;
}

// Kỳ kê khai chứa ngày hóa đơn: tháng 1-12, hoặc quý 1-4 theo cài đặt vat_period của công ty.
export function declarePeriod(invoiceDate: string, vatPeriod: 'month' | 'quarter'): { year: number; period: number } {
  const month = Number(invoiceDate.slice(5, 7));
  return { year: Number(invoiceDate.slice(0, 4)), period: vatPeriod === 'month' ? month : Math.ceil(month / 3) };
}

const blank = (s: string | null | undefined): string | null => (s?.trim() ? s.trim() : null);
type PartySnap = { name: string; tax_code: string | null; address: string | null };
// Thông tin đối tượng hiệu lực của dòng hóa đơn: giá trị ghi đè nếu có, không thì danh mục.
const effectiveParty = (r: InvoiceRow, p: PartySnap | undefined) => ({ name: blank(r.partyName) ?? p?.name ?? null, taxCode: blank(r.partyTaxCode) ?? p?.tax_code ?? null, address: blank(r.partyAddress) ?? p?.address ?? null });

// Khóa kiểm trùng của một hóa đơn đầu vào, cùng chuẩn hóa với chỉ mục (fn_invoice_key): người bán không có mã số thuế thì thêm đối tượng.
async function duplicateKey(trx: Trx, tenantId: string, r: InvoiceRow, partyTaxCode: string | null): Promise<string> {
  const k = await sql<{ key: string }>`SELECT ${tenantId}::text || ':' || fn_invoice_key(${partyTaxCode}) || ':' || fn_invoice_key(${blank(r.serial)}) || ':' || fn_invoice_key(${r.invoiceNo})
    || CASE WHEN fn_invoice_key(${partyTaxCode}) = '' THEN ':' || COALESCE(${r.partyId}::text, '') ELSE '' END AS key`.execute(trx);
  return k.rows[0]!.key;
}

// Hóa đơn đầu vào trùng: cùng chiều mua, cùng mã số thuế người bán, ký hiệu và số hóa đơn (so không phân biệt hoa thường, bỏ mọi khoảng trắng, bằng fn_invoice_key trùng với chỉ mục).
// Chứng từ đã hủy hoặc đã đảo (chứng từ đảo không mang dòng kê khai) không chặn: nhập lại hóa đơn đó là hợp lệ; nháp chặn. Người bán không có mã số thuế thì so thêm cùng đối tượng.
// Nhiều dòng cùng hóa đơn khác mã thuế trong một chứng từ là hợp lệ; cùng mã thuế hai lần thì trùng. insertInvoiceRows đã khóa tư vấn khóa hóa đơn trước khi gọi.
async function assertNotDuplicate(trx: Trx, tenantId: string, voucherId: string, r: InvoiceRow, partyTaxCode: string | null): Promise<void> {
  const hit = await sql<{ voucher_id: string; voucher_no: string | null; voucher_type: string }>`
    SELECT v.id AS voucher_id, v.voucher_no, v.voucher_type FROM voucher_invoice vi JOIN voucher v ON v.tenant_id = vi.tenant_id AND v.id = vi.voucher_id
    WHERE vi.tenant_id = ${tenantId}::uuid AND vi.direction = 'purchase' AND v.state NOT IN ('cancelled', 'reversed')
      AND fn_invoice_key(vi.party_tax_code) = fn_invoice_key(${partyTaxCode}) AND fn_invoice_key(vi.serial) = fn_invoice_key(${blank(r.serial)}) AND fn_invoice_key(vi.invoice_no) = fn_invoice_key(${r.invoiceNo})
      AND (fn_invoice_key(${partyTaxCode}) <> '' OR vi.party_id IS NOT DISTINCT FROM ${r.partyId}::uuid)
      AND (vi.voucher_id <> ${voucherId}::uuid OR vi.tax_code_id IS NOT DISTINCT FROM ${r.taxCodeId}::bigint)
    LIMIT 1`.execute(trx);
  const h = hit.rows[0];
  if (!h) return;
  const label = [blank(r.formNo), blank(r.serial), r.invoiceNo].filter(Boolean).join(' ');
  if (h.voucher_id === voucherId) throw new AppError('INVOICE_DUPLICATE', `Hóa đơn ${label} khai báo hai lần trong cùng chứng từ`, 409);
  // details: màn hình mở chứng từ đã nhập bằng id, không phân tích thông báo; voucherNo null là bản nháp chưa có số.
  throw new AppError('INVOICE_DUPLICATE', `Hóa đơn ${label} đã nhập ở chứng từ ${h.voucher_no ?? `nháp (${h.voucher_type})`}`, 409,
    { voucherId: h.voucher_id, voucherNo: h.voucher_no, voucherType: h.voucher_type });
}

// Ghi các dòng kê khai của một chứng từ nháp: chụp tên, mã số thuế, địa chỉ đối tượng tại thời điểm lập, tính kỳ kê khai, kiểm trùng hóa đơn đầu vào.
export async function insertInvoiceRows(trx: Trx, tenantId: string, voucherId: string, rows: InvoiceRow[]): Promise<void> {
  if (!rows.length) return;
  const { vat_period: vatPeriod } = await getSettings(trx, tenantId);
  const parties = new Map<string, PartySnap>();
  for (const id of new Set(rows.flatMap((r) => (r.partyId ? [r.partyId] : [])))) {
    const p = await trx.selectFrom('party').select(['name', 'tax_code', 'address']).where('id', '=', id).executeTakeFirstOrThrow();
    parties.set(id, p);
  }
  // Khóa tư vấn theo khóa hóa đơn, mọi khóa trước khi kiểm tra và theo thứ tự khóa: hai yêu cầu đồng thời không cùng qua kiểm tra, và hai chứng từ khai chung hai hóa đơn ngược thứ tự không chờ nhau thành vòng (deadlock).
  const keys = new Set<string>();
  for (const r of rows) if (r.direction === 'purchase') keys.add(await duplicateKey(trx, tenantId, r, effectiveParty(r, r.partyId ? parties.get(r.partyId) : undefined).taxCode));
  for (const key of [...keys].sort()) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'invoice_duplicate:' + key}, 0))`.execute(trx);
  for (const r of rows) {
    const p = effectiveParty(r, r.partyId ? parties.get(r.partyId) : undefined);
    if (r.direction === 'purchase') await assertNotDuplicate(trx, tenantId, voucherId, r, p.taxCode);
    const d = declarePeriod(r.invoiceDate, vatPeriod);
    await trx.insertInto('voucher_invoice').values({
      tenant_id: tenantId, voucher_id: voucherId, direction: r.direction, form_no: blank(r.formNo), serial: blank(r.serial), invoice_no: r.invoiceNo, einvoice_series_id: r.einvoiceSeriesId ?? null, einvoice_pending: r.invoiceNo === null, invoice_date: r.invoiceDate,
      party_id: r.partyId, party_name: p.name, party_tax_code: p.taxCode, party_address: p.address, invoice_group_id: r.invoiceGroupId, header_group_id: r.headerGroupId ?? r.invoiceGroupId, tax_code_id: r.taxCodeId,
      base_amount: r.baseAmount, tax_amount: r.taxAmount, is_import: r.isImport ?? false, adjusts_invoice_id: r.adjustsInvoiceId ?? null, declare_year: d.year, declare_period: d.period, declare_period_kind: vatPeriod, note: blank(r.note),
    }).execute();
  }
}

export async function deleteInvoiceRows(trx: Trx, voucherId: string): Promise<void> {
  await trx.deleteFrom('voucher_invoice').where('voucher_id', '=', voucherId).execute();
}

export async function listInvoiceRows(trx: Trx, voucherId: string): Promise<VoucherInvoiceDto[]> {
  const rows = await trx.selectFrom('voucher_invoice as i').leftJoin('party as p', 'p.id', 'i.party_id').leftJoin('invoice_group as g', 'g.id', 'i.invoice_group_id').leftJoin('invoice_group as h', 'h.id', 'i.header_group_id').leftJoin('tax_code as t', 't.id', 'i.tax_code_id')
    .select(['i.id', 'i.direction', 'i.form_no', 'i.serial', 'i.invoice_no', 'i.einvoice_pending', 'i.einvoice_series_id', 'i.invoice_date', 'p.code as party_code', 'i.party_name', 'i.party_tax_code', 'i.party_address', 'g.code as group_code', 'h.code as header_group_code', 't.code as tax_code',
      'i.base_amount', 'i.tax_amount', 'i.is_import', 'i.adjusts_invoice_id', 'i.declare_year', 'i.declare_period', 'i.note'])
    .where('i.voucher_id', '=', voucherId).orderBy('i.id').execute();
  return rows.map((r) => ({ id: r.id, direction: r.direction as 'purchase' | 'sale', formNo: r.form_no, serial: r.serial, invoiceNo: r.invoice_no, einvoicePending: r.einvoice_pending, einvoiceSeriesId: r.einvoice_series_id, invoiceDate: r.invoice_date, partyCode: r.party_code, partyName: r.party_name,
    partyTaxCode: r.party_tax_code, partyAddress: r.party_address, invoiceGroupCode: r.group_code, headerGroupCode: r.header_group_code, taxCode: r.tax_code, baseAmount: r.base_amount, taxAmount: r.tax_amount, isImport: r.is_import,
    adjustsInvoiceId: r.adjusts_invoice_id, declareYear: r.declare_year, declarePeriod: r.declare_period, note: r.note }));
}

// Tra mã sang id cho hóa đơn đầu vào khai trên PC/BN/PKT: nhóm hóa đơn phải thuộc chiều mua, mã thuế phải có.
export async function resolveDeclared(trx: Trx, items: VoucherInvoiceInput[], voucherPartyId: string | null): Promise<InvoiceRow[]> {
  const rows: InvoiceRow[] = [];
  for (const [i, x] of items.entries()) {
    const group = await trx.selectFrom('invoice_group').select('id').where('scope', '=', 'purchase').where('code', '=', x.invoiceGroupCode).executeTakeFirst();
    if (!group) throw new AppError('LOOKUP_NOT_FOUND', `Hóa đơn ${i + 1}: không có nhóm hóa đơn mua mã "${x.invoiceGroupCode}"`, 404);
    const tax = await trx.selectFrom('tax_code').select('id').where('code', '=', x.taxCode).executeTakeFirst();
    if (!tax) throw new AppError('LOOKUP_NOT_FOUND', `Hóa đơn ${i + 1}: không có mã thuế "${x.taxCode}"`, 404);
    let partyId = voucherPartyId;
    if (x.partyCode) {
      const p = await trx.selectFrom('party').select('id').where('code', '=', x.partyCode).executeTakeFirst();
      if (!p) throw new AppError('LOOKUP_NOT_FOUND', `Hóa đơn ${i + 1}: không có đối tượng mã "${x.partyCode}"`, 404);
      partyId = p.id;
    }
    rows.push({ direction: 'purchase', formNo: x.formNo, serial: x.serial, invoiceNo: x.invoiceNo, invoiceDate: x.invoiceDate, partyId, invoiceGroupId: group.id, taxCodeId: tax.id,
      baseAmount: x.baseAmount, taxAmount: x.taxAmount, isImport: x.isImport, note: x.note, partyTaxCode: x.partyTaxCode, partyName: x.partyName, partyAddress: x.partyAddress });
  }
  return rows;
}
