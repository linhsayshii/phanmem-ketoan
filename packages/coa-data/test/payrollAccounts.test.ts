import { describe, expect, it } from 'vitest';
import { COST_ROLES, isSalaryAccount } from '@kt/domain';
import { COA_REGIMES, loadCoaTemplate, loadPayrollAccounts } from '../src/index.js';

describe('tài khoản lương theo chế độ (data/payroll/accounts.json)', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: mọi mã có trong hệ thống tài khoản và là tài khoản lá`, () => {
      const m = loadPayrollAccounts(regime)!;
      expect(m, 'thiếu chế độ trong accounts.json').toBeDefined();
      const rows = new Map(loadCoaTemplate(regime).map((r) => [r.code, r]));
      const codes = [m.payable, m.union, m.si, m.hi, m.ui, m.pit, m.withholding!, ...(m.payableLeaves ?? []), ...COST_ROLES.map((r) => m.cost![r])];
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
  it('tài khoản chi phí lương theo vai trò bộ phận (D2): TT99/TT200 622/6271/6411/6421, TT133 154 cho sản xuất, 6421 bán hàng, 6422 quản lý', () => {
    const name = (r: (typeof COA_REGIMES)[number], c: string) => loadCoaTemplate(r).find((x) => x.code === c)?.name;
    for (const r of ['TT99', 'TT200'] as const) {
      expect(loadPayrollAccounts(r)!.cost).toEqual({ direct: '622', workshop: '6271', selling: '6411', admin: '6421' });
      expect([name(r, '622'), name(r, '6271'), name(r, '6411'), name(r, '6421')]).toEqual([expect.stringMatching(/nhân công trực tiếp/i), expect.stringMatching(/nhân viên phân xưởng/i), expect.stringMatching(/nhân viên/i), expect.stringMatching(/nhân viên quản l/i)]);
    }
    expect(loadPayrollAccounts('TT133')!.cost).toEqual({ direct: '154', workshop: '154', selling: '6421', admin: '6422' });
    expect([name('TT133', '6421'), name('TT133', '6422'), name('TT133', '622')]).toEqual([expect.stringMatching(/bán hàng/i), expect.stringMatching(/quản lý doanh nghiệp/i), undefined]);
    for (const r of COA_REGIMES) expect(name(r, loadPayrollAccounts(r)!.withholding!)).toMatch(/phải trả, phải nộp khác/i);
  });
  it('nhóm tài khoản lãi lỗ hợp đồng/vụ việc (Task 13b): mã có trong hệ thống tài khoản, đúng nghĩa theo chế độ', () => {
    const name = (r: (typeof COA_REGIMES)[number], c: string) => loadCoaTemplate(r).find((x) => x.code === c)?.name;
    for (const r of COA_REGIMES) {
      const g = loadPayrollAccounts(r)!.pnl!;
      for (const c of Object.values(g).flat()) expect(name(r, c), `${r}: không có TK ${c}`).toBeDefined();
      expect([name(r, g.revenue[0]!), name(r, g.cogs[0]!)]).toEqual([expect.stringMatching(/^doanh thu bán hàng/i), expect.stringMatching(/giá vốn/i)]);
      expect(name(r, g.selling[0]!)).toMatch(/chi phí bán hàng/i);
    }
    expect(loadPayrollAccounts('TT133')!.pnl).toMatchObject({ deduction: [], production: ['154'], selling: ['6421'], admin: ['6422'] });
    for (const r of ['TT99', 'TT200'] as const) expect(loadPayrollAccounts(r)!.pnl).toMatchObject({ deduction: ['521'], production: ['621', '622', '623', '627'], selling: ['641'], admin: ['642'] });
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
