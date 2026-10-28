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
import ImportVouchersPage from './pages/ImportVouchers.js';
import CatalogPage from './pages/Catalog.js';
import ItemsPage from './pages/Items.js';
import PriceListsPage from './pages/PriceLists.js';
import OrdersPage from './pages/Orders.js';
import StocktakePage from './pages/Stocktake.js';
import StockReportsPage from './pages/StockReports.js';
import AssetReportsPage from './pages/AssetReports.js';
import AssetCountPage from './pages/AssetCount.js';
import { PurchaseReportsPage, SalesReportsPage } from './pages/SalesPurchaseReports.js';
import CostingRunPage from './pages/CostingRun.js';
import AuditLogPage from './pages/AuditLog.js';
import PeriodsPage from './pages/Periods.js';
import VoucherListPage, { typeLabel } from './pages/VoucherList.js';
import VoucherPage from './pages/VoucherForm.js';
import OpeningBalancePage from './pages/OpeningBalance.js';
import OpeningStockPage from './pages/OpeningStock.js';
import AssetOpeningPage from './pages/AssetOpening.js';
import ClosingPage from './pages/Closing.js';
import PeriodClosePage from './pages/PeriodClose.js';
import LedgersPage from './pages/Ledgers.js';
import BookFormsPage from './pages/BookForms.js';
import ArapReportsPage from './pages/ArapReports.js';
import InvoiceRegisterPage from './pages/InvoiceRegister.js';
import VatReturnPage from './pages/VatReturn.js';
import CitEstimatePage from './pages/CitEstimate.js';
import CitReturnPage from './pages/CitReturn.js';
import EInvoicesPage from './pages/EInvoices.js';
import InboundInvoicesPage from './pages/InboundInvoices.js';
import BankTransactionsPage from './pages/BankTransactions.js';
import BankFeedsPage from './pages/BankFeeds.js';
import ApiKeysPage from './pages/ApiKeys.js';
import RegimesPage from './pages/Regimes.js';
import EnglishNamesPage from './pages/EnglishNames.js';
import EInvoiceConfigPage from './pages/EInvoiceConfig.js';
import SigningSetupPage from './pages/SigningSetup.js';
import EInvoiceErrorNoticePage from './pages/EInvoiceErrorNotice.js';
import SettlementPage from './pages/Settlement.js';
import FxToolsPage from './pages/FxTools.js';
import AmortizationPage from './pages/Amortization.js';
import LoansPage from './pages/Loans.js';
import { AssetCategoriesPage, FixedAssetsPage, PrepaidPage, ToolsPage } from './pages/Assets.js';
import CashBooksPage from './pages/CashBooks.js';
import CashCountPage from './pages/CashCount.js';
import FinancialPage from './pages/Financial.js';
import DataCheckPage from './pages/DataCheck.js';
import DedupePage from './pages/Dedupe.js';
import ExportPage from './pages/Export.js';
import BudgetPage from './pages/Budget.js';
import AnalyticsPage from './pages/Analytics.js';
import ApprovalsPage, { ApprovalFlowsPage } from './pages/Approvals.js';
import { VOUCHER_TYPES } from '@kt/domain';
import { api } from './api/client.js';

