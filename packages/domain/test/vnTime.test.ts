import { describe, expect, it } from 'vitest';
import { todayVn } from '../src/index.js';

describe('todayVn', () => {
  it('17:30 UTC ngày 31/12 là 01/01 năm sau ở Việt Nam', () => {
    expect(todayVn(new Date('2026-12-31T17:30:00Z'))).toBe('2027-01-01');
  });
  it('biên 24:00 giờ Việt Nam: 16:59:59 UTC vẫn là ngày cũ, 17:00:00 UTC sang ngày mới', () => {
    expect(todayVn(new Date('2026-03-09T16:59:59Z'))).toBe('2026-03-09');
    expect(todayVn(new Date('2026-03-09T17:00:00Z'))).toBe('2026-03-10');
  });
  it('không đối số: định dạng YYYY-MM-DD', () => {
    expect(todayVn()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
