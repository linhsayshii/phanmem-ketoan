// Tài khoản lương theo chế độ (dữ liệu: packages/coa-data/data/payroll/accounts.json). Mã tài khoản khác nghĩa giữa các chế độ (3385 là BHTN ở TT133, cổ phần hóa ở TT200), nên không nhận diện bằng mã cố định.
export interface PayrollAccountMap {
  payable: string; union: string; si: string; hi: string; ui: string; pit: string;
  // TT200: 334 là tài khoản tổng hợp, `payable` là tài khoản lá dùng để hạch toán; các lá còn lại liệt kê ở đây.
  payableLeaves?: string[];
  // Hạch toán lương (LU): khấu trừ khác vào thực lĩnh (đoàn phí, tạm ứng, đóng góp...) ghi Có tài khoản này; tài khoản chi phí theo vai trò bộ phận.
  withholding?: string;
  // Tạm ứng trừ lương (cột 'advance' chưa khai TK Có): ghi Có tài khoản tạm ứng theo nhân viên (#971).
  advance?: string;
  cost?: Record<CostRole, string>;
  // Lãi lỗ theo hợp đồng/vụ việc (GĐ6 Task 13b): tiền tố tài khoản từng nhóm (doanh thu, giảm trừ, giá vốn, chi phí sản xuất, bán hàng, quản lý doanh nghiệp).
  pnl?: Record<PnlGroup, string[]>;
  // Chi phí sản xuất kinh doanh dở dang (GĐ6 Task 13c): số dư 154 theo vụ việc/hợp đồng, kết chuyển giá vốn vụ việc Nợ 632 / Có 154.
  wip?: string;
}
export type PnlGroup = 'revenue' | 'deduction' | 'cogs' | 'production' | 'selling' | 'admin';
// Vai trò bộ phận cho tài khoản chi phí lương mặc định: sản xuất trực tiếp, quản lý phân xưởng, bán hàng, quản lý doanh nghiệp.
export const COST_ROLES = ['direct', 'workshop', 'selling', 'admin'] as const;
export type CostRole = (typeof COST_ROLES)[number];
const MIN_GROUP_LEN = 3;
// Tài khoản thuộc nhóm lương nhạy cảm (view_salary): phải trả người lao động (và tài khoản con, kể cả tài khoản tổng hợp chứa các lá), kinh phí công đoàn, BHXH, BHYT, BHTN.
// 3335 (thuế TNCN) không thuộc nhóm: tổng thuế phải nộp không nhạy cảm, số theo nhân viên nằm ở dòng phải trả người lao động.
export function isSalaryAccount(m: PayrollAccountMap, code: string): boolean {
  const roots = [m.payable, ...(m.payableLeaves ?? []), m.union, m.si, m.hi, m.ui];
  if (roots.some((r) => code.startsWith(r))) return true;
  return code.length >= MIN_GROUP_LEN && [m.payable, ...(m.payableLeaves ?? [])].some((r) => r.startsWith(code));
}
