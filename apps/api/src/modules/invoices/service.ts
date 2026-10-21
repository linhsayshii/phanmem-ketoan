import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { buildInvoiceLedgerDetail, computeTaxes, D, toVnd, VND_AMOUNT_MSG, VND_AMOUNT_RE, voucherTypeDef, type TaxDef, type TaxResult } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { createInvoiceVoucher, dateIso, fxRate, getVoucher, updateInvoiceDraft, type LineInput, type VoucherDto, type VoucherInput } from '../ledger/vouchers.service.js';
import { deleteInvoiceRows, insertInvoiceRows, type InvoiceRow } from './declaration.js';

type Trx = Transaction<Database>;

const foreignAmount = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền không hợp lệ');
const optText = (max: number) => z.string().max(max).nullable().optional();
// Dòng hàng hóa, dịch vụ. amountCurrency là tiền hàng trước chiết khấu theo loại tiền của hóa đơn (VND: đồng nguyên); discountCurrency là chiết khấu (số tiền);
// discountRate, quantity, unitPrice, uomCode chỉ để lưu và in, không tham gia tính tiền.
export const invoiceItemInput = z.object({
  description: optText(500), accountCode: z.string().min(1), amountCurrency: foreignAmount, discountCurrency: foreignAmount.default('0'), taxCodes: z.array(z.string().min(1)).max(5).default([]),
  departmentCode: optText(50), projectCode: optText(50), costItemCode: optText(50),
  quantity: foreignAmount.optional(), unitPrice: foreignAmount.optional(), uomCode: optText(50),
  discountRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).refine((s) => Number(s) <= 100, 'Tỷ lệ chiết khấu tối đa 100%').optional(),
});
export const invoiceHeaderInput = z.object({
  formNo: optText(20), serial: optText(20), invoiceNo: z.string().trim().min(1).max(30), invoiceDate: dateIso, invoiceGroupCode: z.string().min(1), isImport: z.boolean().optional(),
  adjustsInvoiceId: z.number().int().positive().optional(), // bắt buộc với giảm giá, trả lại (GGB, GGM): dòng của hóa đơn gốc
  declaredTax: z.record(z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG)).optional(), // thuế GTGT ghi trên hóa đơn theo mã thuế (VND), lệch số tính theo dòng thì dồn vào dòng thuế lớn nhất
});
export const invoiceInput = z.object({
  voucherType: z.enum(['HDB', 'HDM', 'GGB', 'GGM']), postingDate: dateIso, documentDate: dateIso, partyCode: z.string().min(1), counterAccountCode: z.string().min(1).optional(),
  currencyCode: z.string().length(3).default('VND'), fxRate: fxRate.optional(), dueDate: dateIso.nullable().optional(), description: z.string().nullable().optional(),
  items: z.array(invoiceItemInput).min(1).max(500, 'Tối đa 500 dòng mỗi hóa đơn'), invoice: invoiceHeaderInput, idempotencyKey: z.string().max(100).optional(),
});
export type InvoiceInput = z.infer<typeof invoiceInput>;

export interface ItemLineDto {
  lineNo: number; description: string | null; quantity: string | null; unitPrice: string | null; uomCode: string | null; amountCurrency: string; amount: string; discountRate: string;
  discountAmountCurrency: string; discountAmount: string; taxCodes: string[]; taxAmount: string; accountCode: string; departmentCode: string | null; projectCode: string | null; costItemCode: string | null;
}
export type InvoiceDto = VoucherDto & { items: ItemLineDto[] };

const NOT_DRAFT = 'chứng từ đã ghi sổ, hãy bỏ ghi sổ để sửa hóa đơn';
const addDays = (iso: string, days: number): string => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);

