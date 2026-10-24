import { describe, expect, it } from 'vitest';
import { isSalaryAccount } from '@kt/domain';
import { COA_REGIMES, loadCoaTemplate, loadPayrollAccounts } from '../src/index.js';

describe('tài khoản lương theo chế độ (data/payroll/accounts.json)', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: mọi mã có trong hệ thống tài khoản và là tài khoản lá`, () => {
      const m = loadPayrollAccounts(regime)!;
      expect(m, 'thiếu chế độ trong accounts.json').toBeDefined();
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      const codes = [m.payable, m.union, m.si, m.hi, m.ui, m.pit, ...(m.payableLeaves ?? [])];
      for (const c of codes) { expect(rows.has(c), `${regime}: không có TK ${c}`).toBe(true); expect(rows.get(c)!.isGroup, `${regime}: TK ${c} không phải tài khoản lá`).toBe(false); }
      for (const c of m.payableLeaves ?? []) expect(rows.get(c)!.parentCode, c).toBe('334');
    });
  }
  it('đối chiếu nghĩa tài khoản: TT133 3385 = BHTN, TT200 3386 = BHTN, TT99 không có 3385', () => {
    const name = (r: 'TT99' | 'TT133' | 'TT200', c: string) => loadCoaTemplate(r).find((x) => x.code === c)?.name;
    expect(name('TT133', '3385')).toMatch(/thất nghiệp/i); expect(name('TT133', '3386')).toMatch(/ký quỹ/i);
    expect(name('TT200', '3386')).toMatch(/thất nghiệp/i); expect(name('TT200', '3385')).toMatch(/cổ phần hóa/i);
    expect(name('TT99', '3386')).toMatch(/thất nghiệp/i); expect(name('TT99', '3385')).toBeUndefined();
    expect(loadPayrollAccounts('TT200')).toMatchObject({ payable: '3341', payableLeaves: ['3341', '3348'] });
  });
  it('isSalaryAccount theo chế độ: 3385/3386 đổi nghĩa, 334 tổng hợp của TT200 và 3335 không thuộc nhóm', () => {
    const t133 = loadPayrollAccounts('TT133')!; const t200 = loadPayrollAccounts('TT200')!; const t99 = loadPayrollAccounts('TT99')!;
    expect(isSalaryAccount(t133, '3385')).toBe(true); expect(isSalaryAccount(t133, '3386')).toBe(false);
    expect(isSalaryAccount(t200, '3386')).toBe(true); expect(isSalaryAccount(t200, '3385')).toBe(false);
    expect(isSalaryAccount(t99, '3386')).toBe(true); expect(isSalaryAccount(t99, '3385')).toBe(false);
    for (const c of ['334', '3341', '3348', '33411']) expect(isSalaryAccount(t200, c), c).toBe(true);
    for (const m of [t99, t133, t200]) for (const c of ['3335', '3381', '3387', '3388', '338', '33', '1111', '3331']) expect(isSalaryAccount(m, c), c).toBe(false);
    expect(isSalaryAccount(t99, '334')).toBe(true); expect(isSalaryAccount(t99, '3341')).toBe(true);
  });
});
