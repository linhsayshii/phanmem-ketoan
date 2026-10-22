import { buildInvoiceLedgerDetail, computeTaxes, D, Decimal, sum, TaxError, toVnd, type LedgerLine, type TaxDef, type TaxResult } from '@kt/domain';

// Phần tính của màn hình hóa đơn dịch vụ: dẫn xuất ô của dòng hàng và xem trước thuế, bút toán.
// Thuế và bút toán gọi đúng computeTaxes / buildInvoiceLedgerDetail của @kt/domain (cùng hàm máy chủ dùng khi lưu), không có công thức riêng.

// Một dòng của /api/invoices/tax-defs: mã thuế, phạm vi dùng và định nghĩa cho động cơ thuế.
export interface TaxDefRow { code: string; name: string; scope: 'sale' | 'purchase' | 'both'; isActive: boolean; def: TaxDef }
export interface GroupRow { scope: string; code: string; name: string; rate: string | null }
// Mọi ô là chuỗi: số tiền là chuỗi thập phân, mã thuế là chữ cách nhau bằng dấu phẩy. taxAmount do máy tính điền, không nhập.
export interface InvRow { description: string; accountCode: string; quantity: string; unitPrice: string; amount: string; discountRate: string; discount: string; taxCodes: string; taxAmount: string;
  departmentCode: string; projectCode: string; costItemCode: string;
  // Mua hàng hóa (MH, TLM): dòng hàng nhập kho; sourceLineId là mã dòng nhập gốc khi trả lại hàng mua
  itemCode: string; uomCode: string; warehouseCode: string; lotNo: string; expiryDate: string; sourceLineId: string;
  // Mua hàng nhập khẩu (MH): thuế nhập khẩu, TTĐB, GTGT hàng nhập theo tờ khai hải quan (VND, nhập tay), mã thuế GTGT của số thuế GTGT hàng nhập và giá tính thuế GTGT theo tờ khai (trống: hàng + NK + TTĐB)
  importTax: string; specialConsumptionTax: string; vatImport: string; vatImportCode: string; vatImportBase: string }
export const emptyInvRow = (): InvRow => ({ description: '', accountCode: '', quantity: '', unitPrice: '', amount: '', discountRate: '', discount: '', taxCodes: '', taxAmount: '', departmentCode: '', projectCode: '', costItemCode: '',
  itemCode: '', uomCode: '', warehouseCode: '', lotNo: '', expiryDate: '', sourceLineId: '', importTax: '', specialConsumptionTax: '', vatImport: '', vatImportCode: '', vatImportBase: '' });

export const codesOf = (r: Pick<InvRow, 'taxCodes'>): string[] => r.taxCodes.split(/[\s,;]+/).filter(Boolean);
const INPUT_KEYS = ['description', 'accountCode', 'quantity', 'unitPrice', 'amount', 'discountRate', 'discount', 'taxCodes', 'departmentCode', 'projectCode', 'costItemCode', 'itemCode', 'uomCode', 'warehouseCode', 'lotNo', 'expiryDate', 'sourceLineId', 'importTax', 'specialConsumptionTax', 'vatImport', 'vatImportCode', 'vatImportBase'] as const;
export const isBlankRow = (r: InvRow): boolean => INPUT_KEYS.every((k) => (r[k] ?? '').trim() === '');

export const NUM_RE = /^\d{1,16}(\.\d{1,4})?$/;
const round = (x: Decimal, dp: number): string => x.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed();

// Giá trị của dòng ở lần dẫn xuất trước. Lưới ghi thẳng vào đối tượng dòng nên không so được với bản cũ của mảng: chủ giữ bản chụp theo đối tượng dòng.
export type RowSnap = Pick<InvRow, 'quantity' | 'unitPrice' | 'amount' | 'discountRate' | 'discount'>;
export const snapOf = (r: InvRow): RowSnap => ({ quantity: r.quantity, unitPrice: r.unitPrice, amount: r.amount, discountRate: r.discountRate, discount: r.discount });

// Ghi giá trị dẫn xuất tại chỗ (không đổi đối tượng dòng: đổi thì lưới hủy ô đang sửa). `dp` là số chữ số thập phân của loại tiền.
//  - Số lượng hoặc đơn giá đổi: thành tiền = số lượng × đơn giá (vẫn sửa tay được thành tiền).
//  - Sửa tay tiền chiết khấu (không đổi %): bỏ %. Đổi % hoặc thành tiền khi có %: tiền chiết khấu = thành tiền × % / 100.
export function deriveRow(r: InvRow, prev: RowSnap, dp: number): void {
  if ((r.quantity !== prev.quantity || r.unitPrice !== prev.unitPrice) && NUM_RE.test(r.quantity) && NUM_RE.test(r.unitPrice)) r.amount = round(D(r.quantity).times(r.unitPrice), dp);
  if (r.discount !== prev.discount && r.discountRate === prev.discountRate) r.discountRate = '';
  else if (r.discountRate && (r.discountRate !== prev.discountRate || r.amount !== prev.amount) && NUM_RE.test(r.amount) && NUM_RE.test(r.discountRate)) r.discount = round(D(r.amount).times(r.discountRate).div(100), dp);
}

