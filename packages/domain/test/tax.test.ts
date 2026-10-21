import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeTaxes, D, Decimal, sum, TaxError, toVnd, type TaxDef, type TaxDistribution, type TaxableLine } from '../src/index.js';

// Phân bổ mặc định như seed_tenant_defaults (0031): mua 1331, bán 33311, giảm giá/trả lại cùng tài khoản; TNCN khấu trừ tại nguồn -100% vào 3335.
const vatDist = (): TaxDistribution[] => (['invoice', 'refund'] as const).flatMap((documentType) => [
  { documentType, scope: 'purchase' as const, lineType: 'tax' as const, factorPercent: '100', accountCode: '1331', reportTag: 'purchase_tax' },
  { documentType, scope: 'sale' as const, lineType: 'tax' as const, factorPercent: '100', accountCode: '33311', reportTag: 'sale_tax' }]);
const vat = (code: string, rate: string | null, extra: Partial<TaxDef> = {}): TaxDef => ({ code, kind: 'vat', method: 'deduct', rate, priceInclude: false, distributions: vatDist(), ...extra });
const TAXES: Record<string, TaxDef> = {
  V0: vat('V0', '0'), V5: vat('V5', '5'), V8: vat('V8', '8'), V10: vat('V10', '10'),
  V10G: vat('V10G', '10', { priceInclude: true }),
  KCT: vat('KCT', null, { method: 'none' }),
  TT3: vat('TT3', '3', { method: 'direct', distributions: [] }),
  TNCN_KT: { code: 'TNCN_KT', kind: 'pit', method: 'deduct', rate: '10', priceInclude: false,
    distributions: (['invoice', 'refund'] as const).map((documentType) => ({ documentType, scope: 'purchase' as const, lineType: 'tax' as const, factorPercent: '-100', accountCode: '3335', reportTag: null })) },
};
const SALE = { scope: 'sale', documentType: 'invoice', currency: 'VND', fxRate: null } as const;
const PURCHASE = { scope: 'purchase', documentType: 'invoice', currency: 'VND', fxRate: null } as const;
const line = (lineNo: number, amountCurrency: string, taxCodes: string[], discountCurrency = '0'): TaxableLine => ({ lineNo, amountCurrency, discountCurrency, taxCodes });
const err = (f: () => unknown): TaxError => { try { f(); } catch (e) { if (e instanceof TaxError) return e; throw e; } throw new Error('không ném lỗi'); };

