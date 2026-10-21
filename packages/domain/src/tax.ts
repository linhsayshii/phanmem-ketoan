import { D, Decimal, ZERO, sum } from './money.js';
import { toVnd } from './fx.js';

// Động cơ thuế (đặc tả mục 6 "Thuế"): mã thuế (bảng tax_code) + phân bổ thuế (tax_distribution) theo loại chứng từ, mua/bán, dòng cơ sở/dòng thuế.
// Thuế khấu trừ tại nguồn (TNCN) là phân bổ âm. Dòng phân bổ "base" chỉ gắn nhãn báo cáo cho cơ sở tính thuế, không sinh bút toán.
export interface TaxDistribution { documentType: 'invoice' | 'refund'; scope: 'sale' | 'purchase'; lineType: 'base' | 'tax'; factorPercent: string; accountCode: string | null; reportTag: string | null }
export interface TaxDef { code: string; kind: 'vat' | 'pit' | 'import' | 'excise'; method: 'deduct' | 'direct' | 'none'; rate: string | null; priceInclude: boolean; distributions: TaxDistribution[] }
export interface TaxableLine { lineNo: number; amountCurrency: string; discountCurrency: string; taxCodes: string[] } // GTGT và TNCN có thể cùng dòng
export interface TaxLineResult { lineNo: number; baseCurrency: string; baseVnd: string; taxes: { code: string; amountCurrency: string; amountVnd: string }[]; directRate: string | null }
export interface TaxPosting { code: string; accountCode: string; amountVnd: string; amountCurrency: string; reportTag: string | null } // dương = cùng chiều thuế, âm = phân bổ âm (khấu trừ)
export interface TaxResult { lines: TaxLineResult[]; postings: TaxPosting[]; roundingVnd: string }

export type TaxErrorCode = 'TAX_CODE_UNKNOWN' | 'TAX_CODE_DUPLICATE' | 'TAX_RATE_MISSING' | 'TAX_DISTRIBUTION_MISSING' | 'TAX_DISTRIBUTION_INVALID' | 'TAX_DECLARED_MISMATCH' | 'TAX_FX_RATE_REQUIRED';
export class TaxError extends Error {
  constructor(public code: TaxErrorCode, message: string) { super(message); this.name = 'TaxError'; }
}

const HALF_UP = Decimal.ROUND_HALF_UP;
const fix = (x: Decimal, dp: number): string => (x.isZero() ? ZERO : x).toFixed(dp); // không trả "-0"
// Thuế tính ra tiền: phương pháp khấu trừ (GTGT khấu trừ, TNCN khấu trừ tại nguồn, NK, TTĐB). 'none' (không chịu thuế, không kê khai, không tính thuế)
// và 'direct' (GTGT trực tiếp trên doanh thu) cho thuế 0 trên hóa đơn. DB (0031) bắt is_exempt ⇒ 'none', TNCN luôn 'deduct' và không giá đã gồm thuế.
const computed = (t: TaxDef): boolean => t.method === 'deduct';

// Phân bổ đã kiểm (mỗi nhóm cùng dấu cộng đúng ±100%): dòng cuối mỗi nhóm nhận phần còn lại để tổng khớp đúng số thuế (không lệch do làm tròn từng dòng).
function allocate(total: Decimal, factors: Decimal[], dp: number): Decimal[] {
  const out = factors.map((f) => total.times(f).div(100).toDecimalPlaces(dp, HALF_UP));
  for (const neg of [false, true]) {
    const idx = factors.flatMap((f, i) => (f.isNeg() === neg && !f.isZero() ? [i] : []));
    if (idx.length > 1) {
      const last = idx.pop()!;
      out[last] = (neg ? total.neg() : total).minus(sum(idx.map((i) => out[i]!)));
    }
  }
  return out;
}

