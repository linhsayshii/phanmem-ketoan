import { describe, expect, it } from 'vitest';
import { COA_REGIMES, loadCoaTemplate, loadFxRules } from '../src/index.js';

describe('fx-rules.json theo mẫu hệ thống tài khoản', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: tài khoản lãi/lỗ tỷ giá là tài khoản chi tiết có trong mẫu, có nguồn`, () => {
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      const r = loadFxRules(regime)!;
      expect(r, `fx-rules.json thiếu ${regime}`).toBeDefined();
      expect(r.source).not.toBe('');
      for (const code of [r.gainAccount, r.lossAccount]) {
        expect(rows.get(code), `${code} không có trong mẫu ${regime}`).toBeDefined();
        expect(rows.get(code)!.isGroup, `${code} là tài khoản tổng hợp trong ${regime}`).toBe(false);
      }
    });
  }
  it('chế độ chưa có trong fx-rules.json (TT58): undefined', () => { expect(loadFxRules('TT58')).toBeUndefined(); });
});
