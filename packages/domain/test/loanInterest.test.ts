import { describe, expect, it } from 'vitest';
import { addMonthsIso, loanLongTermPart, periodInterest } from '../src/loanInterest.js';

const sched = ['2026-06-30', '2026-12-31', '2027-06-30', '2027-12-31', '2028-06-30', '2028-12-31'].map((dueDate) => ({ dueDate, principal: '150000000' }));
describe('loanLongTermPart', () => {
  it('vay 900tr, 6 kỳ 150tr, đã trả kỳ 30/06/2026 (dư 750tr), báo cáo 31/12/2026: ngắn hạn 450tr, dài hạn 300tr', () => {
    expect(loanLongTermPart('750000000', '150000000', sched, '2026-12-31', null)).toBe('300000000');
  });
  it('đã trả ba kỳ (dư 450tr): ngắn hạn 150tr, dài hạn 300tr', () => {
    expect(loanLongTermPart('450000000', '450000000', sched, '2026-12-31', null)).toBe('300000000');
  });
  it('kỳ quá hạn chưa trả vẫn là ngắn hạn; dư nợ nhỏ hơn tổng ngắn hạn thì dài hạn 0', () => {
    expect(loanLongTermPart('300000000', '0', sched.slice(0, 2), '2026-12-31', null)).toBe('0');
    expect(loanLongTermPart('900000000', '0', sched, '2026-12-31', null)).toBe('300000000');
  });
  it('không lịch: theo ngày đáo hạn', () => {
    expect(loanLongTermPart('500', '0', [], '2026-12-31', '2028-01-01')).toBe('500');
    expect(loanLongTermPart('500', '0', [], '2026-12-31', '2027-12-31')).toBe('0');
    expect(loanLongTermPart('500', '0', [], '2026-12-31', null)).toBe('0');
    expect(loanLongTermPart('0', '0', sched, '2026-12-31', null)).toBe('0');
  });
  it('addMonthsIso lùi về cuối tháng', () => { expect(addMonthsIso('2027-02-28', 12)).toBe('2028-02-28'); expect(addMonthsIso('2028-02-29', 12)).toBe('2029-02-28'); });
});

describe('periodInterest', () => {
  it('giải ngân 1.000.000.000 ngày 11/01, lãi 9%/năm, 365: lãi tháng 1 = round(1e9 × 0,09 × 21/365) = 5.178.082', () => {
    expect(periodInterest({ from: '2026-01-01', to: '2026-01-31', balances: [{ date: '2026-01-11', balance: '1000000000' }], rates: [{ validFrom: '2026-01-01', annualRate: '9' }], dayBasis: 365, decimals: 0 })).toBe('5178082');
  });
  it('lãi suất đổi 9% → 10% từ 16/02, trả 200tr ngày 20/02: lãi tháng 2 tính bậc thang đúng tay', () => {
    // (1e9 × 9% × 15 + 1e9 × 10% × 4 + 8e8 × 10% × 9) / 365 = 2.470.000.000 / 365 = 6.767.123,29
    expect(periodInterest({ from: '2026-02-01', to: '2026-02-28', balances: [{ date: '2026-01-11', balance: '1000000000' }, { date: '2026-02-20', balance: '800000000' }],
      rates: [{ validFrom: '2026-01-01', annualRate: '9' }, { validFrom: '2026-02-16', annualRate: '10' }], dayBasis: 365, decimals: 0 })).toBe('6767123');
  });
  it('ngoại tệ 2 chữ số, cơ sở 360; trước ngày hiệu lực lãi suất đầu tiên không tính lãi; dư nợ 0 thì lãi 0', () => {
    expect(periodInterest({ from: '2026-01-01', to: '2026-01-31', balances: [{ date: '2026-01-02', balance: '100000' }], rates: [{ validFrom: '2026-01-01', annualRate: '6' }], dayBasis: 360, decimals: 2 })).toBe('500.00');
    expect(periodInterest({ from: '2026-01-01', to: '2026-01-31', balances: [{ date: '2025-12-01', balance: '360000' }], rates: [{ validFrom: '2026-01-31', annualRate: '10' }], dayBasis: 360, decimals: 2 })).toBe('100.00');
    expect(periodInterest({ from: '2026-01-01', to: '2026-01-31', balances: [], rates: [{ validFrom: '2026-01-01', annualRate: '6' }], dayBasis: 365, decimals: 0 })).toBe('0');
  });
});
