import { describe, expect, it } from 'vitest';
import { CASH_PURPOSES } from '@kt/domain';
import { loadCoaTemplate } from '../src/index.js';

// Đặt ở coa-data (phụ thuộc domain) vì domain không được phụ thuộc ngược vào coa-data.
describe('CASH_PURPOSES theo mẫu hệ thống tài khoản', () => {
  for (const regime of ['TT133', 'TT99', 'TT200'] as const) {
    it(`${regime}: mọi tài khoản đối ứng tồn tại và là tài khoản chi tiết`, () => {
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      for (const p of CASH_PURPOSES) for (const code of p.counterAccounts[regime]) {
        const row = rows.get(code);
        expect(row, `${p.code}: ${code} không có trong mẫu ${regime}`).toBeDefined();
        expect(row!.isGroup, `${p.code}: ${code} là tài khoản tổng hợp trong ${regime}`).toBe(false);
      }
    });
  }
});