describe('động cơ thuế', () => {
  it('3 dòng 333.333 đ thuế 10%: mỗi dòng 33.333, hóa đơn ghi 100.000 → dồn 1 đồng, roundingVnd = 1', () => {
    const lines = [1, 2, 3].map((n) => line(n, '333333', ['V10']));
    const plain = computeTaxes(lines, TAXES, SALE);
    expect(plain.lines.map((l) => l.taxes[0]!.amountVnd)).toEqual(['33333', '33333', '33333']);
    expect(plain.roundingVnd).toBe('0');
    const r = computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { V10: '100000' } });
    expect(r.roundingVnd).toBe('1');
    // chênh dồn vào dòng có thuế lớn nhất (bằng nhau: dòng đầu), bảng kê không có dòng lẻ
    expect(r.lines.map((l) => l.taxes[0]!.amountVnd)).toEqual(['33334', '33333', '33333']);
    expect(r.lines[0]!.taxes[0]!.amountCurrency).toBe('33334');
    expect(r.lines.map((l) => l.baseVnd)).toEqual(['333333', '333333', '333333']);
    expect(r.postings).toEqual([{ code: 'V10', accountCode: '33311', amountVnd: '100000', amountCurrency: '100000', reportTag: 'sale_tax' }]);
  });

  it('chênh lớn hơn số dòng → TAX_DECLARED_MISMATCH', () => {
    const lines = [1, 2, 3].map((n) => line(n, '333333', ['V10']));
    expect(computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { V10: '100002' } }).roundingVnd).toBe('3'); // 3 dòng: lệch 3 còn nhận
    expect(computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { V10: '99996' } }).roundingVnd).toBe('-3');
    expect(err(() => computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { V10: '100003' } })).code).toBe('TAX_DECLARED_MISMATCH');
    expect(err(() => computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { V5: '1' } })).code).toBe('TAX_DECLARED_MISMATCH'); // mã không có trên dòng nào
  });

  it('mã không chịu thuế, trực tiếp hoặc 0% chỉ nhận thuế ghi trên hóa đơn bằng 0, không dồn chênh vào', () => {
    for (const code of ['KCT', 'TT3', 'V0']) {
      const lines = [line(1, '5000000', [code])];
      expect(computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { [code]: '0' } }).postings).toEqual([]);
      expect(err(() => computeTaxes(lines, TAXES, { ...SALE, declaredTaxVnd: { [code]: '1' } })).code).toBe('TAX_DECLARED_MISMATCH');
    }
  });

  it('dồn chênh cả GTGT và TNCN khấu trừ: roundingVnd theo dấu phân bổ (1331 −2, 3335 +2 → 0)', () => {
    const lines = [1, 2].map((n) => line(n, '333335', ['V10', 'TNCN_KT'])); // mỗi dòng 33.333,5 → 33.334
    const r = computeTaxes(lines, TAXES, { ...PURCHASE, declaredTaxVnd: { V10: '66666', TNCN_KT: '66666' } });
    expect(r.postings.map((p) => [p.accountCode, p.amountVnd])).toEqual([['1331', '66666'], ['3335', '-66666']]);
    expect(r.roundingVnd).toBe('0');
    const vatOnly = computeTaxes(lines, TAXES, { ...PURCHASE, declaredTaxVnd: { V10: '66666' } });
    expect(vatOnly.roundingVnd).toBe('-2');
  });

  it('một mã thuế ghi hai lần trên một dòng → TAX_CODE_DUPLICATE; phân bổ không đủ 100% → TAX_DISTRIBUTION_INVALID', () => {
    expect(err(() => computeTaxes([line(1, '100', ['V10', 'V10'])], TAXES, SALE)).code).toBe('TAX_CODE_DUPLICATE');
    const half = vat('VH', '10', { distributions: [{ documentType: 'invoice', scope: 'sale', lineType: 'tax', factorPercent: '50', accountCode: '33311', reportTag: null }] });
    expect(err(() => computeTaxes([line(1, '1000', ['VH'])], { VH: half }, SALE)).code).toBe('TAX_DISTRIBUTION_INVALID');
    const over = vat('VO', '10', { distributions: [-100, -50].map((f) => ({ documentType: 'invoice' as const, scope: 'sale' as const, lineType: 'tax' as const, factorPercent: String(f), accountCode: '3335', reportTag: null })) });
    expect(err(() => computeTaxes([line(1, '1000', ['VO'])], { VO: over }, SALE)).code).toBe('TAX_DISTRIBUTION_INVALID');
  });

  it('chi trả cá nhân 10.000.000 có TNCN_KT 10%: posting 3335 = -1.000.000', () => {
    const r = computeTaxes([line(1, '10000000', ['TNCN_KT'])], TAXES, PURCHASE);
    expect(r.lines[0]).toMatchObject({ baseVnd: '10000000', taxes: [{ code: 'TNCN_KT', amountCurrency: '1000000', amountVnd: '1000000' }] });
    expect(r.postings).toEqual([{ code: 'TNCN_KT', accountCode: '3335', amountVnd: '-1000000', amountCurrency: '-1000000', reportTag: null }]);
    // cùng dòng có GTGT 10%: thuế GTGT vào 1331, TNCN trừ vào 3335
    const both = computeTaxes([line(1, '10000000', ['V10', 'TNCN_KT'])], TAXES, PURCHASE);
    expect(both.postings.map((p) => [p.accountCode, p.amountVnd])).toEqual([['1331', '1000000'], ['3335', '-1000000']]);
  });

  it('giá đã gồm thuế 11.000.000 thuế 10% → cơ sở 10.000.000, thuế 1.000.000', () => {
    const r = computeTaxes([line(1, '11000000', ['V10G'])], TAXES, SALE);
    expect(r.lines[0]).toMatchObject({ baseCurrency: '10000000', baseVnd: '10000000', taxes: [{ code: 'V10G', amountCurrency: '1000000', amountVnd: '1000000' }] });
    // tách ngược: thuế = round(tổng × 10/110) trước, cơ sở = tổng − thuế (không lệch 1 đồng)
    const odd = computeTaxes([line(1, '1000000', ['V10G'], '1')], TAXES, SALE);
    expect(odd.lines[0]!.baseCurrency).toBe('909090'); // 999.999 × 10/110 = 90.909
    expect(odd.lines[0]!.taxes[0]!.amountCurrency).toBe('90909');
    // dồn chênh vào dòng giá đã gồm thuế: tổng thanh toán giữ nguyên, cơ sở nhận phần ngược lại
    const three = [1, 2, 3].map((n) => line(n, '1000000', ['V10G'])); // mỗi dòng thuế 90.909, cơ sở 909.091
    const r2 = computeTaxes(three, TAXES, { ...SALE, declaredTaxVnd: { V10G: '272728' } });
    expect(r2.lines.map((l) => [l.baseVnd, l.baseCurrency, l.taxes[0]!.amountVnd])).toEqual([['909090', '909090', '90910'], ['909091', '909091', '90909'], ['909091', '909091', '90909']]);
    expect(r2.roundingVnd).toBe('0');
  });

  it('USD giá đã gồm thuế 4 chữ số lẻ 100,5555 @25.000: thuế 9,14, cơ sở 91,4155, cơ sở + thuế = tổng cả nguyên tệ và VND', () => {
    const r = computeTaxes([line(1, '100.5555', ['V10G'])], TAXES, { ...SALE, currency: 'USD', fxRate: '25000' });
    const l = r.lines[0]!;
    expect(l.taxes).toEqual([{ code: 'V10G', amountCurrency: '9.14', amountVnd: '228500' }]); // 100,5555 × 10/110 = 9,1414 → 9,14; VND = toVnd(9,14)
    expect(l.baseCurrency).toBe('91.4155');
    expect(D(l.baseCurrency).plus(l.taxes[0]!.amountCurrency).toFixed()).toBe('100.5555');
    expect(l.baseVnd).toBe('2285388'); // toVnd(100,5555) 2.513.888 − 228.500
    expect(D(l.baseVnd).plus(l.taxes[0]!.amountVnd).toFixed(0)).toBe(toVnd('100.5555', '25000'));
    expect(r.postings).toEqual([{ code: 'V10G', accountCode: '33311', amountVnd: '228500', amountCurrency: '9.14', reportTag: 'sale_tax' }]);
  });

  it('USD 2 dòng 100,55 @25.400: cơ sở VND từng dòng làm tròn rồi cộng', () => {
    const usd = { ...SALE, currency: 'USD', fxRate: '25400' };
    const r = computeTaxes([line(1, '100.55', ['V10']), line(2, '100.55', ['V10'])], TAXES, usd);
    expect(r.lines.map((l) => [l.baseCurrency, l.baseVnd])).toEqual([['100.55', '2553970'], ['100.55', '2553970']]);
    expect(r.lines.map((l) => [l.taxes[0]!.amountCurrency, l.taxes[0]!.amountVnd])).toEqual([['10.06', '255524'], ['10.06', '255524']]); // 10,055 → 10,06
    expect(r.postings).toEqual([{ code: 'V10', accountCode: '33311', amountVnd: '511048', amountCurrency: '20.12', reportTag: 'sale_tax' }]);
    // tỷ giá lẻ: từng dòng 2.554.020,275 → 2.554.020; cộng 5.108.040, khác quy đổi tổng 201,10 (5.108.041)
    const odd = computeTaxes([line(1, '100.55', ['V10']), line(2, '100.55', ['V10'])], TAXES, { ...usd, fxRate: '25400.5' });
    expect(sum(odd.lines.map((l) => l.baseVnd)).toFixed(0)).toBe('5108040');
    expect(toVnd('201.10', '25400.5')).toBe('5108041');
    expect(err(() => computeTaxes([line(1, '1', ['V10'])], TAXES, { ...usd, fxRate: null })).code).toBe('TAX_FX_RATE_REQUIRED');
  });

  it('thiếu thuế suất, mã lạ, thiếu phân bổ; không chịu thuế và phương pháp trực tiếp không sinh thuế', () => {
    expect(err(() => computeTaxes([line(1, '100', ['VX'])], { ...TAXES, VX: vat('VX', null) }, SALE)).code).toBe('TAX_RATE_MISSING');
    expect(err(() => computeTaxes([line(1, '100', ['TNCN_KT'])], { TNCN_KT: { ...TAXES.TNCN_KT!, rate: null } }, PURCHASE)).code).toBe('TAX_RATE_MISSING');
    expect(err(() => computeTaxes([line(1, '100', ['NOPE'])], TAXES, SALE)).code).toBe('TAX_CODE_UNKNOWN');
    // TNCN_KT chỉ có phân bổ mua vào: dùng trên hóa đơn bán thì không biết ghi tài khoản nào
    expect(err(() => computeTaxes([line(1, '100', ['TNCN_KT'])], TAXES, SALE)).code).toBe('TAX_DISTRIBUTION_MISSING');
    const kct = computeTaxes([line(1, '5000000', ['KCT'])], TAXES, SALE);
    expect(kct.lines[0]!.taxes).toEqual([{ code: 'KCT', amountCurrency: '0', amountVnd: '0' }]);
    expect(kct.postings).toEqual([]);
    const v0 = computeTaxes([line(1, '5000000', ['V0'])], TAXES, SALE);
    expect(v0.postings).toEqual([]); // thuế 0: không có bút toán 0 đồng
    const direct = computeTaxes([line(1, '5000000', ['TT3'])], TAXES, SALE);
    expect(direct.lines[0]).toMatchObject({ baseVnd: '5000000', directRate: '3', taxes: [{ code: 'TT3', amountCurrency: '0', amountVnd: '0' }] });
    expect(direct.postings).toEqual([]);
    expect(computeTaxes([line(1, '100', ['V10'])], TAXES, SALE).lines[0]!.directRate).toBeNull();
  });

  it('giảm giá, trả lại dùng phân bổ refund; phân bổ tách 50/50 cộng đúng bằng số thuế', () => {
    const split = vat('VS', '10', { distributions: [
      { documentType: 'invoice', scope: 'purchase', lineType: 'tax', factorPercent: '50', accountCode: '1331', reportTag: 'purchase_tax' },
      { documentType: 'invoice', scope: 'purchase', lineType: 'tax', factorPercent: '50', accountCode: '6422', reportTag: null },
      { documentType: 'refund', scope: 'purchase', lineType: 'tax', factorPercent: '100', accountCode: '1331', reportTag: 'purchase_tax' }] });
    const r = computeTaxes([line(1, '333330', ['VS'])], { VS: split }, PURCHASE); // thuế 33.333
    expect(r.postings.map((p) => [p.accountCode, p.amountVnd])).toEqual([['1331', '16667'], ['6422', '16666']]);
    const refund = computeTaxes([line(1, '333330', ['VS'])], { VS: split }, { ...PURCHASE, documentType: 'refund' });
    expect(refund.postings.map((p) => [p.accountCode, p.amountVnd])).toEqual([['1331', '33333']]);
  });

  it('thuộc tính: Σ baseVnd + Σ thuế VND (theo dấu) = Σ toVnd(gross) ± roundingVnd', () => {
    // Hóa đơn VND: mỗi dòng tối đa một mã GTGT (có thể giá đã gồm thuế) và có thể kèm TNCN_KT; thuế ghi trên hóa đơn lệch tối đa bằng số dòng của mã.
    const vatCodes = ['V0', 'V5', 'V8', 'V10', 'V10G', 'KCT', null] as const;
    const declarable = ['V5', 'V8', 'V10', 'V10G', 'TNCN_KT']; // KCT, V0 không tính thuế: chỉ nhận thuế ghi trên hóa đơn bằng 0 (kiểm ở ca riêng)
    const arbLine = fc.record({ amount: fc.bigInt({ min: 0n, max: 10n ** 12n }), discountPct: fc.integer({ min: 0, max: 100 }), vat: fc.constantFrom(...vatCodes), pit: fc.boolean() });
    fc.assert(fc.property(fc.array(arbLine, { minLength: 1, maxLength: 20 }), fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 5, maxLength: 5 }), (ls, devs) => {
      const lines = ls.map((l, i) => line(i + 1, l.amount.toString(), [...(l.vat ? [l.vat] : []), ...(l.pit ? ['TNCN_KT'] : [])], (l.amount * BigInt(l.discountPct) / 100n).toString()));
      const plain = computeTaxes(lines, TAXES, PURCHASE);
      // thuế ghi trên hóa đơn: mỗi mã tính thuế lệch trong phạm vi số dòng có mã đó
      const declared: Record<string, string> = {};
      declarable.forEach((c, i) => {
        const entries = plain.lines.flatMap((l) => l.taxes.filter((t) => t.code === c));
        if (entries.length) declared[c] = sum(entries.map((t) => t.amountVnd)).plus(Math.max(-entries.length, Math.min(entries.length, devs[i]!))).toFixed(0);
      });
      const r = computeTaxes(lines, TAXES, { ...PURCHASE, declaredTaxVnd: declared });
      // gross từ quy tắc: giá chưa thuế → cơ sở + thuế GTGT; giá đã gồm thuế → chính số tiền; trừ TNCN khấu trừ trên cơ sở
      const gross = lines.map((l) => {
        const net = D(l.amountCurrency).minus(l.discountCurrency);
        const v = l.taxCodes.find((c) => c !== 'TNCN_KT');
        const rate = v && TAXES[v]!.rate ? D(TAXES[v]!.rate!) : D(0);
        const vatAmt = v === 'V10G' ? net.times(10).div(110).toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : net.times(rate).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
        const base = v === 'V10G' ? net.minus(vatAmt) : net;
        const pit = l.taxCodes.includes('TNCN_KT') ? base.times(10).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : D(0);
        return base.plus(vatAmt).minus(pit);
      });
      const left = sum(r.lines.map((l) => l.baseVnd)).plus(sum(r.postings.map((p) => p.amountVnd)));
      expect(left.toFixed(0)).toBe(sum(gross).plus(r.roundingVnd).toFixed(0));
      expect(D(r.roundingVnd).abs().lte(2 * lines.length)).toBe(true);
      // không cần mô phỏng: dòng giá đã gồm thuế có cơ sở + thuế = số tiền, kể cả sau khi dồn chênh
      r.lines.forEach((l, i) => {
        const vatEntry = l.taxes.find((t) => t.code === 'V10G');
        if (vatEntry) expect(D(l.baseVnd).plus(vatEntry.amountVnd).toFixed(0)).toBe(D(lines[i]!.amountCurrency).minus(lines[i]!.discountCurrency).toFixed(0));
        for (const t of l.taxes) if (['V0', 'KCT'].includes(t.code)) expect(t.amountVnd).toBe('0');
      });
      // thuế từng mã sau khi dồn bằng đúng số ghi trên hóa đơn
      for (const [c, v] of Object.entries(declared)) expect(sum(r.lines.flatMap((l) => l.taxes.filter((t) => t.code === c).map((t) => t.amountVnd))).toFixed(0)).toBe(v);
    }), { numRuns: 200 });
  });

  it('thuộc tính ngoại tệ: mỗi dòng cơ sở + thuế = số tiền (nguyên tệ và VND), thuế VND = toVnd(thuế nguyên tệ), tổng lệch quy đổi ≤ số dòng', () => {
    const arbLine = fc.record({ amount: fc.bigInt({ min: 0n, max: 10n ** 13n }), discount: fc.bigInt({ min: 0n, max: 10n ** 4n }), vat: fc.constantFrom('V5', 'V10', 'V10G', 'KCT', null) });
    const arbRate = fc.bigInt({ min: 10_000n * 10n ** 4n, max: 30_000n * 10n ** 4n }).map((x) => D(x.toString()).div(10_000).toFixed());
    fc.assert(fc.property(fc.array(arbLine, { minLength: 1, maxLength: 20 }), arbRate, (ls, fxRate) => {
      const lines = ls.map((l, i) => line(i + 1, D(l.amount.toString()).div(10_000).toFixed(), l.vat ? [l.vat] : [], D((l.discount > l.amount ? l.amount : l.discount).toString()).div(10_000).toFixed()));
      const r = computeTaxes(lines, TAXES, { ...SALE, currency: 'USD', fxRate });
      let invoiceCur = D(0);
      r.lines.forEach((l, i) => {
        const gross = D(lines[i]!.amountCurrency).minus(lines[i]!.discountCurrency);
        const taxCur = sum(l.taxes.map((t) => t.amountCurrency)); const taxVnd = sum(l.taxes.map((t) => t.amountVnd));
        for (const t of l.taxes) { expect(t.amountVnd).toBe(toVnd(t.amountCurrency, fxRate)); expect(D(t.amountCurrency).decimalPlaces()).toBeLessThanOrEqual(2); }
        if (lines[i]!.taxCodes.includes('V10G')) {
          expect(D(l.baseCurrency).plus(taxCur).toFixed()).toBe(gross.toFixed());
          expect(D(l.baseVnd).plus(taxVnd).toFixed(0)).toBe(toVnd(gross.toFixed(), fxRate));
        } else expect(l.baseCurrency).toBe(gross.toFixed());
        expect(D(l.baseVnd).minus(toVnd(l.baseCurrency, fxRate)).abs().lte(1)).toBe(true);
        invoiceCur = invoiceCur.plus(l.baseCurrency).plus(taxCur);
      });
      const invoiceVnd = sum(r.lines.map((l) => l.baseVnd)).plus(sum(r.postings.map((p) => p.amountVnd)));
      expect(invoiceVnd.minus(toVnd(invoiceCur.toFixed(), fxRate)).abs().lte(lines.length)).toBe(true);
    }), { numRuns: 200 });
  });
});
