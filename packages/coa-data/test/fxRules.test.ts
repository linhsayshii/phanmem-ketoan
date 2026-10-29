import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COA_REGIMES, dataPath, loadCoaTemplate, loadFxRules } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
const RATE_TYPES = ['transfer_avg', 'buy', 'sell'];

describe('fx-rules.json theo mẫu hệ thống tài khoản', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: tài khoản lãi/lỗ, đánh giá lại là tài khoản chi tiết có trong mẫu, có nguồn, loại tỷ giá hợp lệ`, () => {
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      const r = loadFxRules(regime)!;
      expect(r, `fx-rules.json thiếu ${regime}`).toBeDefined();
      expect(r.source).not.toBe('');
      expect(r.revalAccount === null || typeof r.revalAccount === 'string', 'revalAccount là mã tài khoản hoặc null').toBe(true);
      for (const code of [r.gainAccount, r.lossAccount, ...(r.revalAccount ? [r.revalAccount] : [])]) {
        expect(rows.get(code), `${code} không có trong mẫu ${regime}`).toBeDefined();
        expect(rows.get(code)!.isGroup, `${code} là tài khoản tổng hợp trong ${regime}`).toBe(false);
      }
      expect(typeof r.transferToPnl).toBe('boolean');
      if (r.revalAccount === null) expect(r.transferToPnl, 'ghi thẳng 515/635 thì không có chứng từ kết chuyển').toBe(false);
      expect(RATE_TYPES).toContain(r.assetRate); expect(RATE_TYPES).toContain(r.liabilityRate);
      // Cổng dữ liệu pháp lý: chế độ chưa đối chiếu văn bản gốc giữ tỷ giá chuyển khoản trung bình (công ty chọn lại ở cài đặt) và có ghi chú.
      expect(typeof status[`fxRules_${regime}`], `status.json thiếu fxRules_${regime}`).toBe('boolean');
      if (status[`fxRules_${regime}`] === false) {
        expect([r.assetRate, r.liabilityRate]).toEqual(['transfer_avg', 'transfer_avg']);
        expect(status.fxRules_note).toContain(regime);
      }
    });
  }
  it('TT133 đánh giá lại qua 413 rồi kết chuyển; TT99 ghi thẳng 515/635 (Tài khoản 413 khoản 4.2)', () => {
    expect(loadFxRules('TT133')).toMatchObject({ revalAccount: '413', transferToPnl: true, assetRate: 'transfer_avg', liabilityRate: 'transfer_avg' });
    expect(loadFxRules('TT99')).toMatchObject({ revalAccount: null, transferToPnl: false, assetRate: 'transfer_avg', liabilityRate: 'transfer_avg' });
    expect([status.fxRules_TT133, status.fxRules_TT99, status.fxRules_TT200]).toEqual([true, true, true]);
  });
  it('TT200 đánh giá lại qua 4131 rồi kết chuyển cuối năm; tài sản theo tỷ giá mua, nợ phải trả theo tỷ giá bán (Điều 69 khoản 1.3 điểm b)', () => {
    expect(loadFxRules('TT200')).toMatchObject({ gainAccount: '515', lossAccount: '635', revalAccount: '4131', transferToPnl: true, assetRate: 'buy', liabilityRate: 'sell' });
    expect(loadFxRules('TT200')!.source).toContain('Điều 69');
  });
  it('chế độ chưa có trong fx-rules.json (TT58): undefined', () => { expect(loadFxRules('TT58')).toBeUndefined(); });
});