async function itemsOf(trx: Trx, voucherId: string): Promise<ItemLineDto[]> {
  const rows = await trx.selectFrom('voucher_item_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('uom as u', 'u.id', 'l.uom_id').leftJoin('department as d', 'd.id', 'l.department_id')
    .leftJoin('project as p', 'p.id', 'l.project_id').leftJoin('cost_item as c', 'c.id', 'l.cost_item_id')
    .select(['l.line_no', 'l.description', 'l.quantity', 'l.unit_price', 'u.code as uom_code', 'l.amount_currency', 'l.amount', 'l.discount_rate', 'l.discount_amount_currency', 'l.discount_amount', 'l.tax_codes', 'l.tax_amount',
      'a.code as account_code', 'd.code as department_code', 'p.code as project_code', 'c.code as cost_item_code'])
    .where('l.voucher_id', '=', voucherId).orderBy('l.line_no').execute();
  return rows.map((r) => ({ lineNo: r.line_no, description: r.description, quantity: r.quantity, unitPrice: r.unit_price, uomCode: r.uom_code, amountCurrency: r.amount_currency, amount: r.amount, discountRate: r.discount_rate,
    discountAmountCurrency: r.discount_amount_currency, discountAmount: r.discount_amount, taxCodes: r.tax_codes, taxAmount: r.tax_amount, accountCode: r.account_code, departmentCode: r.department_code,
    projectCode: r.project_code, costItemCode: r.cost_item_code }));
}

// Chứng từ phải là loại hóa đơn (HDB, HDM, GGB, GGM), nếu không thì coi như không có hóa đơn.
export async function getInvoice(trx: Trx, id: string): Promise<InvoiceDto> {
  const v = await getVoucher(trx, id);
  if (!voucherTypeDef(v.voucherType)?.hasItems) throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn', 404);
  return { ...v, items: await itemsOf(trx, id) };
}

// Mã thuế và phân bổ của chúng, dạng động cơ thuế dùng. Mã không có trong danh mục để động cơ báo TAX_CODE_UNKNOWN.
async function loadTaxDefs(trx: Trx, codes: string[]): Promise<{ defs: Record<string, TaxDef>; ids: Map<string, number> }> {
  const defs: Record<string, TaxDef> = {}; const ids = new Map<string, number>();
  if (!codes.length) return { defs, ids };
  const rows = await trx.selectFrom('tax_code').select(['id', 'code', 'kind', 'rate', 'method', 'price_include']).where('code', 'in', codes).execute();
  const dists = rows.length ? await trx.selectFrom('tax_distribution').select(['tax_code_id', 'document_type', 'scope', 'line_type', 'factor_percent', 'account_code', 'report_tag']).where('tax_code_id', 'in', rows.map((r) => r.id)).execute() : [];
  for (const r of rows) {
    ids.set(r.code, r.id);
    defs[r.code] = { code: r.code, kind: r.kind as TaxDef['kind'], method: r.method as TaxDef['method'], rate: r.rate, priceInclude: r.price_include,
      distributions: dists.filter((d) => d.tax_code_id === r.id).map((d) => ({ documentType: d.document_type as 'invoice' | 'refund', scope: d.scope as 'sale' | 'purchase', lineType: d.line_type as 'base' | 'tax',
        factorPercent: d.factor_percent, accountCode: d.account_code, reportTag: d.report_tag })) };
  }
  return { defs, ids };
}

// Mã dùng gom dòng kê khai: mã GTGT đầu tiên của dòng; không có thì mã thuế đầu tiên không phải TNCN (thuế nhập khẩu, TTĐB); không có nữa thì null (dòng không thuế).
const groupOf = (codes: string[], defs: Record<string, TaxDef>): string | null =>
  codes.find((c) => defs[c]?.kind === 'vat') ?? codes.find((c) => defs[c] && defs[c]!.kind !== 'pit') ?? null;

const vndText = (cur: string, rate: string | null): string => (rate === null ? cur : toVnd(cur, rate));

interface Built { voucher: VoucherInput; regime: string; postItems: (voucherId: string) => Promise<void> }

// Dựng toàn bộ hóa đơn từ đầu vào: tính thuế, bút toán, dòng hàng và dòng kê khai. Chưa ghi gì; postItems ghi dòng hàng và dòng kê khai sau khi chứng từ đã có id.
async function buildInvoice(trx: Trx, tenantId: string, input: InvoiceInput): Promise<Built> {
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
  const dueDate = input.dueDate !== undefined ? input.dueDate : party.payment_term_days === null ? null : addDays(input.documentDate, party.payment_term_days);

  let minorUnit: number | undefined;
  if (!isVnd) {
    const c = await trx.selectFrom('currency').select('minor_unit').where('code', '=', input.currencyCode).executeTakeFirst();
    if (!c) throw new AppError('LOOKUP_NOT_FOUND', `Không có loại tiền "${input.currencyCode}"`, 404);
    minorUnit = c.minor_unit;
  }
  const rate = isVnd ? null : input.fxRate ?? null;

  const { defs, ids } = await loadTaxDefs(trx, [...new Set(input.items.flatMap((i) => i.taxCodes))]);
  const tax: TaxResult = computeTaxes(input.items.map((it, k) => ({ lineNo: k + 1, amountCurrency: it.amountCurrency, discountCurrency: it.discountCurrency, taxCodes: it.taxCodes })), defs,
    { scope, documentType, currency: input.currencyCode, fxRate: rate, ...(input.invoice.declaredTax && { declaredTaxVnd: input.invoice.declaredTax }), ...(minorUnit !== undefined && { minorUnit }) });
  const detail = buildInvoiceLedgerDetail({ scope, documentType, counterAccountCode, partyCode: input.partyCode, currency: input.currencyCode, fxRate: rate, dueDate, tax,
    items: input.items.map((it, k) => ({ lineNo: k + 1, description: it.description ?? null, accountCode: it.accountCode, amountCurrency: it.amountCurrency, discountCurrency: it.discountCurrency, taxCodes: it.taxCodes,
      departmentCode: it.departmentCode ?? null, projectCode: it.projectCode ?? null, costItemCode: it.costItemCode ?? null })) });
  if (!detail.lines.length) throw new AppError('INVOICE_EMPTY', 'Hóa đơn không có số tiền nào để hạch toán', 400);

  const lines: LineInput[] = detail.lines.map((l) => ({
    accountCode: l.accountCode, debit: l.debit, credit: l.credit, ...(!isVnd && { amountCurrency: l.amountCurrency, ...(l.fxRate && { fxRate: l.fxRate }) }),
    ...(l.partyCode && { partyCode: l.partyCode }), ...(l.description && { description: l.description }), ...(l.dueDate && { dueDate: l.dueDate }),
    ...(l.departmentCode && { departmentCode: l.departmentCode }), ...(l.projectCode && { projectCode: l.projectCode }), ...(l.costItemCode && { costItemCode: l.costItemCode }) }));
  const voucher: VoucherInput = { voucherType: input.voucherType, postingDate: input.postingDate, documentDate: input.documentDate, description: input.description ?? null, partyCode: input.partyCode,
    currencyCode: input.currencyCode, ...(rate && { fxRate: rate }), ...(dueDate && { dueDate }), ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }), lines };

  const regime = (await trx.selectFrom('fiscal_period').select('regime').where('period_no', '>=', 1).where('period_no', '<=', 15).where('date_from', '<=', input.postingDate).where('date_to', '>=', input.postingDate).executeTakeFirst())?.regime;
  if (!regime) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${input.postingDate} không thuộc kỳ kế toán nào đã mở`, 404);

  const postItems = async (voucherId: string) => {
    const lookup = async (table: 'account' | 'department' | 'project' | 'cost_item' | 'uom', code: string | null | undefined, label: string): Promise<number | null> => {
      if (!code) return null;
      const q = trx.selectFrom(table).select('id').where('code', '=', code);
      const r = await (table === 'account' ? q.where('regime' as never, '=', regime as never) : q).executeTakeFirst();
      if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${label} mã "${code}"`, 404);
      return r.id as number;
    };
    const itemRows = [];
    for (const [k, it] of input.items.entries()) {
      const t = tax.lines[k]!;
      itemRows.push({
        tenant_id: tenantId, voucher_id: voucherId, line_no: k + 1, description: it.description ?? null, uom_id: await lookup('uom', it.uomCode, 'đơn vị tính'), quantity: it.quantity ?? null, unit_price: it.unitPrice ?? null,
        amount_currency: it.amountCurrency, amount: vndText(it.amountCurrency, rate), discount_rate: it.discountRate ?? '0', discount_amount_currency: it.discountCurrency, discount_amount: vndText(it.discountCurrency, rate),
        tax_codes: it.taxCodes, tax_amount: D(0).plus(t.taxes.filter((x) => defs[x.code]!.kind !== 'pit').reduce((s, x) => s.plus(x.amountVnd), D(0))).toFixed(0),
        account_id: (await lookup('account', it.accountCode, 'tài khoản'))!, department_id: await lookup('department', it.departmentCode, 'bộ phận'), project_id: await lookup('project', it.projectCode, 'vụ việc'),
        cost_item_id: await lookup('cost_item', it.costItemCode, 'khoản mục chi phí'),
      });
    }
    await trx.insertInto('voucher_item_line').values(itemRows).execute();

    const group = await trx.selectFrom('invoice_group').select('id').where('scope', '=', scope).where('code', '=', input.invoice.invoiceGroupCode).executeTakeFirst();
    if (!group) throw new AppError('LOOKUP_NOT_FOUND', `Không có nhóm hóa đơn ${scope === 'sale' ? 'bán' : 'mua'} mã "${input.invoice.invoiceGroupCode}"`, 404);
    const partyId = party.id;
    if (input.invoice.adjustsInvoiceId !== undefined) { // hóa đơn gốc: cùng chiều, cùng đối tượng, chưa hủy; không tự đối trừ công nợ
      const orig = await trx.selectFrom('voucher_invoice as i').innerJoin('voucher as v', 'v.id', 'i.voucher_id').select('i.id')
        .where('i.id', '=', input.invoice.adjustsInvoiceId).where('i.direction', '=', scope).where('i.party_id', '=', partyId).where('v.state', '<>', 'cancelled').executeTakeFirst();
      if (!orig) throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn gốc của cùng đối tượng và cùng chiều mua/bán', 404);
    }
    // Một dòng mỗi nhóm mã thuế: cơ sở và thuế là số VND đã ghi sổ (sau khi chia chênh làm tròn), nên bảng kê khớp đúng bút toán.
    const groups = new Map<string | null, string[]>();
    for (const [k, it] of input.items.entries()) { const g = groupOf(it.taxCodes, defs); groups.set(g, [...(groups.get(g) ?? []), String(k + 1)]); }
    const rows: InvoiceRow[] = [];
    for (const [code, lineNos] of groups) {
      const baseAmount = lineNos.reduce((s, n) => s.plus(detail.baseVnd[Number(n)] ?? 0), D(0)).toFixed(0);
      const taxAmount = code === null ? '0' : D(detail.taxVnd[code] ?? 0).toFixed(0);
      if (D(baseAmount).isZero() && D(taxAmount).isZero()) continue;
      rows.push({ direction: scope, formNo: input.invoice.formNo, serial: input.invoice.serial, invoiceNo: input.invoice.invoiceNo, invoiceDate: input.invoice.invoiceDate, partyId, invoiceGroupId: group.id,
        taxCodeId: code === null ? null : ids.get(code)!, baseAmount, taxAmount, isImport: input.invoice.isImport, adjustsInvoiceId: input.invoice.adjustsInvoiceId ?? null });
    }
    await insertInvoiceRows(trx, tenantId, voucherId, rows);
  };
  return { voucher, regime, postItems };
}

