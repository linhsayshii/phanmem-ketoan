import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYROLL_STRUCTURE, type PayrollColumn } from '@kt/domain';
import { ApiError } from '../src/api/client.js';
import {
  PARAM_DEFS, columnToRow, emptyForm, formToValue, formulaSuggestions, isIllustrative, paramMissing, parseDecimalText, parseManualInput, rowToColumn, structureProblem, summarizeParam, totalRow,
  valueToForm, type GridRow,
} from '../src/pages/payrollCommon.js';

// Số trong kiểm thử chỉ để minh họa hình dạng dữ liệu, không phải tham số pháp lý.
describe('ô nhập tay', () => {
  it('nhận số Việt Nam, rỗng là bỏ ô nhập tay, sai là undefined', () => {
    expect(parseManualInput('1.500.000')).toBe('1500000');
    expect(parseManualInput('1500000')).toBe('1500000');
    expect(parseManualInput('1234,5')).toBe('1234.5');
    expect(parseManualInput('  ')).toBeNull();
    expect(parseManualInput('abc')).toBeUndefined();
    expect(parseManualInput('1,1234567')).toBeUndefined(); // quá 6 chữ số thập phân
    expect(parseManualInput('12345678901234567')).toBeUndefined(); // quá 16 chữ số nguyên
  });
});

describe('hàng tổng', () => {
  const row = (vals: Record<string, string>): GridRow => ({ employeeId: 1, code: 'A', name: 'A', dept: '', vals, manual: new Set(), warnings: [], stale: false });
  it('cộng từng cột bằng số thập phân chính xác, bỏ ngày công chuẩn và số người phụ thuộc', () => {
    const cols: PayrollColumn[] = [{ code: 'std_days', name: 'a', kind: 'builtin' }, { code: 'gross', name: 'b', kind: 'builtin' }, { code: 'bonus', name: 'c', kind: 'input' }, { code: 'dependents', name: 'd', kind: 'builtin' }];
    const t = totalRow(cols, [row({ std_days: '26', gross: '0.1', bonus: '5' }), row({ std_days: '26', gross: '0.2' })]);
    expect(t.vals).toEqual({ gross: '0.3', bonus: '5' });
    expect(t.isTotal).toBe(true); expect(t.name).toBe('2 nhân viên');
  });
});

describe('gợi ý và kiểm công thức', () => {
  const cols = [{ code: 'gross', name: 'Tổng thu nhập', kind: 'builtin' }, { code: 'bonus', name: 'Thưởng', kind: 'input' }, { code: 'chuyen_can', name: 'Chuyên cần', kind: 'formula' }];
  it('gợi ý theo mã hoặc tên, thay đúng từ cuối, không gợi ý chính cột đang soạn', () => {
    expect(formulaSuggestions('[gro', cols, 'chuyen_can')).toEqual([{ value: '[gross]', label: 'gross - Tổng thu nhập' }]);
    expect(formulaSuggestions('IF(gross > 1, bo', cols, 'chuyen_can')).toEqual([{ value: 'IF(gross > 1, [bonus]', label: 'bonus - Thưởng' }]);
    expect(formulaSuggestions('thưởng', cols, 'x')).toEqual([]); // dấu tiếng Việt không phải ký tự mã
    expect(formulaSuggestions('[chuy', cols, 'chuyen_can')).toEqual([]);
    expect(formulaSuggestions('[', cols, 'chuyen_can').map((s) => s.value)).toEqual(['[gross]', '[bonus]']);
  });
  it('không gợi ý khi đang gõ tên hàm hoặc đã xong một tham chiếu', () => {
    expect(formulaSuggestions('IF', cols, 'x')).toEqual([]);
    expect(formulaSuggestions('MIN(', cols, 'x')).toEqual([]);
    expect(formulaSuggestions('[gross]', cols, 'x')).toEqual([]);
    expect(formulaSuggestions('', cols, 'x')).toEqual([]);
  });
  it('cấu trúc mặc định hợp lệ; bắt vòng, cột không có và mã trùng bằng thông báo tiếng Việt', () => {
    expect(structureProblem(DEFAULT_PAYROLL_STRUCTURE.columns)).toBeNull();
    const base = DEFAULT_PAYROLL_STRUCTURE.columns;
    expect(structureProblem([...base, { code: 'a', name: 'A', kind: 'formula', formula: '[b] + 1' }, { code: 'b', name: 'B', kind: 'formula', formula: '[a] + 1' }])).toMatch(/Vòng tham chiếu/);
    expect(structureProblem([...base, { code: 'a', name: 'A', kind: 'formula', formula: '[khong_co] + 1' }])).toMatch(/tham chiếu cột không có/);
    expect(structureProblem([...base, { code: 'bonus', name: 'Trùng', kind: 'input' }])).toMatch(/trùng/);
    expect(structureProblem([...base, { code: 'a', name: 'A', kind: 'formula', formula: '1 +' }])).not.toBeNull();
  });
  it('dòng soạn cột chuyển qua lại, chỉ ghi cờ khác mặc định', () => {
    const c: PayrollColumn = { code: 'bonus', name: 'Thưởng', kind: 'input', income: true, taxable: false, siBase: true };
    expect(rowToColumn(columnToRow(c, 1))).toEqual(c);
    expect(rowToColumn(columnToRow({ code: 'x', name: 'X', kind: 'input', income: true }, 1))).toEqual({ code: 'x', name: 'X', kind: 'input', income: true });
    expect(rowToColumn({ ...columnToRow(c, 1), kind: 'builtin' })).toEqual({ code: 'bonus', name: 'Thưởng', kind: 'builtin' });
    expect(rowToColumn({ ...columnToRow({ code: 'f', name: 'F', kind: 'formula', formula: ' [a] ' }, 1), round: 2 })).toEqual({ code: 'f', name: 'F', kind: 'formula', formula: '[a]', round: 2 });
  });
});

