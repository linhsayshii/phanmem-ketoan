import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { buildInvoiceLedgerDetail, computeTaxes, D, toVnd, type Decimal, VND_AMOUNT_MSG, VND_AMOUNT_RE, voucherTypeDef, type TaxDef, type TaxResult } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { createInvoiceVoucher, dateIso, fxRate, getVoucher, updateInvoiceDraft, type LineInput, type VoucherDto, type VoucherInput } from '../ledger/vouchers.service.js';
import { deleteInvoiceRows, insertInvoiceRows, partyOverride, type InvoiceRow } from './declaration.js';
import { resolvePurchase, type PurchaseLine } from './purchase.js';
import { applyExportMode, resolveSale } from './sales.js';

type Trx = Transaction<Database>;

const foreignAmount = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền không hợp lệ');
const optText = (max: number) => z.string().max(max).nullable().optional();
// Dòng hàng hóa, dịch vụ. amountCurrency là tiền hàng trước chiết khấu theo loại tiền của hóa đơn (VND: đồng nguyên); discountCurrency là chiết khấu (số tiền);
// discountRate, quantity, unitPrice, uomCode chỉ để lưu và in, không tham gia tính tiền.
// Hóa đơn mua hàng hóa (MH) và trả lại, giảm giá hàng mua (TLM): dòng có itemCode là dòng hàng (tài khoản kho do hệ thống chọn, accountCode bỏ trống), kho, lô theo phiếu nhập kho;
// sourceLineId: dòng phiếu nhập (MH hàng về trước, chọn dòng cụ thể) hoặc dòng hóa đơn/phiếu nhập gốc (TLM).
export const invoiceItemInput = z.object({
  description: optText(500), accountCode: z.string().min(1).optional(), amountCurrency: foreignAmount, discountCurrency: foreignAmount.default('0'), taxCodes: z.array(z.string().min(1)).max(5).default([]),
  departmentCode: optText(50), projectCode: optText(50), costItemCode: optText(50),
  quantity: foreignAmount.optional(), unitPrice: foreignAmount.optional(), uomCode: optText(50),
  discountRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).refine((s) => Number(s) <= 100, 'Tỷ lệ chiết khấu tối đa 100%').optional(),
  itemCode: z.string().min(1).nullable().optional(), warehouseCode: z.string().min(1).nullable().optional(), lotNo: optText(50), mfgDate: dateIso.nullable().optional(), expiryDate: dateIso.nullable().optional(),
  sourceLineId: z.number().int().positive().optional(),
  // Hàng nhập khẩu (chỉ dòng hàng của MH): thuế nhập khẩu, tiêu thụ đặc biệt, GTGT hàng nhập theo tờ khai hải quan (VND, nhập tay; không có biểu thuế), vatImportCode là mã thuế GTGT của số thuế đó.
  importMode: z.boolean().optional(), importTax: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).optional(), specialConsumptionTax: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).optional(),
  vatImport: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).optional(), vatImportCode: z.string().min(1).optional(),
  vatImportBase: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).optional(), // giá tính thuế GTGT hàng nhập theo tờ khai (CIF quy đổi theo tỷ giá hải quan + NK + TTĐB); trống: hàng VND + NK + TTĐB
});
export const invoiceHeaderInput = z.object({
  formNo: optText(20), serial: optText(20), invoiceNo: z.string().trim().min(1).max(30), invoiceDate: dateIso, invoiceGroupCode: z.string().min(1), isImport: z.boolean().optional(),
  employeeCode: z.string().min(1).optional(), // nhân viên bán hàng: ghi lên mọi dòng sổ cái của chứng từ, báo cáo bán hàng nhóm theo nhân viên lấy dòng đầu có nhân viên
  ...partyOverride, // ghi đè thông tin đối tượng trên hóa đơn (bỏ trống: lấy từ danh mục)
  adjustsInvoiceId: z.number().int().positive().optional(), // bắt buộc với giảm giá, trả lại (GGB, GGM): dòng của hóa đơn gốc
  declaredTax: z.record(z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG)).optional(), // thuế GTGT ghi trên hóa đơn theo mã thuế (VND), lệch số tính theo dòng thì dồn vào dòng thuế lớn nhất
});
export const invoiceInput = z.object({
  voucherType: z.enum(['HDB', 'HDM', 'GGB', 'GGM', 'MH', 'TLM', 'BH', 'TLB']), postingDate: dateIso, documentDate: dateIso, partyCode: z.string().min(1), counterAccountCode: z.string().min(1).optional(),
  currencyCode: z.string().length(3).default('VND'), fxRate: fxRate.optional(), dueDate: dateIso.nullable().optional(), description: z.string().nullable().optional(),
  items: z.array(invoiceItemInput).min(1).max(500, 'Tối đa 500 dòng mỗi hóa đơn'), invoice: invoiceHeaderInput, idempotencyKey: z.string().max(100).optional(),
  stockMode: z.enum(['through_stock', 'goods_first', 'invoice_first']).optional(), receiptVoucherIds: z.array(z.string().uuid()).max(100).optional(), // chỉ MH: cách nhận hàng
  exportMode: z.boolean().optional(), // chỉ BH, TLB: hóa đơn xuất khẩu, thuế GTGT 0%
});
export type InvoiceInput = z.infer<typeof invoiceInput>;

