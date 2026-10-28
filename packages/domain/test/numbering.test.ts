import { describe, expect, it } from 'vitest';
import { formatVoucherNo } from '../src/numbering.js';
describe('formatVoucherNo', () => {
  it('ghép tiền tố, số đệm, hậu tố và thay năm', () => {
    expect(formatVoucherNo({ prefix: 'PKT', suffix: '', padLength: 5, seq: 7, year: 2026 })).toBe('PKT00007');
    expect(formatVoucherNo({ prefix: 'PC{YY}/', suffix: '', padLength: 4, seq: 12, year: 2026 })).toBe('PC26/0012');
    expect(formatVoucherNo({ prefix: '', suffix: '/{YYYY}', padLength: 3, seq: 1234, year: 2026 })).toBe('1234/2026');
  });
  it('theo chi nhánh: thêm mã ở đầu hoặc thay {BR}; tắt thì bỏ {BR}', () => {
    expect(formatVoucherNo({ prefix: 'PKT', suffix: '', padLength: 3, seq: 2, year: 2026, branchCode: 'HN' })).toBe('HN-PKT002');
    expect(formatVoucherNo({ prefix: 'PKT{YY}/{BR}/', suffix: '', padLength: 3, seq: 2, year: 2026, branchCode: 'HN' })).toBe('PKT26/HN/002');
    expect(formatVoucherNo({ prefix: 'PKT{BR}', suffix: '', padLength: 3, seq: 2, year: 2026 })).toBe('PKT002');
    expect(formatVoucherNo({ prefix: 'PKT', suffix: '', padLength: 3, seq: 2, year: 2026, branchCode: '' })).toBe('PKT002');
  });
});
