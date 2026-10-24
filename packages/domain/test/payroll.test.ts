import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_PAYROLL_STRUCTURE, PayrollError, computePayrollLine, evaluatePayrollFormula, overtimePay, parsePayrollFormula, pitAnnualSettlement, pitProgressive,
  prorate, resolvePayrollParams, siContributions, validateStructure, workDays,
  type PayrollColumn, type PayrollInput, type PayrollStructure, type RawPayrollParams,
} from '../src/index.js';
import { D } from '../src/money.js';

// Dữ liệu minh họa — không phải văn bản pháp lý (docs/dev/bang-luong-mau-20.md). Số kỳ vọng nhập tay từ tài liệu tính tay, không sinh từ mã.
interface Fixture {
  period: { year: number; month: number }; region: 'I' | 'II' | 'III' | 'IV';
  settings: Pick<PayrollInput, 'proration' | 'standardDays' | 'standardHoursPerDay'>;
  params: RawPayrollParams;
  employees: { code: string; input: Partial<PayrollInput>; expected: Record<string, string> }[];
  totals: Record<string, string>;
  bonusRun: { period: { year: number; month: number }; input: Partial<PayrollInput>; expected: Record<string, string> };
  annualSettlement: { selfMonths: number; months: { taxableIncome: string; siEmployee: string; dependents: number; pitWithheld: string }[]; expected: Record<string, string> };
}
const FX = JSON.parse(readFileSync(new URL('../../../apps/api/test/fixtures/payroll-20.json', import.meta.url), 'utf8')) as Fixture;
const P = resolvePayrollParams(FX.params, FX.region);
const BR = P.pitBrackets!;
const full = (i: Partial<PayrollInput>, period = FX.period): PayrollInput => ({ period, ...FX.settings, ...i } as PayrollInput);
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as PayrollError).code; } return 'NO_ERROR'; };

describe('pitProgressive (thuế lũy tiến từng bậc)', () => {
  it('thu nhập tính thuế ≤ 0 → 0, không có bậc', () => {
    expect(pitProgressive('0', BR)).toEqual({ tax: '0', breakdown: [] });
    expect(pitProgressive('-5000', BR).tax).toBe('0');
  });
  it('đúng mốc từng bậc', () => {
    expect(pitProgressive('10000000', BR).tax).toBe('500000');
    expect(pitProgressive('30000000', BR).tax).toBe('2500000');
    expect(pitProgressive('60000000', BR).tax).toBe('8500000');
    expect(pitProgressive('100000000', BR).tax).toBe('20500000');
    expect(pitProgressive('128631000', BR)).toEqual({ tax: '30520850', breakdown: [
      { from: '0', to: '10000000', rate: '5', amount: '10000000', tax: '500000' },
      { from: '10000000', to: '30000000', rate: '10', amount: '20000000', tax: '2000000' },
      { from: '30000000', to: '60000000', rate: '20', amount: '30000000', tax: '6000000' },
      { from: '60000000', to: '100000000', rate: '30', amount: '40000000', tax: '12000000' },
      { from: '100000000', to: null, rate: '35', amount: '28631000', tax: '10020850' },
    ] });
  });
  it('làm tròn đồng một lần ở cuối, nửa lên', () => {
    expect(pitProgressive('60000005', BR).tax).toBe('8500002'); // 8.500.001,5
    expect(pitProgressive('10000001', BR).tax).toBe('500000'); // 500.000,1
    expect(pitProgressive('4287692', BR).tax).toBe('214385'); // 214.384,6
  });
  it('biểu bậc sai (bậc cuối có trần) → PAYROLL_PARAM_INVALID', () => {
    expect(code(() => pitProgressive('1', [{ upTo: '10', rate: 5 }]))).toBe('PAYROLL_PARAM_INVALID');
  });
});

describe('siContributions', () => {
  const p = { rates: P.siRates!, ceiling: '50600000', floor: '5310000', uiCeiling: '106200000' };
  const all = { si: true, hi: true, ui: true, occupational: true };
  it('vượt trần BHXH, dưới trần BHTN', () => {
    expect(siContributions('80000000', p, all)).toEqual({ base: '50600000', uiBase: '80000000',
      employee: { si: '4048000', hi: '759000', ui: '800000' }, employer: { si: '8602000', hi: '1518000', ui: '800000', occupational: '253000' } });
  });
  it('dưới sàn lấy sàn; không tham gia → 0', () => {
    expect(siContributions('4000000', p, all).employee).toEqual({ si: '424800', hi: '79650', ui: '53100' });
    expect(siContributions('4000000', p, { si: false, hi: true, ui: false, occupational: false })).toMatchObject({ employee: { si: '0', hi: '79650', ui: '0' }, employer: { si: '0', hi: '159300', ui: '0', occupational: '0' } });
  });
  it('không có trần BHTN riêng → dùng trần BHXH', () => {
    expect(siContributions('150000000', { rates: P.siRates!, ceiling: '50600000' }, all).employee.ui).toBe('506000');
  });
});

