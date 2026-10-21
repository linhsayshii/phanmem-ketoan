import { D, ZERO, sum, type Decimal } from './money.js';
import { toVnd } from './fx.js';
import type { TaxResult } from './tax.js';

// Bút toán của hóa đơn mua/bán dịch vụ và giảm giá, trả lại (HDB, HDM, GGB, GGM). Kết quả của động cơ thuế (`computeTaxes`) vào, các dòng sổ cái ra.
export interface InvoiceItemInput { lineNo: number; description: string | null; accountCode: string; amountCurrency: string; discountCurrency: string; taxCodes: string[]; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null }
export interface InvoiceLedgerInput { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; counterAccountCode: string; partyCode: string; currency: string; fxRate: string | null; dueDate: string | null; items: InvoiceItemInput[]; tax: TaxResult }
export interface LedgerLine { accountCode: string; debit: string; credit: string; amountCurrency: string; fxRate: string | null; partyCode: string | null; description: string | null; dueDate: string | null; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null }
// Số VND đã ghi sổ theo chiều của chứng từ (cơ sở luôn dương; thuế khấu trừ tại nguồn âm), để bảng kê hóa đơn (voucher_invoice) khớp đúng bút toán sau khi chia chênh làm tròn.
export interface InvoiceLedgerDetail { lines: LedgerLine[]; baseVnd: Record<number, string>; taxVnd: Record<string, string> }

interface Entry { account: string; cur: Decimal; vnd: Decimal; src: Partial<LedgerLine>; lineNo?: number; taxCode?: string }

// Chiều Nợ dương. Hóa đơn mua Nợ chi phí/thuế, Có công nợ; hóa đơn bán ngược lại; giảm giá, trả lại đảo chiều toàn bộ so với hóa đơn cùng phạm vi.
// Tiền VND: các dòng lấy đúng số của động cơ thuế nên cân sẵn (công nợ = cơ sở + thuế theo dấu, số thuế ghi trên hóa đơn đã nằm trong dòng thuế, không cộng lại roundingVnd).
// Ngoại tệ (kiểm dòng của sổ cái: |làm tròn(nguyên tệ × tỷ giá) − (Nợ − Có)| ≤ 1): dòng công nợ và dòng thuế lấy đúng làm tròn(nguyên tệ × tỷ giá);
// dòng cơ sở bắt đầu ở làm tròn(cơ sở × tỷ giá) rồi chia chênh lệch VND còn lại ±1 đồng mỗi dòng, dòng có số tiền tuyệt đối lớn nhất trước (cùng số: dòng nhỏ số trước).
export function buildInvoiceLedgerDetail(i: InvoiceLedgerInput): InvoiceLedgerDetail {
  const isVnd = i.currency === 'VND';
  if (!isVnd && !i.fxRate) throw new Error(`Hóa đơn ${i.currency} phải có tỷ giá`);
  const sign = (i.scope === 'purchase' ? 1 : -1) * (i.documentType === 'refund' ? -1 : 1);
  const vndOf = (cur: string): Decimal => D(isVnd ? cur : toVnd(cur, i.fxRate!));
  const lineOf = new Map(i.tax.lines.map((l) => [l.lineNo, l]));

  const bases: Entry[] = []; const taxes: Entry[] = [];
  for (const it of i.items) {
    const t = lineOf.get(it.lineNo);
    if (!t) throw new Error(`Dòng ${it.lineNo} không có kết quả tính thuế`);
    if (D(t.baseCurrency).isZero()) continue;
    bases.push({ account: it.accountCode, cur: D(t.baseCurrency).times(sign), vnd: (isVnd ? D(t.baseVnd) : vndOf(t.baseCurrency)).times(sign), lineNo: it.lineNo,
      src: { description: it.description, departmentCode: it.departmentCode ?? null, projectCode: it.projectCode ?? null, costItemCode: it.costItemCode ?? null } });
  }
  for (const p of i.tax.postings) {
    const cur = D(p.amountCurrency).times(sign); const vnd = (isVnd ? D(p.amountVnd) : vndOf(p.amountCurrency)).times(sign);
    if (cur.isZero() && vnd.isZero()) continue;
    taxes.push({ account: p.accountCode, cur, vnd, taxCode: p.code, src: { description: `Thuế ${p.code}` } });
  }
  const counterCur = ZERO.minus(sum([...bases, ...taxes].map((e) => e.cur)));
  const counter: Entry = { account: i.counterAccountCode, cur: counterCur, vnd: isVnd ? ZERO.minus(sum([...bases, ...taxes].map((e) => e.vnd))) : vndOf(counterCur.toFixed()),
    src: { partyCode: i.partyCode, dueDate: i.dueDate } };

  const imbalance = sum([...bases, ...taxes, counter].map((e) => e.vnd));
  if (!imbalance.isZero()) {
    if (imbalance.abs().gt(bases.length))
      throw new Error(`INVOICE_LEDGER_UNBALANCED: chênh lệch làm tròn ${imbalance.toFixed()} đồng vượt số dòng cơ sở (${bases.length}), không thể chia ±1 đồng mỗi dòng`);
    const step = imbalance.isPos() ? -1 : 1;
    const order = bases.map((e, k) => ({ e, k })).sort((a, b) => b.e.vnd.abs().comparedTo(a.e.vnd.abs()) || a.k - b.k);
    for (let n = 0; n < imbalance.abs().toNumber(); n++) order[n]!.e.vnd = order[n]!.e.vnd.plus(step);
  }

  const toLine = (e: Entry): LedgerLine => ({
    accountCode: e.account, debit: e.vnd.isPos() ? e.vnd.toFixed(0) : '0', credit: e.vnd.isNeg() ? e.vnd.neg().toFixed(0) : '0', amountCurrency: e.cur.isZero() ? '0' : e.cur.toFixed(),
    fxRate: isVnd ? null : i.fxRate, partyCode: null, description: null, dueDate: null, ...e.src });
  const entries = [...bases, ...taxes, counter].filter((e) => !(e.cur.isZero() && e.vnd.isZero()));
  const baseVnd: Record<number, string> = Object.fromEntries(i.items.map((it) => [it.lineNo, '0']));
  for (const e of bases) baseVnd[e.lineNo!] = e.vnd.times(sign).toFixed(0);
  const taxVnd: Record<string, string> = {};
  for (const e of taxes) taxVnd[e.taxCode!] = D(taxVnd[e.taxCode!] ?? 0).plus(e.vnd.times(sign)).toFixed(0);
  return { lines: entries.map(toLine), baseVnd, taxVnd };
}

export const buildInvoiceLedger = (i: InvoiceLedgerInput): LedgerLine[] => buildInvoiceLedgerDetail(i).lines;
