import { describe, expect, it } from 'vitest';
import { nextFiscalYearDefaults } from '../src/pages/FiscalYearForm.js';

describe('nextFiscalYearDefaults', () => {
  it('chưa có năm: 01/01 năm hiện tại, TT133, 12 tháng', () => {
    const d = nextFiscalYearDefaults([]);
    expect([d.fiscalYear, d.dateFrom.format('MM-DD'), d.months, d.regime]).toEqual([new Date().getFullYear(), '01-01', 12, 'TT133']);
  });
  it('đã có năm: bắt đầu ngay sau năm cuối, cùng chế độ', () => {
    const d = nextFiscalYearDefaults([{ fiscalYear: 2025, regime: 'TT200', dateTo: '2025-12-31' }, { fiscalYear: 2026, regime: 'TT99', dateTo: '2026-12-31' }]);
    expect([d.fiscalYear, d.dateFrom.format('YYYY-MM-DD'), d.regime]).toEqual([2027, '2027-01-01', 'TT99']);
  });
  it('năm tài chính lệch (kết thúc 31/03) vẫn nối tiếp đúng ngày', () => {
    expect(nextFiscalYearDefaults([{ fiscalYear: 2026, regime: 'TT133', dateTo: '2027-03-31' }]).dateFrom.format('YYYY-MM-DD')).toBe('2027-04-01');
  });
});