describe('overtimePay', () => {
  const m = P.otMultipliers!;
  it('ba loại làm thêm, phần chênh lệch không chịu thuế khi tham số cho phép', () => {
    expect(overtimePay('125000', { weekday: '10', rest: '8', holiday: '4' }, m, 'full', true)).toEqual({ pay: '5375000', taxExempt: '2625000' });
    expect(overtimePay('125000', { weekday: '10', rest: '8', holiday: '4' }, m, 'full', false)).toEqual({ pay: '5375000', taxExempt: '0' });
    expect(overtimePay('125000', { weekday: '10', rest: '0', holiday: '0' }, m, 'extra_only', true)).toEqual({ pay: '625000', taxExempt: '625000' });
  });
  it('đơn giá giờ lẻ: chia một lần ở cuối (per = số giờ chuẩn tháng)', () => {
    expect(overtimePay('15000000', { weekday: '7.5', rest: '0', holiday: '3' }, m, 'full', true, '208')).toEqual({ pay: '1460337', taxExempt: '703125' });
  });
});

describe('workDays, prorate', () => {
  it('quy đổi ngày, buổi, giờ; làm thêm theo ba loại', () => {
    expect(workDays([
      { kind: 'work_day', qty: '20' }, { kind: 'half_day', qty: '3' }, { kind: 'hour', qty: '6' }, { kind: 'paid_leave', qty: '1' },
      { kind: 'ot_weekday_hour', qty: '4' }, { kind: 'ot_rest_hour', qty: '2.5' }, { kind: 'ot_holiday_hour', qty: '1' }, { kind: 'unpaid_leave', qty: '1' },
      { kind: 'sick_leave', qty: '1' }, { kind: 'holiday', qty: '1' },
    ], '8')).toEqual({ workDays: '22.25', paidLeave: '1', sickLeave: '1', unpaidLeave: '1', holiday: '1', otWeekdayHours: '4', otRestHours: '2.5', otHolidayHours: '1' });
  });
  it('bốn cách chia lương theo công', () => {
    expect(prorate('18000000', '17.5', '26', 'calendar')).toBe('12115385');
    expect(prorate('18000000', '17.5', '0', 'standard_26')).toBe('12115385');
    expect(prorate('22000000', '11', '0', 'standard_22')).toBe('11000000');
    expect(prorate('22000000', '3', '26', 'fixed')).toBe('22000000');
  });
});

describe('payrollFormula', () => {
  const ev = (f: string, vals: Record<string, string> = {}) => evaluatePayrollFormula(parsePayrollFormula(f), {
    column: 'x', get: (c) => D(vals[c] ?? '0'), pit: (v) => D(pitProgressive(v.toString(), BR).tax), siEmp: () => D(1), siEr: () => D(2), param: (n) => D(n === 'k' ? '7' : '0'),
  }).toString();
  it('toán tử, ưu tiên, hàm', () => {
    expect(ev('1 + 2 * 3 - 4 / 2')).toBe('5');
    expect(ev('(1 + 2) * -3')).toBe('-9');
    expect(ev('MIN(5, [a], 9) + MAX(1, 2) + ABS(-3) + SUM(1, 2, 3)', { a: '4' })).toBe('15');
    expect(ev('IF([a] >= 26 && [b] == 0, 500000, 0)', { a: '26', b: '0' })).toBe('500000');
    expect(ev('IF([a] > 1 || [b] != 0, 1, 2)', { a: '0', b: '0' })).toBe('2');
    expect(ev('ROUND(1234567, -3) + ROUND(2.345, 2) + ROUND(2.5)')).toBe('1235005.35');
    expect(ev('PIT(10000000) + SI_EMP(1) + SI_ER(1) + PARAM(\'k\')')).toBe('500010');
    expect(ev('[a] <= 3 && [a] < 4 && 1', { a: '3' })).toBe('1');
  });
  it('IF chỉ tính nhánh được chọn; chia 0 → FORMULA_DIV_ZERO mang tên cột', () => {
    expect(ev('IF([a] == 0, 0, 10 / [a])')).toBe('0');
    try { ev('10 / [a]'); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(PayrollError); expect((e as PayrollError).code).toBe('FORMULA_DIV_ZERO'); expect((e as PayrollError).column).toBe('x'); }
  });
  it('lỗi cú pháp, hàm lạ, số đối số sai', () => {
    expect(code(() => parsePayrollFormula('1 +'))).toBe('FORMULA_SYNTAX');
    expect(code(() => parsePayrollFormula('[a'))).toBe('FORMULA_SYNTAX');
    expect(code(() => parsePayrollFormula('EVAL(1)'))).toBe('FORMULA_UNKNOWN_FUNCTION');
    expect(code(() => parsePayrollFormula('IF(1, 2)'))).toBe('FORMULA_ARGS');
    expect(code(() => parsePayrollFormula('PARAM(1)'))).toBe('FORMULA_ARGS');
    expect(code(() => parsePayrollFormula('constructor.constructor("x")()'))).not.toBe('NO_ERROR');
  });
});