export interface ItemLineDto {
  lineNo: number; description: string | null; quantity: string | null; unitPrice: string | null; uomCode: string | null; amountCurrency: string; amount: string; discountRate: string;
  discountAmountCurrency: string; discountAmount: string; taxCodes: string[]; taxAmount: string; accountCode: string; departmentCode: string | null; projectCode: string | null; costItemCode: string | null;
  id: number; itemCode: string | null; warehouseCode: string | null; lotNo: string | null; mfgDate: string | null; expiryDate: string | null; receiptVoucherId: string | null; linkLineId: number | null;
  importMode: boolean; importTax: string | null; specialConsumptionTax: string | null; vatImport: string | null; vatImportCode: string | null; vatImportBase: string | null;
}
export type InvoiceDto = VoucherDto & { items: ItemLineDto[]; receiptState: string | null; warnings?: { code: string; message: string; lineNo?: number }[] };

const NOT_DRAFT = 'chứng từ không còn là nháp, hãy bỏ ghi sổ (nếu đã ghi sổ) để sửa hóa đơn';
const addDays = (iso: string, days: number): string => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);

async function itemsOf(trx: Trx, voucherId: string): Promise<ItemLineDto[]> {
  const rows = await trx.selectFrom('voucher_item_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('uom as u', 'u.id', 'l.uom_id').leftJoin('department as d', 'd.id', 'l.department_id')
    .leftJoin('project as p', 'p.id', 'l.project_id').leftJoin('cost_item as c', 'c.id', 'l.cost_item_id')
    .leftJoin('item as it', 'it.id', 'l.item_id').leftJoin('warehouse as w', 'w.id', 'l.warehouse_id')
    .select(['l.id', 'l.line_no', 'l.description', 'l.quantity', 'l.unit_price', 'u.code as uom_code', 'l.amount_currency', 'l.amount', 'l.discount_rate', 'l.discount_amount_currency', 'l.discount_amount', 'l.tax_codes', 'l.tax_amount',
      'a.code as account_code', 'd.code as department_code', 'p.code as project_code', 'c.code as cost_item_code', 'it.code as item_code', 'w.code as wh_code', 'l.lot_no', 'l.mfg_date', 'l.expiry_date',
      'l.receipt_voucher_id', 'l.link_line_id', 'l.import_mode', 'l.import_tax', 'l.excise_tax', 'l.import_vat', 'l.import_vat_code', 'l.import_vat_base'])
    .where('l.voucher_id', '=', voucherId).orderBy('l.line_no').execute();
  return rows.map((r) => ({ lineNo: r.line_no, description: r.description, quantity: r.quantity, unitPrice: r.unit_price, uomCode: r.uom_code, amountCurrency: r.amount_currency, amount: r.amount, discountRate: r.discount_rate,
    discountAmountCurrency: r.discount_amount_currency, discountAmount: r.discount_amount, taxCodes: r.tax_codes, taxAmount: r.tax_amount, accountCode: r.account_code, departmentCode: r.department_code,
    projectCode: r.project_code, costItemCode: r.cost_item_code, id: r.id, itemCode: r.item_code, warehouseCode: r.wh_code, lotNo: r.lot_no, mfgDate: r.mfg_date, expiryDate: r.expiry_date,
    receiptVoucherId: r.receipt_voucher_id, linkLineId: r.link_line_id,
    importMode: r.import_mode, importTax: r.import_tax, specialConsumptionTax: r.excise_tax, vatImport: r.import_vat, vatImportCode: r.import_vat_code, vatImportBase: r.import_vat_base }));
}

// Chứng từ phải là loại hóa đơn (HDB, HDM, GGB, GGM), nếu không thì coi như không có hóa đơn.
export async function getInvoice(trx: Trx, id: string): Promise<InvoiceDto> {
  const v = await getVoucher(trx, id);
  if (!voucherTypeDef(v.voucherType)?.hasItems) throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn', 404);
  const rs = await trx.selectFrom('voucher').select('receipt_state').where('id', '=', id).executeTakeFirstOrThrow();
  return { ...v, items: await itemsOf(trx, id), receiptState: rs.receipt_state };
}

// Mã thuế và phân bổ của chúng, dạng động cơ thuế dùng. Mã không có trong danh mục để động cơ báo TAX_CODE_UNKNOWN. scopes: phạm vi dùng của mã (sale, purchase, both).
// codes bỏ trống: nạp mọi mã (danh mục cho màn hình hóa đơn, xem listTaxDefs); rows là các dòng tax_code đã nạp.
async function loadTaxDefs(trx: Trx, codes?: string[]) {
  const defs: Record<string, TaxDef> = {}; const ids = new Map<string, number>(); const scopes = new Map<string, string>();
  if (codes && !codes.length) return { defs, ids, scopes, rows: [] };
  let q = trx.selectFrom('tax_code').select(['id', 'code', 'name', 'kind', 'rate', 'method', 'price_include', 'scope', 'is_active']);
  if (codes) q = q.where('code', 'in', codes);
  const rows = await q.orderBy('code').execute();
  const dists = rows.length ? await trx.selectFrom('tax_distribution').select(['tax_code_id', 'document_type', 'scope', 'line_type', 'factor_percent', 'account_code', 'report_tag']).where('tax_code_id', 'in', rows.map((r) => r.id)).execute() : [];
  for (const r of rows) {
    ids.set(r.code, r.id); scopes.set(r.code, r.scope);
    defs[r.code] = { code: r.code, kind: r.kind as TaxDef['kind'], method: r.method as TaxDef['method'], rate: r.rate, priceInclude: r.price_include,
      distributions: dists.filter((d) => d.tax_code_id === r.id).map((d) => ({ documentType: d.document_type as 'invoice' | 'refund', scope: d.scope as 'sale' | 'purchase', lineType: d.line_type as 'base' | 'tax',
        factorPercent: d.factor_percent, accountCode: d.account_code, reportTag: d.report_tag })) };
  }
  return { defs, ids, scopes, rows };
}

// Danh mục mã thuế kèm phân bổ cho màn hình hóa đơn: trình duyệt xem trước thuế và bút toán bằng đúng động cơ thuế (@kt/domain) với dữ liệu này.
export interface TaxDefRow { code: string; name: string; scope: 'sale' | 'purchase' | 'both'; isActive: boolean; def: TaxDef }
export async function listTaxDefs(trx: Trx): Promise<TaxDefRow[]> {
  const { defs, rows } = await loadTaxDefs(trx);
  return rows.map((r) => ({ code: r.code, name: r.name, scope: r.scope as TaxDefRow['scope'], isActive: r.is_active, def: defs[r.code]! }));
}

// Mã dùng gom dòng kê khai: mã GTGT của dòng (tối đa một, buildInvoice đã chặn nhiều mã); không có thì mã thuế đầu tiên không phải TNCN (thuế nhập khẩu, TTĐB); không có nữa thì null (dòng không thuế).
const groupOf = (codes: string[], defs: Record<string, TaxDef>): string | null =>
  codes.find((c) => defs[c]?.kind === 'vat') ?? codes.find((c) => defs[c] && defs[c]!.kind !== 'pit') ?? null;

const voucherTypeIsPurchase = (t: string): boolean => t === 'MH' || t === 'TLM';
const voucherTypeIsSale = (t: string): boolean => t === 'BH' || t === 'TLB';
const vndText = (cur: string, rate: string | null): string => (rate === null ? cur : toVnd(cur, rate));

type Auth = { sensitive: Set<string>; permissions: Set<string> };
interface Built { voucher: VoucherInput & { receiptState?: string }; regime: string; postItems: (voucherId: string) => Promise<void>; warnings: NonNullable<InvoiceDto['warnings']> }

// Dựng toàn bộ hóa đơn từ đầu vào: tính thuế, bút toán, dòng hàng và dòng kê khai. Chưa ghi gì; postItems ghi dòng hàng và dòng kê khai sau khi chứng từ đã có id.
async function buildInvoice(trx: Trx, tenantId: string, input0: InvoiceInput, opt: { auth?: Auth; selfId?: string; perm: string }): Promise<Built> {
  const input = await applyExportMode(trx, input0);
  const def = voucherTypeDef(input.voucherType)!;
  const scope = def.invoiceDirection!; const documentType = def.refund ? 'refund' : 'invoice';
  const isVnd = input.currencyCode === 'VND';
  if (def.refund && input.invoice.adjustsInvoiceId === undefined) throw new AppError('VALIDATION', `${def.name}: phải chỉ rõ hóa đơn gốc (adjustsInvoiceId)`, 400);
  if (!def.refund && input.invoice.adjustsInvoiceId !== undefined) throw new AppError('VALIDATION', `${def.name} không điều chỉnh hóa đơn khác (adjustsInvoiceId chỉ dùng cho giảm giá, trả lại)`, 400);
  for (const [i, it] of input.items.entries()) {
    if (isVnd && !(VND_AMOUNT_RE.test(it.amountCurrency) && VND_AMOUNT_RE.test(it.discountCurrency))) throw new AppError('VALIDATION', `Dòng ${i + 1}: ${VND_AMOUNT_MSG}`, 400);
    if (D(it.discountCurrency).gt(it.amountCurrency)) throw new AppError('VALIDATION', `Dòng ${i + 1}: chiết khấu lớn hơn tiền hàng`, 400);
  }

  const party = await trx.selectFrom('party').select(['id', 'payment_term_days', 'default_account_code']).where('code', '=', input.partyCode).executeTakeFirst();
  if (!party) throw new AppError('LOOKUP_NOT_FOUND', `Không có đối tượng mã "${input.partyCode}"`, 404);
  // Công nợ mặc định theo chiều: tài khoản mặc định của đối tượng chỉ được dùng khi đúng nhóm 131 (bán) / 331 (mua); đối tượng vừa là khách vừa là nhà cung cấp có thể mang tài khoản của chiều kia.
  const fallback = scope === 'sale' ? '131' : '331';
  const counterAccountCode = input.counterAccountCode ?? (party.default_account_code?.startsWith(fallback) ? party.default_account_code : fallback);
  // Giảm giá, trả lại là khoản giảm công nợ: không mặc định hạn thanh toán theo đối tượng (tránh hiện quá hạn trên phân tích tuổi nợ)
  const dueDate = input.dueDate !== undefined ? input.dueDate : def.refund || party.payment_term_days === null ? null : addDays(input.documentDate, party.payment_term_days);

  let minorUnit: number | undefined;
  if (!isVnd) {
    const c = await trx.selectFrom('currency').select('minor_unit').where('code', '=', input.currencyCode).executeTakeFirst();
    if (!c) throw new AppError('LOOKUP_NOT_FOUND', `Không có loại tiền "${input.currencyCode}"`, 404);
    minorUnit = c.minor_unit;
  }
  const rate = isVnd ? null : input.fxRate ?? null;
  const regime = (await trx.selectFrom('fiscal_period').select('regime').where('period_no', '>=', 1).where('period_no', '<=', 15).where('date_from', '<=', input.postingDate).where('date_to', '>=', input.postingDate).executeTakeFirst())?.regime;
  if (!regime) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${input.postingDate} không thuộc kỳ kế toán nào đã mở`, 404);
  if (input.exportMode && !voucherTypeIsSale(input.voucherType)) throw new AppError('VALIDATION', 'Xuất khẩu (exportMode) chỉ dùng cho bán hàng hóa và hàng bán bị trả lại', 400);
  if (!voucherTypeIsPurchase(input.voucherType) && !voucherTypeIsSale(input.voucherType)) {
    if (input.stockMode || input.receiptVoucherIds?.length || input.items.some((i) => i.itemCode || i.warehouseCode || i.sourceLineId)) throw new AppError('VALIDATION', `${def.name} không có dòng hàng nhập kho (chỉ dùng cho mua, bán hàng hóa và trả lại)`, 400);
    for (const [k, it] of input.items.entries()) if (!it.accountCode) throw new AppError('VALIDATION', `Dòng ${k + 1}: phải chọn tài khoản`, 400);
  }
  const purchase: Awaited<ReturnType<typeof resolvePurchase>> = voucherTypeIsPurchase(input.voucherType)
    ? await resolvePurchase(trx, { input, regime, counterAccountCode, partyId: party.id, ...(opt.selfId && { selfId: opt.selfId }), ...(opt.auth && { auth: opt.auth }), perm: opt.perm })
    : { lines: input.items.map(() => null), receiptState: null, warnings: [] };
  const sale = voucherTypeIsSale(input.voucherType)
    ? await resolveSale(trx, { input, counterAccountCode, partyId: party.id, rate, ...(opt.selfId && { selfId: opt.selfId }), ...(opt.auth && { auth: opt.auth }), perm: opt.perm }) : null;
  const acctOf = (k: number): string => purchase.lines[k]?.accountCode ?? sale?.lines[k]?.accountCode ?? input.items[k]!.accountCode!;
  const isImp = (k: number): boolean => !!input.items[k]!.importMode;

  const { defs, ids, scopes } = await loadTaxDefs(trx, [...new Set(input.items.flatMap((i) => [...i.taxCodes, ...(i.vatImportCode ? [i.vatImportCode] : [])]))]);
  for (const [k, it] of input.items.entries()) { // nhập khẩu: số thuế theo tờ khai hải quan; GTGT hàng nhập không đi qua mã thuế của dòng (người bán nước ngoài không xuất hóa đơn GTGT)
    const n = k + 1; const any = !!(it.importTax || it.specialConsumptionTax || it.vatImport || it.vatImportCode || it.vatImportBase);
    if (!it.importMode) { if (any) throw new AppError('VALIDATION', `Dòng ${n}: thuế nhập khẩu, TTĐB, GTGT hàng nhập chỉ nhập ở dòng hàng nhập khẩu (importMode)`, 400); continue; }
    if (input.voucherType !== 'MH' || !purchase.lines[k]) throw new AppError('IMPORT_LINE_INVALID', `Dòng ${n}: hàng nhập khẩu chỉ dùng cho dòng hàng hóa của hóa đơn mua hàng hóa`, 400);
    if (it.taxCodes.some((c) => defs[c]?.kind === 'vat')) throw new AppError('IMPORT_LINE_INVALID', `Dòng ${n}: hàng nhập khẩu không ghi mã thuế GTGT trên dòng; nhập thuế GTGT hàng nhập theo tờ khai (vatImport, vatImportCode)`, 400);
    const other = it.taxCodes.filter((c) => defs[c]?.kind === 'import' || defs[c]?.kind === 'excise');
    if (other.length) throw new AppError('IMPORT_LINE_INVALID', `Dòng ${n}: thuế nhập khẩu, TTĐB của hàng nhập khẩu nhập theo số tiền trên tờ khai (importTax, specialConsumptionTax), không ghi mã ${other.join(', ')} trên dòng`, 400);
    if (it.vatImportBase && !it.vatImportCode) throw new AppError('VALIDATION', `Dòng ${n}: giá tính thuế GTGT hàng nhập cần mã thuế GTGT hàng nhập`, 400);
    if (D(it.vatImport ?? '0').gt(0) && !it.vatImportCode) throw new AppError('VALIDATION', `Dòng ${n}: chọn mã thuế GTGT của thuế GTGT hàng nhập`, 400);
    if (it.vatImportCode && defs[it.vatImportCode]?.kind !== 'vat') throw new AppError('IMPORT_LINE_INVALID', `Dòng ${n}: "${it.vatImportCode}" không phải mã thuế GTGT`, 400);
  }
  for (const [code, s] of scopes) if (s !== 'both' && s !== scope) throw new AppError('TAX_SCOPE_MISMATCH', `Mã thuế ${code} chỉ dùng cho hóa đơn ${s === 'sale' ? 'bán ra' : 'mua vào'}, không dùng cho ${def.name}`, 400);
  for (const [k, it] of input.items.entries()) { // một dòng hàng một thuế suất GTGT; TNCN khấu trừ được đi kèm. Bảng kê voucher_invoice gom theo mã GTGT của dòng nên nhiều mã sẽ làm mất thuế của mã sau
    const vats = it.taxCodes.filter((c) => defs[c]?.kind === 'vat');
    if (vats.length > 1) throw new AppError('INVOICE_LINE_MULTIPLE_VAT', `Dòng ${k + 1}: mỗi dòng hàng chỉ được một mã thuế GTGT, đang có ${vats.join(', ')}. Tách thành các dòng hàng riêng theo từng thuế suất`, 400);
  }
  const tax: TaxResult = computeTaxes(input.items.map((it, k) => ({ lineNo: k + 1, amountCurrency: it.amountCurrency, discountCurrency: it.discountCurrency, taxCodes: it.taxCodes })), defs,
    { scope, documentType, currency: input.currencyCode, fxRate: rate, ...(input.invoice.declaredTax && { declaredTaxVnd: input.invoice.declaredTax }), ...(minorUnit !== undefined && { minorUnit }) });
  const detail = buildInvoiceLedgerDetail({ scope, documentType, counterAccountCode, partyCode: input.partyCode, currency: input.currencyCode, fxRate: rate, dueDate, tax,
    ...(input.invoice.declaredTax && { declaredTaxVnd: input.invoice.declaredTax }),
    items: input.items.map((it, k) => ({ lineNo: k + 1, description: it.description ?? null, accountCode: acctOf(k), amountCurrency: it.amountCurrency, discountCurrency: it.discountCurrency, taxCodes: it.taxCodes,
      departmentCode: it.departmentCode ?? null, projectCode: it.projectCode ?? null, costItemCode: it.costItemCode ?? null,
      ...(purchase.lines[k] && { itemCode: purchase.lines[k]!.itemCode, warehouseCode: purchase.lines[k]!.warehouseCode, ...(purchase.lines[k]!.offsetVnd && { offsetVnd: purchase.lines[k]!.offsetVnd }) }) })) });
  if (!detail.lines.length) throw new AppError('INVOICE_EMPTY', 'Hóa đơn không có số tiền nào để hạch toán', 400);

  const lines: (LineInput & { currencyCode?: string })[] = detail.lines.map((l) => ({
    accountCode: l.accountCode, debit: l.debit, credit: l.credit, ...(!isVnd && { amountCurrency: l.amountCurrency, ...(l.fxRate && { fxRate: l.fxRate }) }),
    ...(l.partyCode && { partyCode: l.partyCode }), ...(l.description && { description: l.description }), ...(l.dueDate && { dueDate: l.dueDate }),
    ...(l.departmentCode && { departmentCode: l.departmentCode }), ...(l.projectCode && { projectCode: l.projectCode }), ...(l.costItemCode && { costItemCode: l.costItemCode }),
    ...(l.itemCode && { itemCode: l.itemCode }), ...(l.warehouseCode && { warehouseCode: l.warehouseCode }), ...(input.invoice.employeeCode && { employeeCode: input.invoice.employeeCode }) }));
  // Nhập khẩu: thuế NK Có 3333, TTĐB Có 3332 vào TK của dòng hàng (kho, hoặc 151 khi hóa đơn về trước hàng); GTGT hàng nhập Nợ 1331 / Có 33312. Dòng VND (cả khi hóa đơn ngoại tệ: thuế nộp theo tờ khai bằng đồng).
  const importedVnd = input.items.map(() => D(0));
  for (const [k, it] of input.items.entries()) {
    if (!isImp(k)) continue;
    const pl = purchase.lines[k]!; const vndLine = isVnd ? {} : { currencyCode: 'VND' };
    const stockSide = { itemCode: pl.itemCode, ...(pl.warehouseCode && { warehouseCode: pl.warehouseCode }) };
    for (const [amt, acc, label] of [[it.importTax, '3333', 'Thuế nhập khẩu'], [it.specialConsumptionTax, '3332', 'Thuế tiêu thụ đặc biệt hàng nhập khẩu']] as const) {
      if (!amt || D(amt).isZero()) continue;
      importedVnd[k] = importedVnd[k]!.plus(amt);
      lines.push({ accountCode: acctOf(k), debit: amt, credit: '0', ...stockSide, ...vndLine, description: `${label} dòng ${k + 1}` }, { accountCode: acc, debit: '0', credit: amt, ...vndLine, description: `${label} dòng ${k + 1}` });
    }
    if (it.vatImport && D(it.vatImport).gt(0))
      lines.push({ accountCode: '1331', debit: it.vatImport, credit: '0', ...vndLine, description: `Thuế GTGT hàng nhập khẩu dòng ${k + 1}` }, { accountCode: '33312', debit: '0', credit: it.vatImport, ...vndLine, description: `Thuế GTGT hàng nhập khẩu dòng ${k + 1}` });
  }
  for (const pl of purchase.lines) { // TLM: chi phí mua phân bổ cho số lượng trả rời kho cùng phiếu trả (Nợ 632 / Có TK kho)
    if (!pl?.landedOut) continue;
    lines.push({ accountCode: pl.cogsCode ?? '632', debit: pl.landedOut, credit: '0', description: 'Chi phí mua hàng của hàng trả lại' },
      { accountCode: pl.accountCode, debit: '0', credit: pl.landedOut, itemCode: pl.itemCode, warehouseCode: pl.warehouseCode!, description: 'Chi phí mua hàng của hàng trả lại' });
  }
  if (sale) for (const k of input.items.keys()) lines.push(...sale.costLines[k]!); // giá vốn tạm tính của dòng bán, nhập lại của dòng trả
  const voucher: VoucherInput = { voucherType: input.voucherType, postingDate: input.postingDate, documentDate: input.documentDate, description: input.description ?? null, partyCode: input.partyCode,
    currencyCode: input.currencyCode, ...(rate && { fxRate: rate }), ...(dueDate && { dueDate }), ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }), lines,
    ...(purchase.receiptState && { receiptState: purchase.receiptState }) };

  const postItems = async (voucherId: string) => {
    const lookup = async (table: 'account' | 'department' | 'project' | 'cost_item' | 'uom', code: string | null | undefined, label: string): Promise<number | null> => {
      if (!code) return null;
      const q = trx.selectFrom(table).select('id').where('code', '=', code);
      const r = await (table === 'account' ? q.where('regime' as never, '=', regime as never) : q).executeTakeFirst();
      if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${label} mã "${code}"`, 404);
      return r.id as number;
    };
    // Thuế GTGT (không tính TNCN) từng dòng theo động cơ thuế; ngoại tệ thì bút toán có thể lệch vài đồng (thuế ghi trên hóa đơn, chia chênh làm tròn), phần lệch
    // dồn vào dòng có thuế lớn nhất của mã đó để tổng dòng hàng theo mã khớp bảng kê voucher_invoice và dòng thuế đã ghi sổ.
    const taxOf = input.items.map((_, k) => new Map(tax.lines[k]!.taxes.filter((x) => defs[x.code]!.kind !== 'pit').map((x) => [x.code, D(x.amountVnd)])));
    for (const code of new Set(taxOf.flatMap((m) => [...m.keys()]))) {
      const diff = D(detail.taxVnd[code] ?? 0).minus(taxOf.reduce((acc, m) => acc.plus(m.get(code) ?? 0), D(0)));
      if (diff.isZero()) continue;
      const top = taxOf.reduce((best, m) => ((m.get(code) ?? D(-1)).gt(best.get(code) ?? D(-1)) ? m : best));
      top.set(code, top.get(code)!.plus(diff));
    }
    const itemRows = [];
    for (const [k, it] of input.items.entries()) {
      const pl: PurchaseLine | null = purchase.lines[k] ?? sale?.lines[k] ?? null;
      itemRows.push({
        tenant_id: tenantId, voucher_id: voucherId, line_no: k + 1, description: it.description ?? null, uom_id: await lookup('uom', it.uomCode, 'đơn vị tính'), quantity: it.quantity ?? null, unit_price: it.unitPrice ?? null,
        amount_currency: it.amountCurrency, amount: vndText(it.amountCurrency, rate), discount_rate: it.discountRate ?? '0', discount_amount_currency: it.discountCurrency, discount_amount: vndText(it.discountCurrency, rate),
        tax_codes: it.taxCodes, tax_amount: [...taxOf[k]!.values()].reduce((acc, v) => acc.plus(v), D(0)).toFixed(0),
        account_id: (await lookup('account', acctOf(k), 'tài khoản'))!, department_id: await lookup('department', it.departmentCode, 'bộ phận'), project_id: await lookup('project', it.projectCode, 'vụ việc'),
        cost_item_id: await lookup('cost_item', it.costItemCode, 'khoản mục chi phí'),
        ...pl?.row, ...(pl && !sale && { stock_value: D(detail.baseVnd[k + 1] ?? '0').plus(importedVnd[k]!).toFixed(0) }),
        ...(isImp(k) && { import_mode: true, import_tax: it.importTax ?? null, excise_tax: it.specialConsumptionTax ?? null, import_vat: it.vatImport ?? null, import_vat_code: it.vatImportCode ?? null, import_vat_base: it.vatImportBase ?? null }), ...(pl?.debitCode && { debit_account_id: await lookup('account', pl.debitCode, 'tài khoản') }), ...(pl?.creditCode && { credit_account_id: await lookup('account', pl.creditCode, 'tài khoản') }),
      });
    }
    await trx.insertInto('voucher_item_line').values(itemRows).execute();

    const groupRows = await trx.selectFrom('invoice_group').select(['id', 'code', 'rate']).where('scope', '=', scope).orderBy('code').execute(); // thứ tự cố định khi hai nhóm cùng thuế suất
    const group = groupRows.find((g) => g.code === input.invoice.invoiceGroupCode);
    if (!group) throw new AppError('LOOKUP_NOT_FOUND', `Không có nhóm hóa đơn ${scope === 'sale' ? 'bán' : 'mua'} mã "${input.invoice.invoiceGroupCode}"`, 404);
    const headerIsTaxCode = !!(await trx.selectFrom('tax_code').select('id').where('code', '=', group.code).executeTakeFirst());
    // Bán ra: nhóm kê khai theo từng dòng mã thuế (một hóa đơn có thể nhiều thuế suất, mỗi thuế suất một chỉ tiêu của tờ khai). Thứ tự: nhóm đầu hóa đơn nếu khớp thuế suất
    // của mã (nhóm không thuế suất như KTGT, NPV nhận mọi mã không thuế suất; nhóm mang mã của một mã thuế khác, vd. KCT với dòng KKK, thì không); không thì nhóm cùng mã
    // với mã thuế (KCT, KKK); không nữa thì nhóm cùng thuế suất (00, 05, 08, 10); không có thì 400. Mua vào giữ nhóm đầu hóa đơn (nhóm là mục đích sử dụng, không phải thuế suất).
    const groupFor = (code: string | null): number => {
      const d = code === null ? undefined : defs[code];
      if (scope !== 'sale' || !d || d.kind !== 'vat') return group.id;
      const sameRate = (g: { rate: string | null }) => (g.rate === null ? d.rate === null : d.rate !== null && D(g.rate).eq(d.rate));
      const ownGroup = groupRows.find((g) => g.code === code);
      if (sameRate(group) && (group.code === code || !headerIsTaxCode || !ownGroup)) return group.id;
      const g = ownGroup ?? (d.rate === null ? undefined : groupRows.find((x) => x.rate !== null && sameRate(x)));
      if (!g) throw new AppError('INVOICE_GROUP_MISMATCH', `Dòng thuế ${code}: nhóm kê khai ${group.code} không khớp thuế suất ${d.rate === null ? '(không thuế suất)' : `${D(d.rate).toString()}%`} và không có nhóm bán ra cùng mã hoặc cùng thuế suất; chọn nhóm khác hoặc khai báo nhóm kê khai`, 400);
      return g.id;
    };
    const partyId = party.id;
    if (input.invoice.adjustsInvoiceId !== undefined) { // hóa đơn gốc: cùng chiều, cùng đối tượng, chưa hủy; không tự đối trừ công nợ
      const orig = await trx.selectFrom('voucher_invoice as i').innerJoin('voucher as v', 'v.id', 'i.voucher_id').select('i.id')
        .where('i.id', '=', input.invoice.adjustsInvoiceId).where('i.direction', '=', scope).where('i.party_id', '=', partyId).where('v.state', '<>', 'cancelled').executeTakeFirst();
      if (!orig) throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn gốc của cùng đối tượng và cùng chiều mua/bán', 404);
    }
    // Một dòng mỗi nhóm mã thuế: cơ sở và thuế là số VND đã ghi sổ (sau khi chia chênh làm tròn), nên bảng kê khớp đúng bút toán.
    const groups = new Map<string | null, string[]>();
    for (const [k, it] of input.items.entries()) { if (isImp(k) && it.vatImportCode) continue; const g = groupOf(it.taxCodes, defs); groups.set(g, [...(groups.get(g) ?? []), String(k + 1)]); }
    const rows: InvoiceRow[] = [];
    for (const [code, lineNos] of groups) {
      const baseAmount = lineNos.reduce((s, n) => s.plus(detail.baseVnd[Number(n)] ?? 0), D(0)).toFixed(0);
      const taxAmount = code === null ? '0' : D(detail.taxVnd[code] ?? 0).toFixed(0);
      if (D(baseAmount).isZero() && D(taxAmount).isZero()) continue;
      rows.push({ direction: scope, formNo: input.invoice.formNo, serial: input.invoice.serial, invoiceNo: input.invoice.invoiceNo, invoiceDate: input.invoice.invoiceDate, partyId, invoiceGroupId: groupFor(code), headerGroupId: group.id,
        taxCodeId: code === null ? null : ids.get(code)!, baseAmount, taxAmount, isImport: input.invoice.isImport, adjustsInvoiceId: input.invoice.adjustsInvoiceId ?? null,
        partyTaxCode: input.invoice.partyTaxCode, partyName: input.invoice.partyName, partyAddress: input.invoice.partyAddress });
    }
    // Hàng nhập khẩu: GTGT hàng nhập lên bảng kê mua vào (is_import) theo mã GTGT của số thuế, cơ sở = giá trị hàng + thuế NK + TTĐB (VND); thuế NK, TTĐB liệt kê ở phần thuế khác
    // nếu danh mục còn mã NK, TTDB (kind import, excise). Số hóa đơn là số trên tab Hóa đơn (với hàng nhập khẩu: số tờ khai hải quan).
    const imp = new Map<string, { base: Decimal; tax: Decimal }>();
    const add = (code: string, base: Decimal, tax: Decimal) => { const g = imp.get(code) ?? { base: D(0), tax: D(0) }; imp.set(code, { base: g.base.plus(base), tax: g.tax.plus(tax) }); };
    // Mã thuế NK, TTĐB đang dùng, phạm vi mua vào (danh mục mã thuế không có ngày hiệu lực: ngừng dùng thì tắt is_active); nhiều mã cùng loại lấy mã nhỏ nhất.
    const otherCodes = Object.fromEntries((await trx.selectFrom('tax_code').select(['code', 'kind']).where('kind', 'in', ['import', 'excise']).where('is_active', '=', true).where('scope', 'in', ['purchase', 'both'])
      .orderBy('code').execute()).reverse().map((r) => [r.kind, r.code]));
    for (const [k, it] of input.items.entries()) {
      if (!isImp(k)) continue;
      const goodsVnd = D(detail.baseVnd[k + 1] ?? '0');
      if (it.vatImportCode) add(it.vatImportCode, it.vatImportBase ? D(it.vatImportBase) : goodsVnd.plus(importedVnd[k]!), D(it.vatImport ?? '0')); // không có mã GTGT hàng nhập: dòng hàng kê như dòng không thuế (nhóm mã rỗng ở trên)
      if (otherCodes['import'] && D(it.importTax ?? '0').gt(0)) add(otherCodes['import'], goodsVnd, D(it.importTax!));
      if (otherCodes['excise'] && D(it.specialConsumptionTax ?? '0').gt(0)) add(otherCodes['excise'], goodsVnd.plus(it.importTax ?? '0'), D(it.specialConsumptionTax!));
    }
    let impIds = new Map<string, number>();
    const extra = [...imp.keys()].filter((c) => !ids.has(c));
    if (extra.length) impIds = new Map((await trx.selectFrom('tax_code').select(['id', 'code']).where('code', 'in', extra).execute()).map((r) => [r.code, r.id]));
    for (const [code, g] of imp) rows.push({ direction: scope, formNo: input.invoice.formNo, serial: input.invoice.serial, invoiceNo: input.invoice.invoiceNo, invoiceDate: input.invoice.invoiceDate, partyId, invoiceGroupId: group.id, headerGroupId: group.id,
      taxCodeId: ids.get(code) ?? impIds.get(code)!, baseAmount: g.base.toFixed(0), taxAmount: g.tax.toFixed(0), isImport: true, adjustsInvoiceId: null,
      partyTaxCode: input.invoice.partyTaxCode, partyName: input.invoice.partyName, partyAddress: input.invoice.partyAddress });
    await insertInvoiceRows(trx, tenantId, voucherId, rows);
  };
  return { voucher, regime, postItems, warnings: [...purchase.warnings, ...(sale?.warnings ?? [])] };
}

