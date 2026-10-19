import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCoaTemplate } from '@kt/domain';
import { COA_REGIMES, dataPath, loadCoaTemplate, tt99Status } from '../src/index.js';

const refCodes = (file: string, col: string): string[] => {
  const lines = readFileSync(dataPath('..', 'reference', 'sunsoft', file), 'utf8').split(/\r?\n/).filter(Boolean);
  const h = lines[0]!.split(','); const i = h.indexOf(col);
  return lines.slice(1).map((l) => l.split(',')[i]?.replace(/"/g, '') ?? '').filter((v) => /^\d{3,}$/.test(v));
};

describe('mẫu hệ thống tài khoản', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: cấu trúc hợp lệ`, () => {
      const rows = loadCoaTemplate(regime);
      expect(validateCoaTemplate(rows)).toEqual([]);
    });
  }
  it('TT133 có 131/331 lưỡng tính, 1112/1122 theo dõi ngoại tệ, đủ tài khoản SUNSOFT', () => {
    const rows = loadCoaTemplate('TT133'); const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get('131')?.normalBalance).toBe('both'); expect(by.get('131')?.subledgerKind).toBe('receivable');
    expect(by.get('331')?.subledgerKind).toBe('payable'); expect(by.get('1112')?.trackCurrency).toBe(true);
    for (const c of refCodes('OrgDMTK_133.csv', 'TK_TI')) expect(by.has(c), `thiếu ${c}`).toBe(true);
  });
  it('TT200 đủ tài khoản SUNSOFT OrgDMTK_200', () => {
    const by = new Set(loadCoaTemplate('TT200').map((r) => r.code));
    for (const c of refCodes('OrgDMTK_200.csv', 'TK_TI')) expect(by.has(c), `thiếu ${c}`).toBe(true);
  });
  it('TT99: đối chiếu Phụ lục II và DesBC_*_99 (chỉ chạy khi complete=true)', (t) => {
    const st = tt99Status();
    if (!st.complete) { console.warn('CẢNH BÁO: tt99.csv chưa hoàn tất, bỏ qua kiểm tra đối chiếu TT99'); t.skip(); return; }
    const by = new Set(loadCoaTemplate('TT99').map((r) => r.code));
    for (const c of ['137', '215', '2295', '246', '332', '351', '1383']) expect(by.has(c), `thiếu TK mới ${c}`).toBe(true);
    for (const c of ['161', '417', '441', '461', '466', '611', '631']) expect(by.has(c), `TK ${c} đã bỏ theo TT99`).toBe(false);
    for (const c of refCodes('DesBC_CDKT_B01_99.csv', 'TK')) expect(by.has(c), `B01 tham chiếu ${c}`).toBe(true);
    for (const c of [...refCodes('DesBC_KQKD_LAILO_99.csv', 'TK_TI'), ...refCodes('DesBC_KQKD_LAILO_99.csv', 'TK_DU')]) expect(by.has(c), `B02 tham chiếu ${c}`).toBe(true);
  });
});
