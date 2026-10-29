import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, isCitAppendix1AComplete, loadCitAppendix1A } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;

describe('phụ lục 03-1A/TNDN theo TT 80/2021', () => {
  const t = loadCitAppendix1A();
  it('cổng status.json mở, nguồn ghi Công báo 969 + 970 trang 65-66', () => {
    expect(status['03_1A_TNDN_TT80']).toBe(true);
    expect(isCitAppendix1AComplete()).toBe(true);
    expect(t.source).toContain('Công báo số 969 + 970');
    expect(t.source).toContain('trang 65-66');
  });
  it('mã chỉ tiêu [04]-[22] và công thức đúng như in', () => {
    expect(t.lines.map((l) => l.code)).toEqual(['04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22']);
    const f = Object.fromEntries(t.lines.filter((l) => l.formula).map((l) => [l.code, l.formula]));
    expect(f).toEqual({ '06': '07+08+09', '12': '13+14+15', '18': '04-06+10-12-16', '21': '19-20', '22': '18+21' });
    expect(t.lines.find((l) => l.code === '22')?.label).toContain('Tổng lợi nhuận kế toán trước thuế');
    expect(t.note).toContain('A1');
  });
});
