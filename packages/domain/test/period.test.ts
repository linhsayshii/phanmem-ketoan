import { describe, expect, it } from 'vitest';
import { buildFiscalPeriods } from '../src/period.js';

describe('buildFiscalPeriods', () => {
  it('năm dương lịch 12 tháng có kỳ 0 là ngày trước ngày bắt đầu', () => {
    const ps = buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
    expect(ps).toHaveLength(13);
    expect(ps[0]).toEqual({ fiscalYear: 2026, periodNo: 0, dateFrom: '2025-12-31', dateTo: '2025-12-31', regime: 'TT99' });
    expect(ps[1]).toMatchObject({ periodNo: 1, dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(ps[2]).toMatchObject({ periodNo: 2, dateFrom: '2026-02-01', dateTo: '2026-02-28' });
    expect(ps[12]).toMatchObject({ periodNo: 12, dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  });
  it('năm đầu 15 tháng bắt đầu 01/10/2025', () => {
    const ps = buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2025-10-01', months: 15, regime: 'TT99' });
    expect(ps).toHaveLength(16);
    expect(ps[15]).toMatchObject({ periodNo: 15, dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  });
  it('từ chối số tháng ngoài 1..15 hoặc ngày không phải đầu tháng', () => {
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-01-01', months: 16, regime: 'TT99' })).toThrow();
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-01-15', months: 12, regime: 'TT99' })).toThrow();
  });
  it('từ chối ngày không hợp lệ hoặc fiscalYear không nguyên', () => {
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-02-29', months: 12, regime: 'TT99' })).toThrow('dateFrom phải là ngày đầu tháng dạng YYYY-MM-01');
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-4-1', months: 12, regime: 'TT99' })).toThrow('dateFrom phải là ngày đầu tháng dạng YYYY-MM-01');
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-04-15', months: 12, regime: 'TT99' })).toThrow('dateFrom phải là ngày đầu tháng dạng YYYY-MM-01');
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-13-01', months: 12, regime: 'TT99' })).toThrow('dateFrom phải là ngày đầu tháng dạng YYYY-MM-01');
    expect(() => buildFiscalPeriods({ fiscalYear: 2026.5, dateFrom: '2026-01-01', months: 12, regime: 'TT99' })).toThrow('fiscalYear phải là số nguyên');
  });
});
