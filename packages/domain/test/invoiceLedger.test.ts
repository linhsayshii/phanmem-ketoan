import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildInvoiceLedger, buildInvoiceLedgerDetail, computeTaxes, D, sum, toVnd, type InvoiceItemInput, type InvoiceLedgerInput, type LedgerLine, type TaxDef, type TaxDistribution } from '../src/index.js';

// Phân bổ mặc định như seed_tenant_defaults (0031): mua 1331, bán 33311, giảm giá/trả lại cùng tài khoản; TNCN khấu trừ tại nguồn -100% vào 3335.
const vatDist = (): TaxDistribution[] => (['invoice', 'refund'] as const).flatMap((documentType) => [
  { documentType, scope: 'purchase' as const, lineType: 'tax' as const, factorPercent: '100', accountCode: '1331', reportTag: 'purchase_tax' },
  { documentType, scope: 'sale' as const, lineType: 'tax' as const, factorPercent: '100', accountCode: '33311', reportTag: 'sale_tax' }]);
const vat = (code: string, rate: string | null, extra: Partial<TaxDef> = {}): TaxDef => ({ code, kind: 'vat', method: 'deduct', rate, priceInclude: false, distributions: vatDist(), ...extra });
const TAXES: Record<string, TaxDef> = {
  V0: vat('V0', '0'), V5: vat('V5', '5'), V8: vat('V8', '8'), V10: vat('V10', '10'), KCT: vat('KCT', null, { method: 'none' }),
  TNCN_KT: { code: 'TNCN_KT', kind: 'pit', method: 'deduct', rate: '10', priceInclude: false,
    distributions: (['invoice', 'refund'] as const).map((documentType) => ({ documentType, scope: 'purchase' as const, lineType: 'tax' as const, factorPercent: '-100', accountCode: '3335', reportTag: null })) },
};
const item = (lineNo: number, amountCurrency: string, taxCodes: string[], more: Partial<InvoiceItemInput> = {}): InvoiceItemInput =>
  ({ lineNo, description: `Dòng ${lineNo}`, accountCode: '5113', amountCurrency, discountCurrency: '0', taxCodes, ...more });

type Base = Pick<InvoiceLedgerInput, 'scope' | 'documentType' | 'currency' | 'fxRate'> & { counterAccountCode?: string; dueDate?: string | null; declaredTaxVnd?: Record<string, string> };
function ledger(items: InvoiceItemInput[], b: Base) {
  const tax = computeTaxes(items.map((i) => ({ lineNo: i.lineNo, amountCurrency: i.amountCurrency, discountCurrency: i.discountCurrency, taxCodes: i.taxCodes })), TAXES,
    { scope: b.scope, documentType: b.documentType, currency: b.currency, fxRate: b.fxRate, ...(b.declaredTaxVnd && { declaredTaxVnd: b.declaredTaxVnd }) });
  const input: InvoiceLedgerInput = { scope: b.scope, documentType: b.documentType, counterAccountCode: b.counterAccountCode ?? (b.scope === 'sale' ? '131' : '331'), partyCode: 'KH001',
    currency: b.currency, fxRate: b.fxRate, dueDate: b.dueDate ?? null, items, tax };
  return { input, lines: buildInvoiceLedger(input) };
}
const VND = (scope: 'sale' | 'purchase', documentType: 'invoice' | 'refund' = 'invoice'): Base => ({ scope, documentType, currency: 'VND', fxRate: null });
const side = (l: LedgerLine) => (l.debit !== '0' ? { account: l.accountCode, debit: l.debit } : { account: l.accountCode, credit: l.credit });
const totals = (lines: LedgerLine[]) => ({ debit: sum(lines.map((l) => l.debit)), credit: sum(lines.map((l) => l.credit)), cur: sum(lines.map((l) => l.amountCurrency)) });

