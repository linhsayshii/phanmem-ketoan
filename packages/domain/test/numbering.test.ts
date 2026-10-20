import { describe, expect, it } from 'vitest';
import { formatVoucherNo } from '../src/numbering.js';
describe('formatVoucherNo', () => {
  it('ghép tiền tố, số đệm, hậu tố và thay năm', () => {
    expect(formatVoucherNo({ prefix: 'PKT', suffix: '', padLength: 5, seq: 7, year: 2026 })).toBe('PKT00007');
    expect(formatVoucherNo({ prefix: 'PC{YY}/', suffix: '', padLength: 4, seq: 12, year: 2026 })).toBe('PC26/0012');
    expect(formatVoucherNo({ prefix: '', suffix: '/{YYYY}', padLength: 3, seq: 1234, year: 2026 })).toBe('1234/2026');
  });
});
