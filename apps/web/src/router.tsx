import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Spin } from 'antd';
import { AppLayout, type MenuItem } from './layout/AppLayout.js';
import { useAuth } from './auth.js';
import LoginPage from './pages/Login.js';
import SelectTenantPage from './pages/SelectTenant.js';
import UsersPage from './pages/Users.js';
import CompanyPage from './pages/Company.js';
import CompanyWizard from './pages/CompanyWizard.js';
import AccountsPage from './pages/Accounts.js';
import ImportExcelPage from './pages/ImportExcel.js';
import CatalogPage from './pages/Catalog.js';
import AuditLogPage from './pages/AuditLog.js';
import PeriodsPage from './pages/Periods.js';
import VoucherListPage, { typeLabel } from './pages/VoucherList.js';
import VoucherPage from './pages/VoucherForm.js';
import OpeningBalancePage from './pages/OpeningBalance.js';
import ClosingPage from './pages/Closing.js';
import LedgersPage from './pages/Ledgers.js';
import ArapReportsPage from './pages/ArapReports.js';
import SettlementPage from './pages/Settlement.js';
import FxToolsPage from './pages/FxTools.js';
import CashBooksPage from './pages/CashBooks.js';
import CashCountPage from './pages/CashCount.js';
import FinancialPage from './pages/Financial.js';
import DataCheckPage from './pages/DataCheck.js';
import ExportPage from './pages/Export.js';
import { VOUCHER_TYPES } from '@kt/domain';
import { api } from './api/client.js';

// Các task sau thêm mục vào MENU và route vào routeTree.
// Mỗi mục menu Chứng từ là danh sách lọc theo loại; hóa đơn (HDB, HDM, GGB, GGM) có màn hình riêng ở giai đoạn sau.
const VOUCHER_MENU_TYPES = ['PT', 'PC', 'BC', 'BN', 'CT', 'QTU', 'BT', 'PKT'] as const;
export const MENU: MenuItem[] = [
  { key: 'hethong', label: 'Hệ thống', to: '/he-thong', children: [
    { key: 'users', label: 'Người dùng', to: '/he-thong/nguoi-dung', permission: 'user.view' },
    { key: 'company', label: 'Thông tin công ty', to: '/he-thong/cong-ty' },
    { key: 'newco', label: 'Tạo công ty mới', to: '/he-thong/tao-cong-ty' },
    { key: 'audit', label: 'Nhật ký kiểm toán', to: '/he-thong/nhat-ky', permission: 'audit.view' },
  ] },
  { key: 'danhmuc', label: 'Danh mục', to: '/danh-muc', children: [
    { key: 'accounts', label: 'Hệ thống tài khoản', to: '/danh-muc/he-thong-tai-khoan', permission: 'account.view' },
    { key: 'cat-party', label: 'Đối tượng', to: '/danh-muc/party', permission: 'catalog.view' },
    { key: 'cat-party_group', label: 'Nhóm đối tượng', to: '/danh-muc/party_group', permission: 'catalog.view' },
    { key: 'cat-department', label: 'Bộ phận', to: '/danh-muc/department', permission: 'catalog.view' },
    { key: 'cat-employee', label: 'Nhân viên', to: '/danh-muc/employee', permission: 'catalog.view' },
    { key: 'cat-currency', label: 'Loại tiền', to: '/danh-muc/currency', permission: 'catalog.view' },
    { key: 'cat-exchange_rate', label: 'Tỷ giá', to: '/danh-muc/exchange_rate', permission: 'catalog.view' },
    { key: 'cat-bank', label: 'Ngân hàng', to: '/danh-muc/bank', permission: 'catalog.view' },
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
  { key: 'chungtu', label: 'Chứng từ', to: '/chung-tu', children: [
    ...VOUCHER_MENU_TYPES.map((code) => ({ key: code.toLowerCase(), label: typeLabel(VOUCHER_TYPES[code]!), to: `/chung-tu/${code}`, permission: 'voucher.view' })),
  ] },
  { key: 'quy', label: 'Quỹ', to: '/quy', children: [
    { key: 'cashcount', label: 'Kiểm kê quỹ', to: '/quy/kiem-ke', permission: 'cash_count.view' },
  ] },
  { key: 'congno', label: 'Công nợ', to: '/cong-no', children: [
    { key: 'arapreports', label: 'Báo cáo công nợ', to: '/cong-no/bao-cao', permission: 'report.view' },
    { key: 'settlement', label: 'Đối trừ chứng từ', to: '/cong-no/doi-tru', permission: 'settlement.view' },
    { key: 'fxtools', label: 'Công cụ tỷ giá', to: '/cong-no/ty-gia', permission: 'fx.run' },
  ] },
  { key: 'socai', label: 'Sổ cái', to: '/so-cai', children: [
    { key: 'periods', label: 'Kỳ kế toán và khóa sổ', to: '/so-cai/ky-ke-toan', permission: 'period.view' },
    { key: 'opening', label: 'Số dư đầu kỳ', to: '/so-cai/so-du-dau-ky', permission: 'opening_balance.view' },
    { key: 'closing', label: 'Kết chuyển cuối kỳ', to: '/so-cai/ket-chuyen', permission: 'closing.run' },
  ] },
  { key: 'baocao', label: 'Báo cáo', to: '/bao-cao', children: [
    { key: 'ledgers', label: 'Sổ sách kế toán', to: '/bao-cao/so-sach', permission: 'report.view' },
    { key: 'cashbooks', label: 'Sổ quỹ và tiền gửi', to: '/bao-cao/so-quy', permission: 'report.view' },
    { key: 'financial', label: 'Báo cáo tài chính', to: '/bao-cao/bao-cao-tai-chinh', permission: 'report.view' },
  ] },
  { key: 'tienich', label: 'Tiện ích', to: '/tien-ich', children: [
    { key: 'datacheck', label: 'Soát lỗi dữ liệu', to: '/tien-ich/soat-loi', permission: 'data_check.run' },
    { key: 'export', label: 'Xuất dữ liệu cho cơ quan thẩm quyền', to: '/tien-ich/xuat-du-lieu', permission: 'export.authority' },
  ] },
];

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/dang-nhap', component: LoginPage });
const selectTenantRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chon-cong-ty', component: SelectTenantPage });
const newCompanyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/he-thong/tao-cong-ty', component: CompanyWizard });
const requireMe = async () => {
  try { const me = await api<{ tenantId: string | null }>('/api/auth/me'); if (!me.tenantId) throw redirect({ to: '/chon-cong-ty' }); }
  catch (e) { if ((e as { status?: number }).status === 401) throw redirect({ to: '/dang-nhap' }); throw e; }
};
export const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', beforeLoad: requireMe,
  component: () => { const { loading } = useAuth(); return loading ? <Spin /> : <AppLayout menu={MENU} />; } });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: () => <div>Chọn chức năng ở menu trái.</div> });
const usersRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/nguoi-dung', component: UsersPage });
const companyRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/cong-ty', component: CompanyPage });
const auditRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/nhat-ky', component: AuditLogPage });
const accountsRoute = createRoute({ getParentRoute: () => appRoute, path: '/danh-muc/he-thong-tai-khoan', component: AccountsPage });
const importRoute = createRoute({ getParentRoute: () => appRoute, path: '/danh-muc/nhap-excel', component: ImportExcelPage });
const periodsRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/ky-ke-toan', component: PeriodsPage });
const openingRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/so-du-dau-ky', component: OpeningBalancePage });
const closingRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/ket-chuyen', component: ClosingPage });
const ledgersRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/so-sach', component: LedgersPage });
const cashBooksRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/so-quy', component: CashBooksPage });
const arapReportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/cong-no/bao-cao', component: ArapReportsPage });
const settlementRoute = createRoute({ getParentRoute: () => appRoute, path: '/cong-no/doi-tru', component: SettlementPage });
const fxToolsRoute = createRoute({ getParentRoute: () => appRoute, path: '/cong-no/ty-gia', component: FxToolsPage });
const cashCountRoute = createRoute({ getParentRoute: () => appRoute, path: '/quy/kiem-ke', component: CashCountPage });
const financialRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/bao-cao-tai-chinh', component: FinancialPage });
const dataCheckRoute = createRoute({ getParentRoute: () => appRoute, path: '/tien-ich/soat-loi', component: DataCheckPage });
const exportRoute = createRoute({ getParentRoute: () => appRoute, path: '/tien-ich/xuat-du-lieu', component: ExportPage });
const voucherListRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/$type', component: VoucherListPage });
const voucherRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/$type/$id', component: VoucherPage });
// Địa chỉ cũ của Phiếu kế toán (đã gửi cho người dùng, lưu trong dấu trang) chuyển sang địa chỉ theo loại.
const oldPktListRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/phieu-ke-toan', beforeLoad: () => { throw redirect({ to: '/chung-tu/$type', params: { type: 'PKT' } }); } });
const oldPktRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/phieu-ke-toan/$id', beforeLoad: ({ params }) => { throw redirect({ to: '/chung-tu/$type/$id', params: { type: 'PKT', id: params.id } }); } });
const catalogRoute = createRoute({ getParentRoute: () => appRoute, path: '/danh-muc/$name', component: CatalogPage });

export const routeTree = rootRoute.addChildren([loginRoute, selectTenantRoute, newCompanyRoute, appRoute.addChildren([homeRoute, usersRoute, companyRoute, auditRoute, accountsRoute, importRoute, periodsRoute, openingRoute, closingRoute, ledgersRoute, cashBooksRoute, arapReportsRoute, settlementRoute, fxToolsRoute, cashCountRoute, financialRoute, dataCheckRoute, exportRoute, oldPktListRoute, oldPktRoute, voucherListRoute, voucherRoute, catalogRoute])]);
export const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
