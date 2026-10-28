export const SENSITIVE_FLAGS = ['view_cost', 'view_receivable', 'view_payable', 'view_salary'] as const;
export type SensitiveFlag = (typeof SENSITIVE_FLAGS)[number];
// Bốn cờ bảo vệ số liệu công nợ, giá vốn, lương: sổ tổng hợp (Nhật ký chung, Bảng cân đối số phát sinh), bộ sổ năm và gói xuất cho cơ quan thẩm quyền cần đủ cả bốn (dòng phải trả người lao động nằm trong các sổ này).
export const SENSITIVE_FLAGS_ALL = ['view_receivable', 'view_payable', 'view_cost', 'view_salary'] as const;

// Cờ cần để xem tài khoản theo loại sổ chi tiết; tài khoản giá vốn (632*) cần view_cost. Dùng chung cho sổ sách, số dư và các màn công nợ ở API.
export const SENSITIVE_BY_SUBLEDGER = { receivable: 'view_receivable', payable: 'view_payable', inventory: 'view_cost' } as const;
// salary: tài khoản thuộc nhóm lương của chế độ kế toán (isSalaryAccount với ánh xạ coa-data/payroll/accounts.json); người gọi tính theo chế độ của tài khoản, vì mã như 3385, 3386 đổi nghĩa giữa các chế độ.
type SensitiveAccount = { subledger_kind: string | null; code: string; salary?: boolean };
const DENIAL: Record<'view_receivable' | 'view_payable' | 'view_cost' | 'view_salary', string> = {
  view_receivable: 'Không có quyền xem công nợ phải thu', view_payable: 'Không có quyền xem công nợ phải trả', view_cost: 'Không có quyền xem giá vốn', view_salary: 'Không có quyền xem lương',
};
const flagsOf = (acc: SensitiveAccount): (keyof typeof DENIAL)[] => [
  ...(acc.subledger_kind && acc.subledger_kind in SENSITIVE_BY_SUBLEDGER ? [SENSITIVE_BY_SUBLEDGER[acc.subledger_kind as keyof typeof SENSITIVE_BY_SUBLEDGER]] : []),
  ...(acc.code.startsWith('632') ? ['view_cost' as const] : []),
  ...(acc.salary ? ['view_salary' as const] : []),
].filter((f, i, a) => a.indexOf(f) === i);
// Lý do cờ nhạy cảm che tài khoản này với người dùng; null là được xem.
export function sensitiveDenial(auth: { sensitive: Set<string> }, acc: SensitiveAccount): string | null {
  const missing = flagsOf(acc).find((f) => !auth.sensitive.has(f));
  return missing ? DENIAL[missing] : null;
}
// Mọi cờ cần có để xem hết các tài khoản này (không trùng).
export function flagsForAccounts(accs: SensitiveAccount[]): SensitiveFlag[] {
  return [...new Set(accs.flatMap(flagsOf))];
}

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
  // GĐ2: đối trừ công nợ không có "sửa" (xóa rồi đối trừ lại).
  ...crud('settlement', 'đối trừ công nợ', 'Công nợ').filter((p) => p.code !== 'settlement.update'),
  { code: 'fx.run', name: 'Chạy tỷ giá xuất quỹ, đánh giá lại ngoại tệ', group: 'Công nợ' },
  ...crud('cash_count', 'kiểm kê quỹ', 'Quỹ'),
  { code: 'tax.view', name: 'Xem sổ và bảng kê thuế', group: 'Thuế' },
  ...crud('tax_return', 'tờ khai thuế', 'Thuế', [['finalize', 'Chốt']]),
  { code: 'tax.offset', name: 'Khấu trừ thuế GTGT cuối kỳ', group: 'Thuế' },
  { code: 'voucher.import', name: 'Nhập chứng từ từ Excel', group: 'Chứng từ' },
  { code: 'dedupe.run', name: 'Khử trùng chứng từ', group: 'Tiện ích' },
  ...crud('amortization', 'lịch phân bổ', 'Cuối kỳ', [['run', 'Chạy']]),
  // GĐ3: kho và mua bán hàng hóa.
  ...crud('item', 'vật tư hàng hóa', 'Kho'),
  ...crud('warehouse', 'kho', 'Kho'),
  ...crud('price_list', 'bảng giá', 'Kho'),
  ...crud('stock_voucher', 'phiếu kho', 'Kho', [['post', 'Ghi sổ']]),
  { code: 'costing.run', name: 'Chạy tính giá vốn', group: 'Kho' },
  { code: 'costing.view', name: 'Xem tính giá vốn', group: 'Kho' },
  ...crud('order', 'báo giá, đơn hàng, hợp đồng', 'Bán hàng'),
  ...crud('stocktake', 'kiểm kê kho', 'Kho'),
  // GĐ4: tài sản, khế ước vay, quy trình cuối kỳ.
  ...crud('asset', 'tài sản, công cụ dụng cụ, chi phí trả trước', 'Tài sản', [['run', 'Chạy khấu hao, phân bổ']]),
  ...crud('loan', 'khế ước vay', 'Khế ước vay', [['run', 'Tính lãi vay']]),
  { code: 'period_close.view', name: 'Xem quy trình cuối kỳ', group: 'Cuối kỳ' },
  // GĐ5: hóa đơn điện tử, hóa đơn đầu vào, ngân hàng, khóa API, thuế TNDN, ký số.
  ...crud('einvoice', 'hóa đơn điện tử', 'Hóa đơn điện tử', [['issue', 'Phát hành'], ['config', 'Cấu hình nhà cung cấp, ký hiệu']]),
  ...crud('inbound_invoice', 'hóa đơn đầu vào', 'Hóa đơn điện tử'),
  ...crud('bank_feed', 'kết nối và giao dịch ngân hàng', 'Ngân hàng', [['match', 'Đối chiếu']]),
  { code: 'api_key.manage', name: 'Quản lý khóa API', group: 'Hệ thống' },
  ...crud('cit', 'thuế TNDN', 'Thuế'),
  { code: 'signing.use', name: 'Ký số', group: 'Hệ thống' },
  // GĐ6: lương, chấm công, giá thành, theo dõi hợp đồng (tờ khai TNCN dùng tax_return.*).
  ...crud('payroll', 'bảng lương', 'Lương', [['post', 'Hạch toán'], ['param', 'Nhập tham số lương, thuế, bảo hiểm cho'], ['pay', 'Chi lương, nộp bảo hiểm, nộp thuế cho'], ['export', 'Xuất tệp chi lương, báo cáo lương cho']]),
  ...crud('attendance', 'bảng chấm công', 'Lương'),
  ...crud('costing_obj', 'đối tượng tập hợp chi phí, định mức', 'Giá thành'),
  { code: 'cost_run.view', name: 'Xem kỳ tính giá thành', group: 'Giá thành' },
  { code: 'cost_run.run', name: 'Chạy tính giá thành', group: 'Giá thành' },
  { code: 'contract_track.view', name: 'Xem theo dõi hợp đồng, lãi lỗ vụ việc', group: 'Hợp đồng' },
  { code: 'contract_track.run', name: 'Chạy phân bổ chi phí theo vụ việc, chuyển số dư vụ việc', group: 'Hợp đồng' },
  // GĐ7: hình thức sổ.
  ...crud('voucher_set', 'Chứng từ ghi sổ', 'Báo cáo'),
  // GĐ7 nhóm 3: ngân sách.
  ...crud('budget', 'ngân sách', 'Ngân sách', [['approve', 'Duyệt, cấu hình cảnh báo']]),
  // GĐ7 nhóm 4: đề nghị thanh toán, tạm ứng và phê duyệt (cấu hình quy trình dùng setting.update).
  { code: 'approval_request.view', name: 'Xem mọi đề nghị thanh toán, tạm ứng', group: 'Phê duyệt' },
  { code: 'approval_request.create', name: 'Lập đề nghị thanh toán, tạm ứng', group: 'Phê duyệt' },
  { code: 'approval_request.approve', name: 'Duyệt đề nghị thanh toán, tạm ứng', group: 'Phê duyệt' },
  // GĐ7 nhóm 7: trợ lý (gợi ý định khoản, nhận diện hóa đơn) và bút toán định kỳ.
  { code: 'assistant.use', name: 'Dùng trợ lý (gợi ý định khoản, nhận diện hóa đơn)', group: 'Trợ lý' },
  { code: 'recurring.view', name: 'Xem bút toán định kỳ', group: 'Trợ lý' },
  { code: 'recurring.manage', name: 'Quản lý bút toán định kỳ (lập mẫu, chạy)', group: 'Trợ lý' },
  // GĐ7 nhóm 6b: sổ hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026), cấp bởi migration 0251.
  { code: 'sohkd.view', name: 'Xem sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', group: 'Sổ HKD, siêu nhỏ' },
  { code: 'sohkd.create', name: 'Ghi sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', group: 'Sổ HKD, siêu nhỏ' },
  { code: 'sohkd.update', name: 'Sửa bút ghi sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', group: 'Sổ HKD, siêu nhỏ' },
  { code: 'sohkd.delete', name: 'Xóa bút ghi sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', group: 'Sổ HKD, siêu nhỏ' },
  { code: 'sohkd.config', name: 'Cấu hình nhóm ngành nghề, tỷ lệ thuế, phương pháp nộp thuế', group: 'Sổ HKD, siêu nhỏ' },
];
export const PERMISSION_CODES: readonly string[] = PERMISSIONS.map((p) => p.code);
