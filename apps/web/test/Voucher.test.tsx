import { describe, expect, it } from 'vitest';
import { cleanLines, emptyLine, parseAmount, totals } from '../src/pages/Voucher.js';

describe('Phiếu kế toán: tổng và làm sạch dòng', () => {
  it('bỏ dòng trống, tính tổng Nợ/Có', () => {
    const lines = [{ ...emptyLine(), accountCode: '6422', debit: '1500000' }, { ...emptyLine(), accountCode: '1111', credit: '1500000' }, emptyLine()];
    expect(cleanLines(lines)).toHaveLength(2);
    expect(totals(lines)).toEqual({ debit: '1500000', credit: '1500000' });
  });
});

describe('Phiếu kế toán: nhập số tiền ở ô Nợ/Có', () => {
  it('ô để trống (Backspace + Enter, Delete) về 0', () => {
    for (const blank of ['', '   ', null, undefined]) expect(parseAmount(blank, '1500000')).toBe('0');
  });
  it('nhận số nguyên không âm kiểu Việt Nam', () => {
    expect(parseAmount('1.500.000', '0')).toBe('1500000');
    expect(parseAmount('1500000', '0')).toBe('1500000');
  });
  it('chữ, số âm, số lẻ bị từ chối: giữ giá trị cũ', () => {
    for (const bad of ['abc', '-5', '12,5', '1.5.5']) expect(parseAmount(bad, '100')).toBe('100');
    expect(parseAmount('abc', undefined)).toBe('0');
  });
  it('tối đa 16 chữ số: 10^16 bị từ chối, giữ giá trị cũ', () => {
    expect(parseAmount('9999999999999999', '0')).toBe('9999999999999999');
    expect(parseAmount('10000000000000000', '100')).toBe('100');
  });
});
