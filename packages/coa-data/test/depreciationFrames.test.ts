import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, isDepreciationFramesComplete, loadDepreciationFrames } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
// Dòng in trên Phụ lục I TT 45/2013/TT-BTC (Công báo 277 + 278, trang 53-55), ghi tay từ ảnh trang, không suy ra từ dữ liệu: mã nhóm → [tối thiểu, tối đa] năm.
const PRINTED: Record<string, [number, number]> = {
  'A.1': [8, 15], 'A.2': [7, 20], 'A.3': [7, 15], 'A.4': [6, 15],
  'B.1': [7, 15], 'B.2': [5, 15], 'B.8': [10, 20], 'B.11': [10, 15], 'B.12': [5, 10], 'B.16': [3, 15], 'B.17': [6, 10], 'B.18': [5, 12], 'B.19': [10, 20], 'B.20': [7, 10], 'B.22': [10, 20],
  'C.1': [5, 10], 'C.8': [2, 5],
  'D.1': [6, 10], 'D.2': [7, 15], 'D.4': [8, 20], 'D.5': [10, 30], 'D.7': [6, 10],
  'E.1': [5, 8], 'E.2': [3, 8], 'E.3': [5, 10],
  'G.1': [25, 50], 'G.2': [6, 25], 'G.4': [5, 20], 'G.5': [6, 30], 'G.6': [10, 40], 'G.7': [5, 10],
  'H.1': [4, 15], 'H.2': [6, 40], 'H.3': [2, 8], I: [4, 25], K: [2, 20],
};
const COUNT = { A: 4, B: 22, C: 8, D: 7, E: 3, G: 7, H: 3, I: 1, K: 1 };

describe('khung thời gian trích khấu hao TT 45/2013 Phụ lục 1', () => {
  const set = loadDepreciationFrames();
  it('cổng status.json mở và nguồn ghi Công báo, QĐ 1760/QĐ-BTC', () => {
    expect(status.depreciationFrames_TT45).toBe(true);
    expect(isDepreciationFramesComplete()).toBe(true);
    expect(set.source).toContain('Công báo số 277 + 278');
    expect(set.source).toContain('1760/QĐ-BTC');
    expect(set.validFrom).toBe('2013-06-10');
    expect(set.validTo).toBe('2026-12-31');
  });
  it('56 dòng, mã duy nhất, tối thiểu <= tối đa, số dòng từng nhóm đúng như in', () => {
    expect(set.frames).toHaveLength(56);
    expect(new Set(set.frames.map((f) => f.code)).size).toBe(56);
    for (const f of set.frames) expect(f.minYears).toBeLessThanOrEqual(f.maxYears);
    for (const [g, n] of Object.entries(COUNT)) expect(set.frames.filter((f) => f.group === g)).toHaveLength(n);
  });
  it('các dòng đối chiếu ảnh trang khớp từng số', () => {
    for (const [code, [min, max]] of Object.entries(PRINTED)) {
      const f = set.frames.find((x) => x.code === code);
      expect(f, code).toBeDefined();
      expect([f!.minYears, f!.maxYears], code).toEqual([min, max]);
    }
  });
});