// Nhóm kê khai mặc định theo mã thuế GTGT đầu tiên của hóa đơn, theo dữ liệu danh mục (không viết cứng thuế suất):
// bán ra: nhóm cùng thuế suất (thuế suất trống thì nhóm không có thuế suất, vd. không chịu thuế); mua vào: nhóm đầu tiên (hàng hóa, dịch vụ dùng cho kinh doanh chịu thuế, đủ điều kiện khấu trừ) khi mã khấu trừ có thuế suất.
export function defaultGroup(scope: 'sale' | 'purchase', codes: string[], defs: TaxDefRow[], groups: GroupRow[]): string | null {
  const vat = codes.map((c) => defs.find((d) => d.code === c)).find((d) => d?.def.kind === 'vat');
  if (!vat) return null;
  const inScope = groups.filter((g) => g.scope === scope).sort((a, b) => a.code.localeCompare(b.code));
  if (scope === 'purchase') return vat.def.method === 'deduct' && vat.def.rate !== null ? inScope[0]?.code ?? null : null;
  // Nhóm cùng mã với mã thuế (KCT, KKK) trước: các nhóm không thuế suất (KCT, KKK, KTGT, NPV) lên các chỉ tiêu khác nhau của tờ khai.
  return (inScope.find((g) => g.code === vat.code) ?? inScope.find((g) => (g.rate === null ? vat.def.rate === null : vat.def.rate !== null && D(g.rate).eq(vat.def.rate))))?.code ?? null;
}

export interface CodeSummary { code: string; name: string; lines: number; computed: string; declared: string; diff: string; allowed: number; ok: boolean }
export interface Preview { lineTax: string[]; ledger: LedgerLine[]; byCode: CodeSummary[]; error: { code: string; message: string } | null }
export interface PreviewInput { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; defs: TaxDefRow[]; rows: InvRow[]; currency: string; fxRate: string | null; minorUnit?: number | undefined;
  partyCode: string; counterAccountCode: string; declared: Record<string, string>;
  stockAccount?: string } // MH, TLM: tài khoản tạm cho dòng hàng chưa có tài khoản (kho 156 hoặc hàng đang đi đường 151); máy chủ tính tài khoản thật khi lưu
// Bút toán thuế hàng nhập khẩu của các dòng (như máy chủ, service.ts buildInvoice): Nợ TK hàng / Có 3333 thuế NK, Nợ TK hàng / Có 3332 thuế TTĐB, Nợ 1331 / Có 33312 thuế GTGT hàng nhập. Số VND.
export function importLedger(rows: InvRow[], stockAccount: string): LedgerLine[] {
  const ln = (accountCode: string, debit: string, credit: string, description: string, r: InvRow): LedgerLine => ({ accountCode, debit, credit, amountCurrency: '0', fxRate: null, partyCode: null, description, dueDate: null,
    ...(debit !== '0' && accountCode !== '1331' && r.itemCode.trim() ? { itemCode: r.itemCode.trim(), warehouseCode: r.warehouseCode.trim() || null } : {}) });
  return rows.flatMap((r, k) => {
    if (!r.itemCode.trim()) return [];
    const acct = r.accountCode.trim() || stockAccount; const out: LedgerLine[] = [];
    const pair = (amt: string, debitAcct: string, creditAcct: string, what: string) => { if (NUM_RE.test(amt) && D(amt).gt(0)) out.push(ln(debitAcct, amt, '0', `${what} dòng ${k + 1}`, r), ln(creditAcct, '0', amt, `${what} dòng ${k + 1}`, r)); };
    pair(r.importTax, acct, '3333', 'Thuế nhập khẩu'); pair(r.specialConsumptionTax, acct, '3332', 'Thuế tiêu thụ đặc biệt hàng nhập khẩu'); pair(r.vatImport, '1331', '33312', 'Thuế GTGT hàng nhập khẩu');
    return out;
  });
}

export const NO_PREVIEW: Preview = { lineTax: [], ledger: [], byCode: [], error: null };

