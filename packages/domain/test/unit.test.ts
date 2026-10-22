import { describe, expect, it } from 'vitest';
import { fromBaseQty, toBaseQty } from '../src/index.js';

describe('quy đổi đơn vị tính về đơn vị cơ sở', () => {
  it('toBaseQty("12", "24") = "288"; fromBaseQty("288","24") = "12"; factor lẻ 0,5', () => {
    expect(toBaseQty('12', '24')).toBe('288');
    expect(fromBaseQty('288', '24')).toBe('12');
    expect(toBaseQty('3', '0.5')).toBe('1.5');
    expect(fromBaseQty('1.5', '0.5')).toBe('3');
  });
  it('làm tròn 4 chữ số thập phân nửa lên', () => {
    expect(toBaseQty('1.2345', '0.5')).toBe('0.6173'); // 0,61725
    expect(fromBaseQty('1', '3')).toBe('0.3333');
    expect(fromBaseQty('2', '3')).toBe('0.6667');
  });
  it('hệ số phải dương', () => {
    expect(() => toBaseQty('1', '0')).toThrow();
    expect(() => fromBaseQty('1', '-2')).toThrow();
    expect(() => toBaseQty('abc', '1')).toThrow();
  });
});
