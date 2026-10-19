import { describe, expect, it } from 'vitest';
import { formatVnDate, formatVnNumber, parseVnDate, parseVnNumber } from '../src/format.js';

describe('format', () => {
  it('số kiểu Việt Nam', () => {
    expect(formatVnNumber('1500000')).toBe('1.500.000');
    expect(formatVnNumber('-1500000')).toBe('-1.500.000');
    expect(formatVnNumber('1234.5', 2)).toBe('1.234,50');
    expect(formatVnNumber(null)).toBe('');
    expect(formatVnNumber('0')).toBe('0');
  });
  it('phân tích số người dùng gõ', () => {
    expect(parseVnNumber('1.500.000')).toBe('1500000');
    expect(parseVnNumber('1 500 000,25')).toBe('1500000.25');
    expect(parseVnNumber('')).toBeNull();
    expect(parseVnNumber('abc')).toBeNull();
  });
  it('ngày dd/MM/yyyy', () => {
    expect(formatVnDate('2026-01-31')).toBe('31/01/2026');
    expect(parseVnDate('31/01/2026')).toBe('2026-01-31');
    expect(parseVnDate('31/02/2026')).toBeNull();
    expect(parseVnDate('1/2/26')).toBe('2026-02-01');
  });
});
