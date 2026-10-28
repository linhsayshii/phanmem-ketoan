import { describe, expect, it } from 'vitest';
import { BOOK_REGIMES, isRegimeReady, loadBookSet, loadCoaTemplate, regimeReportsReady, regimeStatus } from '../src/index.js';

describe('regimes/status.json: cổng pháp lý TT58 và TT152 (đã có văn bản gốc)', () => {
  for (const r of BOOK_REGIMES) {
    it(`${r}: có văn bản gốc, thông tư không có hệ thống tài khoản, sổ đã nhập`, () => {
      const s = regimeStatus()[r];
      expect(s.primaryTextObtained).toBe(true);
      expect(s.applicable.coa).toBe(false);
      expect(s.gates.books).toBe(true);
      expect(isRegimeReady(r)).toBe(true);
      expect(s.sources.length).toBeGreaterThan(0);
      expect(s.sources.every((x) => x.kind.startsWith('văn bản gốc'))).toBe(true);
    });
  }
  it('TT152 không có báo cáo tài chính nên không áp dụng; TT58 chưa lập được B01-DNSN nên cổng báo cáo còn false, có giới hạn ghi rõ', () => {
    expect(regimeReportsReady('TT152')).toBe(true);
    expect(regimeStatus().TT152.gates.reports).toBe(false);
    expect(regimeReportsReady('TT58')).toBe(false);
    expect(regimeStatus().TT58.limits.some((l) => l.includes('B01-DNSN'))).toBe(true);
  });
  it('không có mẫu hệ thống tài khoản cho chế độ này (không bịa danh mục)', () => {
    expect(() => loadCoaTemplate('TT152')).toThrow();
  });
});

describe('data/books: định nghĩa sổ theo văn bản gốc', () => {
  it('TT152 có đúng 7 sổ S1a, S2a, S2b, S2c, S2d, S2e, S3a-HKD, đều đã dựng và đối chiếu', () => {
    const b = loadBookSet('TT152');
    expect(b.books.map((x) => x.code)).toEqual(['S1a-HKD', 'S2a-HKD', 'S2b-HKD', 'S2c-HKD', 'S2d-HKD', 'S2e-HKD', 'S3a-HKD']);
    expect(b.books.every((x) => x.built && x.verified)).toBe(true);
    expect(b.reports).toEqual([]);
  });
  it('số cột từng mẫu đúng văn bản: S1a 3, S2a 4, S2d 12, S2e 5, S3a 12 (A, B, 1 đến 10)', () => {
    const n = (r: 'TT152' | 'TT58', c: string) => loadBookSet(r).books.find((x) => x.code === c)!.columns.length;
    expect([n('TT152', 'S1a-HKD'), n('TT152', 'S2a-HKD'), n('TT152', 'S2d-HKD'), n('TT152', 'S2e-HKD'), n('TT152', 'S3a-HKD')]).toEqual([3, 4, 12, 5, 12]);
    expect([n('TT58', 'S1-DNSN'), n('TT58', 'S2c-DNSN'), n('TT58', 'S3b-DNSN'), n('TT58', 'S4a-DNSN'), n('TT58', 'S4b-DNSN'), n('TT58', 'S4c-DNSN'), n('TT58', 'S4d-DNSN')]).toEqual([4, 12, 5, 9, 11, 13, 6]);
  });
  it('TT58: các phương pháp nộp thuế (Điều 5 đến 8) trỏ tới sổ có định nghĩa; B02-DNSN dựng, B01-DNSN chưa dựng nhưng đã nhập chỉ tiêu', () => {
    const b = loadBookSet('TT58'); const codes = new Set(b.books.map((x) => x.code));
    expect(b.methods.map((m) => m.article)).toEqual(['Điều 5', 'Điều 6', 'Điều 7', 'Điều 8']);
    for (const m of b.methods) for (const c of m.books) expect(codes.has(c)).toBe(true);
    const by = Object.fromEntries(b.reports.map((r) => [r.code, r]));
    expect([by['B02-DNSN']!.built, by['B01-DNSN']!.built]).toEqual([true, false]);
    expect(by['B02-DNSN']!.lines.map((l) => l.lineNo)).toEqual(['01', '02', '03', '10', '20']);
    expect(by['B01-DNSN']!.lines.map((l) => l.lineNo)).toEqual(['110', '120', '130', '140', '150', '200', '300', '310', '320', '400', '410', '420', '430', '500']);
  });
  it('sổ chưa dựng ghi lý do', () => {
    for (const x of loadBookSet('TT58').books.filter((b) => !b.built)) expect(x.reason).toBeTruthy();
  });
});
