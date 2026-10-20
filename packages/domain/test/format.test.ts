import { describe, expect, it } from 'vitest';
import { formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, vndInWords } from '../src/format.js';

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
  it('phân tích số chặt: dấu chấm chỉ là phân cách nghìn', () => {
    expect(parseVnNumber('1.5')).toBeNull();
    expect(parseVnNumber('0.5')).toBeNull();
    expect(parseVnNumber('1.500,5')).toBe('1500.5');
    expect(parseVnNumber('-2.000')).toBe('-2000');
    expect(parseVnNumber('12345')).toBe('12345');
  });
});

describe('vndInWords', () => {
  it.each([
    ['1500000', 'Một triệu năm trăm nghìn đồng'], ['21', 'Hai mươi mốt đồng'], ['105', 'Một trăm lẻ năm đồng'], ['1000000000000', 'Một nghìn tỷ đồng'], ['0', 'Không đồng'],
    ['10', 'Mười đồng'], ['15', 'Mười lăm đồng'], ['11', 'Mười một đồng'], ['14', 'Mười bốn đồng'], ['24', 'Hai mươi tư đồng'], ['25', 'Hai mươi lăm đồng'], ['4', 'Bốn đồng'],
    ['1001', 'Một nghìn không trăm lẻ một đồng'], ['1050000', 'Một triệu không trăm năm mươi nghìn đồng'], ['1000000001', 'Một tỷ không trăm lẻ một đồng'],
    ['5000000', 'Năm triệu đồng'], ['100', 'Một trăm đồng'], ['012', 'Mười hai đồng'],
    ['9999999999999999', 'Chín triệu tỷ chín trăm chín mươi chín nghìn tỷ chín trăm chín mươi chín tỷ chín trăm chín mươi chín triệu chín trăm chín mươi chín nghìn chín trăm chín mươi chín đồng'],
  ])('vndInWords(%s)', (a, w) => expect(vndInWords(a)).toBe(w));
  it.each(['-5', '1.5', '', ' 1', '1e3', '12345678901234567', 'abc'])('từ chối %j (âm, không nguyên, quá 16 chữ số)', (a) => expect(() => vndInWords(a)).toThrow());
});