describe('bút toán hóa đơn', () => {
  it('bán: Có doanh thu theo dòng (sau chiết khấu), Có 33311 từng mức thuế, Nợ 131 một dòng có đối tượng và hạn thanh toán', () => {
    const items = [item(1, '10000000', ['V10'], { discountCurrency: '500000' }), item(2, '5000000', ['V8'], { discountCurrency: '250000' })];
    const { lines } = ledger(items, { ...VND('sale'), dueDate: '2026-02-15' });
    expect(lines.map(side)).toEqual([
      { account: '5113', credit: '9500000' }, { account: '5113', credit: '4750000' },
      { account: '33311', credit: '950000' }, { account: '33311', credit: '380000' },
      { account: '131', debit: '15580000' }]);
    const counter = lines.at(-1)!;
    expect(counter).toMatchObject({ partyCode: 'KH001', dueDate: '2026-02-15', amountCurrency: '15580000', fxRate: null });
    expect(lines.slice(0, 2).map((l) => [l.description, l.partyCode, l.dueDate])).toEqual([['Dòng 1', null, null], ['Dòng 2', null, null]]);
    expect(lines[0]!.amountCurrency).toBe('-9500000'); // VND: nguyên tệ = Nợ − Có
  });

  it('mua của cá nhân 10.000.000 khấu trừ TNCN 10%: Nợ 6422 10tr / Có 3335 1tr / Có 331 9tr', () => {
    const { lines } = ledger([item(1, '10000000', ['TNCN_KT'], { accountCode: '6422' })], VND('purchase'));
    expect(lines.map(side)).toEqual([{ account: '6422', debit: '10000000' }, { account: '3335', credit: '1000000' }, { account: '331', credit: '9000000' }]);
  });

  it('mua có GTGT và TNCN cùng dòng: Nợ 1331, Có 3335, Có 331 = cơ sở + GTGT − TNCN', () => {
    const { lines } = ledger([item(1, '10000000', ['V10', 'TNCN_KT'], { accountCode: '6422' })], VND('purchase'));
    expect(lines.map(side)).toEqual([{ account: '6422', debit: '10000000' }, { account: '1331', debit: '1000000' }, { account: '3335', credit: '1000000' }, { account: '331', credit: '10000000' }]);
  });

  it('giảm giá, trả lại đảo chiều toàn bộ so với hóa đơn cùng phạm vi', () => {
    const items = [item(1, '10000000', ['V10'], { discountCurrency: '500000' }), item(2, '5000000', ['V8'])];
    for (const scope of ['sale', 'purchase'] as const) {
      const inv = ledger(items, VND(scope)).lines; const ref = ledger(items, VND(scope, 'refund')).lines;
      expect(ref.map((l) => [l.accountCode, l.debit, l.credit])).toEqual(inv.map((l) => [l.accountCode, l.credit, l.debit]));
      expect(ref.map((l) => l.amountCurrency)).toEqual(inv.map((l) => D(l.amountCurrency).neg().toFixed()));
      expect(ref.at(-1)!.dueDate).toBeNull();
    }
  });

  it('bỏ dòng có nguyên tệ 0: dòng cơ sở 0 và thuế 0; mã không tính thuế không sinh dòng thuế', () => {
    const { lines } = ledger([item(1, '0', ['V10']), item(2, '2000000', ['KCT']), item(3, '1000000', ['V0'])], VND('sale'));
    expect(lines.map(side)).toEqual([{ account: '5113', credit: '2000000' }, { account: '5113', credit: '1000000' }, { account: '131', debit: '3000000' }]);
  });

  it('thuế ghi trên hóa đơn lệch vài đồng: dòng thuế và dòng công nợ theo số ghi trên hóa đơn, không cộng thêm roundingVnd', () => {
    const items = [1, 2, 3].map((n) => item(n, '333333', ['V10']));
    const { lines, input } = ledger(items, { ...VND('sale'), declaredTaxVnd: { V10: '100000' } });
    expect(input.tax.roundingVnd).toBe('1');
    expect(lines.map(side).slice(3)).toEqual([{ account: '33311', credit: '100000' }, { account: '131', debit: '1099999' }]);
    expect(totals(lines).debit.eq(totals(lines).credit)).toBe(true);
  });

  it('ngoại tệ: dòng công nợ và dòng thuế lấy đúng nguyên tệ × tỷ giá, dòng cơ sở nhận chênh ±1 đồng, lớn nhất trước; cân VND và nguyên tệ', () => {
    // 3 dòng 0,50 USD × 25.001: mỗi dòng cơ sở 12.500,5 → 12.501; thuế 10% = 0,15 USD (chỉ bằng 0,05 × 3) → 3.750,15
    const items = [item(1, '33.33', ['V10']), item(2, '33.33', ['V10']), item(3, '33.34', ['V10'])];
    const b: Base = { scope: 'sale', documentType: 'invoice', currency: 'USD', fxRate: '25432.5' };
    const { lines, input } = ledger(items, b);
    const detail = buildInvoiceLedgerDetail(input);
    const t = totals(lines);
    expect(t.debit.eq(t.credit)).toBe(true);
    expect(t.cur.isZero()).toBe(true);
    for (const l of lines) expect(D(toVnd(l.amountCurrency, '25432.5')).minus(D(l.debit).minus(l.credit)).abs().lte(1), `${l.accountCode} ${l.amountCurrency}`).toBe(true);
    const counter = lines.at(-1)!;
    expect(counter.debit).toBe(toVnd(counter.amountCurrency, '25432.5')); // công nợ: đúng nguyên tệ × tỷ giá
    const tax = lines.find((l) => l.accountCode === '33311')!;
    expect(tax.credit).toBe(toVnd(D(tax.amountCurrency).neg().toFixed(), '25432.5'));
    // voucher_invoice lấy số sau khi chia chênh: cơ sở + thuế đã ghi khớp dòng công nợ
    expect(D(sum(Object.values(detail.baseVnd))).plus(sum(Object.values(detail.taxVnd))).toFixed()).toBe(counter.debit);
    expect(Object.keys(detail.baseVnd)).toEqual(['1', '2', '3']);
  });

  it('chia chênh ±1 đồng ưu tiên dòng cơ sở lớn nhất; chênh vượt số dòng cơ sở thì ném lỗi nội bộ', () => {
    // 1,00 + 3,00 + 1,00 USD × 1,5: cơ sở 1,5 → 2; 4,5 → 5; 1,5 → 2 (cộng 9) nhưng công nợ 5,00 × 1,5 = 7,5 → 8: lệch 1 đồng, trừ vào dòng lớn nhất
    const items = [item(1, '1.00', []), item(2, '3.00', []), item(3, '1.00', [])];
    const { lines, input } = ledger(items, { scope: 'purchase', documentType: 'invoice', currency: 'USD', fxRate: '1.5' });
    expect(buildInvoiceLedgerDetail(input).baseVnd).toEqual({ 1: '2', 2: '4', 3: '2' });
    expect(lines.map(side)).toEqual([{ account: '5113', debit: '2' }, { account: '5113', debit: '4' }, { account: '5113', debit: '2' }, { account: '331', credit: '8' }]);
    // 1 dòng cơ sở 0,01 USD × 50 = 0,5 → 1 và 3 dòng thuế mỗi dòng 0,01 USD → 1: công nợ 0,04 × 50 = 2, lệch 2 đồng > 1 dòng cơ sở → lỗi nội bộ, không ghi bút toán sai
    const tax = computeTaxes([{ lineNo: 1, amountCurrency: '0.01', discountCurrency: '0', taxCodes: [] }], TAXES, { scope: 'sale', documentType: 'invoice', currency: 'USD', fxRate: '50' });
    const forged = { ...tax, postings: [1, 2, 3].map(() => ({ code: 'V10', accountCode: '33311', amountVnd: '1', amountCurrency: '0.01', reportTag: null })) };
    expect(() => buildInvoiceLedger({ scope: 'sale', documentType: 'invoice', counterAccountCode: '131', partyCode: 'KH001', currency: 'USD', fxRate: '50', dueDate: null, items: [item(1, '0.01', [])], tax: forged }))
      .toThrow(/INVOICE_LEDGER_UNBALANCED/);
  });
});

