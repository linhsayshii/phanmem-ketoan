import { describe, expect, it } from 'vitest';
import { loadCoaTemplate } from '../src/index.js';

describe('TK 2141, 2142, 2143 theo dõi theo tài sản', () => {
  for (const regime of ['TT133', 'TT99', 'TT200'] as const) {
    it(`${regime}: subledgerKind = fixed_asset`, () => {
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      for (const c of ['2141', '2142', '2143']) expect(rows.get(c)?.subledgerKind, c).toBe('fixed_asset');
    });
  }
});