const childrenExist = async (trx: Trx, id: string): Promise<boolean> => !!(await trx.selectFrom('voucher_item_line').select('id').where('voucher_id', '=', id).limit(1).executeTakeFirst());

export async function createInvoice(trx: Trx, ctx: { tenantId: string; userId: string; auth?: Auth }, input: InvoiceInput): Promise<InvoiceDto> {
  if (input.idempotencyKey) { // gửi lại cùng khóa: trả đúng hóa đơn cũ, không ghi dòng hàng lần nữa
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) return getInvoice(trx, existing.id);
  }
  const built = await buildInvoice(trx, ctx.tenantId, input, { ...(ctx.auth && { auth: ctx.auth }), perm: 'stock_voucher.create' });
  const v = await createInvoiceVoucher(trx, ctx, built.voucher);
  if (await childrenExist(trx, v.id)) return getInvoice(trx, v.id); // thua cuộc đua idempotency: giao dịch thắng đã ghi đủ
  await built.postItems(v.id);
  return { ...(await getInvoice(trx, v.id)), ...(built.warnings.length && { warnings: built.warnings }) };
}

// Sửa hóa đơn nháp: dựng lại toàn bộ từ đầu vào, thay dòng sổ, dòng hàng và dòng kê khai. Hóa đơn đã ghi sổ phải Bỏ ghi sổ trước (khớp trigger fn_voucher_child_guard).
export async function updateInvoice(trx: Trx, ctx: { tenantId: string; auth?: Auth }, id: string, version: number, input: InvoiceInput): Promise<InvoiceDto> {
  const cur = await trx.selectFrom('voucher').select(['state', 'voucher_type']).where('id', '=', id).forUpdate().executeTakeFirst(); // khóa dòng: ghi sổ đồng thời báo VOUCHER_CHILD_IMMUTABLE chứ không phải lỗi sửa chứng từ đã ghi sổ
  if (!cur || !voucherTypeDef(cur.voucher_type)?.hasItems) throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn', 404);
  if (cur.state !== 'draft') throw new AppError('VOUCHER_CHILD_IMMUTABLE', NOT_DRAFT, 409);
  const built = await buildInvoice(trx, ctx.tenantId, input, { ...(ctx.auth && { auth: ctx.auth }), selfId: id, perm: 'stock_voucher.update' });
  await updateInvoiceDraft(trx, id, version, built.voucher);
  await trx.deleteFrom('voucher_item_line').where('voucher_id', '=', id).execute();
  await deleteInvoiceRows(trx, id);
  await built.postItems(id);
  return { ...(await getInvoice(trx, id)), ...(built.warnings.length && { warnings: built.warnings }) };
}
