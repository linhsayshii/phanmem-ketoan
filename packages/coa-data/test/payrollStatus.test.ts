import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, loadLegalParams } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
const base = JSON.parse(readFileSync(dataPath('tax', 'legal-params.json'), 'utf8')) as { code: string }[];
const payroll = loadLegalParams().filter((r) => /^(pit_|si_|min_wage|ot_|payroll)/.test(r.code));
const row = (code: string, from: string) => payroll.find((r) => r.code === code && r.validFrom === from)!;

describe('cổng dữ liệu pháp lý lương và thuế TNCN (GĐ6)', () => {
  it('tham số lương, thuế TNCN, BHXH, lương tối thiểu vùng đã nhập từ văn bản gốc nên cổng là true; tờ khai 05/KK, 05/QTT chưa có mẫu thì false', () => {
    for (const k of ['payrollParams_pit', 'payrollParams_si', 'payrollParams_minWage']) expect(status[k], k).toBe(true);
    for (const k of ['05KK_TNCN_TT89', '05QTT_TNCN_TT89']) expect(status[k], k).toBe(false);
    const note = String(status['payrollParams_note']) + String(status['TNCN_note']);
    for (const t of ['109/2025/QH15', '41/2024/QH15', '293/2025', 'TT 89/2026', '05/KK-TNCN', '05/QTT-TNCN']) expect(note, t).toContain(t);
  });
  it('tham số lương nằm ở legal-params-payroll.json (không lẫn vào legal-params.json); mỗi dòng ghi nguồn văn bản và ngày tải', () => {
    expect(base.filter((r) => /^(pit_|si_|min_wage|ot_|payroll)/.test(r.code)).map((r) => r.code)).toEqual([]);
    expect([...new Set(payroll.map((r) => r.code))].sort()).toEqual(['min_wage_region', 'pit_brackets', 'pit_brackets_annual', 'pit_deduction', 'pit_flat_rate_no_contract', 'pit_non_resident_rate', 'si_ceiling', 'si_floor', 'si_rates']);
    for (const r of payroll) { expect(r.source, r.code).toContain('tải 2026-10-29'); expect(r.source, r.code).toMatch(/Điều \d+/); }
  });
  it('không nhập tham số mà văn bản chỉ quy định mức tối thiểu hoặc chưa rõ cách hiểu (hệ số làm thêm giờ, miễn thuế làm thêm giờ, thời điểm tính thu nhập)', () => {
    for (const c of ['ot_multipliers', 'ot_tax_exempt_extra', 'pit_income_timing']) expect(payroll.some((r) => r.code === c), c).toBe(false);
  });
  it('biểu thuế lũy tiến 5 bậc tháng và năm đúng Luật 109/2025/QH15 Điều 9 khoản 2 (đối chiếu ảnh trang 8)', () => {
    expect(row('pit_brackets', '2026-01-01').value).toEqual([{ upTo: '10000000', rate: 5 }, { upTo: '30000000', rate: 10 }, { upTo: '60000000', rate: 20 }, { upTo: '100000000', rate: 30 }, { upTo: null, rate: 35 }]);
    expect(row('pit_brackets_annual', '2026-01-01').value).toEqual([{ upTo: '120000000', rate: 5 }, { upTo: '360000000', rate: 10 }, { upTo: '720000000', rate: 20 }, { upTo: '1200000000', rate: 30 }, { upTo: null, rate: 35 }]);
    expect(row('pit_deduction', '2026-01-01').value).toEqual({ self: '15500000', dependent: '6200000' });
    expect(row('pit_deduction', '2026-01-01').validTo).toBeNull();
  });
  it('khấu trừ tại nguồn: 10% (NĐ 253/2026 Điều 50 khoản 2) từ kỳ tính thuế 2026; không cư trú 20% (Luật 109 Điều 21) từ 01/7/2026', () => {
    expect(row('pit_flat_rate_no_contract', '2026-01-01')).toMatchObject({ value: { rate: 10 }, validTo: null });
    expect(row('pit_non_resident_rate', '2026-07-01')).toMatchObject({ value: { rate: 20 }, validTo: null });
  });
  it('lương tối thiểu vùng NĐ 293/2025 và bảo hiểm: tỷ lệ, trần, sàn theo lương cơ sở 2.340.000 đến 30/6/2026 và 2.530.000 từ 01/7/2026', () => {
    expect(row('min_wage_region', '2026-01-01').value).toEqual({ I: '5310000', II: '4730000', III: '4140000', IV: '3700000' });
    expect(row('si_rates', '2026-01-01').value).toEqual({ employee: { si: 8, hi: 1.5, ui: 1 }, employer: { si: 17, hi: 3, ui: 1, occupational: 0.5, union: 2 } });
    expect(row('si_ceiling', '2026-01-01')).toMatchObject({ value: { si_base_max: String(20 * 2340000), ui_base_max_multiple_of_min_wage: 20 }, validTo: '2026-06-30' });
    expect(row('si_ceiling', '2026-07-01')).toMatchObject({ value: { si_base_max: String(20 * 2530000), ui_base_max_multiple_of_min_wage: 20 }, validTo: null });
    expect(row('si_floor', '2026-01-01')).toMatchObject({ value: { si_base_min: '2340000' }, validTo: '2026-06-30' });
    expect(row('si_floor', '2026-07-01')).toMatchObject({ value: { si_base_min: '2530000' }, validTo: null });
  });
});
