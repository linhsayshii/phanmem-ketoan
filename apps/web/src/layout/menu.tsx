import { AuditOutlined, BarChartOutlined, BookOutlined, CalculatorOutlined, DatabaseOutlined, DesktopOutlined, FileTextOutlined, HomeOutlined, InboxOutlined, PercentageOutlined, SettingOutlined, ShopOutlined, ShoppingCartOutlined, SolutionOutlined, SwapOutlined, TeamOutlined, WalletOutlined } from '@ant-design/icons';
import { VOUCHER_TYPES } from '@kt/domain';
import { typeLabel } from '../pages/VoucherList.js';
import type { MenuItem } from './AppLayout.js';

// Menu theo phân hệ: mỗi phân hệ cấp 1 có icon; khóa antd của nhóm là `group:<key>`, của mục là `to` (AppLayout).
// Mỗi mục chứng từ là danh sách lọc theo loại; hóa đơn và giảm giá (HDB, HDM, GGB, GGM) nằm ở nhóm Mua hàng / Bán hàng, cùng đường dẫn /chung-tu/<mã> (VoucherPage chọn màn hình hóa đơn theo loại).
const voucherItem = (code: string, label: string): MenuItem => ({ key: code.toLowerCase(), label, to: `/chung-tu/${code}`, permission: 'voucher.view' });
const typedVoucherItem = (code: keyof typeof VOUCHER_TYPES): MenuItem => voucherItem(code, typeLabel(VOUCHER_TYPES[code]!));
export const MENU: MenuItem[] = [
  { key: 'tong-quan', label: 'Tổng quan', to: '/', icon: <HomeOutlined /> },
  { key: 'tien-ngan-hang', label: 'Tiền mặt, ngân hàng', to: '/quy', icon: <WalletOutlined />, children: [
    ...(['PT', 'PC', 'BC', 'BN', 'CT'] as const).map(typedVoucherItem),
    { key: 'cashcount', label: 'Kiểm kê quỹ', to: '/quy/kiem-ke', permission: 'cash_count.view' },
    { key: 'bank-txn', label: 'Giao dịch ngân hàng', to: '/ngan-hang/giao-dich', permission: 'bank_feed.view' },
    { key: 'bank-feed', label: 'Kết nối ngân hàng', to: '/ngan-hang/ket-noi', permission: 'bank_feed.view' },
  ] },
  { key: 'muahang', label: 'Mua hàng', to: '/chung-tu/MH', icon: <ShoppingCartOutlined />, children: [{ key: 'don-mua', label: 'Đơn đặt hàng mua', to: '/don-hang/don-mua', permission: 'order.view' }, voucherItem('MH', 'Mua hàng hóa'), voucherItem('TLM', 'Trả lại, giảm giá hàng mua'), voucherItem('CPM', 'Chi phí mua hàng'), voucherItem('HDM', 'Hóa đơn mua dịch vụ'), voucherItem('GGM', 'Giảm giá mua'), { key: 'bao-cao-mua', label: 'Báo cáo mua hàng', to: '/mua-hang/bao-cao', permission: 'report.view' }] },
  { key: 'banhang', label: 'Bán hàng', to: '/chung-tu/HDB', icon: <ShopOutlined />, children: [{ key: 'bao-gia', label: 'Báo giá', to: '/don-hang/bao-gia', permission: 'order.view' }, { key: 'don-ban', label: 'Đơn đặt hàng bán', to: '/don-hang/don-ban', permission: 'order.view' }, voucherItem('BH', 'Bán hàng hóa'), voucherItem('TLB', 'Hàng bán bị trả lại'), voucherItem('HDB', 'Hóa đơn bán dịch vụ'), voucherItem('GGB', 'Giảm giá bán'), { key: 'bao-cao-ban', label: 'Báo cáo bán hàng', to: '/ban-hang/bao-cao', permission: 'report.view' }] },
  { key: 'hddt', label: 'Hóa đơn điện tử', to: '/hoa-don-dien-tu', icon: <FileTextOutlined />, children: [
    { key: 'hddt-ds', label: 'Danh sách hóa đơn điện tử', to: '/hoa-don-dien-tu', permission: 'einvoice.view' },
    { key: 'hddt-dv', label: 'Hóa đơn đầu vào', to: '/hoa-don-dau-vao', permission: 'inbound_invoice.view' },
    { key: 'hddt-ss', label: 'Thông báo sai sót 04/SS', to: '/hoa-don-dien-tu/thong-bao-sai-sot', permission: 'einvoice.view' },
    { key: 'hddt-cfg', label: 'Cấu hình hóa đơn điện tử', to: '/hoa-don-dien-tu/cau-hinh', permission: 'einvoice.config' },
  ] },
  { key: 'kho', label: 'Kho', to: '/kho/vat-tu', icon: <InboxOutlined />, children: [
    { key: 'items', label: 'Vật tư hàng hóa', to: '/kho/vat-tu', permission: 'item.view' },
    { key: 'item_group', label: 'Nhóm vật tư hàng hóa', to: '/danh-muc/item_group', permission: 'item.view' },
    { key: 'price_list', label: 'Bảng giá', to: '/kho/bang-gia', permission: 'price_list.view' },
    { key: 'warehouse', label: 'Kho', to: '/danh-muc/warehouse', permission: 'warehouse.view' },
    { key: 'pnk', label: 'Phiếu nhập kho', to: '/chung-tu/PNK', permission: 'stock_voucher.view' },
    { key: 'pxk', label: 'Phiếu xuất kho', to: '/chung-tu/PXK', permission: 'stock_voucher.view' },
    { key: 'ck', label: 'Phiếu chuyển kho', to: '/chung-tu/CK', permission: 'stock_voucher.view' },
    { key: 'stocktake', label: 'Kiểm kê kho', to: '/kho/kiem-ke', permission: 'stocktake.view' },
    { key: 'costing', label: 'Tính giá vốn', to: '/kho/gia-von', permission: 'costing.view' },
    { key: 'stock-reports', label: 'Báo cáo kho', to: '/kho/bao-cao', permission: 'report.view' },
  ] },
  { key: 'taisan', label: 'Tài sản', to: '/tai-san', icon: <DesktopOutlined />, children: [
    { key: 'tscd', label: 'Tài sản cố định', to: '/tai-san/tscd', permission: 'asset.view' },
    { key: 'ccdc', label: 'Công cụ dụng cụ', to: '/tai-san/ccdc', permission: 'asset.view' },
    { key: 'cptt', label: 'Chi phí trả trước', to: '/tai-san/chi-phi-tra-truoc', permission: 'asset.view' },
    { key: 'asset-cat', label: 'Loại tài sản', to: '/tai-san/loai', permission: 'asset.view' },
    { key: 'asset-count', label: 'Kiểm kê tài sản', to: '/tai-san/kiem-ke', permission: 'asset.view' },
    { key: 'asset-reports', label: 'Báo cáo tài sản', to: '/tai-san/bao-cao', permission: 'report.view' },
  ] },
  { key: 'luong', label: 'Lương', to: '/luong', icon: <TeamOutlined />, children: [
    { key: 'ho-so-luong', label: 'Hồ sơ lương', to: '/luong/ho-so', permission: 'payroll.view', flag: 'view_salary' },
    { key: 'cham-cong', label: 'Chấm công', to: '/luong/cham-cong', permission: 'attendance.view' },
    { key: 'bang-luong', label: 'Bảng lương', to: '/luong/bang-luong', permission: 'payroll.view', flag: 'view_salary' },
    { key: 'bao-cao-luong', label: 'Báo cáo lương', to: '/luong/bao-cao', permission: 'payroll.view', flag: 'view_salary' },
    { key: 'thue-tncn', label: 'Thuế TNCN', to: '/luong/thue-tncn', permission: 'payroll.view', flag: 'view_salary' },
    { key: 'mau-chi-luong', label: 'Mẫu tệp chi lương', to: '/luong/mau-chi-luong', permission: 'payroll.export', flag: 'view_salary' },
    { key: 'cau-truc-luong', label: 'Cấu trúc bảng lương', to: '/luong/cau-truc', permission: 'payroll.view', flag: 'view_salary' },
    { key: 'tham-so-luong', label: 'Tham số lương', to: '/luong/tham-so', permission: 'payroll.view' },
  ] },
  { key: 'giathanh', label: 'Giá thành', to: '/gia-thanh', icon: <CalculatorOutlined />, children: [
    { key: 'doi-tuong-thcp', label: 'Đối tượng tập hợp chi phí', to: '/gia-thanh/doi-tuong', permission: 'costing_obj.view', flag: 'view_cost' },
    { key: 'dinh-muc-nvl', label: 'Định mức nguyên vật liệu', to: '/gia-thanh/dinh-muc', permission: 'costing_obj.view', flag: 'view_cost' },
    { key: 'tinh-gia-thanh', label: 'Tính giá thành', to: '/gia-thanh/tinh-gia-thanh', permission: 'cost_run.view', flag: 'view_cost' },
    { key: 'bao-cao-gia-thanh', label: 'Báo cáo giá thành', to: '/gia-thanh/bao-cao', permission: 'cost_run.view', flag: 'view_cost' },
  ] },
  { key: 'hopdong', label: 'Hợp đồng, khế ước', to: '/hop-dong-khe-uoc', icon: <SolutionOutlined />, children: [
    { key: 'khe-uoc', label: 'Khế ước vay', to: '/khe-uoc', permission: 'loan.view' },
    { key: 'hop-dong', label: 'Hợp đồng', to: '/hop-dong', permission: 'order.view' },
    { key: 'bao-cao-hop-dong', label: 'Báo cáo hợp đồng, vụ việc', to: '/hop-dong/bao-cao', permission: 'contract_track.view' },
    { key: 'phan-bo-vu-viec', label: 'Phân bổ chi phí vào vụ việc', to: '/hop-dong/phan-bo', permission: 'contract_track.view', flag: 'view_cost' },
  ] },
  { key: 'congno', label: 'Công nợ', to: '/cong-no', icon: <SwapOutlined />, children: [
    { key: 'arapreports', label: 'Báo cáo công nợ', to: '/cong-no/bao-cao', permission: 'report.view' },
    { key: 'settlement', label: 'Đối trừ chứng từ', to: '/cong-no/doi-tru', permission: 'settlement.view' },
    typedVoucherItem('BT'),
    { key: 'fxtools', label: 'Công cụ tỷ giá', to: '/cong-no/ty-gia', permission: 'fx.run' },
  ] },
  { key: 'thue', label: 'Thuế', to: '/thue', icon: <PercentageOutlined />, children: [
    { key: 'invoice-register', label: 'Bảng kê hóa đơn', to: '/thue/bang-ke-hoa-don', permission: 'tax.view' },
    { key: 'vat-return', label: 'Tờ khai thuế GTGT', to: '/thue/to-khai-gtgt', permission: 'tax_return.view' },
    { key: 'cit-estimate', label: 'Tạm tính thuế TNDN', to: '/thue/tam-tinh-tndn', permission: 'cit.view' },
    { key: 'cit-return', label: 'Quyết toán thuế TNDN (03/TNDN)', to: '/thue/quyet-toan-tndn', permission: 'cit.view' },
    { key: 'signing', label: 'Cài đặt ký số', to: '/thue/ky-so', permission: 'signing.use' },
  ] },
  { key: 'tonghop', label: 'Tổng hợp', to: '/so-cai', icon: <BookOutlined />, children: [
    typedVoucherItem('PKT'),
    typedVoucherItem('QTU'),
    { key: 'import-vouchers', label: 'Nhập chứng từ từ Excel', to: '/chung-tu/nhap-excel', permission: 'voucher.import' },
    { key: 'period-close', label: 'Quy trình cuối kỳ', to: '/so-cai/cuoi-ky', permission: 'period_close.view' },
    { key: 'periods', label: 'Kỳ kế toán và khóa sổ', to: '/so-cai/ky-ke-toan', permission: 'period.view' },
    { key: 'opening', label: 'Số dư đầu kỳ', to: '/so-cai/so-du-dau-ky', permission: 'opening_balance.view' },
    { key: 'opening-stock', label: 'Tồn kho đầu kỳ', to: '/so-cai/ton-kho-dau-ky', permission: 'opening_balance.view' },
    { key: 'opening-assets', label: 'Số dư đầu kỳ tài sản', to: '/so-cai/tai-san-dau-ky', permission: 'opening_balance.view' },
    { key: 'closing', label: 'Kết chuyển cuối kỳ', to: '/so-cai/ket-chuyen', permission: 'closing.run' },
    { key: 'amortization', label: 'Phân bổ doanh thu nhận trước', to: '/so-cai/phan-bo', permission: 'amortization.view' },
  ] },
  { key: 'baocao', label: 'Báo cáo', to: '/bao-cao', icon: <BarChartOutlined />, children: [
    { key: 'ledgers', label: 'Sổ sách kế toán', to: '/bao-cao/so-sach', permission: 'report.view' },
    { key: 'bookforms', label: 'Hình thức sổ', to: '/bao-cao/hinh-thuc-so', permission: 'report.view' },
    { key: 'cashbooks', label: 'Sổ quỹ và tiền gửi', to: '/bao-cao/so-quy', permission: 'report.view' },
    { key: 'financial', label: 'Báo cáo tài chính', to: '/bao-cao/bao-cao-tai-chinh', permission: 'report.view' },
    { key: 'analytics', label: 'Phân tích tài chính', to: '/phan-tich', permission: 'report.view' },
    { key: 'budget', label: 'Ngân sách', to: '/ngan-sach', permission: 'budget.view' },
    { key: 'sohkd-books', label: 'Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', to: '/so-hkd', permission: 'sohkd.view' },
  ] },
  // GĐ7 nhóm 4: người chỉ có quyền duyệt vào hộp duyệt từ huy hiệu "Chờ duyệt" ở đầu trang.
  { key: 'pheduyet', label: 'Phê duyệt', to: '/phe-duyet-nhom', icon: <AuditOutlined />, children: [
    { key: 'approvals', label: 'Đề nghị thanh toán, tạm ứng', to: '/phe-duyet', permission: 'approval_request.create' },
    { key: 'approval-flows', label: 'Quy trình phê duyệt', to: '/phe-duyet/quy-trinh', permission: 'setting.update' },
    { key: 'approval-delegations', label: 'Ủy quyền duyệt', to: '/phe-duyet/uy-quyen', permission: 'approval_request.approve' },
  ] },
  { key: 'danhmuc', label: 'Danh mục', to: '/danh-muc', icon: <DatabaseOutlined />, children: [
    { key: 'accounts', label: 'Hệ thống tài khoản', to: '/danh-muc/he-thong-tai-khoan', permission: 'account.view' },
    { key: 'cat-party', label: 'Đối tượng', to: '/danh-muc/party', permission: 'catalog.view' },
    { key: 'cat-party_group', label: 'Nhóm đối tượng', to: '/danh-muc/party_group', permission: 'catalog.view' },
    { key: 'cat-department', label: 'Bộ phận', to: '/danh-muc/department', permission: 'catalog.view' },
    { key: 'cat-employee', label: 'Nhân viên', to: '/danh-muc/employee', permission: 'catalog.view' },
    { key: 'cat-currency', label: 'Loại tiền', to: '/danh-muc/currency', permission: 'catalog.view' },
    { key: 'cat-exchange_rate', label: 'Tỷ giá', to: '/danh-muc/exchange_rate', permission: 'catalog.view' },
    { key: 'cat-bank', label: 'Ngân hàng', to: '/danh-muc/bank', permission: 'catalog.view' },
    { key: 'cat-voucher_dup_rule', label: 'Quy tắc khử trùng chứng từ', to: '/danh-muc/voucher_dup_rule', permission: 'catalog.view' },
    { key: 'cat-bank_account', label: 'Tài khoản ngân hàng', to: '/danh-muc/bank_account', permission: 'catalog.view' },
    { key: 'cat-payment_method', label: 'Hình thức thanh toán', to: '/danh-muc/payment_method', permission: 'catalog.view' },
    { key: 'cat-tax_code', label: 'Loại thuế', to: '/danh-muc/tax_code', permission: 'catalog.view' },
    { key: 'cat-tax_distribution', label: 'Phân bổ thuế', to: '/danh-muc/tax_distribution', permission: 'catalog.view' },
    { key: 'cat-invoice_group', label: 'Nhóm hóa đơn', to: '/danh-muc/invoice_group', permission: 'catalog.view' },
    { key: 'cat-cost_item', label: 'Khoản mục chi phí', to: '/danh-muc/cost_item', permission: 'catalog.view' },
    { key: 'cat-project', label: 'Vụ việc / công trình', to: '/danh-muc/project', permission: 'catalog.view' },
    { key: 'cat-uom', label: 'Đơn vị tính', to: '/danh-muc/uom', permission: 'catalog.view' },
    { key: 'import', label: 'Nhập Excel', to: '/danh-muc/nhap-excel', permission: 'catalog.import' },
  ] },
  { key: 'hethong', label: 'Hệ thống', to: '/he-thong', icon: <SettingOutlined />, children: [
    { key: 'users', label: 'Người dùng', to: '/he-thong/nguoi-dung', permission: 'user.view' },
    { key: 'company', label: 'Thông tin công ty', to: '/he-thong/cong-ty' },
    { key: 'newco', label: 'Tạo công ty mới', to: '/he-thong/tao-cong-ty' },
    { key: 'audit', label: 'Nhật ký kiểm toán', to: '/he-thong/nhat-ky', permission: 'audit.view' },
    { key: 'api-keys', label: 'Khóa API', to: '/he-thong/khoa-api', permission: 'api_key.manage' },
    { key: 'regimes', label: 'Chế độ kế toán', to: '/he-thong/che-do-ke-toan' },
    { key: 'english-names', label: 'Tên tiếng Anh', to: '/he-thong/ten-tieng-anh', permission: 'account.view' },
    { key: 'branches', label: 'Chi nhánh', to: '/chi-nhanh', permission: 'catalog.view' },
    { key: 'dedupe', label: 'Khử trùng chứng từ', to: '/tien-ich/khu-trung', permission: 'dedupe.run' },
    { key: 'datacheck', label: 'Soát lỗi dữ liệu', to: '/tien-ich/soat-loi', permission: 'data_check.run' },
    { key: 'export', label: 'Xuất dữ liệu cho cơ quan thẩm quyền', to: '/tien-ich/xuat-du-lieu', permission: 'export.authority' },
    // GĐ7 nhóm 7: trợ lý (bút toán định kỳ, nhận diện hóa đơn, gợi ý định khoản)
    { key: 'assistant', label: 'Bút toán định kỳ, nhận diện hóa đơn', to: '/tro-ly', permission: 'assistant.use' },
  ] },
];

export interface MatchedMenuRoute {
  leaf: MenuItem | null;
  group: MenuItem | null;
  selectedKey: string;
}

// Khớp đường dẫn theo nguyên tắc: path === to || path.startsWith(to + '/').
// Nếu nhiều mục khớp thì chọn mục có to dài nhất.
export function matchMenuRoute(items: MenuItem[], path: string): MatchedMenuRoute {
  let bestLeaf: MenuItem | null = null;
  let bestGroup: MenuItem | null = null;
  let maxLen = -1;

  for (const item of items) {
    if (item.children) {
      for (const child of item.children) {
        const matches = path === child.to || (child.to !== '/' && path.startsWith(child.to + '/'));
        if (matches && child.to.length > maxLen) {
          maxLen = child.to.length;
          bestLeaf = child;
          bestGroup = item;
        }
      }
    } else {
      const matches = path === item.to || (item.to !== '/' && path.startsWith(item.to + '/'));
      if (matches && item.to.length > maxLen) {
        maxLen = item.to.length;
        bestLeaf = item;
        bestGroup = null;
      }
    }
  }

  return {
    leaf: bestLeaf,
    group: bestGroup,
    selectedKey: bestLeaf?.to ?? path,
  };
}

