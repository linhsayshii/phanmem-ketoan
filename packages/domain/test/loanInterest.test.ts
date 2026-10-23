import { describe, expect, it } from 'vitest';
import { addMonthsIso, loanLongTermPart } from '../src/loanInterest.js';

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
