import { describe, expect, it } from 'vitest';
import { evenSchedule } from '../src/pages/loanCalc.js';

describe('sinh lịch trả gốc đều', () => {
  it('chia đều theo đồng, phần dư dồn kỳ cuối; ngày tính từ ngày đầu (31/01 → 28/02 → 31/03)', () => {
    const r = evenSchedule('2026-01-31', 3, 1, '100');
    expect(r.map((x) => x.principal)).toEqual(['33', '33', '34']);
    expect(r.map((x) => x.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('đầu vào sai thì rỗng', () => { expect(evenSchedule('', 3, 1, '100')).toEqual([]); expect(evenSchedule('2026-01-01', 0, 1, '100')).toEqual([]); });
});
