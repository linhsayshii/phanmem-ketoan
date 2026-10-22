import { D, ZERO, sum, type Decimal } from './money.js';
import { toVnd } from './fx.js';
import { TaxError, type TaxResult } from './tax.js';

// Bút toán của hóa đơn mua/bán dịch vụ và giảm giá, trả lại (HDB, HDM, GGB, GGM). Kết quả của động cơ thuế (`computeTaxes`) vào, các dòng sổ cái ra.
export interface InvoiceItemInput { lineNo: number; description: string | null; accountCode: string; amountCurrency: string; discountCurrency: string; taxCodes: string[]; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null;
  itemCode?: string | null; warehouseCode?: string | null; offsetVnd?: string } // hàng, kho của dòng cơ sở (tài khoản kho); offsetVnd: giá tạm tính đã ghi ở phiếu nhập (VND), trừ khỏi dòng cơ sở (MH hàng về trước)
export interface InvoiceLedgerInput { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; counterAccountCode: string; partyCode: string; currency: string; fxRate: string | null; dueDate: string | null; items: InvoiceItemInput[]; tax: TaxResult;
  declaredTaxVnd?: Record<string, string> } // mã thuế có số ghi trên hóa đơn (chỉ dùng khóa): dòng thuế ngoại tệ của mã đó ghi đúng số VND của động cơ thuế
export interface LedgerLine { accountCode: string; debit: string; credit: string; amountCurrency: string; fxRate: string | null; partyCode: string | null; description: string | null; dueDate: string | null; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null; itemCode?: string | null; warehouseCode?: string | null }
// Số VND đã ghi sổ theo chiều của chứng từ (cơ sở luôn dương), để bảng kê hóa đơn (voucher_invoice) khớp đúng bút toán sau khi chia chênh làm tròn.
// taxVnd theo mã thuế = tổng các dòng thuế cùng chiều với thuế (dương); mã chỉ có dòng khấu trừ (TNCN) thì là tổng các dòng đó (âm).
export interface InvoiceLedgerDetail { lines: LedgerLine[]; baseVnd: Record<number, string>; taxVnd: Record<string, string> }

interface Entry { account: string; cur: Decimal; vnd: Decimal; src: Partial<LedgerLine>; lineNo?: number; taxCode?: string; fixed?: boolean; offset?: Decimal }

