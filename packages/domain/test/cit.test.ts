import { describe, expect, it } from 'vitest';
import { CitError, citRateFor, evalCitReturn, quarterlyEstimate, type CitRateParam } from '../src/cit.js';

// Luật 67/2025/QH15 Điều 10: 20%; 15% doanh thu năm trước không quá 3 tỷ; 17% trên 3 tỷ đến 50 tỷ. NĐ 141/2026 Điều 2: miễn khi từ 1 tỷ trở xuống (từ kỳ 2026).
const P: CitRateParam = { standard: 20, tiers: [{ maxRevenue: '50000000000', rate: 17 }, { maxRevenue: '3000000000', rate: 15 }] }; // thứ tự bậc không quan trọng
const TY = (n: number) => String(BigInt(Math.round(n * 1000)) * 1_000_000n);

describe('thuế suất TNDN', () => {
  it('citRateFor theo bậc doanh thu năm trước khi có tham số; không tham số và không override → lỗi CIT_RATE_REQUIRED', () => {
    expect(citRateFor(TY(3), P).rate).toBe('15');
    expect(citRateFor(String(BigInt(TY(3)) + 1n), P).rate).toBe('17');
    expect(citRateFor(TY(50), P).rate).toBe('17');
    expect(citRateFor(TY(50.001), P)).toMatchObject({ rate: '20', exempt: false });
    expect(citRateFor(TY(70), P, '22').rate).toBe('22'); // nhập tay thắng
    expect(citRateFor(null, null, '20')).toMatchObject({ rate: '20', basis: expect.stringContaining('nhập tay') });
    expect(() => citRateFor(TY(1), null)).toThrow(CitError);
    try { citRateFor(TY(1), null); } catch (e) { expect((e as CitError).code).toBe('CIT_RATE_REQUIRED'); }
    expect(() => citRateFor(null, P)).toThrow(/doanh thu năm trước/);
    expect(() => citRateFor(TY(1), P, '101')).toThrow(CitError);
  });

  it('doanh thu năm trước ≤ 1 tỷ (2026): miễn thuế, số phải nộp 0; ≤ 3 tỷ: 15%', () => {
    const exempt = citRateFor(TY(1), P, undefined, TY(1));
    expect(exempt).toMatchObject({ rate: '0', exempt: true });
    expect(quarterlyEstimate({ ytdProfit: TY(0.4), adjustments: '0', lossCarried: '0', rate: exempt.rate, paidYtd: '0' }).payable).toBe('0');
    const r = citRateFor(String(BigInt(TY(1)) + 1n), P, undefined, TY(1));
    expect(r).toMatchObject({ rate: '15', exempt: false });
    expect(quarterlyEstimate({ ytdProfit: '200000000', adjustments: '0', lossCarried: '0', rate: r.rate, paidYtd: '0' })).toEqual({ taxableIncome: '200000000', taxYtd: '30000000', payable: '30000000' });
    expect(citRateFor(TY(1), P).rate).toBe('15'); // không có tham số miễn (kỳ trước 2026) thì vẫn 15%
  });
});

describe('tạm tính quý', () => {
  it('quarterlyEstimate: lỗ lũy kế → payable 0', () => {
    expect(quarterlyEstimate({ ytdProfit: '-50000000', adjustments: '10000000', lossCarried: '0', rate: '20', paidYtd: '0' })).toEqual({ taxableIncome: '0', taxYtd: '0', payable: '0' });
    expect(quarterlyEstimate({ ytdProfit: '100000000', adjustments: '0', lossCarried: '150000000', rate: '20', paidYtd: '5000000' }).payable).toBe('0');
  });
  it('trừ số đã tạm nộp, làm tròn đến đồng (nửa lên)', () => {
    expect(quarterlyEstimate({ ytdProfit: '100000003', adjustments: '5000000', lossCarried: '1000000', rate: '17', paidYtd: '10000000' }))
      .toEqual({ taxableIncome: '104000003', taxYtd: '17680001', payable: '7680001' }); // 104.000.003 × 17% = 17.680.000,51
    expect(quarterlyEstimate({ ytdProfit: '100', adjustments: '0', lossCarried: '0', rate: '20', paidYtd: '50' }).payable).toBe('0');
    expect(() => quarterlyEstimate({ ytdProfit: '1.5', adjustments: '0', lossCarried: '0', rate: '20', paidYtd: '0' })).toThrow(CitError);
  });
});

describe('tính tờ khai 03/TNDN theo mẫu dữ liệu', () => {
  const t = { lines: [
    { code: 'A', kind: 'section' as const }, { code: 'A1', kind: 'ledger' as const, overridable: true }, { code: 'B2', kind: 'input' as const, overridable: true },
    { code: 'B13', kind: 'formula' as const, formula: 'A1+B2' }, { code: 'C7a', kind: 'rate' as const, overridable: true },
    { code: 'C9', kind: 'formula' as const, formula: 'B13*C7a/100', clamp: 'positivePart' as const }, { code: '04', kind: 'text' as const, overridable: true },
    { code: 'E1', kind: 'formula' as const, formula: 'C9', overridable: true }, { code: 'I', kind: 'formula' as const, formula: '(E1-B2)-(0-A1)' },
  ] };
  it('nguồn sổ cái, mặc định, ghi đè; nhân chia phần trăm làm tròn; kẹp không âm; dòng tiêu đề không có số', () => {
    const v = evalCitReturn(t, { ledger: { A1: '1000005' }, defaults: { C7a: '20' }, overrides: { B2: '2', '04': 'Bán buôn' } });
    expect(v).toEqual({ A1: '1000005', B2: '2', B13: '1000007', C7a: '20', C9: '200001', '04': 'Bán buôn', E1: '200001', I: '1200004' });
    expect(evalCitReturn(t, { ledger: { A1: '-500' }, defaults: {}, overrides: {} })).toMatchObject({ C9: '0', C7a: '0', '04': '' });
    expect(evalCitReturn(t, { ledger: { A1: '100' }, defaults: { C7a: '20' }, overrides: { E1: '7' } }).E1).toBe('7');
  });
  it('ghi đè chỉ tiêu không cho sửa, số sai định dạng, thuế suất quá 100% → CitError', () => {
    expect(() => evalCitReturn(t, { ledger: {}, defaults: {}, overrides: { B13: '1' } })).toThrow(/không ghi đè/);
    expect(() => evalCitReturn(t, { ledger: {}, defaults: {}, overrides: { B2: '1.5' } })).toThrow(CitError);
    expect(() => evalCitReturn(t, { ledger: {}, defaults: {}, overrides: { C7a: '120' } })).toThrow(CitError);
    expect(() => evalCitReturn({ lines: [{ code: 'B1', kind: 'formula', formula: 'B1+1' }] }, { ledger: {}, defaults: {}, overrides: {} })).toThrow(/Vòng lặp/);
  });
});