describe('tham số lương', () => {
  it('biểu mới hoàn toàn trống, không điền sẵn giá trị nào', () => {
    for (const d of PARAM_DEFS) { const f = emptyForm(d.code); expect(Object.values(f.fields)).toEqual([]); expect(f.brackets).toEqual(d.brackets ? [{ upTo: null, rate: null }] : []); }
  });
  it('bậc thuế: kiểm tăng dần, bậc cuối không giới hạn, thuế suất 0 đến 100; ra đúng hình dạng API', () => {
    const form = { ...emptyForm('pit_brackets'), brackets: [{ upTo: '1000', rate: '5' }, { upTo: '5000', rate: '10,5' }, { upTo: null, rate: '20' }] };
    expect(formToValue('pit_brackets', form)).toEqual({ ok: true, value: [{ upTo: '1000', rate: 5 }, { upTo: '5000', rate: 10.5 }, { upTo: null, rate: 20 }] });
    const bad = (b: { upTo: string | null; rate: string | null }[]) => formToValue('pit_brackets', { ...form, brackets: b });
    expect(bad([{ upTo: '5000', rate: '5' }, { upTo: '1000', rate: '10' }, { upTo: null, rate: '20' }])).toMatchObject({ ok: false, error: expect.stringContaining('Bậc 2') });
    expect(bad([{ upTo: null, rate: '120' }])).toMatchObject({ ok: false });
    expect(bad([{ upTo: '', rate: '5' }, { upTo: null, rate: '5' }])).toMatchObject({ ok: false, error: expect.stringContaining('Bậc 1') });
    expect(bad([{ upTo: null, rate: null }])).toMatchObject({ ok: false });
  });
  it('tỷ lệ bảo hiểm: đủ bảy ô bắt buộc, hai ô công đoàn tùy chọn, giữ nguyên phần tách quỹ khi sửa', () => {
    const value = { employee: { si: 1, hi: 2, ui: 3 }, employer: { si: 4, hi: 5, ui: 6, occupational: 7, union: 8 }, parts: { a: 1 } };
    const form = valueToForm('si_rates', value);
    expect(form.fields['employer.union']).toBe('8'); expect(form.fields['employer.union_fee']).toBeNull();
    expect(formToValue('si_rates', form)).toEqual({ ok: true, value });
    expect(formToValue('si_rates', { ...form, fields: { ...form.fields, 'employee.hi': '' } })).toMatchObject({ ok: false, error: expect.stringContaining('BHYT') });
    expect(formToValue('si_rates', { ...form, fields: { ...form.fields, 'employee.hi': '101' } })).toMatchObject({ ok: false });
  });
  it('mức trần cần ít nhất một mức; số tiền VND phải nguyên không âm; giá trị đơn (enum, đúng/sai)', () => {
    expect(formToValue('si_ceiling', emptyForm('si_ceiling'))).toMatchObject({ ok: false });
    expect(formToValue('si_ceiling', { ...emptyForm('si_ceiling'), fields: { si_base_max: '1000' } })).toEqual({ ok: true, value: { si_base_max: '1000' } });
    expect(formToValue('pit_deduction', { ...emptyForm('pit_deduction'), fields: { self: '1,5', dependent: '1' } })).toMatchObject({ ok: false });
    expect(formToValue('pit_income_timing', { ...emptyForm('pit_income_timing'), fields: { '': 'period' } })).toEqual({ ok: true, value: 'period' });
    expect(formToValue('ot_tax_exempt_extra', { ...emptyForm('ot_tax_exempt_extra'), fields: { '': 'false' } })).toEqual({ ok: true, value: false });
    expect(formToValue('ot_tax_exempt_extra', emptyForm('ot_tax_exempt_extra'))).toMatchObject({ ok: false });
    expect(formToValue('ot_multipliers', { ...emptyForm('ot_multipliers'), fields: { weekday: '0', weekly_rest: '1', holiday: '1' } })).toMatchObject({ ok: false });
    expect(formToValue('min_wage_region', valueToForm('min_wage_region', { I: '1', II: '2', III: '3', IV: '4' }))).toEqual({ ok: true, value: { I: '1', II: '2', III: '3', IV: '4' } });
  });
  it('tóm tắt giá trị thành một dòng chữ', () => {
    expect(summarizeParam('pit_brackets', [{ upTo: '5000000', rate: 5 }, { upTo: null, rate: 10.5 }])).toBe('2 bậc: đến 5.000.000: 5%; trên 5.000.000: 10,5%');
    expect(summarizeParam('pit_deduction', { self: '1000', dependent: '500' })).toBe('Giảm trừ bản thân: 1.000; Giảm trừ mỗi người phụ thuộc: 500');
    expect(summarizeParam('ot_tax_exempt_extra', true)).toBe('Có');
    expect(summarizeParam('pit_income_timing', 'payment_date')).toBe('Thời điểm chi trả');
  });
  it('nhận biết nguồn dữ liệu minh họa và đọc số thập phân', () => {
    expect(isIllustrative('Dữ liệu minh họa kiểm thử')).toBe(true); expect(isIllustrative('  dữ liệu minh họa')).toBe(true);
    expect(isIllustrative('Luật số 1/2025, Điều 2')).toBe(false); expect(isIllustrative(null)).toBe(false);
    expect(parseDecimalText('1,5')).toBe(1.5); expect(parseDecimalText('1.5')).toBe(1.5); expect(parseDecimalText('1,2,3')).toBeNull(); expect(parseDecimalText('')).toBeNull();
  });
});

describe('lỗi thiếu tham số', () => {
  it('lấy tên tham số, ngày, nhân viên từ chi tiết lỗi; lỗi khác là null', () => {
    const e = new ApiError('PAYROLL_PARAM_MISSING', 'Thiếu', 409, { param: 'si_rates', date: '2026-10-31', employeeCode: 'NV01' });
    expect(paramMissing(e)).toEqual({ code: 'si_rates', label: 'Tỷ lệ bảo hiểm và kinh phí công đoàn', date: '2026-10-31', employeeCode: 'NV01' });
    expect(paramMissing(new ApiError('PAYROLL_PARAM_MISSING', 'Thiếu', 409))).toMatchObject({ code: null, label: null });
    expect(paramMissing(new ApiError('SALARY_FORBIDDEN', 'x', 403))).toBeNull(); expect(paramMissing(new Error('x'))).toBeNull();
  });
});
