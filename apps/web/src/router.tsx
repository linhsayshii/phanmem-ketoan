import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Spin } from 'antd';
import { AppLayout, type MenuItem } from './layout/AppLayout.js';
import { useAuth } from './auth.js';
import LoginPage from './pages/Login.js';
import SelectTenantPage from './pages/SelectTenant.js';
import UsersPage from './pages/Users.js';
import { api } from './api/client.js';

// Các task sau thêm mục vào MENU và route vào routeTree.
export const MENU: MenuItem[] = [
  { key: 'hethong', label: 'Hệ thống', to: '/he-thong', children: [
    { key: 'users', label: 'Người dùng', to: '/he-thong/nguoi-dung', permission: 'user.view' },
  ] },
];

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/dang-nhap', component: LoginPage });
const selectTenantRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chon-cong-ty', component: SelectTenantPage });
const requireMe = async () => {
  try { const me = await api<{ tenantId: string | null }>('/api/auth/me'); if (!me.tenantId) throw redirect({ to: '/chon-cong-ty' }); }
  catch (e) { if ((e as { status?: number }).status === 401) throw redirect({ to: '/dang-nhap' }); throw e; }
};
export const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', beforeLoad: requireMe,
  component: () => { const { loading } = useAuth(); return loading ? <Spin /> : <AppLayout menu={MENU} />; } });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: () => <div>Chọn chức năng ở menu trái.</div> });
const usersRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/nguoi-dung', component: UsersPage });

export const routeTree = rootRoute.addChildren([loginRoute, selectTenantRoute, appRoute.addChildren([homeRoute, usersRoute])]);
export const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
