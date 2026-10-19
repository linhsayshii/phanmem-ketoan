import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, isBalanced, sum, vnd } from '../src/money.js';

describe('money', () => {
  it('vnd làm tròn nửa lên về 0 chữ số', () => {
    expect(vnd('1234.5').toString()).toBe('1235');
    expect(vnd('1234.4999').toString()).toBe('1234');
    expect(vnd(-0.5).toString()).toBe('-1');
  });
  it('sum cộng chính xác chuỗi số lớn', () => {
    expect(sum(['9999999999999999', '1']).toString()).toBe('10000000000000000');
  });
  it('isBalanced đúng khi tổng Nợ = tổng Có', () => {
    expect(isBalanced([{ debit: '100', credit: '0' }, { debit: '0', credit: '100' }])).toBe(true);
    expect(isBalanced([{ debit: '100', credit: '0' }, { debit: '0', credit: '99' }])).toBe(false);
  });
  it('tính chất: sum(a) - sum(b) = sum(a - b)', () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n })), (xs) => {
      const s = sum(xs.map((x) => x.toString()));
      const expected = xs.reduce((acc, x) => acc + x, 0n);
      return s.toString() === expected.toString();
    }));
  });
  it('D không nhận NaN', () => {
    expect(() => D('abc')).toThrow();
  });
});
