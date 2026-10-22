import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocateByRatio, buildSchedule, futurePeriods, periodUnits, targetAccumulated, type ActiveWindow, type DepreciationUnit, type PeriodSpan } from '../src/depreciation.js';
import { D } from '../src/money.js';

const span = (y: number, m: number): PeriodSpan => futurePeriods([], y, m, 1)[0]!;
const jan = span(2026, 1);
const open = (start: string): ActiveWindow => ({ start, end: null, pauses: [] });
const total = (xs: { amount: string }[]) => xs.reduce((t, x) => t.plus(x.amount), D(0)).toString();

describe('periodUnits', () => {
  it('month_day: bắt đầu 16/01/2026, kỳ tháng 1 tiêu thụ 16/31', () => expect(periodUnits(jan, open('2026-01-16'), 'month_day')).toBe('0.516129032258'));
  it('month_whole: bắt đầu 16/01 tính đủ tháng 1; ghi giảm 10/03 thì tháng 3 bằng 0', () => {
    const w: ActiveWindow = { start: '2026-01-16', end: '2026-03-10', pauses: [] };
    expect(periodUnits(jan, w, 'month_whole')).toBe('1');
    expect(periodUnits(span(2026, 2), w, 'month_whole')).toBe('1');
    expect(periodUnits(span(2026, 3), w, 'month_whole')).toBe('0');
    expect(periodUnits(span(2025, 12), w, 'month_whole')).toBe('0');
  });
  it('dừng 10/02–19/02 (to là ngày tiếp tục): tháng 2 tiêu thụ 19/28', () => {
    const w: ActiveWindow = { start: '2026-01-01', end: null, pauses: [{ from: '2026-02-10', to: '2026-02-19' }] };
    expect(periodUnits(span(2026, 2), w, 'month_day')).toBe(D(19).div(28).toDecimalPlaces(12).toString());
    expect(periodUnits(span(2026, 2), w, 'month_whole')).toBe('1');
    expect(periodUnits(span(2026, 3), { ...w, pauses: [{ from: '2026-02-10', to: null }] }, 'month_whole')).toBe('0');
  });
  it('month_day: ghi giảm 10/03 tính 9/31 ngày tháng 3', () => expect(periodUnits(span(2026, 3), { start: '2026-01-01', end: '2026-03-10', pauses: [] }, 'month_day')).toBe(D(9).div(31).toDecimalPlaces(12).toString()));
  it('period: kỳ bắt đầu tính 1 dù dừng; kỳ bị dừng từ ngày đầu tính 0; kỳ ghi giảm ngày đầu tính 0', () => {
    expect(periodUnits(jan, { start: '2026-01-20', end: null, pauses: [{ from: '2026-01-20', to: null }] }, 'period')).toBe('1');
    expect(periodUnits(span(2026, 2), { start: '2026-01-20', end: null, pauses: [{ from: '2026-02-01', to: '2026-02-05' }] }, 'period')).toBe('0');
    expect(periodUnits(span(2026, 2), { start: '2026-01-20', end: null, pauses: [{ from: '2026-02-02', to: '2026-02-05' }] }, 'period')).toBe('1');
    expect(periodUnits(span(2026, 2), { start: '2026-01-20', end: '2026-02-01', pauses: [] }, 'period')).toBe('0');
    expect(periodUnits(span(2026, 2), { start: '2026-01-20', end: '2026-02-02', pauses: [] }, 'period')).toBe('1');
  });
  it('kỳ 0 và kỳ > 12 tiêu thụ 0', () => {
    expect(periodUnits({ ...jan, periodNo: 0 }, open('2026-01-01'), 'month_day')).toBe('0');
    expect(periodUnits({ ...jan, periodNo: 13 }, open('2026-01-01'), 'period')).toBe('0');
  });
});

describe('targetAccumulated', () => {
  it('làm tròn nửa lên theo lũy kế, đủ đơn vị trả cơ sở', () => {
    expect(targetAccumulated('100', '3', '1')).toBe('33');
    expect(targetAccumulated('100', '8', '1')).toBe('13'); // 12,5
    expect(targetAccumulated('100', '3', '3.5')).toBe('100');
    expect(targetAccumulated('100', '0', '0')).toBe('100');
  });
});

