import { D, Decimal, parseVnDate, formatVnDate, STOCK_KINDS, type StockVoucherType } from '@kt/domain';

// Dòng hàng của phiếu kho: mọi ô là chuỗi (số lượng, đơn giá là chuỗi thập phân); ngày lô, hạn dùng nhập dạng dd/mm/yyyy, gửi lên dạng ISO.
export interface StockRow { itemCode: string; uomCode: string; quantity: string; unitPrice: string; lotNo: string; mfgDate: string; expiryDate: string }
export const emptyStockRow = (): StockRow => ({ itemCode: '', uomCode: '', quantity: '', unitPrice: '', lotNo: '', mfgDate: '', expiryDate: '' });
export const isBlankStockRow = (r: StockRow): boolean => Object.values(r).every((v) => v.trim() === '');
export const QTY_RE = /^\d{1,16}(\.\d{1,4})?$/;

// Thành tiền nhập kho = làm tròn đồng (số lượng nhập x đơn giá); máy chủ tính lại bằng cùng công thức. Xuất, chuyển: giá vốn tạm tính do máy chủ trả sau khi lưu.
export const rowAmount = (r: Pick<StockRow, 'quantity' | 'unitPrice'>): string =>
  QTY_RE.test(r.quantity) && QTY_RE.test(r.unitPrice || '0') ? D(r.quantity).times(r.unitPrice || '0').toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0) : '';

export const kindsOf = (type: StockVoucherType) => STOCK_KINDS.filter((k) => k.type === type);
export const kindLabel = (type: StockVoucherType, code: string | null | undefined): string => kindsOf(type).find((k) => k.code === code)?.label ?? '';

const isoOf = (s: string, row: number, what: string): string | null => {
  if (!s.trim()) return null;
  const iso = parseVnDate(s.trim());
  if (!iso) throw new Error(`Dòng ${row}: ${what} phải có dạng ngày/tháng/năm`);
  return iso;
};
// Thân gửi /api/stock-vouchers từ lưới; ném Error tiếng Việt khi dòng thiếu dữ liệu.
export function itemsBody(rows: StockRow[], withPrice: boolean) {
  return rows.flatMap((r, k) => {
    if (isBlankStockRow(r)) return [];
    const n = k + 1;
    if (!r.itemCode.trim()) throw new Error(`Dòng ${n}: nhập mã hàng`);
    if (!r.uomCode.trim()) throw new Error(`Dòng ${n}: nhập đơn vị tính`);
    if (!QTY_RE.test(r.quantity) || D(r.quantity).lte(0)) throw new Error(`Dòng ${n}: số lượng phải lớn hơn 0`);
    if (withPrice && r.unitPrice && !QTY_RE.test(r.unitPrice)) throw new Error(`Dòng ${n}: đơn giá không hợp lệ`);
    return [{ itemCode: r.itemCode.trim(), uomCode: r.uomCode.trim(), quantity: r.quantity, ...(withPrice && r.unitPrice ? { unitPrice: r.unitPrice } : {}),
      ...(r.lotNo.trim() ? { lotNo: r.lotNo.trim() } : {}), mfgDate: isoOf(r.mfgDate, n, 'ngày sản xuất'), expiryDate: isoOf(r.expiryDate, n, 'hạn dùng') }];
  });
}
export const dateCell = (iso: string | null): string => (iso ? formatVnDate(iso) : '');
