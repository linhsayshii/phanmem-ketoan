import { D, Decimal } from './money.js';
import type { Regime } from './period.js';

// Loại phiếu kho (stock_kind của voucher, 0046) theo loại chứng từ và tài khoản đối ứng mặc định theo chế độ.
// Nhập: Nợ TK kho / Có TK đối ứng. Xuất: Nợ TK đối ứng / Có TK kho. Dòng có thể ghi đè bằng debitAccountCode/creditAccountCode.
// Chi phí xuất sử dụng, biếu tặng: 6418 (TT99/TT200 Chi phí bằng tiền khác), 6421 (TT133 Chi phí bán hàng): TK chi tiết. Mã tài khoản có trong mẫu hệ thống tài khoản của chế độ (kiểm thử ở packages/coa-data/test/stockKinds.test.ts); chế độ ngoài danh sách dùng cột TT99.
export type StockVoucherType = 'PNK' | 'PXK' | 'CK' | 'LR';
type CounterRegime = 'TT99' | 'TT133' | 'TT200';
export interface StockKindDef { code: string; type: StockVoucherType; label: string; counter: Record<CounterRegime, string> }
const same = (c: string): StockKindDef['counter'] => ({ TT99: c, TT133: c, TT200: c });
const split = (tt99: string, tt133: string): StockKindDef['counter'] => ({ TT99: tt99, TT133: tt133, TT200: tt99 });

export const STOCK_KINDS: readonly StockKindDef[] = [
  { code: 'purchase', type: 'PNK', label: 'Nhập mua', counter: same('331') },
  { code: 'finished', type: 'PNK', label: 'Nhập thành phẩm', counter: same('154') },
  { code: 'return_in', type: 'PNK', label: 'Nhập trả lại', counter: same('632') },
  { code: 'processing_in', type: 'PNK', label: 'Nhập hàng gia công', counter: same('154') },
  { code: 'consign_in', type: 'PNK', label: 'Nhập hàng gửi bán trả về', counter: same('157') },
  { code: 'other_in', type: 'PNK', label: 'Nhập khác', counter: same('3381') },
  { code: 'sale', type: 'PXK', label: 'Xuất bán', counter: same('632') },
  { code: 'production', type: 'PXK', label: 'Xuất sản xuất', counter: split('621', '154') },
  { code: 'use', type: 'PXK', label: 'Xuất sử dụng', counter: split('6418', '6421') },
  { code: 'gift', type: 'PXK', label: 'Xuất biếu tặng', counter: split('6418', '6421') },
  { code: 'destroy', type: 'PXK', label: 'Xuất hủy', counter: same('811') },
  { code: 'return_out', type: 'PXK', label: 'Xuất trả nhà cung cấp', counter: same('331') },
  { code: 'processing_out', type: 'PXK', label: 'Xuất gia công', counter: same('154') },
  { code: 'consign_out', type: 'PXK', label: 'Xuất hàng gửi bán', counter: same('157') },
  { code: 'other_out', type: 'PXK', label: 'Xuất khác', counter: same('1388') },
  { code: 'transfer', type: 'CK', label: 'Chuyển kho', counter: same('') },
  { code: 'assembly', type: 'LR', label: 'Lắp ráp', counter: same('') },
  { code: 'disassembly', type: 'LR', label: 'Tháo dỡ', counter: same('') },
];
export const stockKindDef = (type: string, code: string): StockKindDef | undefined => STOCK_KINDS.find((k) => k.type === type && k.code === code);
export const stockCounterAccount = (k: StockKindDef, regime: Regime): string => k.counter[regime === 'TT133' ? 'TT133' : regime === 'TT200' ? 'TT200' : 'TT99'];

// Chia tổng giá trị (VND nguyên) theo tỷ lệ phần trăm: từng phần làm tròn nửa lên, phần cuối nhận số dư để Σ = tổng đúng. Dùng cho lắp ráp, tháo dỡ (LR).
export function splitByRatio(total: string | Decimal, ratios: string[]): string[] {
  const t = D(total); let left = t;
  return ratios.map((r, i) => {
    const v = i === ratios.length - 1 ? left : t.times(r).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    left = left.minus(v);
    return v.toFixed(0);
  });
}