// Cơ sở = tiền hàng − chiết khấu (giá chưa thuế). Giá đã gồm thuế (GTGT, không áp cho TNCN): thuế = round(gross × Σ thuế suất / (100 + Σ thuế suất)) trước, cơ sở = gross − thuế,
// nên cơ sở + thuế = gross đúng cả khi nguyên tệ có 4 chữ số lẻ; VND: thuế = toVnd(thuế), cơ sở = toVnd(gross) − thuế VND.
// Thuế từng dòng làm tròn theo đơn vị nhỏ nhất của loại tiền (VND 0 chữ số, ngoại tệ `minorUnit`, mặc định 2); VND = toVnd từng dòng.
// declaredTaxVnd[mã] (thuế ghi trên hóa đơn) lệch Σ thuế dòng không quá số dòng có mã đó: dồn vào dòng có thuế lớn nhất của mã (bảng kê và bút toán không có dòng lẻ).
// Mã không tính thuế hoặc thuế suất 0% chỉ nhận thuế ghi trên hóa đơn bằng 0. roundingVnd = phần tổng tiền hóa đơn VND (Σ cơ sở + Σ bút toán thuế theo dấu phân bổ)
// thay đổi do dồn chênh: giá chưa thuế thì bằng phần bút toán thay đổi; giá đã gồm thuế thì cơ sở nhận phần ngược lại nên không đổi tổng.
export function computeTaxes(lines: TaxableLine[], taxes: Record<string, TaxDef>,
  opts: { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; currency: string; fxRate: string | null; declaredTaxVnd?: Record<string, string>; minorUnit?: number }): TaxResult {
  const isVnd = opts.currency === 'VND';
  if (!isVnd && !opts.fxRate) throw new TaxError('TAX_FX_RATE_REQUIRED', `Hóa đơn ${opts.currency} phải có tỷ giá để quy đổi thuế ra đồng`);
  const dp = isVnd ? 0 : (opts.minorUnit ?? 2); // số chữ số thập phân của loại tiền (currency.minor_unit), mặc định 2
  const rate = isVnd ? '1' : opts.fxRate!;
  const vndOf = (x: Decimal): string => toVnd(x.toFixed(), rate);
  const defOf = (code: string): TaxDef => {
    const t = taxes[code];
    if (!t) throw new TaxError('TAX_CODE_UNKNOWN', `Không có mã thuế ${code}`);
    if (t.rate === null && computed(t)) throw new TaxError('TAX_RATE_MISSING', `Mã thuế ${code} chưa có thuế suất`);
    return t;
  };

  const incOf: { grossVnd: string; idx: number[] }[] = []; // dòng giá đã gồm thuế: cơ sở VND = gross VND − thuế VND, tính lại sau khi dồn chênh
  const out: TaxLineResult[] = lines.map((l) => {
    if (new Set(l.taxCodes).size !== l.taxCodes.length) throw new TaxError('TAX_CODE_DUPLICATE', `Dòng ${l.lineNo}: một mã thuế ghi hai lần`);
    const defs = l.taxCodes.map(defOf);
    const gross = D(l.amountCurrency).minus(D(l.discountCurrency));
    const inc = defs.filter((t) => computed(t) && t.priceInclude && t.kind !== 'pit');
    const incRate = sum(inc.map((t) => D(t.rate!)));
    const incTax = gross.times(incRate).div(incRate.plus(100)).toDecimalPlaces(dp, HALF_UP);
    const base = gross.minus(incTax);
    const amounts = defs.map((t) => (computed(t) && !inc.includes(t) ? base.times(D(t.rate!)).div(100).toDecimalPlaces(dp, HALF_UP) : ZERO));
    inc.forEach((t, k) => { // nhiều thuế đã gồm trong giá: chia tổng thuế theo thuế suất, mã cuối nhận phần còn lại
      amounts[defs.indexOf(t)] = k < inc.length - 1 ? (incRate.isZero() ? ZERO : incTax.times(D(t.rate!)).div(incRate).toDecimalPlaces(dp, HALF_UP))
        : incTax.minus(sum(inc.slice(0, -1).map((x) => amounts[defs.indexOf(x)]!)));
    });
    const taxVnd = amounts.map(vndOf);
    const direct = defs.find((t) => t.method === 'direct');
    const grossVnd = vndOf(gross); const idx = inc.map((t) => defs.indexOf(t));
    incOf.push({ grossVnd, idx });
    return {
      lineNo: l.lineNo, baseCurrency: isVnd ? fix(base, 0) : base.toFixed(),
      baseVnd: idx.length ? D(grossVnd).minus(sum(idx.map((k) => taxVnd[k]!))).toFixed(0) : vndOf(base),
      taxes: defs.map((t, i) => ({ code: t.code, amountCurrency: fix(amounts[i]!, dp), amountVnd: taxVnd[i]! })),
      directRate: direct?.rate ?? null,
    };
  });

  const codes = [...new Set(lines.flatMap((l) => l.taxCodes))];
  const entriesOf = (code: string) => out.flatMap((l) => l.taxes.filter((t) => t.code === code));
  const beforeVnd = new Map(codes.map((c) => [c, sum(entriesOf(c).map((t) => t.amountVnd))]));
  const baseBefore = sum(out.map((l) => l.baseVnd));
  for (const [code, declared] of Object.entries(opts.declaredTaxVnd ?? {})) {
    const entries = entriesOf(code);
    const diff = D(declared).minus(sum(entries.map((t) => t.amountVnd)));
    if (diff.isZero()) continue;
    const t = taxes[code];
    if (t && entries.length && (!computed(t) || t.rate === null || D(t.rate).isZero()))
      throw new TaxError('TAX_DECLARED_MISMATCH', `Mã thuế ${code} không tính thuế trên hóa đơn (không chịu thuế, trực tiếp hoặc thuế suất 0%): thuế ghi trên hóa đơn phải bằng 0, nhận ${declared}`);
    if (diff.abs().gt(entries.length)) throw new TaxError('TAX_DECLARED_MISMATCH', `Thuế ${code} ghi trên hóa đơn ${declared} lệch số tính theo dòng ${diff.toFixed(0)} đồng, vượt quá số dòng (${entries.length})`);
    const top = entries.reduce((a, b) => (D(b.amountVnd).abs().gt(D(a.amountVnd).abs()) ? b : a));
    top.amountVnd = D(top.amountVnd).plus(diff).toFixed(0);
    if (isVnd) top.amountCurrency = top.amountVnd;
  }
  out.forEach((l, i) => { // giá đã gồm thuế: tổng tiền thanh toán cố định nên cơ sở nhận phần ngược với thuế (kể cả phần dồn chênh), cơ sở + thuế = gross VND
    const { grossVnd, idx } = incOf[i]!;
    if (!idx.length) return;
    l.baseVnd = D(grossVnd).minus(sum(idx.map((k) => l.taxes[k]!.amountVnd))).toFixed(0);
    if (isVnd) l.baseCurrency = l.baseVnd;
  });

  let rounding = sum(out.map((l) => l.baseVnd)).minus(baseBefore);
  const postings: TaxPosting[] = [];
  const where = `${opts.scope === 'sale' ? 'bán ra' : 'mua vào'} (${opts.documentType === 'invoice' ? 'hóa đơn' : 'giảm giá, trả lại'})`;
  for (const code of codes) {
    const entries = entriesOf(code);
    const totalVnd = sum(entries.map((t) => t.amountVnd)); const totalCur = sum(entries.map((t) => t.amountCurrency));
    const before = beforeVnd.get(code)!;
    if (totalVnd.isZero() && totalCur.isZero() && before.isZero()) continue;
    const dists = taxes[code]!.distributions.filter((d) => d.documentType === opts.documentType && d.scope === opts.scope && d.lineType === 'tax' && d.accountCode);
    if (!dists.length) throw new TaxError('TAX_DISTRIBUTION_MISSING', `Mã thuế ${code} chưa khai báo tài khoản phân bổ cho ${where}`);
    const factors = dists.map((d) => D(d.factorPercent));
    const pos = sum(factors.filter((f) => f.gt(0))); const neg = sum(factors.filter((f) => f.lt(0)));
    if (!(pos.isZero() || pos.eq(100)) || !(neg.isZero() || neg.eq(-100)) || (pos.isZero() && neg.isZero()))
      throw new TaxError('TAX_DISTRIBUTION_INVALID', `Mã thuế ${code}: tỷ lệ phân bổ cho ${where} phải cộng đúng 100% (phần dương) hoặc -100% (phần âm), đang là ${pos.toFixed()}% và ${neg.toFixed()}%`);
    rounding = rounding.plus(totalVnd.minus(before).times(pos.plus(neg)).div(100)); // mỗi nhóm cộng đúng ±100% nên Σ bút toán = tổng × (Σ tỷ lệ)/100
    const vnd = allocate(totalVnd, factors, 0); const cur = allocate(totalCur, factors, dp);
    dists.forEach((d, i) => {
      if (vnd[i]!.isZero() && cur[i]!.isZero()) return;
      postings.push({ code, accountCode: d.accountCode!, amountVnd: fix(vnd[i]!, 0), amountCurrency: fix(cur[i]!, dp), reportTag: d.reportTag });
    });
  }
  return { lines: out, postings, roundingVnd: fix(rounding, 0) };
}
