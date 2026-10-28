import { describe, expect, it } from 'vitest';
import { isRegimeReady, loadCoaTemplate, regimeStatus, type BookRegime } from '../src/index.js';

describe('regimes/status.json: cổng pháp lý TT58 và TT152', () => {
  for (const r of ['TT58', 'TT152'] as BookRegime[]) {
    it(`${r}: chưa có văn bản gốc thì mọi cổng false, có nguồn và danh sách văn bản còn thiếu`, () => {
      const s = regimeStatus()[r];
      expect(s.primaryTextObtained).toBe(false);
      expect(isRegimeReady(r)).toBe(false);
      expect(Object.values(s.gates).every((g) => g === false)).toBe(true);
      expect(s.sources.length).toBeGreaterThan(0);
      expect(s.missing.length).toBeGreaterThan(0);
    });
  }
  it('không có mẫu hệ thống tài khoản cho chế độ này (không bịa danh mục)', () => {
    expect(() => loadCoaTemplate('TT152')).toThrow();
  });
});
