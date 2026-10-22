import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocateLandedCost, D, LandedCostError, sum } from '../src/index.js';

const line = (id: string, qty: string, value: string) => ({ id, qty, value });

describe('allocateLandedCost', () => {
  it('allocateLandedCost: 100 phân bổ theo giá trị 3 dòng 1.000/2.000/3.000 → 17, 33, 50 và tổng 100', () => {
    expect(allocateLandedCost(['100'], [line('1', '1', '1000'), line('2', '1', '2000'), line('3', '1', '3000')], 'value')).toEqual({ '1': '17', '2': '33', '3': '50' });
  });

  it('phân bổ theo số lượng; chi phí 1 đồng cho 3 dòng vẫn tổng đúng 1 (fast-check: Σ = tổng)', () => {
    expect(allocateLandedCost(['400', '200'], [line('a', '10', '5'), line('b', '20', '5'), line('c', '30', '5')], 'quantity')).toEqual({ a: '100', b: '200', c: '300' });
    expect(allocateLandedCost(['1'], [line('1', '1', '1'), line('2', '1', '1'), line('3', '1', '1')], 'quantity')).toEqual({ '1': '1', '2': '0', '3': '0' }); // cùng phần lẻ, cùng tỷ trọng: id nhỏ nhất
    fc.assert(fc.property(
      fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: 1, maxLength: 4 }),
      fc.array(fc.record({ qty: fc.bigInt({ min: 0n, max: 10n ** 6n }), value: fc.bigInt({ min: 0n, max: 10n ** 12n }) }), { minLength: 1, maxLength: 8 }),
      fc.constantFrom('value' as const, 'quantity' as const),
      (costs, ls, basis) => {
        const lines = ls.map((l, i) => line(String(i + 1), l.qty.toString(), l.value.toString()));
        const total = sum(costs.map(String));
        if (sum(lines.map((l) => (basis === 'value' ? l.value : l.qty))).isZero()) {
          if (total.isZero()) return true;
          expect(() => allocateLandedCost(costs.map(String), lines, basis)).toThrow(LandedCostError); return true;
        }
        const r = allocateLandedCost(costs.map(String), lines, basis);
        expect(sum(Object.values(r)).eq(total)).toBe(true);
        const wt = sum(lines.map((l) => (basis === 'value' ? l.value : l.qty)));
        for (const l of lines) { // không âm, lệch tỷ lệ chính xác dưới 1 đồng
          const exact = total.times(basis === 'value' ? l.value : l.qty).div(wt);
          expect(D(r[l.id]!).gte(0)).toBe(true); expect(D(r[l.id]!).minus(exact).abs().lt(1)).toBe(true);
        }
        return true;
      }), { numRuns: 300 });
  });

  it('cơ sở 0 thì báo lỗi; dòng giá trị 0 nhận 0', () => {
    expect(() => allocateLandedCost(['5'], [line('1', '0', '0')], 'value')).toThrow(/bằng 0/);
    expect(allocateLandedCost(['5'], [line('1', '1', '0'), line('2', '1', '10')], 'value')).toEqual({ '1': '0', '2': '5' });
    expect(() => allocateLandedCost(['1.5'], [line('1', '1', '1')], 'value')).toThrow(LandedCostError);
  });
});