// Các task sau thêm mục vào MENU và route vào routeTree.
// Mỗi mục menu Chứng từ là danh sách lọc theo loại; hóa đơn và giảm giá (HDB, HDM, GGB, GGM) nằm ở nhóm Mua hàng / Bán hàng, cùng đường dẫn /chung-tu/<mã> (VoucherPage chọn màn hình hóa đơn theo loại).
const VOUCHER_MENU_TYPES = ['PT', 'PC', 'BC', 'BN', 'CT', 'QTU', 'BT', 'PKT'] as const;
const voucherItem = (code: string, label: string): MenuItem => ({ key: code.toLowerCase(), label, to: `/chung-tu/${code}`, permission: 'voucher.view' });
export const MENU: MenuItem[] = [
  { key: 'hethong', label: 'Hệ thống', to: '/he-thong', children: [
    { key: 'users', label: 'Người dùng', to: '/he-thong/nguoi-dung', permission: 'user.view' },
    { key: 'company', label: 'Thông tin công ty', to: '/he-thong/cong-ty' },
    { key: 'newco', label: 'Tạo công ty mới', to: '/he-thong/tao-cong-ty' },
    { key: 'audit', label: 'Nhật ký kiểm toán', to: '/he-thong/nhat-ky', permission: 'audit.view' },
    { key: 'api-keys', label: 'Khóa API', to: '/he-thong/khoa-api', permission: 'api_key.manage' },
    { key: 'regimes', label: 'Chế độ kế toán', to: '/he-thong/che-do-ke-toan' },
    { key: 'english-names', label: 'Tên tiếng Anh', to: '/he-thong/ten-tieng-anh', permission: 'account.view' },
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
  { key: 'kho', label: 'Kho', to: '/kho/vat-tu', children: [
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
    { key: 'uom', label: 'Đơn vị tính', to: '/danh-muc/uom', permission: 'catalog.view' },
  ] },
  { key: 'chungtu', label: 'Chứng từ', to: '/chung-tu', children: [
    ...VOUCHER_MENU_TYPES.map((code) => ({ key: code.toLowerCase(), label: typeLabel(VOUCHER_TYPES[code]!), to: `/chung-tu/${code}`, permission: 'voucher.view' })),
    { key: 'import-vouchers', label: 'Nhập chứng từ từ Excel', to: '/chung-tu/nhap-excel', permission: 'voucher.import' },
  ] },
  { key: 'muahang', label: 'Mua hàng', to: '/chung-tu/MH', children: [{ key: 'don-mua', label: 'Đơn đặt hàng mua', to: '/don-hang/don-mua', permission: 'order.view' }, voucherItem('MH', 'Mua hàng hóa'), voucherItem('TLM', 'Trả lại, giảm giá hàng mua'), voucherItem('CPM', 'Chi phí mua hàng'), voucherItem('HDM', 'Hóa đơn mua dịch vụ'), voucherItem('GGM', 'Giảm giá mua'), { key: 'bao-cao-mua', label: 'Báo cáo mua hàng', to: '/mua-hang/bao-cao', permission: 'report.view' }] },
  { key: 'banhang', label: 'Bán hàng', to: '/chung-tu/HDB', children: [{ key: 'bao-gia', label: 'Báo giá', to: '/don-hang/bao-gia', permission: 'order.view' }, { key: 'don-ban', label: 'Đơn đặt hàng bán', to: '/don-hang/don-ban', permission: 'order.view' }, voucherItem('BH', 'Bán hàng hóa'), voucherItem('TLB', 'Hàng bán bị trả lại'), voucherItem('HDB', 'Hóa đơn bán dịch vụ'), voucherItem('GGB', 'Giảm giá bán'), { key: 'bao-cao-ban', label: 'Báo cáo bán hàng', to: '/ban-hang/bao-cao', permission: 'report.view' }] },
  { key: 'quy', label: 'Quỹ', to: '/quy', children: [
    { key: 'cashcount', label: 'Kiểm kê quỹ', to: '/quy/kiem-ke', permission: 'cash_count.view' },
  ] },
  { key: 'nganhang', label: 'Ngân hàng', to: '/ngan-hang', children: [
    { key: 'bank-txn', label: 'Giao dịch ngân hàng', to: '/ngan-hang/giao-dich', permission: 'bank_feed.view' },
    { key: 'bank-feed', label: 'Kết nối ngân hàng', to: '/ngan-hang/ket-noi', permission: 'bank_feed.view' },
  ] },
  { key: 'congno', label: 'Công nợ', to: '/cong-no', children: [
    { key: 'arapreports', label: 'Báo cáo công nợ', to: '/cong-no/bao-cao', permission: 'report.view' },
    { key: 'settlement', label: 'Đối trừ chứng từ', to: '/cong-no/doi-tru', permission: 'settlement.view' },
    { key: 'fxtools', label: 'Công cụ tỷ giá', to: '/cong-no/ty-gia', permission: 'fx.run' },
  ] },
  { key: 'thue', label: 'Thuế', to: '/thue', children: [
    { key: 'invoice-register', label: 'Bảng kê hóa đơn', to: '/thue/bang-ke-hoa-don', permission: 'tax.view' },
    { key: 'vat-return', label: 'Tờ khai thuế GTGT', to: '/thue/to-khai-gtgt', permission: 'tax_return.view' },
    { key: 'cit-estimate', label: 'Tạm tính thuế TNDN', to: '/thue/tam-tinh-tndn', permission: 'cit.view' },
    { key: 'cit-return', label: 'Quyết toán thuế TNDN (03/TNDN)', to: '/thue/quyet-toan-tndn', permission: 'cit.view' },
    { key: 'signing', label: 'Cài đặt ký số', to: '/thue/ky-so', permission: 'signing.use' },
  ] },
  { key: 'hddt', label: 'Hóa đơn điện tử', to: '/hoa-don-dien-tu', children: [
    { key: 'hddt-ds', label: 'Danh sách hóa đơn điện tử', to: '/hoa-don-dien-tu', permission: 'einvoice.view' },
    { key: 'hddt-dv', label: 'Hóa đơn đầu vào', to: '/hoa-don-dau-vao', permission: 'inbound_invoice.view' },
    { key: 'hddt-ss', label: 'Thông báo sai sót 04/SS', to: '/hoa-don-dien-tu/thong-bao-sai-sot', permission: 'einvoice.view' },
    { key: 'hddt-cfg', label: 'Cấu hình hóa đơn điện tử', to: '/hoa-don-dien-tu/cau-hinh', permission: 'einvoice.config' },
  ] },
  { key: 'socai', label: 'Sổ cái', to: '/so-cai', children: [
    { key: 'period-close', label: 'Quy trình cuối kỳ', to: '/so-cai/cuoi-ky', permission: 'period_close.view' },
    { key: 'periods', label: 'Kỳ kế toán và khóa sổ', to: '/so-cai/ky-ke-toan', permission: 'period.view' },
    { key: 'opening', label: 'Số dư đầu kỳ', to: '/so-cai/so-du-dau-ky', permission: 'opening_balance.view' },
    { key: 'opening-stock', label: 'Tồn kho đầu kỳ', to: '/so-cai/ton-kho-dau-ky', permission: 'opening_balance.view' },
    { key: 'opening-assets', label: 'Số dư đầu kỳ tài sản', to: '/so-cai/tai-san-dau-ky', permission: 'opening_balance.view' },
    { key: 'closing', label: 'Kết chuyển cuối kỳ', to: '/so-cai/ket-chuyen', permission: 'closing.run' },
    { key: 'amortization', label: 'Phân bổ doanh thu nhận trước', to: '/so-cai/phan-bo', permission: 'amortization.view' },
  ] },
  { key: 'taisan', label: 'Tài sản', to: '/tai-san', children: [
    { key: 'tscd', label: 'Tài sản cố định', to: '/tai-san/tscd', permission: 'asset.view' },
    { key: 'ccdc', label: 'Công cụ dụng cụ', to: '/tai-san/ccdc', permission: 'asset.view' },
    { key: 'cptt', label: 'Chi phí trả trước', to: '/tai-san/chi-phi-tra-truoc', permission: 'asset.view' },
    { key: 'asset-cat', label: 'Loại tài sản', to: '/tai-san/loai', permission: 'asset.view' },
    { key: 'asset-count', label: 'Kiểm kê tài sản', to: '/tai-san/kiem-ke', permission: 'asset.view' },
    { key: 'asset-reports', label: 'Báo cáo tài sản', to: '/tai-san/bao-cao', permission: 'report.view' },
  ] },
  { key: 'khe-uoc', label: 'Khế ước vay', to: '/khe-uoc', permission: 'loan.view' },
  { key: 'baocao', label: 'Báo cáo', to: '/bao-cao', children: [
    { key: 'ledgers', label: 'Sổ sách kế toán', to: '/bao-cao/so-sach', permission: 'report.view' },
    { key: 'bookforms', label: 'Hình thức sổ', to: '/bao-cao/hinh-thuc-so', permission: 'report.view' },
    { key: 'cashbooks', label: 'Sổ quỹ và tiền gửi', to: '/bao-cao/so-quy', permission: 'report.view' },
    { key: 'financial', label: 'Báo cáo tài chính', to: '/bao-cao/bao-cao-tai-chinh', permission: 'report.view' },
  ] },
  { key: 'tienich', label: 'Tiện ích', to: '/tien-ich', children: [
    { key: 'dedupe', label: 'Khử trùng chứng từ', to: '/tien-ich/khu-trung', permission: 'dedupe.run' },
    { key: 'datacheck', label: 'Soát lỗi dữ liệu', to: '/tien-ich/soat-loi', permission: 'data_check.run' },
    { key: 'export', label: 'Xuất dữ liệu cho cơ quan thẩm quyền', to: '/tien-ich/xuat-du-lieu', permission: 'export.authority' },
  ] },  // GĐ7 nhóm 4: người chỉ có quyền duyệt vào hộp duyệt từ huy hiệu "Chờ duyệt" ở đầu trang.
  { key: 'pheduyet', label: 'Phê duyệt', to: '/phe-duyet-nhom', children: [
    { key: 'approvals', label: 'Đề nghị thanh toán, tạm ứng', to: '/phe-duyet', permission: 'approval_request.create' },
    { key: 'approval-flows', label: 'Quy trình phê duyệt', to: '/phe-duyet/quy-trinh', permission: 'setting.update' },
  ] },
  { key: 'ngansach', label: 'Ngân sách và phân tích', to: '/ngan-sach', children: [
    { key: 'budget', label: 'Ngân sách', to: '/ngan-sach', permission: 'budget.view' },
    { key: 'analytics', label: 'Phân tích tài chính', to: '/phan-tich', permission: 'report.view' },
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
const periodCloseRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/cuoi-ky', component: PeriodClosePage });
const closingRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/ket-chuyen', component: ClosingPage });
const ledgersRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/so-sach', component: LedgersPage });
const cashBooksRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/so-quy', component: CashBooksPage });
const arapReportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/cong-no/bao-cao', component: ArapReportsPage });
const invoiceRegisterRoute = createRoute({ getParentRoute: () => appRoute, path: '/thue/bang-ke-hoa-don', component: InvoiceRegisterPage });
const vatReturnRoute = createRoute({ getParentRoute: () => appRoute, path: '/thue/to-khai-gtgt', component: VatReturnPage });
const citEstimateRoute = createRoute({ getParentRoute: () => appRoute, path: '/thue/tam-tinh-tndn', component: CitEstimatePage });
const citReturnRoute = createRoute({ getParentRoute: () => appRoute, path: '/thue/quyet-toan-tndn', component: CitReturnPage });
const settlementRoute = createRoute({ getParentRoute: () => appRoute, path: '/cong-no/doi-tru', component: SettlementPage });
const fxToolsRoute = createRoute({ getParentRoute: () => appRoute, path: '/cong-no/ty-gia', component: FxToolsPage });
const amortizationRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/phan-bo', component: AmortizationPage });
const tscdRoute = createRoute({ getParentRoute: () => appRoute, path: '/tai-san/tscd', component: FixedAssetsPage });
const ccdcRoute = createRoute({ getParentRoute: () => appRoute, path: '/tai-san/ccdc', component: ToolsPage });
const cpttRoute = createRoute({ getParentRoute: () => appRoute, path: '/tai-san/chi-phi-tra-truoc', component: PrepaidPage });
const loansRoute = createRoute({ getParentRoute: () => appRoute, path: '/khe-uoc', component: LoansPage });
const assetCatRoute = createRoute({ getParentRoute: () => appRoute, path: '/tai-san/loai', component: AssetCategoriesPage });
const cashCountRoute = createRoute({ getParentRoute: () => appRoute, path: '/quy/kiem-ke', component: CashCountPage });
const financialRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/bao-cao-tai-chinh', component: FinancialPage });
const dataCheckRoute = createRoute({ getParentRoute: () => appRoute, path: '/tien-ich/soat-loi', component: DataCheckPage });
const dedupeRoute = createRoute({ getParentRoute: () => appRoute, path: '/tien-ich/khu-trung', component: DedupePage });
const exportRoute = createRoute({ getParentRoute: () => appRoute, path: '/tien-ich/xuat-du-lieu', component: ExportPage });
const importVouchersRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/nhap-excel', component: ImportVouchersPage });
const voucherListRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/$type', component: VoucherListPage });
const voucherRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/$type/$id', component: VoucherPage });
// Địa chỉ cũ của Phiếu kế toán (đã gửi cho người dùng, lưu trong dấu trang) chuyển sang địa chỉ theo loại.
const oldPktListRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/phieu-ke-toan', beforeLoad: () => { throw redirect({ to: '/chung-tu/$type', params: { type: 'PKT' } }); } });
const oldPktRoute = createRoute({ getParentRoute: () => appRoute, path: '/chung-tu/phieu-ke-toan/$id', beforeLoad: ({ params }) => { throw redirect({ to: '/chung-tu/$type/$id', params: { type: 'PKT', id: params.id } }); } });
const itemsRoute = createRoute({ getParentRoute: () => appRoute, path: '/kho/vat-tu', component: ItemsPage });
const priceListsRoute = createRoute({ getParentRoute: () => appRoute, path: '/kho/bang-gia', component: PriceListsPage });
const ordersRoute = createRoute({ getParentRoute: () => appRoute, path: '/don-hang/$slug', component: OrdersPage });
const openingStockRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/ton-kho-dau-ky', component: OpeningStockPage });
const openingAssetsRoute = createRoute({ getParentRoute: () => appRoute, path: '/so-cai/tai-san-dau-ky', component: AssetOpeningPage });
const stockReportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/kho/bao-cao', component: StockReportsPage });
const assetReportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/tai-san/bao-cao', component: AssetReportsPage });
const assetCountRoute = createRoute({ getParentRoute: () => appRoute, path: '/tai-san/kiem-ke', component: AssetCountPage });
const salesReportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ban-hang/bao-cao', component: SalesReportsPage });
const purchaseReportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/mua-hang/bao-cao', component: PurchaseReportsPage });
const stocktakeRoute = createRoute({ getParentRoute: () => appRoute, path: '/kho/kiem-ke', component: StocktakePage });
const costingRoute = createRoute({ getParentRoute: () => appRoute, path: '/kho/gia-von', component: CostingRunPage });
const catalogRoute = createRoute({ getParentRoute: () => appRoute, path: '/danh-muc/$name', component: CatalogPage });

const signingRoute = createRoute({ getParentRoute: () => appRoute, path: '/thue/ky-so', component: SigningSetupPage });
const einvoicesRoute = createRoute({ getParentRoute: () => appRoute, path: '/hoa-don-dien-tu', component: EInvoicesPage });
const bankTransactionsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ngan-hang/giao-dich', component: BankTransactionsPage });
const bankFeedsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ngan-hang/ket-noi', component: BankFeedsPage });
const apiKeysRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/khoa-api', component: ApiKeysPage });
const inboundInvoicesRoute = createRoute({ getParentRoute: () => appRoute, path: '/hoa-don-dau-vao', component: InboundInvoicesPage });
const einvoiceNoticeRoute = createRoute({ getParentRoute: () => appRoute, path: '/hoa-don-dien-tu/thong-bao-sai-sot', component: EInvoiceErrorNoticePage });
const einvoiceConfigRoute = createRoute({ getParentRoute: () => appRoute, path: '/hoa-don-dien-tu/cau-hinh', component: EInvoiceConfigPage });
const regimesRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/che-do-ke-toan', component: RegimesPage });
const bookFormsRoute = createRoute({ getParentRoute: () => appRoute, path: '/bao-cao/hinh-thuc-so', component: BookFormsPage });

const budgetRoute = createRoute({ getParentRoute: () => appRoute, path: '/ngan-sach', component: BudgetPage });
const analyticsRoute = createRoute({ getParentRoute: () => appRoute, path: '/phan-tich', component: AnalyticsPage });

const englishNamesRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/ten-tieng-anh', component: EnglishNamesPage });

const approvalsRoute = createRoute({ getParentRoute: () => appRoute, path: '/phe-duyet', component: ApprovalsPage });
const approvalFlowsRoute = createRoute({ getParentRoute: () => appRoute, path: '/phe-duyet/quy-trinh', component: ApprovalFlowsPage });
export const routeTree = rootRoute.addChildren([loginRoute, selectTenantRoute, newCompanyRoute, appRoute.addChildren([homeRoute, bankTransactionsRoute, bankFeedsRoute, apiKeysRoute, usersRoute, companyRoute, auditRoute, accountsRoute, importRoute, periodsRoute, openingRoute, openingStockRoute, openingAssetsRoute, periodCloseRoute, closingRoute, amortizationRoute, tscdRoute, ccdcRoute, cpttRoute, assetCatRoute, loansRoute, ledgersRoute, cashBooksRoute, arapReportsRoute, invoiceRegisterRoute, vatReturnRoute, citEstimateRoute, citReturnRoute, signingRoute, einvoicesRoute, inboundInvoicesRoute, einvoiceNoticeRoute, einvoiceConfigRoute, settlementRoute, fxToolsRoute, cashCountRoute, financialRoute, dataCheckRoute, dedupeRoute, exportRoute, oldPktListRoute, oldPktRoute, importVouchersRoute, voucherListRoute, voucherRoute, itemsRoute, priceListsRoute, ordersRoute, stocktakeRoute, stockReportsRoute, assetReportsRoute, assetCountRoute, salesReportsRoute, purchaseReportsRoute, costingRoute, catalogRoute, regimesRoute, bookFormsRoute, budgetRoute, analyticsRoute, englishNamesRoute, approvalsRoute, approvalFlowsRoute])]);
export const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
