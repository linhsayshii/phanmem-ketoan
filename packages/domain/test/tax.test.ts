import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeTaxes, D, sum, TaxError, toVnd, type TaxDef, type TaxDistribution, type TaxableLine } from '../src/index.js';

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
    // tách ngược không chia hết: cơ sở làm tròn, thuế = tổng − cơ sở (không lệch 1 đồng)
    const odd = computeTaxes([line(1, '1000000', ['V10G'], '1')], TAXES, SALE);
    expect(odd.lines[0]!.baseCurrency).toBe('909090'); // 999.999 / 1,1 = 909.090,0…
    expect(odd.lines[0]!.taxes[0]!.amountCurrency).toBe('90909');
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
    const arbLine = fc.record({ amount: fc.bigInt({ min: 0n, max: 10n ** 12n }), discountPct: fc.integer({ min: 0, max: 100 }), vat: fc.constantFrom(...vatCodes), pit: fc.boolean() });
    fc.assert(fc.property(fc.array(arbLine, { minLength: 1, maxLength: 20 }), fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 7, maxLength: 7 }), (ls, devs) => {
      const lines = ls.map((l, i) => line(i + 1, l.amount.toString(), [...(l.vat ? [l.vat] : []), ...(l.pit ? ['TNCN_KT'] : [])], (l.amount * BigInt(l.discountPct) / 100n).toString()));
      const plain = computeTaxes(lines, TAXES, PURCHASE);
      // thuế ghi trên hóa đơn: mỗi mã GTGT lệch trong phạm vi số dòng có mã đó
      const declared: Record<string, string> = {};
      vatCodes.forEach((c, i) => {
        if (!c) return;
        const entries = plain.lines.flatMap((l) => l.taxes.filter((t) => t.code === c));
        if (entries.length) declared[c] = sum(entries.map((t) => t.amountVnd)).plus(Math.max(-entries.length, Math.min(entries.length, devs[i]!))).toFixed(0);
      });
      const r = computeTaxes(lines, TAXES, { ...PURCHASE, declaredTaxVnd: declared });
      // gross độc lập: giá chưa thuế → cơ sở + thuế GTGT; giá đã gồm thuế → chính số tiền; trừ TNCN khấu trừ trên cơ sở
      const gross = lines.map((l) => {
        const net = D(l.amountCurrency).minus(l.discountCurrency);
        const v = l.taxCodes.find((c) => c !== 'TNCN_KT');
        const rate = v && TAXES[v]!.rate ? D(TAXES[v]!.rate!) : D(0);
        const base = v === 'V10G' ? net.div(1.1).toDecimalPlaces(0) : net;
        const vatAmt = v === 'V10G' ? net.minus(base) : base.times(rate).div(100).toDecimalPlaces(0);
        const pit = l.taxCodes.includes('TNCN_KT') ? base.times(10).div(100).toDecimalPlaces(0) : D(0);
        return toVnd(base.plus(vatAmt).minus(pit).toFixed(0), '1');
      });
      const left = sum(r.lines.map((l) => l.baseVnd)).plus(sum(r.postings.map((p) => p.amountVnd)));
      expect(left.toFixed(0)).toBe(sum(gross).plus(r.roundingVnd).toFixed(0));
      expect(D(r.roundingVnd).abs().lte(lines.length)).toBe(true);
      // thuế từng mã sau khi dồn bằng đúng số ghi trên hóa đơn
      for (const [c, v] of Object.entries(declared)) expect(sum(r.lines.flatMap((l) => l.taxes.filter((t) => t.code === c).map((t) => t.amountVnd))).toFixed(0)).toBe(v);
    }), { numRuns: 200 });
  });
});
