import { describe, expect, it } from 'vitest';
import { amountInWords, formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, vndInWords } from '../src/format.js';

describe('format', () => {
  it('số kiểu Việt Nam', () => {
    expect(formatVnNumber('1500000')).toBe('1.500.000');
    expect(formatVnNumber('-1500000')).toBe('-1.500.000');
    expect(formatVnNumber('1234.5', 2)).toBe('1.234,50');
    expect(formatVnNumber(null)).toBe('');
    expect(formatVnNumber('0')).toBe('0');
    expect(formatVnNumber('-0.4')).toBe('0'); expect(formatVnNumber('-0.004', 2)).toBe('0,00'); expect(formatVnNumber('-0.5')).toBe('-1'); // không in "-0" (GĐ7 gói 2, T6)
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


describe('amountInWords', () => {
  it.each([
    ['1200.50', 'đô la Mỹ', 'Một nghìn hai trăm đô la Mỹ phẩy năm mươi'], ['1200.5000', 'đô la Mỹ', 'Một nghìn hai trăm đô la Mỹ phẩy năm mươi'], ['1200', 'đô la Mỹ', 'Một nghìn hai trăm đô la Mỹ'],
    ['1200.00', 'USD', 'Một nghìn hai trăm USD'], ['0.05', 'euro', 'Không euro phẩy không năm'], ['10.5', 'euro', 'Mười euro phẩy năm mươi'], ['3.25', 'euro', 'Ba euro phẩy hai mươi lăm'],
    ['21.01', 'euro', 'Hai mươi mốt euro phẩy không một'], ['7.1234', 'euro', 'Bảy euro phẩy một nghìn hai trăm ba mươi tư'], ['7.0125', 'euro', 'Bảy euro phẩy không một trăm hai mươi lăm'], ['0', 'euro', 'Không euro'],
    ['1500000', 'đồng', 'Một triệu năm trăm nghìn đồng'],
  ])('amountInWords(%s, %s)', (a, u, w) => expect(amountInWords(a, u)).toBe(w));
  it.each(['-5', '1.', '.5', '1.12345', '', ' 1', '1e3', '12345678901234567', 'abc'])('từ chối %j', (a) => expect(() => amountInWords(a, 'euro')).toThrow());
});
