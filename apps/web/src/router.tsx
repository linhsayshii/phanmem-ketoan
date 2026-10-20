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
import { api } from './api/client.js';

// Các task sau thêm mục vào MENU và route vào routeTree.
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
    { key: 'cat-invoice_group', label: 'Nhóm hóa đơn', to: '/danh-muc/invoice_group', permission: 'catalog.view' },
    { key: 'cat-cost_item', label: 'Khoản mục chi phí', to: '/danh-muc/cost_item', permission: 'catalog.view' },
    { key: 'cat-project', label: 'Vụ việc / công trình', to: '/danh-muc/project', permission: 'catalog.view' },
    { key: 'cat-uom', label: 'Đơn vị tính', to: '/danh-muc/uom', permission: 'catalog.view' },
    { key: 'import', label: 'Nhập Excel', to: '/danh-muc/nhap-excel', permission: 'catalog.import' },
  ] },
  { key: 'socai', label: 'Sổ cái', to: '/so-cai', children: [
    { key: 'periods', label: 'Kỳ kế toán và khóa sổ', to: '/so-cai/ky-ke-toan', permission: 'period.view' },
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
const catalogRoute = createRoute({ getParentRoute: () => appRoute, path: '/danh-muc/$name', component: CatalogPage });

export const routeTree = rootRoute.addChildren([loginRoute, selectTenantRoute, newCompanyRoute, appRoute.addChildren([homeRoute, usersRoute, companyRoute, auditRoute, accountsRoute, importRoute, periodsRoute, catalogRoute])]);
export const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
