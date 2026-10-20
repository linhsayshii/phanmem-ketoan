import { describe, expect, it } from 'vitest';
import { cleanLines, emptyLine, totals } from '../src/pages/Voucher.js';

describe('Phiếu kế toán: tổng và làm sạch dòng', () => {
  it('bỏ dòng trống, tính tổng Nợ/Có', () => {
    const lines = [{ ...emptyLine(), accountCode: '6422', debit: '1500000' }, { ...emptyLine(), accountCode: '1111', credit: '1500000' }, emptyLine()];
    expect(cleanLines(lines)).toHaveLength(2);
    expect(totals(lines)).toEqual({ debit: '1500000', credit: '1500000' });
  });
});
