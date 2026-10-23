import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { amountInWords, D, vndInWords } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { EInvoiceDoc, EInvoiceLine, EInvoiceTaxGroup, OriginalRef } from './providers/types.js';

type Trx = Transaction<Database>;

const CURRENCY_WORDS: Record<string, string> = { USD: 'đô la Mỹ', EUR: 'ơ rô', JPY: 'yên Nhật', GBP: 'bảng Anh', CNY: 'nhân dân tệ', KRW: 'won Hàn Quốc' };
const num = (x: string | null | undefined) => D(x ?? 0);

// Mã thuế -> thuế suất hóa đơn: có suất thì chuỗi số ('0','5','8','10'); không suất thì KCT (không chịu thuế), KKK -> KKKNT (không kê khai, tính nộp), còn lại KHAC.
function taxRateOf(c: { code: string; rate: string | null } | undefined): string {
  if (!c) return 'KCT';
  if (c.rate !== null) return D(c.rate).toString();
  return c.code === 'KCT' ? 'KCT' : c.code === 'KKK' ? 'KKKNT' : 'KHAC';
}
const toGroups = (m: Map<string, { base: ReturnType<typeof D>; tax: ReturnType<typeof D> }>, dp: number): EInvoiceTaxGroup[] =>
  [...m].map(([taxRate, g]) => ({ taxRate, base: g.base.toFixed(dp), tax: g.tax.toFixed(dp) }));

async function originalRef(trx: Trx, originalId: number): Promise<OriginalRef> {
  const o = await trx.selectFrom('einvoice as e').innerJoin('einvoice_series as s', 's.id', 'e.series_id')
    .select(['e.invoice_no', 'e.issue_date', 'e.provider_ref', 's.form_no', 's.serial']).where('e.id', '=', originalId).executeTakeFirst();
  if (!o || !o.invoice_no || !o.issue_date) throw new AppError('EINVOICE_ORIGINAL_NOT_ISSUED', 'Hóa đơn gốc chưa được phát hành nên không lập được hóa đơn điều chỉnh, thay thế', 409);
  return { formNo: o.form_no, serial: o.serial, invoiceNo: o.invoice_no, issueDate: o.issue_date, providerRef: o.provider_ref };
}

