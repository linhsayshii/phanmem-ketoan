export const SENSITIVE_FLAGS = ['view_cost', 'view_receivable', 'view_payable', 'view_salary'] as const;
export type SensitiveFlag = (typeof SENSITIVE_FLAGS)[number];
// Ba cờ bảo vệ số liệu công nợ/giá vốn: sổ tổng hợp (Nhật ký chung, Bảng cân đối số phát sinh), bộ sổ năm và gói xuất cho cơ quan thẩm quyền cần đủ cả ba.
export const SENSITIVE_FLAGS_ALL = ['view_receivable', 'view_payable', 'view_cost'] as const;

const crud = (res: string, name: string, group: string, extra: [string, string][] = []) => [
  { code: `${res}.view`, name: `Xem ${name}`, group },
  { code: `${res}.create`, name: `Thêm ${name}`, group },
  { code: `${res}.update`, name: `Sửa ${name}`, group },
  { code: `${res}.delete`, name: `Xóa ${name}`, group },
  ...extra.map(([a, n]) => ({ code: `${res}.${a}`, name: `${n} ${name}`, group })),
];

export const PERMISSIONS: readonly { code: string; name: string; group: string }[] = [
  ...crud('user', 'người dùng', 'Hệ thống'),
  ...crud('role', 'vai trò', 'Hệ thống'),
  { code: 'company.update', name: 'Sửa thông tin công ty', group: 'Hệ thống' },
  { code: 'setting.update', name: 'Sửa tùy chọn hệ thống', group: 'Hệ thống' },
  { code: 'audit.view', name: 'Xem nhật ký kiểm toán', group: 'Hệ thống' },
  { code: 'backup.run', name: 'Sao lưu dữ liệu', group: 'Hệ thống' },
  { code: 'export.authority', name: 'Xuất dữ liệu cho cơ quan thẩm quyền', group: 'Hệ thống' },
  ...crud('account', 'hệ thống tài khoản', 'Danh mục'),
  ...crud('catalog', 'danh mục', 'Danh mục', [['import', 'Nhập Excel']]),
  ...crud('period', 'kỳ kế toán', 'Kỳ kế toán', [['lock', 'Khóa'], ['unlock', 'Bỏ khóa'], ['unlock_hard', 'Bỏ khóa cứng']]),
  ...crud('voucher', 'chứng từ', 'Chứng từ', [['print', 'In'], ['post', 'Ghi sổ'], ['unpost', 'Bỏ ghi sổ'], ['edit_posted', 'Sửa sau ghi sổ'], ['renumber', 'Đánh lại số'], ['backdate_locked', 'Ghi lùi ngày vào kỳ khóa mềm']]),
  ...crud('opening_balance', 'số dư đầu kỳ', 'Chứng từ'),
  { code: 'closing.run', name: 'Chạy kết chuyển/phân bổ', group: 'Cuối kỳ' },
  ...crud('closing_step', 'sơ đồ kết chuyển', 'Cuối kỳ'),
  { code: 'report.view', name: 'Xem sổ sách, báo cáo', group: 'Báo cáo' },
  { code: 'report.print', name: 'In sổ sách, báo cáo', group: 'Báo cáo' },
  ...crud('report_def', 'định nghĩa báo cáo', 'Báo cáo'),
  { code: 'data_check.run', name: 'Soát lỗi dữ liệu', group: 'Tiện ích' },
  { code: 'data_check.manage', name: 'Quản lý quy tắc soát lỗi', group: 'Tiện ích' },
];
export const PERMISSION_CODES: readonly string[] = PERMISSIONS.map((p) => p.code);
