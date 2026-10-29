import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, isHkdReturnTemplateComplete, loadHkdReturnTemplate } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
// Mã chỉ tiêu in trên mẫu 01/TKN-CNKD, TT 89/2026 trang PDF 365-371 (đối chiếu ảnh trang); ghi tay, không suy ra từ dữ liệu.
const HEADER = ['01', '01a', '01b', '01c', '02', '03', '04', '05', '06', '06.1', '06.2', '07', '07.1', '07.2'];
const range = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}.${i + 1}`);
const LINES = ['08', '09', '10', '11', '12', ...range('13', 15), '13', '14', '15', '16', '17', '18', '19', ...range('19', 15), '20', '21',
  '22a', '22b', '23', '23.1', '23.2', '24', '25', '26a', '26b', '27', '28', '29', '30a', '30b', '31', '32', '33', '34a', '34b', '35', '36', '37',
  '38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '48', '49', '49.1', '49.2', '49.3', '49.4', '50', '50.1', '50.2', '50.3', '50.4', '51', '51.1', '51.2', '51.3',
  '52', '53', '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64'];

describe('mẫu 01/TKN-CNKD theo TT 89/2026 (thay 01/CNKD)', () => {
  const t = loadHkdReturnTemplate();
  it('cổng 01TKN_CNKD_TT89 bật; đủ mã chỉ tiêu theo thứ tự in, mỗi mã một lần, có nhãn', () => {
    expect(status['01TKN_CNKD_TT89']).toBe(true); expect(isHkdReturnTemplateComplete()).toBe(true);
    expect(t.header.map((h) => h.code)).toEqual(HEADER);
    expect(t.lines.map((l) => l.code)).toEqual(LINES);
    for (const l of [...t.header, ...t.lines]) expect(l.label, l.code).not.toBe('');
  });
  it('nguồn ghi url, ngày tải, trang; 16 cột phần A; sáu ô đánh dấu và bốn ghi chú', () => {
    expect(t.source).toContain('https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/7/89-btc.signed.pdf');
    expect(t.source).toContain('2026-10-29'); expect(t.source).toContain('365-371');
    expect(t.sectionA.columns.map((c) => c.no)).toEqual(Array.from({ length: 16 }, (_, i) => String(i + 1)));
    expect(t.applicability).toHaveLength(6); expect(t.notes).toHaveLength(4);
    expect([t.form, t.validFrom, t.validTo]).toEqual(['01/TKN-CNKD', '2026-07-01', null]);
  });
  it('công thức in đúng nguyên văn (kể cả công thức [32] in lệch mã, giữ như in)', () => {
    const f = Object.fromEntries(t.lines.filter((l) => l.formula).map((l) => [l.code, l.formula]));
    expect(f).toEqual({
      '15': '[15]=[13.13]-[14]>=0', '16': '[16]=[15] < 50.000', '17': '[17]=[15]-[16]', '18': '[18]=[13.13]-[14]<0 hoặc [13.15]+[14]>0', '21': '[21]=[19.15]+[20]',
      '24': '[24]=[23.2] <=50.000', '25': '[25]=[23.2] - [24]', '26a': '(10)=(7)*(8)*(9)', '28': '[28]=[27]<=50.000', '29': '[29]=[27]-[28]', '30a': '(10)=(7)*(8)',
      '32': '[30]=[29]<=50.000', '33': '[33]=[31]-[32]', '34a': '(10)=(7)*(8)*(9)', '36': '[36]=[35]<=50.000', '37': '[37]=[35]-[36]', '64': '[64]=[62]-[63]',
    });
    expect(t.lines.find((l) => l.code === '32')!.printedAnomaly).toBe(true); expect(t.printedAnomalies).toHaveLength(1);
  });
});