describe('validateStructure', () => {
  const base = DEFAULT_PAYROLL_STRUCTURE.columns;
  it('cấu trúc mặc định hợp lệ', () => { expect(() => validateStructure(DEFAULT_PAYROLL_STRUCTURE)).not.toThrow(); });
  it('cột không có, vòng tham chiếu, mã trùng, builtin lạ', () => {
    const add = (...c: PayrollColumn[]): PayrollStructure => ({ columns: [...base, ...c] });
    expect(code(() => validateStructure(add({ code: 'a', name: 'A', kind: 'formula', formula: '[khong_co] + 1' })))).toBe('FORMULA_UNKNOWN_COLUMN');
    expect(code(() => validateStructure(add({ code: 'a', name: 'A', kind: 'formula', formula: '[b]' }, { code: 'b', name: 'B', kind: 'formula', formula: '[a]' })))).toBe('FORMULA_CYCLE');
    // cột thu nhập tham chiếu thực lĩnh: gross → other_income → a → net → gross
    expect(code(() => validateStructure(add({ code: 'a', name: 'A', kind: 'formula', formula: '[net] * 0.1', income: true })))).toBe('FORMULA_CYCLE');
    expect(code(() => validateStructure(add({ code: 'bonus', name: 'Trùng', kind: 'input' })))).toBe('STRUCTURE_INVALID');
    expect(code(() => validateStructure(add({ code: 'la', name: 'Lạ', kind: 'builtin' })))).toBe('STRUCTURE_INVALID');
    expect(code(() => validateStructure(add({ code: 'a', name: 'A', kind: 'formula' })))).toBe('STRUCTURE_INVALID');
  });
});

describe('bảng lương mẫu 20 nhân viên (tính tay, docs/dev/bang-luong-mau-20.md)', () => {
  const results = FX.employees.map((e) => ({ e, r: computePayrollLine(full(e.input), DEFAULT_PAYROLL_STRUCTURE, P) }));
  for (const { e, r } of results) {
    it(`${e.code}: khớp từng cột`, () => {
      for (const [k, v] of Object.entries(e.expected)) expect(r.values[k], `${e.code}.${k}`).toBe(v);
      expect({ gross: r.gross, siEmp: r.siEmp, siEr: r.siEr, pit: r.pit, net: r.net }).toEqual({ gross: e.expected.gross, siEmp: e.expected.si_emp, siEr: e.expected.si_er, pit: e.expected.pit, net: e.expected.net });
    });
  }
  it('tổng bảng lương khớp tài liệu', () => {
    for (const [k, v] of Object.entries(FX.totals)) expect(results.reduce((a, { r }) => a.plus(r.values[k]!), D(0)).toString(), k).toBe(v);
  });
  it('NV09 dưới sàn, NV05/NV06 vượt trần có cảnh báo', () => {
    const w = (c: string) => results.find((x) => x.e.code === c)!.r.warnings.map((x) => x.code);
    expect(w('NV09')).toContain('SI_FLOOR_APPLIED');
    expect(w('NV05')).toContain('SI_CEILING_APPLIED');
    expect(w('NV01')).toEqual([]);
  });
  it('bảng lương phụ (thưởng) tính TNCN trên tổng tháng trừ phần đã khấu trừ', () => {
    const r = computePayrollLine(full(FX.bonusRun.input, FX.bonusRun.period), DEFAULT_PAYROLL_STRUCTURE, P);
    for (const [k, v] of Object.entries(FX.bonusRun.expected)) expect(r.values[k], k).toBe(v);
  });
  it('quyết toán năm 12 tháng thu nhập thay đổi: hoàn chênh lệch', () => {
    const s = FX.annualSettlement;
    expect(pitAnnualSettlement(s.months, { brackets: P.pitBracketsAnnual!, deduction: P.pitDeduction! }, { selfMonths: s.selfMonths })).toEqual(s.expected);
  });
});

