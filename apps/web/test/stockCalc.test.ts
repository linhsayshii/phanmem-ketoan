import { describe, expect, it } from 'vitest';
import { emptyStockRow, itemsBody, kindLabel, kindsOf, rowAmount } from '../src/pages/stockCalc.js';

const row = (o: object) => ({ ...emptyStockRow(), ...o });

describe('stockCalc', () => {
  it('thành tiền nhập = làm tròn đồng số lượng x đơn giá', () => {
    expect(rowAmount({ quantity: '100', unitPrice: '10' })).toBe('1000');
    expect(rowAmount({ quantity: '3', unitPrice: '0.5' })).toBe('2');
    expect(rowAmount({ quantity: 'abc', unitPrice: '10' })).toBe('');
  });
  it('bỏ dòng trống, đổi ngày dd/mm/yyyy sang ISO, đơn giá chỉ gửi khi là phiếu nhập', () => {
    const rows = [row({ itemCode: 'SP1', uomCode: 'CAI', quantity: '5', unitPrice: '7', lotNo: 'L1', expiryDate: '31/12/2026' }), emptyStockRow()];
    expect(itemsBody(rows, true)).toEqual([{ itemCode: 'SP1', uomCode: 'CAI', quantity: '5', unitPrice: '7', lotNo: 'L1', mfgDate: null, expiryDate: '2026-12-31' }]);
    expect(itemsBody(rows, false)[0]).not.toHaveProperty('unitPrice');
  });
  it('dòng thiếu dữ liệu ném lỗi tiếng Việt', () => {
    expect(() => itemsBody([row({ itemCode: 'SP1', uomCode: 'CAI', quantity: '0' })], true)).toThrow('Dòng 1: số lượng phải lớn hơn 0');
    expect(() => itemsBody([row({ quantity: '1' })], true)).toThrow('nhập mã hàng');
    expect(() => itemsBody([row({ itemCode: 'A', uomCode: 'CAI', quantity: '1', expiryDate: '99/99/2026' })], true)).toThrow('hạn dùng');
  });
  it('loại nghiệp vụ theo loại phiếu', () => {
    expect(kindsOf('PNK').length).toBeGreaterThan(1);
    expect(kindLabel('PNK', 'purchase')).not.toBe('');
    expect(kindLabel('CK', 'nope')).toBe('');
  });
});
