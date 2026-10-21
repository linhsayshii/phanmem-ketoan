import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { avgRate, D, proportionalVnd, sum, toVnd } from '../src/index.js';

describe('quy đổi ngoại tệ', () => {
  it('toVnd làm tròn nửa lên (xa số 0) về đồng, như round() của PostgreSQL', () => {
    expect(toVnd('1000', '25200')).toBe('25200000');
    expect(toVnd('0.0001', '25000.5')).toBe('3'); // 2,50005
    expect(toVnd('1.5', '1')).toBe('2');
    expect(toVnd('-1.5', '1')).toBe('-2');
    expect(toVnd('1.4999', '1')).toBe('1');
    expect(toVnd('-0.0001', '1')).toBe('0'); // không ra "-0"
  });
  it('avgRate: số dư VND / số dư nguyên tệ, 10 chữ số thập phân; nguyên tệ 0 thì null', () => {
    expect(avgRate('50400000', '2000')).toBe('25200.0000000000');
    expect(avgRate('1', '3')).toBe('0.3333333333');
    expect(avgRate('2', '3')).toBe('0.6666666667');
    expect(avgRate('5000000', '0')).toBeNull();
    expect(avgRate('0', '0.0000')).toBeNull();
  });
  it('proportionalVnd: lấy hết nguyên tệ thì lấy đúng hết số dư VND; phần lẻ theo bình quân', () => {
    expect(proportionalVnd('37900000', '1500', '500')).toBe('12633333'); // 500 × 25.266,6666666667
    expect(proportionalVnd('37900000', '1500', '1500')).toBe('37900000');
    expect(proportionalVnd('1', '3', '3.0000')).toBe('1');
    expect(() => proportionalVnd('100', '0', '1')).toThrow();
  });
  it('proportionalVnd: mỗi lần lấy nằm trong số dư và lệch phép chia chính xác không quá 1 đồng; chia nhiều lần cộng lại đúng bằng số dư VND', () => {
    // số dư nguyên tệ chia thành các phần (4 chữ số lẻ, mỗi phần tới 10^9 đơn vị); mỗi lần lấy một phần của số dư còn lại, lần cuối lấy hết
    const arb = fc.record({
      residualVnd: fc.bigInt({ min: 0n, max: 10n ** 15n }),
      parts: fc.array(fc.bigInt({ min: 1n, max: 10n ** 13n }), { minLength: 1, maxLength: 12 }),
    });
    fc.assert(fc.property(arb, ({ residualVnd, parts }) => {
      const cur = (x: bigint) => D(x.toString()).div(10_000).toFixed(4);
      let restVnd = residualVnd.toString(); let restCur = parts.reduce((a, b) => a + b, 0n);
      const taken: string[] = [];
      for (const p of parts) {
        const v = proportionalVnd(restVnd, cur(restCur), cur(p));
        const exact = D(cur(p)).times(restVnd).div(cur(restCur)); // part × số dư VND / số dư nguyên tệ, không làm tròn tỷ giá
        expect(D(v).gte(0) && D(v).lte(restVnd), `lấy ${v} ngoài [0, ${restVnd}]`).toBe(true);
        expect(D(v).minus(exact).abs().lte(1), `lấy ${v}, chính xác ${exact.toString()}`).toBe(true);
        taken.push(v); restVnd = D(restVnd).minus(v).toFixed(0); restCur -= p;
      }
      expect(restCur).toBe(0n);
      expect(sum(taken).toFixed(0)).toBe(residualVnd.toString());
    }), { numRuns: 300 });
  });
});
