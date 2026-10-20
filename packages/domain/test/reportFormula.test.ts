import { describe, expect, it } from 'vitest';
import { D } from '../src/money.js';
import { evaluateReport, FormulaError, formulaRefs, parseFormula, type Resolver } from '../src/reportFormula.js';

describe('parseFormula', () => {
  it('phân tích tiền tố, loại trừ, dòng, đối ứng, số', () => {
    expect(parseFormula('111 + 112 + 113')).toEqual({ kind: 'bin', op: '+', left: { kind: 'bin', op: '+', left: { kind: 'account', prefix: '111', exclude: [] }, right: { kind: 'account', prefix: '112', exclude: [] } }, right: { kind: 'account', prefix: '113', exclude: [] } });
    expect(parseFormula('131(1312,1313)')).toEqual({ kind: 'account', prefix: '131', exclude: ['1312', '1313'] });
    expect(parseFormula('[100] + [200]')).toEqual({ kind: 'bin', op: '+', left: { kind: 'line', code: '100' }, right: { kind: 'line', code: '200' } });
    expect(parseFormula('N911/C632 - N632/C911')).toEqual({ kind: 'bin', op: '-', left: { kind: 'pair', debit: ['911'], credit: ['632'] }, right: { kind: 'pair', debit: ['632'], credit: ['911'] } });
    expect(parseFormula('N111,112/C511,131')).toEqual({ kind: 'pair', debit: ['111', '112'], credit: ['511', '131'] });
    expect(parseFormula('0')).toEqual({ kind: 'num', value: '0' });
    expect(parseFormula('1.5')).toEqual({ kind: 'num', value: '1.5' });
  });
  it('báo lỗi công thức sai', () => {
    expect(() => parseFormula('111 +')).toThrow(/Công thức/); expect(() => parseFormula('[100')).toThrow(/Công thức/); expect(() => parseFormula('N911/632')).toThrow(/Công thức/);
    expect(() => parseFormula('')).toThrow(/Công thức/); expect(() => parseFormula('111 112')).toThrow(/Công thức/); expect(() => parseFormula('131(1312')).toThrow(/Công thức/);
    expect(() => parseFormula('1.2.3')).toThrow(/Công thức/); expect(() => parseFormula('abc')).toThrow(/Công thức/);
  });
  it('mọi lỗi công thức là FormulaError (để API trả FORMULA_INVALID)', () => {
    for (const bad of ['111 +', '[100', 'N911/632', '1.2.3', '$']) {
      try { parseFormula(bad); throw new Error('phải ném lỗi'); } catch (e) { expect(e).toBeInstanceOf(FormulaError); expect((e as Error).name).toBe('FormulaError'); expect((e as Error).message).toMatch(/^Công thức "/); }
    }
  });
  it('formulaRefs liệt kê dòng và tài khoản tham chiếu', () => {
    expect(formulaRefs(parseFormula('[10] - 131(1312) + N911/C632'))).toEqual({ lines: ['10'], accounts: ['131', '1312', '911', '632'] });
  });
});

describe('evaluateReport', () => {
  const resolver: Resolver = {
    account: async (ref, source, side) => D(ref.prefix === '111' ? 100 : ref.prefix === '131' ? (side === 'debit' ? 500 : side === 'credit' ? 200 : 300) : 0).times(source === 'movement' ? 2 : 1),
    pair: async (d, c) => D(d[0] === '911' && c[0] === '632' ? 700 : 0),
  };
  it('tính theo thứ tự phụ thuộc, không phụ thuộc thứ tự khai báo', async () => {
    const r = await evaluateReport([
      { lineCode: '100', formula: '[110] + [130]', source: 'lines', side: 'net_debit' },
      { lineCode: '110', formula: '111', source: 'balance', side: 'net_debit' },
      { lineCode: '130', formula: '131', source: 'balance', side: 'debit' },
      { lineCode: '312', formula: '131', source: 'balance', side: 'credit' },
      { lineCode: '11', formula: 'N911/C632', source: 'pair', side: 'net_debit' },
      { lineCode: '01', formula: '111', source: 'movement', side: 'credit' },
      { lineCode: 'TXT', formula: null, source: 'lines', side: 'net_debit' },
    ], resolver);
    expect(r.get('110')!.toString()).toBe('100'); expect(r.get('130')!.toString()).toBe('500'); expect(r.get('312')!.toString()).toBe('200');
    expect(r.get('100')!.toString()).toBe('600'); expect(r.get('11')!.toString()).toBe('700'); expect(r.get('01')!.toString()).toBe('200'); expect(r.get('TXT')!.toString()).toBe('0');
  });
  it('phát hiện vòng lặp và dòng tham chiếu không tồn tại', async () => {
    await expect(evaluateReport([{ lineCode: 'A', formula: '[B]', source: 'lines', side: 'net_debit' }, { lineCode: 'B', formula: '[A]', source: 'lines', side: 'net_debit' }], resolver)).rejects.toThrow(/Vòng lặp/);
    await expect(evaluateReport([{ lineCode: 'A', formula: '[Z]', source: 'lines', side: 'net_debit' }], resolver)).rejects.toThrow(/không tồn tại/);
    await expect(evaluateReport([{ lineCode: 'A', formula: '[A]', source: 'lines', side: 'net_debit' }], resolver)).rejects.toBeInstanceOf(FormulaError);
  });
  it('dòng dùng số trừ cộng đúng dấu', async () => {
    const r = await evaluateReport([{ lineCode: 'X', formula: '111 - 131(1312) + 5.5', source: 'balance', side: 'net_debit' }], resolver);
    expect(r.get('X')!.toString()).toBe('-194.5'); // 100 - 300 + 5,5
  });
});
