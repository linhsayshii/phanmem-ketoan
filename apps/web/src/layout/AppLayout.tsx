import { Layout, Menu, Typography } from 'antd';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useAuth } from '../auth.js';
import { ApprovalBadge } from '../pages/Approvals.js';

// flag: cờ nhạy cảm (view_salary...) cần có để mục hiện ra.
export interface MenuItem { key: string; label: string; to: string; permission?: string; flag?: string; children?: MenuItem[] | undefined }

// Mục có quyền, bỏ cả nhóm khi không còn mục con nào hiện (không để nhóm rỗng trên menu).
export const visibleMenu = (items: MenuItem[], can: (code: string) => boolean, has: (flag: string) => boolean = () => true): MenuItem[] =>
  items.filter((i) => (!i.permission || can(i.permission)) && (!i.flag || has(i.flag))).map((i) => ({ ...i, children: i.children ? visibleMenu(i.children, can, has) : undefined })).filter((i) => !i.children || i.children.length > 0);

export function AppLayout({ menu }: { menu: MenuItem[] }) {
  const { me, can, logout } = useAuth();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const toAntd = (items: MenuItem[]): { key: string; label: React.ReactNode; children?: unknown[] | undefined }[] =>
    items.map((i) => ({ key: i.to, label: i.children ? i.label : <Link to={i.to}>{i.label}</Link>, children: i.children ? toAntd(i.children) : undefined }));
  const company = me?.tenants.find((t) => t.id === me.tenantId);
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={240} theme="light" breakpoint="lg" collapsedWidth={0}><div style={{ padding: 12 }}><Typography.Text strong>{company?.name ?? 'Kế toán'}</Typography.Text></div>
        <Menu mode="inline" selectedKeys={[path]} items={toAntd(visibleMenu(menu, can, (f) => !!me?.sensitive.includes(f)))} /></Layout.Sider>
      <Layout><Layout.Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', gap: 16 }}>
        <ApprovalBadge /><span>{me?.username}</span><a onClick={async () => { try { await logout(); } catch { /* trạng thái cục bộ đã được xóa, vẫn thoát về trang đăng nhập */ } void navigate({ to: '/dang-nhap' }); }}>Đăng xuất</a></Layout.Header>
        <Layout.Content style={{ padding: 16 }}><Outlet /></Layout.Content></Layout>
    </Layout>
  );
}
