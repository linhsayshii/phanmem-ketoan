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

export type TaxErrorCode = 'TAX_CODE_UNKNOWN' | 'TAX_RATE_MISSING' | 'TAX_DISTRIBUTION_MISSING' | 'TAX_DECLARED_MISMATCH' | 'TAX_FX_RATE_REQUIRED';
export class TaxError extends Error {
  constructor(public code: TaxErrorCode, message: string) { super(message); this.name = 'TaxError'; }
}

const HALF_UP = Decimal.ROUND_HALF_UP;
const fix = (x: Decimal, dp: number): string => (x.isZero() ? ZERO : x).toFixed(dp); // không trả "-0"
// Thuế tính ra tiền: GTGT khấu trừ và mọi thuế TNCN. 'none' (không chịu thuế, không kê khai) và 'direct' (GTGT trực tiếp trên doanh thu) thuế 0 trên hóa đơn.
const computed = (t: TaxDef): boolean => t.kind === 'pit' || t.method === 'deduct';

// Các dòng phân bổ cùng dấu cộng đủ ±100%: dòng cuối nhận phần còn lại để tổng khớp đúng số thuế (không lệch do làm tròn từng dòng).
function allocate(total: Decimal, factors: Decimal[], dp: number): Decimal[] {
  const out = factors.map((f) => total.times(f).div(100).toDecimalPlaces(dp, HALF_UP));
  for (const neg of [false, true]) {
    const idx = factors.flatMap((f, i) => (f.isNeg() === neg && !f.isZero() ? [i] : []));
    if (idx.length > 1 && sum(idx.map((i) => factors[i]!)).abs().eq(100)) {
      const last = idx.pop()!;
      out[last] = (neg ? total.neg() : total).minus(sum(idx.map((i) => out[i]!)));
    }
  }
  return out;
}

// Cơ sở = tiền hàng − chiết khấu (giá chưa thuế); giá đã gồm thuế thì tách ngược cơ sở = gross / (1 + Σ thuế suất / 100), thuế = gross − cơ sở.
// Thuế từng dòng làm tròn theo đơn vị nhỏ nhất của loại tiền (VND 0 chữ số, ngoại tệ 2); VND = toVnd từng dòng.
// declaredTaxVnd[mã] (thuế ghi trên hóa đơn) lệch Σ thuế dòng không quá số dòng có mã đó: dồn vào dòng có thuế lớn nhất của mã (bảng kê và bút toán không có dòng lẻ), roundingVnd = Σ lệch.
export function computeTaxes(lines: TaxableLine[], taxes: Record<string, TaxDef>,
  opts: { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; currency: string; fxRate: string | null; declaredTaxVnd?: Record<string, string> }): TaxResult {
  const isVnd = opts.currency === 'VND';
  if (!isVnd && !opts.fxRate) throw new TaxError('TAX_FX_RATE_REQUIRED', `Hóa đơn ${opts.currency} phải có tỷ giá để quy đổi thuế ra đồng`);
  const dp = isVnd ? 0 : 2;
  const rate = isVnd ? '1' : opts.fxRate!;
  const defOf = (code: string): TaxDef => {
    const t = taxes[code];
    if (!t) throw new TaxError('TAX_CODE_UNKNOWN', `Không có mã thuế ${code}`);
    if (t.rate === null && computed(t)) throw new TaxError('TAX_RATE_MISSING', `Mã thuế ${code} chưa có thuế suất`);
    return t;
  };

  const out: TaxLineResult[] = lines.map((l) => {
    const defs = l.taxCodes.map(defOf);
    const gross = D(l.amountCurrency).minus(D(l.discountCurrency));
    const inc = defs.filter((t) => computed(t) && t.priceInclude);
    const base = inc.length ? gross.div(sum(inc.map((t) => D(t.rate!))).div(100).plus(1)).toDecimalPlaces(dp, HALF_UP) : gross;
    const amounts = defs.map((t) => (computed(t) ? base.times(D(t.rate!)).div(100).toDecimalPlaces(dp, HALF_UP) : ZERO));
    if (inc.length) { // thuế đã gồm trong giá cuối cùng nhận phần còn lại: cơ sở + thuế = đúng số tiền
      const last = defs.lastIndexOf(inc[inc.length - 1]!);
      amounts[last] = gross.minus(base).minus(sum(amounts.filter((_, i) => i !== last && defs[i]!.priceInclude && computed(defs[i]!))));
    }
    const direct = defs.find((t) => t.kind !== 'pit' && t.method === 'direct');
    return {
      lineNo: l.lineNo, baseCurrency: isVnd ? fix(base, 0) : base.toFixed(), baseVnd: toVnd(base.toFixed(), rate),
      taxes: defs.map((t, i) => ({ code: t.code, amountCurrency: fix(amounts[i]!, dp), amountVnd: toVnd(amounts[i]!.toFixed(), rate) })),
      directRate: direct?.rate ?? null,
    };
  });

  const entriesOf = (code: string) => out.flatMap((l) => l.taxes.filter((t) => t.code === code));
  let rounding = ZERO;
  for (const [code, declared] of Object.entries(opts.declaredTaxVnd ?? {})) {
    const entries = entriesOf(code);
    const diff = D(declared).minus(sum(entries.map((t) => t.amountVnd)));
    if (diff.isZero()) continue;
    if (diff.abs().gt(entries.length)) throw new TaxError('TAX_DECLARED_MISMATCH', `Thuế ${code} ghi trên hóa đơn ${declared} lệch số tính theo dòng ${diff.toFixed(0)} đồng, vượt quá số dòng (${entries.length})`);
    const top = entries.reduce((a, b) => (D(b.amountVnd).abs().gt(D(a.amountVnd).abs()) ? b : a));
    top.amountVnd = D(top.amountVnd).plus(diff).toFixed(0);
    if (isVnd) top.amountCurrency = top.amountVnd;
    rounding = rounding.plus(diff);
  }

  const postings: TaxPosting[] = [];
  for (const code of [...new Set(lines.flatMap((l) => l.taxCodes))]) {
    const entries = entriesOf(code);
    const totalVnd = sum(entries.map((t) => t.amountVnd)); const totalCur = sum(entries.map((t) => t.amountCurrency));
    if (totalVnd.isZero() && totalCur.isZero()) continue;
    const dists = taxes[code]!.distributions.filter((d) => d.documentType === opts.documentType && d.scope === opts.scope && d.lineType === 'tax' && d.accountCode);
    if (!dists.length) throw new TaxError('TAX_DISTRIBUTION_MISSING', `Mã thuế ${code} chưa khai báo tài khoản phân bổ cho ${opts.scope === 'sale' ? 'bán ra' : 'mua vào'} (${opts.documentType === 'invoice' ? 'hóa đơn' : 'giảm giá, trả lại'})`);
    const factors = dists.map((d) => D(d.factorPercent));
    const vnd = allocate(totalVnd, factors, 0); const cur = allocate(totalCur, factors, dp);
    dists.forEach((d, i) => {
      if (vnd[i]!.isZero() && cur[i]!.isZero()) return;
      postings.push({ code, accountCode: d.accountCode!, amountVnd: fix(vnd[i]!, 0), amountCurrency: fix(cur[i]!, dp), reportTag: d.reportTag });
    });
  }
  return { lines: out, postings, roundingVnd: fix(rounding, 0) };
}