// Dựng hóa đơn trung lập từ bản ghi einvoice + chứng từ bán. Tiền VND lấy từ chứng từ/bảng kê (đúng số đã kê khai); ngoại tệ theo nguyên tệ từng dòng.
export async function buildEInvoiceDoc(trx: Trx, einvoiceId: number): Promise<EInvoiceDoc> {
  const e = await trx.selectFrom('einvoice').selectAll().where('id', '=', einvoiceId).executeTakeFirst();
  if (!e) throw new AppError('EINVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn điện tử', 404);
  const series = await trx.selectFrom('einvoice_series').selectAll().where('id', '=', e.series_id).executeTakeFirstOrThrow();
  const v = await trx.selectFrom('voucher').selectAll().where('id', '=', e.voucher_id).executeTakeFirstOrThrow();
  const tenant = await trx.selectFrom('tenant').selectAll().where('id', '=', e.tenant_id).executeTakeFirstOrThrow();
  const invs = await trx.selectFrom('voucher_invoice').selectAll().where('voucher_id', '=', v.id).orderBy('id').execute();
  const head = invs[0];
  const party = v.party_id ? await trx.selectFrom('party').selectAll().where('id', '=', v.party_id).executeTakeFirst() : undefined;
  const items = await trx.selectFrom('voucher_item_line as l').leftJoin('item as i', 'i.id', 'l.item_id').leftJoin('uom as u', 'u.id', 'l.uom_id')
    .select(['l.line_no', 'l.description', 'l.quantity', 'l.unit_price', 'l.amount', 'l.amount_currency', 'l.discount_rate', 'l.discount_amount', 'l.discount_amount_currency', 'l.tax_codes', 'l.tax_amount', 'i.code as item_code', 'i.name as item_name', 'u.name as uom_name'])
    .where('l.voucher_id', '=', v.id).orderBy('l.line_no').execute();
  const codes = await trx.selectFrom('tax_code').select(['id', 'code', 'rate', 'kind']).execute();
  const byCode = new Map(codes.map((c) => [c.code, c]));
  const byId = new Map(codes.map((c) => [c.id, c]));

  const currency = v.currency_code;
  const foreign = currency !== 'VND';
  const dp = foreign ? 2 : 0;
  const groups = new Map<string, { base: ReturnType<typeof D>; tax: ReturnType<typeof D> }>();
  const addGroup = (rate: string, base: ReturnType<typeof D>, tax: ReturnType<typeof D>) => { const g = groups.get(rate) ?? { base: D(0), tax: D(0) }; groups.set(rate, { base: g.base.plus(base), tax: g.tax.plus(tax) }); };

  const lines: EInvoiceLine[] = items.map((l, k) => {
    const vat = l.tax_codes.map((c) => byCode.get(c)).find((c) => c?.kind === 'vat');
    const taxRate = taxRateOf(vat);
    const amount = num(foreign ? l.amount_currency : l.amount);
    const discount = num(foreign ? l.discount_amount_currency : l.discount_amount);
    const base = amount.minus(discount);
    const tax = foreign ? (vat?.rate != null ? base.times(vat.rate).div(100).toDecimalPlaces(dp, 4) : D(0)) : num(l.tax_amount);
    if (foreign) addGroup(taxRate, base, tax);
    return { lineNo: k + 1, kind: 'goods', code: l.item_code, name: l.description?.trim() || l.item_name || '', uom: l.uom_name, quantity: l.quantity, unitPrice: l.unit_price,
      amount: amount.toFixed(dp), discountRate: num(l.discount_rate).isZero() ? null : num(l.discount_rate).toString(), discountAmount: discount.toFixed(dp),
      taxRate, taxAmount: tax.toFixed(dp), total: base.plus(tax).toFixed(dp) };
  });
  if (!foreign) for (const r of invs) addGroup(taxRateOf(r.tax_code_id === null ? undefined : byId.get(r.tax_code_id)), num(r.base_amount), num(r.tax_amount));
  const taxGroups = toGroups(groups, dp);
  const beforeTax = taxGroups.reduce((s, g) => s.plus(g.base), D(0));
  const tax = taxGroups.reduce((s, g) => s.plus(g.tax), D(0));
  const discount = lines.reduce((s, l) => s.plus(l.discountAmount), D(0));
  const total = beforeTax.plus(tax).toFixed(dp);

  let relation: EInvoiceDoc['relation'] = { kind: 'original' };
  if (e.relation !== 'original') {
    if (e.original_id === null) throw new AppError('EINVOICE_ORIGINAL_NOT_ISSUED', 'Thiếu hóa đơn gốc', 409);
    const original = await originalRef(trx, e.original_id);
    const reason = v.description?.trim() || (e.relation === 'adjustment' ? 'Điều chỉnh hóa đơn' : 'Thay thế hóa đơn');
    relation = e.relation === 'adjustment'
      ? { kind: 'adjustment', adjust: v.voucher_type === 'GGB' || v.voucher_type === 'TLB' ? 'decrease' : (e.adjust_kind as 'increase' | 'decrease' | 'info' | null) ?? 'info', original, reason }
      : { kind: 'replacement', original, reason };
  }

  return {
    transactionUuid: e.transaction_uuid, formNo: series.form_no, serial: series.serial, providerTemplate: series.provider_template,
    issueDate: e.issue_date ?? head?.invoice_date ?? v.document_date, currency, fxRate: foreign ? D(v.fx_rate ?? 1).toString() : '1',
    paymentMethod: 'TM/CK', // chứng từ chưa lưu hình thức thanh toán: dùng giá trị gộp mà hóa đơn điện tử cho phép
    seller: { name: tenant.name, taxCode: tenant.tax_code, address: tenant.address, email: tenant.email, phone: tenant.phone },
    buyer: { name: head?.party_name || party?.name || '', taxCode: head?.party_tax_code ?? party?.tax_code ?? null, address: head?.party_address ?? party?.invoice_address ?? party?.address ?? null,
      buyerName: party?.contact_name ?? null, email: party?.email ?? null, phone: party?.phone ?? null, idNo: party?.id_number ?? null },
    lines, taxGroups,
    totals: { beforeTax: beforeTax.toFixed(dp), tax: tax.toFixed(dp), discount: discount.toFixed(dp), total, totalInWords: foreign ? amountInWords(total, CURRENCY_WORDS[currency] ?? currency) : vndInWords(total) },
    relation,
  };
}