const childrenExist = async (trx: Trx, id: string): Promise<boolean> => !!(await trx.selectFrom('voucher_item_line').select('id').where('voucher_id', '=', id).limit(1).executeTakeFirst());

export async function createInvoice(trx: Trx, ctx: { tenantId: string; userId: string }, input: InvoiceInput): Promise<InvoiceDto> {
  if (input.idempotencyKey) { // gửi lại cùng khóa: trả đúng hóa đơn cũ, không ghi dòng hàng lần nữa
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) return getInvoice(trx, existing.id);
  }
  const built = await buildInvoice(trx, ctx.tenantId, input);
  const v = await createInvoiceVoucher(trx, ctx, built.voucher);
  if (await childrenExist(trx, v.id)) return getInvoice(trx, v.id); // thua cuộc đua idempotency: giao dịch thắng đã ghi đủ
  await built.postItems(v.id);
  return getInvoice(trx, v.id);
}

// Sửa hóa đơn nháp: dựng lại toàn bộ từ đầu vào, thay dòng sổ, dòng hàng và dòng kê khai. Hóa đơn đã ghi sổ phải Bỏ ghi sổ trước (khớp trigger fn_voucher_child_guard).
export async function updateInvoice(trx: Trx, ctx: { tenantId: string }, id: string, version: number, input: InvoiceInput): Promise<InvoiceDto> {
  const cur = await trx.selectFrom('voucher').select(['state', 'voucher_type']).where('id', '=', id).executeTakeFirst();
  if (!cur || !voucherTypeDef(cur.voucher_type)?.hasItems) throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn', 404);
  if (cur.state !== 'draft') throw new AppError('VOUCHER_CHILD_IMMUTABLE', NOT_DRAFT, 409);
  const built = await buildInvoice(trx, ctx.tenantId, input);
  await updateInvoiceDraft(trx, id, version, built.voucher);
  await trx.deleteFrom('voucher_item_line').where('voucher_id', '=', id).execute();
  await deleteInvoiceRows(trx, id);
  await built.postItems(id);
  return getInvoice(trx, id);
}
