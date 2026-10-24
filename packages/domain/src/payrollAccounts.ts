// Tài khoản lương theo chế độ (dữ liệu: packages/coa-data/data/payroll/accounts.json). Mã tài khoản khác nghĩa giữa các chế độ (3385 là BHTN ở TT133, cổ phần hóa ở TT200), nên không nhận diện bằng mã cố định.
export interface PayrollAccountMap {
  payable: string; union: string; si: string; hi: string; ui: string; pit: string;
  // TT200: 334 là tài khoản tổng hợp, `payable` là tài khoản lá dùng để hạch toán; các lá còn lại liệt kê ở đây.
  payableLeaves?: string[];
}
const MIN_GROUP_LEN = 3;
// Tài khoản thuộc nhóm lương nhạy cảm (view_salary): phải trả người lao động (và tài khoản con, kể cả tài khoản tổng hợp chứa các lá), kinh phí công đoàn, BHXH, BHYT, BHTN.
// 3335 (thuế TNCN) không thuộc nhóm: tổng thuế phải nộp không nhạy cảm, số theo nhân viên nằm ở dòng phải trả người lao động.
export function isSalaryAccount(m: PayrollAccountMap, code: string): boolean {
  const roots = [m.payable, ...(m.payableLeaves ?? []), m.union, m.si, m.hi, m.ui];
  if (roots.some((r) => code.startsWith(r))) return true;
  return code.length >= MIN_GROUP_LEN && [m.payable, ...(m.payableLeaves ?? [])].some((r) => r.startsWith(code));
}
