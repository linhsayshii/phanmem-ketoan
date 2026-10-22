import { describe, expect, it } from 'vitest';
import { splitByRatio } from '../src/stock.js';

describe('splitByRatio', () => {
  it('chia theo tỷ lệ, dòng cuối nhận phần dư nên tổng khớp', () => {
    expect(splitByRatio('100', ['70', '30']).map(String)).toEqual(['70', '30']);
    const r = splitByRatio('100', ['33.3333', '33.3333', '33.3334']);
    expect(r.reduce((s, x) => s + Number(x), 0)).toBe(100);
  });
  it('một dòng nhận toàn bộ', () => expect(splitByRatio('41', ['100']).map(String)).toEqual(['41']));
});