describe('buildSchedule', () => {
  it('nguyên giá 120.000.000, 60 tháng, bắt đầu 01/01/2026: mỗi kỳ 2.000.000, kỳ 60 lũy kế 120.000.000', () => {
    const s = buildSchedule({ basisValue: '120000000', basisAcc: '0', units: '60', periods: futurePeriods([], 2026, 1, 70), window: open('2026-01-01'), unit: 'month_day' });
    expect(s).toHaveLength(60);
    expect(s.every((l) => l.amount === '2000000')).toBe(true);
    expect(s[59]).toMatchObject({ fiscalYear: 2030, periodNo: 12, accumulated: '120000000' });
  });
  it('100.000.000 / 7 kỳ: các kỳ 14285714 hoặc 14285715, tổng đúng 100.000.000', () => {
    const s = buildSchedule({ basisValue: '100000000', basisAcc: '5000', units: '7', periods: futurePeriods([], 2026, 3, 20), window: open('2026-03-05'), unit: 'period' });
    expect(s).toHaveLength(7);
    expect(s.every((l) => l.amount === '14285714' || l.amount === '14285715')).toBe(true);
    expect(total(s)).toBe('100000000');
    expect(s[6]!.accumulated).toBe('100005000');
  });
  it('month_day bắt đầu 16/01, 12 tháng, 12.000.000: kỳ 1 = 516.129, kỳ 13 nhận phần còn lại, tổng 12.000.000', () => {
    const s = buildSchedule({ basisValue: '12000000', basisAcc: '0', units: '12', periods: futurePeriods([], 2026, 1, 24), window: open('2026-01-16'), unit: 'month_day' });
    expect(s).toHaveLength(13);
    expect(s[0]).toMatchObject({ units: '0.516129032258', amount: '516129' });
    expect(s[12]).toMatchObject({ fiscalYear: 2027, periodNo: 1, units: '1', amount: String(12000000 - 516129 - 11 * 1000000) });
    expect(total(s)).toBe('12000000');
  });
  it('kỳ không tiêu thụ đơn vị (dừng cả tháng) không có dòng', () => {
    const s = buildSchedule({ basisValue: '3000', basisAcc: '0', units: '3', periods: futurePeriods([], 2026, 1, 12), window: { start: '2026-01-01', end: null, pauses: [{ from: '2026-02-01', to: '2026-03-01' }] }, unit: 'month_whole' });
    expect(s.map((l) => l.periodNo)).toEqual([1, 3, 4]);
  });
});

describe('allocateByRatio', () => {
  it('allocateByRatio("1000001", ["60","40"]) = ["600001","400000"]; phần dư lớn nhất, thứ tự ổn định', () => {
    expect(allocateByRatio('1000001', ['60', '40'])).toEqual(['600001', '400000']);
    expect(allocateByRatio('5', ['30', '30', '30', '10'])).toEqual(['2', '2', '1', '0']);
    expect(allocateByRatio('-1000001', ['60', '40'])).toEqual(['-600001', '-400000']);
  });
  it('tổng luôn bằng amount, không phần nào trái dấu (fast-check)', () => fc.assert(fc.property(
    fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 1, maxLength: 8 }).filter((r) => r.some((x) => x > 0)),
    (a, rs) => {
      const parts = allocateByRatio(a.toString(), rs.map((r) => (r / 100).toFixed(2)));
      expect(parts.reduce((t, x) => t.plus(x), D(0)).toString()).toBe(a.toString());
      expect(parts.every((x) => (a < 0n ? D(x).lte(0) : D(x).gte(0)))).toBe(true);
    })));
});

describe('futurePeriods', () => {
  it('dùng kỳ đã có, bỏ kỳ 0 và kỳ > 12; năm chưa có giả định 12 tháng theo tháng bắt đầu năm tài chính', () => {
    const known: PeriodSpan[] = [{ fiscalYear: 2026, periodNo: 0, from: '2026-03-31', to: '2026-03-31' },
      ...Array.from({ length: 12 }, (_, i) => ({ fiscalYear: 2026, periodNo: i + 1, ...(({ from, to }) => ({ from, to }))(span(2026 + Math.floor((3 + i) / 12), ((3 + i) % 12) + 1)) })),
      { fiscalYear: 2026, periodNo: 13, from: '2027-03-31', to: '2027-03-31' }];
    const r = futurePeriods(known, 2026, 11, 4);
    expect(r).toEqual([{ fiscalYear: 2026, periodNo: 11, from: '2027-02-01', to: '2027-02-28' }, { fiscalYear: 2026, periodNo: 12, from: '2027-03-01', to: '2027-03-31' },
      { fiscalYear: 2027, periodNo: 1, from: '2027-04-01', to: '2027-04-30' }, { fiscalYear: 2027, periodNo: 2, from: '2027-05-01', to: '2027-05-31' }]);
    expect(futurePeriods([], 2027, 12, 2)).toEqual([{ fiscalYear: 2027, periodNo: 12, from: '2027-12-01', to: '2027-12-31' }, { fiscalYear: 2028, periodNo: 1, from: '2028-01-01', to: '2028-01-31' }]);
  });
});

describe('thuộc tính lịch (fast-check)', () => {
  const dateArb = fc.integer({ min: 0, max: 364 }).map((n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10));
  it('mọi lịch tổng amount = basisValue khi đủ kỳ; không kỳ nào âm; accumulated tăng đơn điệu', () => fc.assert(fc.property(
    fc.bigInt({ min: 0n, max: 10n ** 13n }), fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.integer({ min: 1, max: 120 }), dateArb, fc.constantFrom<DepreciationUnit>('month_day', 'month_whole', 'period'),
    fc.option(fc.tuple(dateArb, fc.integer({ min: 1, max: 90 })), { nil: undefined }),
    (basis, acc0, units, start, unit, pause) => {
      const pauses = pause ? [{ from: pause[0], to: new Date(Date.parse(pause[0]) + pause[1] * 86400000).toISOString().slice(0, 10) }] : [];
      const s = buildSchedule({ basisValue: basis.toString(), basisAcc: acc0.toString(), units: String(units), periods: futurePeriods([], 2026, 1, units + 20), window: { start, end: null, pauses }, unit });
      expect(total(s)).toBe(basis.toString());
      let prev = D(acc0.toString());
      for (const l of s) {
        expect(D(l.amount).gte(0)).toBe(true);
        expect(D(l.units).gt(0)).toBe(true);
        expect(D(l.accumulated).gte(prev)).toBe(true);
        prev = D(l.accumulated);
      }
      expect(prev.toString()).toBe((basis + acc0).toString());
    })));
});