describe('computePayrollLine: tham số, công đoàn, cấu trúc tùy biến', () => {
  const nv = FX.employees.find((e) => e.code === 'NV13')!;
  it('làm thêm giờ mà thiếu ot_tax_exempt_extra hoặc hệ số → PAYROLL_PARAM_MISSING (không mặc định)', () => {
    const noFlag = { ...P }; delete noFlag.otTaxExemptExtra;
    const noMult = { ...P }; delete noMult.otMultipliers;
    try { computePayrollLine(full(nv.input), DEFAULT_PAYROLL_STRUCTURE, noFlag); expect.unreachable(); } catch (e) { expect((e as PayrollError).code).toBe('PAYROLL_PARAM_MISSING'); expect((e as PayrollError).param).toBe('ot_tax_exempt_extra'); }
    expect(code(() => computePayrollLine(full(nv.input), DEFAULT_PAYROLL_STRUCTURE, noMult))).toBe('PAYROLL_PARAM_MISSING');
    // không làm thêm thì không cần hai tham số này
    expect(computePayrollLine(full(FX.employees[0]!.input), DEFAULT_PAYROLL_STRUCTURE, { ...noFlag }).net).toBe('8950000');
  });
  it('không cư trú thiếu thuế suất → cảnh báo PIT_RATE_MISSING, thuế 0', () => {
    const rest = { ...P }; delete rest.pitNonResidentRate;
    const r = computePayrollLine(full(FX.employees.find((e) => e.code === 'NV15')!.input), DEFAULT_PAYROLL_STRUCTURE, rest);
    expect(r.pit).toBe('0'); expect(r.warnings.map((w) => w.code)).toContain('PIT_RATE_MISSING');
  });
  it('kinh phí công đoàn (NSDLĐ) và đoàn phí (NLĐ) theo tỷ lệ minh họa', () => {
    // Tỷ lệ 2% và 1% chỉ để kiểm phép tính, không phải giá trị pháp lý.
    const p2 = { ...P, siRates: { ...P.siRates!, employer: { ...P.siRates!.employer, union: 2, union_fee: 1 } } };
    const r = computePayrollLine(full({ ...FX.employees[0]!.input, union: { employer: true, member: true } }), DEFAULT_PAYROLL_STRUCTURE, p2);
    expect(r.values.union_er).toBe('200000');
    expect(r.values.union_fee).toBe('100000');
    expect(r.values.other_withholding).toBe('100000');
    expect(r.net).toBe('8850000');
  });
  it('cột "Thưởng chuyên cần" công thức IF, khai báo trước cột nó dùng', () => {
    const s: PayrollStructure = { columns: [{ code: 'chuyen_can', name: 'Thưởng chuyên cần', kind: 'formula', formula: 'IF([work_days] >= 26, ROUND([base_salary] * 0.05, -3), 0)', income: true, taxable: false }, ...DEFAULT_PAYROLL_STRUCTURE.columns] };
    const r = computePayrollLine(full(FX.employees[0]!.input), s, P);
    expect(r.values.chuyen_can).toBe('500000');
    expect(r.gross).toBe('10500000');
    expect(r.values.taxable_income).toBe('10000000');
  });
  it('chia 0 trong công thức → FORMULA_DIV_ZERO mang mã cột', () => {
    const s: PayrollStructure = { columns: [...DEFAULT_PAYROLL_STRUCTURE.columns, { code: 'ty_le', name: 'Tỷ lệ', kind: 'formula', formula: '[bonus] / [ot_pay]', round: 4 }] };
    try { computePayrollLine(full(FX.employees[0]!.input), s, P); expect.unreachable(); } catch (e) { expect((e as PayrollError).code).toBe('FORMULA_DIV_ZERO'); expect((e as PayrollError).column).toBe('ty_le'); }
  });
  it('đầu vào tiền sai → lỗi, không nhận number', () => {
    expect(code(() => computePayrollLine(full({ ...FX.employees[0]!.input, manual: { bonus: '1e9' } }), DEFAULT_PAYROLL_STRUCTURE, P))).toBe('PAYROLL_INPUT_INVALID');
  });
});

