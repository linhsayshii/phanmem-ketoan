import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountingRegimeRules, checkRegimeForYear, dataPath, isReportComplete, reportApproximations } from '../src/index.js';

// GĐ7 gói 2 (TB5): chỉ tiêu để 0 cố định in kèm báo cáo phải đúng với CSV (cột 6 là công thức).
describe('reports/approximations.json', () => {
  it('mọi chỉ tiêu fixedZero có trong báo cáo và công thức là 0', () => {
    for (const [regime, dir] of [['TT99', 'tt99'], ['TT133', 'tt133'], ['TT200', 'tt200']] as const) for (const code of ['B01', 'B02', 'B03']) {
      const lines = readFileSync(dataPath('reports', dir, `${code}.csv`), 'utf8').split('\n').slice(1).filter(Boolean);
      for (const lc of reportApproximations(regime, code).fixedZero) {
        const row = lines.find((l) => l.startsWith(`${lc},`)); expect(row, `${regime} ${code} ${lc}`).toBeTruthy();
        expect(row!.replace(/"[^"]*"/g, 'X').split(',')[5], `${regime} ${code} ${lc}: công thức`).toBe('0');
      }
    }
    expect(reportApproximations('TT200', 'B01').fixedZero).toEqual(['112', '219', '241', '261', '263', '340']);
    expect(reportApproximations('KHAC', 'B01')).toEqual({ fixedZero: [], approx: [] });
    expect(reportApproximations('TT99', 'B01').fixedZero).toContain('112');
  });
});

// GĐ7 gói 2 (C4): hiệu lực và cổng của TT99, TT133, TT200 là dữ liệu (data/regimes/accounting.json), không viết cứng ở mã.
describe('regimes/accounting.json: hiệu lực và cổng TT99, TT133, TT200', () => {
  it('TT200 sẵn sàng (Phụ lục 1 và B01-B03 đã đối chiếu), áp dụng từ 2015 và hết hiệu lực từ 2026; cổng reports khớp reports/status.json', () => {
    const r = checkRegimeForYear('TT200', '2025-01-01');
    expect(r).toMatchObject({ ready: true, effective: true, effectiveTo: '2025-12-31', notReady: [] });
    expect(accountingRegimeRules().TT200.gates!.reports).toBe(['B01', 'B02', 'B03'].every((c) => isReportComplete('TT200', c)));
    expect(checkRegimeForYear('TT200', '2014-01-01').effective).toBe(false); expect(checkRegimeForYear('TT200', '2015-01-01').effective).toBe(true);
    expect(checkRegimeForYear('TT200', '2026-01-01').effective).toBe(false);
    expect(accountingRegimeRules().TT200.missing).toEqual([]);
  });
  it('TT99 chỉ áp dụng cho năm tài chính bắt đầu từ 01/01/2026; cổng lấy từ tt99.status.json và reports/status.json', () => {
    expect(checkRegimeForYear('TT99', '2025-12-01').effective).toBe(false);
    expect(checkRegimeForYear('TT99', '2026-01-01')).toMatchObject({ ready: true, effective: true });
    expect(checkRegimeForYear('TT99', '2027-01-01').effective).toBe(true);
  });
  it('TT133 không giới hạn ngày và sẵn sàng; TT58, TT152 chưa sẵn sàng, hiệu lực lấy từ regimes/status.json', () => {
    expect(checkRegimeForYear('TT133', '2010-01-01')).toMatchObject({ ready: true, effective: true });
    expect(checkRegimeForYear('TT152', '2025-01-01').effective).toBe(false);
    expect(checkRegimeForYear('TT152', '2026-01-01').effective).toBe(true);
    expect(checkRegimeForYear('TT58', '2026-01-01').effective).toBe(false); // hiệu lực 01/07/2026
    expect(checkRegimeForYear('KHAC', '2026-01-01').ready).toBe(false);
  });
});
