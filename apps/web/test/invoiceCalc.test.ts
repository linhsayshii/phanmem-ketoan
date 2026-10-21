import { describe, expect, it } from 'vitest';
import { defaultGroup, type GroupRow, type TaxDefRow } from '../src/pages/invoiceCalc.js';

const def = (code: string, rate: string | null, method: 'deduct' | 'none' = rate === null ? 'none' : 'deduct'): TaxDefRow =>
  ({ code, name: code, scope: 'both', isActive: true, def: { code, kind: 'vat', method, rate, priceInclude: false, distributions: [] } });
const defs = [def('V10', '10'), def('KCT', null), def('KKK', null)];
const groups: GroupRow[] = [{ scope: 'sale', code: '10', name: '', rate: '10' }, { scope: 'sale', code: 'KCT', name: '', rate: null }, { scope: 'sale', code: 'KKK', name: '', rate: null },
  { scope: 'sale', code: 'KTGT', name: '', rate: null }, { scope: 'purchase', code: '01', name: '', rate: null }];

describe('defaultGroup', () => {
  it('bán ra: mã KKK vào nhóm KKK (không gộp vào KCT), KCT vào KCT, V10 theo thuế suất', () => {
    expect(defaultGroup('sale', ['KKK'], defs, groups)).toBe('KKK');
    expect(defaultGroup('sale', ['KCT'], defs, groups)).toBe('KCT');
    expect(defaultGroup('sale', ['V10'], defs, groups)).toBe('10');
    expect(defaultGroup('purchase', ['V10'], defs, groups)).toBe('01');
  });
});
