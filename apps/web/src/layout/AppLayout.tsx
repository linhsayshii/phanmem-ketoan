import { Layout, Menu, Typography } from 'antd';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useAuth } from '../auth.js';

export interface MenuItem { key: string; label: string; to: string; permission?: string; children?: MenuItem[] | undefined }

export function AppLayout({ menu }: { menu: MenuItem[] }) {
  const { me, can, logout } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const visible = (items: MenuItem[]): MenuItem[] => items.filter((i) => !i.permission || can(i.permission)).map((i) => ({ ...i, children: i.children ? visible(i.children) : undefined }));
  const toAntd = (items: MenuItem[]): { key: string; label: React.ReactNode; children?: unknown[] | undefined }[] =>
    items.map((i) => ({ key: i.to, label: i.children ? i.label : <Link to={i.to}>{i.label}</Link>, children: i.children ? toAntd(i.children) : undefined }));
  const company = me?.tenants.find((t) => t.id === me.tenantId);
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={240} theme="light"><div style={{ padding: 12 }}><Typography.Text strong>{company?.name ?? 'Kế toán'}</Typography.Text></div>
        <Menu mode="inline" selectedKeys={[path]} items={toAntd(visible(menu))} /></Layout.Sider>
      <Layout><Layout.Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', gap: 16 }}>
        <span>{me?.username}</span><a onClick={() => void logout()}>Đăng xuất</a></Layout.Header>
        <Layout.Content style={{ padding: 16 }}><Outlet /></Layout.Content></Layout>
    </Layout>
  );
}
