import { describe, expect, it } from 'vitest';
import { STOCK_KINDS, stockCounterAccount } from '@kt/domain';
import { loadCoaTemplate } from '../src/index.js';

describe('STOCK_KINDS theo mẫu hệ thống tài khoản', () => {
  for (const regime of ['TT133', 'TT99', 'TT200'] as const) {
    it(`${regime}: mọi tài khoản đối ứng mặc định tồn tại và là tài khoản chi tiết`, () => {
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      for (const k of STOCK_KINDS.filter((x) => x.type !== 'CK')) {
        const code = stockCounterAccount(k, regime);
        expect(rows.get(code), `${k.code}: ${code} không có trong mẫu ${regime}`).toBeDefined();
        expect(rows.get(code)!.isGroup, `${k.code}: ${code} là tài khoản tổng hợp trong ${regime}`).toBe(false);
      }
    });
  }
});