// Xem trước thuế từng dòng, bảng thuế theo mã và bút toán. Dòng chưa có tài khoản bỏ qua (chưa đủ để hạch toán; lúc lưu mới báo thiếu).
// Kiểm tra chiết khấu, một mã GTGT mỗi dòng và phạm vi mã thuế giống máy chủ (service.ts buildInvoice) để lỗi hiện ngay khi nhập.
// Dung sai thuế ghi trên hóa đơn: VND lệch Σ thuế dòng tối đa bằng số dòng mang mã; ngoại tệ thêm ±1 đồng mỗi dòng thuế hạch toán so với số quy đổi từ nguyên tệ.
export function previewInvoice(i: PreviewInput): Preview {
  const lineTax = i.rows.map(() => '');
  const acct = (r: InvRow) => r.accountCode.trim() || (r.itemCode.trim() ? i.stockAccount ?? '' : '');
  const items = i.rows.flatMap((r, k) => (acct(r) ? [{ r, lineNo: k + 1, codes: codesOf(r) }] : []));
  if (!items.length) return { ...NO_PREVIEW, lineTax };
  const defs = Object.fromEntries(i.defs.map((d) => [d.code, d.def]));
  const isVnd = i.currency === 'VND';
  const fail = (e: unknown, partial: Partial<Preview> = {}): Preview => {
    const error = e instanceof TaxError ? { code: e.code, message: e.message } : e instanceof Error ? { code: 'PREVIEW', message: e.message } : (e as { code: string; message: string });
    return { ...NO_PREVIEW, lineTax, ...partial, error };
  };
  for (const { r, lineNo, codes } of items) {
    if (r.amount && D(r.discount || '0').gt(r.amount)) return fail({ code: 'VALIDATION', message: `Dòng ${lineNo}: chiết khấu lớn hơn tiền hàng` });
    const vats = codes.filter((c) => defs[c]?.kind === 'vat');
    if (vats.length > 1) return fail({ code: 'INVOICE_LINE_MULTIPLE_VAT', message: `Dòng ${lineNo}: mỗi dòng hàng chỉ được một mã thuế GTGT, đang có ${vats.join(', ')}. Tách thành các dòng hàng riêng theo từng thuế suất` });
    for (const c of codes) {
      const s = i.defs.find((d) => d.code === c)?.scope;
      if (s && s !== 'both' && s !== i.scope) return fail({ code: 'TAX_SCOPE_MISMATCH', message: `Mã thuế ${c} chỉ dùng cho hóa đơn ${s === 'sale' ? 'bán ra' : 'mua vào'}` });
    }
  }
  const taxLines = items.map(({ r, lineNo, codes }) => ({ lineNo, amountCurrency: r.amount || '0', discountCurrency: r.discount || '0', taxCodes: codes }));
  const opts = { scope: i.scope, documentType: i.documentType, currency: i.currency, fxRate: isVnd ? null : i.fxRate, ...(i.minorUnit !== undefined && { minorUnit: i.minorUnit }) };
  let base: TaxResult;
  try { base = computeTaxes(taxLines, defs, opts); } catch (e) { return fail(e); }
  for (const l of base.lines) lineTax[l.lineNo - 1] = l.taxes.length ? sum(l.taxes.map((t) => t.amountCurrency)).toFixed() : '';

  // Thuế ghi trên hóa đơn: chỉ mã đang có trên dòng và đã nhập số.
  const present = [...new Set(items.flatMap((x) => x.codes))];
  const declared = Object.fromEntries(Object.entries(i.declared).filter(([c, v]) => v !== '' && present.includes(c)));
  const byCode: CodeSummary[] = present.map((code) => {
    const lines = items.filter((x) => x.codes.includes(code)).length;
    const postings = base.postings.filter((p) => p.code === code);
    const sumVnd = sum(base.lines.flatMap((l) => l.taxes.filter((t) => t.code === code).map((t) => t.amountVnd)));
    const exact = isVnd ? sumVnd : sum(postings.map((p) => toVnd(p.amountCurrency, i.fxRate!)));
    const dec = declared[code] ?? '';
    const diff = dec === '' ? D(0) : D(dec).minus(sumVnd);
    const ok = dec === '' || (diff.abs().lte(lines) && (isVnd || D(dec).minus(exact).abs().lte(Math.max(postings.length, 1))));
    return { code, name: i.defs.find((d) => d.code === code)?.name ?? code, lines, computed: sumVnd.toFixed(), declared: dec, diff: diff.toFixed(), allowed: lines, ok };
  });

  try {
    const tax = Object.keys(declared).length ? computeTaxes(taxLines, defs, { ...opts, declaredTaxVnd: declared }) : base;
    const detail = buildInvoiceLedgerDetail({ scope: i.scope, documentType: i.documentType, counterAccountCode: i.counterAccountCode, partyCode: i.partyCode, currency: i.currency, fxRate: isVnd ? null : i.fxRate,
      dueDate: null, tax, ...(Object.keys(declared).length && { declaredTaxVnd: declared }),
      items: items.map(({ r, lineNo, codes }) => ({ lineNo, description: r.description.trim() || null, accountCode: acct(r), amountCurrency: r.amount || '0', discountCurrency: r.discount || '0', taxCodes: codes,
        departmentCode: r.departmentCode.trim() || null, projectCode: r.projectCode.trim() || null, costItemCode: r.costItemCode.trim() || null })) });
    return { lineTax, ledger: detail.lines, byCode, error: null };
  } catch (e) { return fail(e, { byCode }); }
}