describe('thuộc tính bút toán hóa đơn', () => {
  const amount = fc.integer({ min: 0, max: 5_000_000_000 }).map(String);
  const codes = fc.constantFrom([], ['V0'], ['V5'], ['V8'], ['V10'], ['KCT']);
  const itemsVnd = fc.array(fc.record({ amt: amount, disc: fc.integer({ min: 0, max: 100 }), codes: fc.oneof(codes, fc.constant(['V10', 'TNCN_KT']), fc.constant(['TNCN_KT'])) }), { minLength: 1, maxLength: 8 })
    .map((xs) => xs.map((x, i) => item(i + 1, x.amt, x.codes, { discountCurrency: D(x.amt).times(x.disc).div(100).toDecimalPlaces(0).toFixed(), accountCode: i % 2 ? '6422' : '5113' })));

  it('VND: luôn cân Nợ = Có, công nợ một dòng, mọi dòng là số nguyên đồng', () => {
    fc.assert(fc.property(itemsVnd, fc.constantFrom('sale', 'purchase') as fc.Arbitrary<'sale' | 'purchase'>, fc.constantFrom('invoice', 'refund') as fc.Arbitrary<'invoice' | 'refund'>, (items, scope, documentType) => {
      const withTncn = items.some((i) => i.taxCodes.includes('TNCN_KT'));
      if (scope === 'sale' && withTncn) return; // TNCN_KT chỉ có phân bổ mua vào
      const { lines } = ledger(items, VND(scope, documentType));
      const t = totals(lines);
      expect(t.debit.eq(t.credit)).toBe(true);
      expect(t.cur.isZero()).toBe(true);
      expect(lines.filter((l) => l.accountCode === (scope === 'sale' ? '131' : '331')).length).toBeLessThanOrEqual(1);
      for (const l of lines) expect(l.debit === '0' || l.credit === '0').toBe(true);
    }), { numRuns: 300 });
  });

  it('ngoại tệ: cân VND và nguyên tệ, mọi dòng lệch quy đổi không quá 1 đồng (một mã thuế mỗi dòng)', () => {
    const cents = fc.integer({ min: 1, max: 99_999_999 }).map((n) => (n / 100).toFixed(2));
    const itemsFx = fc.array(fc.record({ amt: cents, codes: fc.constantFrom(['V5'], ['V8'], ['V10'], [] as string[]) }), { minLength: 1, maxLength: 6 }).map((xs) => xs.map((x, i) => item(i + 1, x.amt, x.codes)));
    const rate = fc.tuple(fc.integer({ min: 1, max: 30_000 }), fc.integer({ min: 0, max: 99 })).map(([a, b]) => `${a}.${String(b).padStart(2, '0')}`);
    fc.assert(fc.property(itemsFx, rate, fc.constantFrom('sale', 'purchase') as fc.Arbitrary<'sale' | 'purchase'>, (items, fx, scope) => {
      const { lines } = ledger(items, { scope, documentType: 'invoice', currency: 'USD', fxRate: fx });
      const t = totals(lines);
      expect(t.debit.eq(t.credit)).toBe(true);
      expect(t.cur.isZero()).toBe(true);
      for (const l of lines) expect(D(toVnd(l.amountCurrency, fx)).minus(D(l.debit).minus(l.credit)).abs().lte(1)).toBe(true);
    }), { numRuns: 400 });
  });
});