describe('bất biến (fast-check)', () => {
  const money = fc.bigInt({ min: 0n, max: 10n ** 9n }).map(String);
  it('thuế không giảm khi thu nhập tăng; Σ breakdown.tax = tax', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 6n), max: 10n ** 10n }), fc.bigInt({ min: 0n, max: 10n ** 9n }), (a, d) => {
      const x = pitProgressive(a.toString(), BR); const y = pitProgressive((a + d).toString(), BR);
      expect(D(x.tax).lte(D(y.tax))).toBe(true);
      expect(x.breakdown.reduce((s, b) => s.plus(b.tax), D(0)).toString()).toBe(x.tax);
    }), { numRuns: 500 });
  });
  it('thực lĩnh = gross − BH NLĐ − TNCN − khấu trừ khác', () => {
    const input = fc.record({
      salary: money, days: fc.integer({ min: 0, max: 2600 }).map((n) => (n / 100).toString()), si: money,
      ot: fc.tuple(fc.integer({ min: 0, max: 80 }), fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 20 })),
      bonus: money, advance: money, charity: fc.bigInt({ min: 0n, max: 10n ** 7n }).map(String), deps: fc.integer({ min: 0, max: 4 }),
      flags: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()), residency: fc.constantFrom('resident', 'non_resident'), contract: fc.constantFrom('long', 'short', 'none'),
    });
    fc.assert(fc.property(input, (i) => {
      const r = computePayrollLine(full({
        segments: [{ monthlySalary: i.salary, paidDays: i.days }], siSalary: i.si, otHours: { weekday: String(i.ot[0]), rest: String(i.ot[1]), holiday: String(i.ot[2]) },
        manual: { bonus: i.bonus, advance: i.advance, charity: i.charity }, dependents: Array.from({ length: i.deps }, () => ({ from: '2026-01' })),
        insurance: { si: i.flags[0], hi: i.flags[1], ui: i.flags[2], occupational: i.flags[3] }, taxResidency: i.residency as 'resident', contractType: i.contract as 'long',
      }), DEFAULT_PAYROLL_STRUCTURE, P);
      expect(r.net).toBe(D(r.gross).minus(r.siEmp).minus(r.pit).minus(r.values.other_withholding!).toString());
      expect(D(r.pit).gte(0)).toBe(true);
    }), { numRuns: 300 });
  });
  it('vòng tham chiếu bất kỳ bị từ chối', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 5 }), (n, extra) => {
      const cols: PayrollColumn[] = Array.from({ length: n }, (_, k) => ({ code: `c${k}`, name: `C${k}`, kind: 'formula', formula: `[c${(k + 1) % n}] + [gross]` }));
      for (let k = 0; k < extra; k++) cols.push({ code: `d${k}`, name: `D${k}`, kind: 'formula', formula: '[c0] * 2' });
      expect(code(() => validateStructure({ columns: [...DEFAULT_PAYROLL_STRUCTURE.columns, ...cols] }))).toBe('FORMULA_CYCLE');
    }));
  });
  it('kết quả không đổi theo thứ tự khai báo cột', () => {
    const extra: PayrollColumn[] = [
      { code: 'chuyen_can', name: 'Thưởng chuyên cần', kind: 'formula', formula: 'IF([work_days] >= 20, [muc_cc], 0)', income: true },
      { code: 'muc_cc', name: 'Mức chuyên cần', kind: 'formula', formula: 'MIN(1000000, [base_salary] * 0.04)' },
      { code: 'trich', name: 'Trích quỹ', kind: 'formula', formula: 'ROUND([net] * 0.01, -2)', deduct: false },
      { code: 'phu_cap_bh', name: 'Phụ cấp tính BH', kind: 'input', income: true, siBase: true },
    ];
    const cols = [...DEFAULT_PAYROLL_STRUCTURE.columns, ...extra];
    const e = FX.employees.find((x) => x.code === 'NV17')!;
    const inp = full({ ...e.input, manual: { phu_cap_bh: '1500000', bonus: '2000000' } });
    const ref = computePayrollLine(inp, { columns: cols }, P).values;
    fc.assert(fc.property(fc.shuffledSubarray(cols, { minLength: cols.length, maxLength: cols.length }), (shuffled) => {
      expect(computePayrollLine(inp, { columns: shuffled }, P).values).toEqual(ref);
    }), { numRuns: 50 });
  });
});
