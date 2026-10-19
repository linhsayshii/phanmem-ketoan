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
import { api } from './api/client.js';

// Các task sau thêm mục vào MENU và route vào routeTree.
export const MENU: MenuItem[] = [
  { key: 'hethong', label: 'Hệ thống', to: '/he-thong', children: [
    { key: 'users', label: 'Người dùng', to: '/he-thong/nguoi-dung', permission: 'user.view' },
    { key: 'company', label: 'Thông tin công ty', to: '/he-thong/cong-ty' },
    { key: 'newco', label: 'Tạo công ty mới', to: '/he-thong/tao-cong-ty' },
  ] },
  { key: 'danhmuc', label: 'Danh mục', to: '/danh-muc', children: [
    { key: 'accounts', label: 'Hệ thống tài khoản', to: '/danh-muc/he-thong-tai-khoan', permission: 'account.view' },
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
const accountsRoute = createRoute({ getParentRoute: () => appRoute, path: '/danh-muc/he-thong-tai-khoan', component: AccountsPage });

export const routeTree = rootRoute.addChildren([loginRoute, selectTenantRoute, newCompanyRoute, appRoute.addChildren([homeRoute, usersRoute, companyRoute, accountsRoute])]);
export const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