// Chiều Nợ dương. Hóa đơn mua Nợ chi phí/thuế, Có công nợ; hóa đơn bán ngược lại; giảm giá, trả lại đảo chiều toàn bộ so với hóa đơn cùng phạm vi.
// Tiền VND: các dòng lấy đúng số của động cơ thuế nên cân sẵn (công nợ = cơ sở + thuế theo dấu, số thuế ghi trên hóa đơn đã nằm trong dòng thuế, không cộng lại roundingVnd).
// Ngoại tệ (kiểm dòng của sổ cái: |làm tròn(nguyên tệ × tỷ giá) − (Nợ − Có)| ≤ 1): dòng công nợ và dòng thuế bắt đầu ở làm tròn(nguyên tệ × tỷ giá), riêng mã thuế có số ghi trên hóa đơn
// (declaredTaxVnd) lấy đúng số VND của động cơ thuế nếu lệch số làm tròn không quá 1 đồng mỗi dòng (quá thì TAX_DECLARED_MISMATCH) và không bị chia chênh;
// dòng cơ sở bắt đầu ở làm tròn(cơ sở × tỷ giá) rồi chia chênh lệch VND còn lại ±1 đồng mỗi dòng, dòng có số tiền tuyệt đối lớn nhất trước (cùng số: dòng nhỏ số trước);
// hết dòng cơ sở mà còn chênh thì chia tiếp cho các dòng thuế không cố định theo cùng thứ tự, cuối cùng đến dòng công nợ (nên số công nợ đã ghi lệch làm tròn(nguyên tệ × tỷ giá) tối đa 1 đồng và bảng kê khớp số đã ghi);
// vẫn còn thì INVOICE_ROUNDING_OVERFLOW. Mỗi dòng thuế cố định thêm tối đa 1 đồng chênh mà không chia được: với một mã thuế ghi trên hóa đơn luôn đủ chỗ chia, với nhiều mã ghi cùng lúc trên ít dòng thì có thể không đủ.
export function buildInvoiceLedgerDetail(i: InvoiceLedgerInput): InvoiceLedgerDetail {
  const isVnd = i.currency === 'VND';
  if (!isVnd && !i.fxRate) throw new Error(`Hóa đơn ${i.currency} phải có tỷ giá`);
  const sign = (i.scope === 'purchase' ? 1 : -1) * (i.documentType === 'refund' ? -1 : 1);
  const vndOf = (cur: string): Decimal => D(isVnd ? cur : toVnd(cur, i.fxRate!));
  const lineOf = new Map(i.tax.lines.map((l) => [l.lineNo, l]));
  const declared = new Set(isVnd ? [] : Object.keys(i.declaredTaxVnd ?? {}));

  const bases: Entry[] = []; const taxes: Entry[] = [];
  for (const it of i.items) {
    const t = lineOf.get(it.lineNo);
    if (!t) throw new Error(`Dòng ${it.lineNo} không có kết quả tính thuế`);
    if (D(t.baseCurrency).isZero()) continue;
    const offset = D(it.offsetVnd ?? 0); // chỉ VND (hóa đơn ngoại tệ hàng về trước không hỗ trợ)
    bases.push({ account: it.accountCode, cur: D(t.baseCurrency).times(sign).minus(offset), vnd: (isVnd ? D(t.baseVnd) : vndOf(t.baseCurrency)).times(sign).minus(offset), lineNo: it.lineNo, offset,
      src: { description: it.description, departmentCode: it.departmentCode ?? null, projectCode: it.projectCode ?? null, costItemCode: it.costItemCode ?? null, itemCode: it.itemCode ?? null, warehouseCode: it.warehouseCode ?? null } });
  }
  for (const p of i.tax.postings) {
    const exact = vndOf(p.amountCurrency); const fixed = declared.has(p.code);
    if (fixed && D(p.amountVnd).minus(exact).abs().gt(1))
      throw new TaxError('TAX_DECLARED_MISMATCH', `Thuế ${p.code} ghi trên hóa đơn ${p.amountVnd} đồng lệch quá 1 đồng so với số quy đổi từ nguyên tệ ${p.amountCurrency} × tỷ giá ${i.fxRate} = ${exact.toFixed(0)} đồng`);
    const cur = D(p.amountCurrency).times(sign); const vnd = (isVnd || fixed ? D(p.amountVnd) : exact).times(sign);
    if (cur.isZero() && vnd.isZero()) continue;
    taxes.push({ account: p.accountCode, cur, vnd, taxCode: p.code, fixed, src: { description: `Thuế ${p.code}` } });
  }
  const counterCur = ZERO.minus(sum([...bases, ...taxes].map((e) => e.cur)));
  const counter: Entry = { account: i.counterAccountCode, cur: counterCur, vnd: isVnd ? ZERO.minus(sum([...bases, ...taxes].map((e) => e.vnd))) : vndOf(counterCur.toFixed()),
    src: { partyCode: i.partyCode, dueDate: i.dueDate } };

  const imbalance = sum([...bases, ...taxes, counter].map((e) => e.vnd));
  if (!imbalance.isZero()) {
    const step = imbalance.isPos() ? -1 : 1;
    const bySize = (es: Entry[]) => es.map((e, k) => ({ e, k })).sort((a, b) => b.e.vnd.abs().comparedTo(a.e.vnd.abs()) || a.k - b.k).map((x) => x.e);
    // mỗi dòng nhích tối đa một lần ±1 và không đổi sang bên đối với dấu nguyên tệ (ràng buộc sign_consistent của dòng sổ cái)
    const movable = [...bySize(bases), ...bySize(taxes.filter((e) => !e.fixed)), counter].filter((e) => !(e.cur.isPos() && e.vnd.plus(step).isNeg()) && !(e.cur.isNeg() && e.vnd.plus(step).isPos()));
    if (imbalance.abs().gt(movable.length))
      throw new TaxError('INVOICE_ROUNDING_OVERFLOW', `Chênh lệch làm tròn ${imbalance.toFixed()} đồng vượt số dòng có thể chia (${movable.length}), không thể chia ±1 đồng mỗi dòng: hãy tách hóa đơn hoặc kiểm tra số tiền và số thuế ghi trên hóa đơn`);
    for (let n = 0; n < imbalance.abs().toNumber(); n++) movable[n]!.vnd = movable[n]!.vnd.plus(step);
  }

  const toLine = (e: Entry): LedgerLine => ({
    accountCode: e.account, debit: e.vnd.isPos() ? e.vnd.toFixed(0) : '0', credit: e.vnd.isNeg() ? e.vnd.neg().toFixed(0) : '0', amountCurrency: e.cur.isZero() ? '0' : e.cur.toFixed(),
    fxRate: isVnd ? null : i.fxRate, partyCode: null, description: null, dueDate: null, ...e.src });
  const entries = [...bases, ...taxes, counter].filter((e) => !(e.cur.isZero() && e.vnd.isZero()));
  const baseVnd: Record<number, string> = Object.fromEntries(i.items.map((it) => [it.lineNo, '0']));
  for (const e of bases) baseVnd[e.lineNo!] = e.vnd.times(sign).plus(e.offset ?? 0).toFixed(0);
  const taxVnd: Record<string, string> = {};
  for (const code of new Set(taxes.map((e) => e.taxCode!))) {
    const mine = taxes.filter((e) => e.taxCode === code).map((e) => e.vnd.times(sign));
    taxVnd[code] = sum(mine.some((v) => v.isPos()) ? mine.filter((v) => v.isPos()) : mine).toFixed(0);
  }
  return { lines: entries.map(toLine), baseVnd, taxVnd };
}

export const buildInvoiceLedger = (i: InvoiceLedgerInput): LedgerLine[] => buildInvoiceLedgerDetail(i).lines;
