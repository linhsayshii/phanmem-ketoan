import { describe, expect, it } from 'vitest';
import { parseInvoiceSymbol } from '../src/index.js';

describe('parseInvoiceSymbol (TT 91/2026 Phụ lục I)', () => {
  it.each([['1', 'C26TAA', true], ['2', 'C26TBB', true], ['1', 'C26LBB', true], ['1', 'K26TYY', true], ['3', 'C26DYY', true], ['6', 'K26NAB', true], ['7', 'K26XAB', true],
    ['0', 'C26TAA', false], ['1', 'A26TAA', false], ['1', 'C26ZAA', false], ['1', 'C26Taa', false], ['1', 'C2TAA', false], ['10', 'C26TAA', false]])('parseInvoiceSymbol(%s,%s) → %s', (f, s, ok) => {
    expect(parseInvoiceSymbol(f, s).ok).toBe(ok);
  });
  it('tách thành phần', () => {
    expect(parseInvoiceSymbol('1', 'K26MAB')).toEqual({ ok: true, formNo: '1', withCode: false, year: 2026, typeLetter: 'M', suffix: 'AB' });
    expect(parseInvoiceSymbol('1', 'C26TAA')).toMatchObject({ withCode: true });
  });
  it('lỗi có thông điệp tiếng Việt', () => {
    const r = parseInvoiceSymbol('1', 'C26ZAA');
    expect(!r.ok && r.message).toMatch(/Ký hiệu hóa đơn/);
  });
});
