import { useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Input, Layout, Menu, Typography } from 'antd';
import { DownOutlined, MenuOutlined } from '@ant-design/icons';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { COLOR } from '@kt/ui';
import { useAuth } from '../auth.js';
import { ApprovalBadge } from '../pages/Approvals.js';
import { matchMenuRoute } from './menu.js';

// flag: cờ nhạy cảm (view_salary...) cần có để mục hiện ra.
export interface MenuItem {
  key: string;
  label: string;
  to: string;
  icon?: React.ReactNode;
  permission?: string;
  flag?: string;
  children?: MenuItem[] | undefined;
}

// Mục có quyền, bỏ cả nhóm khi không còn mục con nào hiện (không để nhóm rỗng trên menu).
export const visibleMenu = (items: MenuItem[], can: (code: string) => boolean, has: (flag: string) => boolean = () => true): MenuItem[] =>
  items
    .filter((i) => (!i.permission || can(i.permission)) && (!i.flag || has(i.flag)))
    .map((i) => ({ ...i, children: i.children ? visibleMenu(i.children, can, has) : undefined }))
    .filter((i) => !i.children || i.children.length > 0);

function stripDiacritics(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function filterMenuItems(items: MenuItem[], query: string): { filtered: MenuItem[]; matchedKeys: string[] } {
  const q = stripDiacritics(query.trim());
  if (!q) return { filtered: items, matchedKeys: [] };
  const matchedKeys: string[] = [];

  function walk(list: MenuItem[]): MenuItem[] {
    const res: MenuItem[] = [];
    for (const item of list) {
      const matchSelf = stripDiacritics(item.label).includes(q);
      if (item.children) {
        const sub = walk(item.children);
        if (sub.length > 0 || matchSelf) {
          matchedKeys.push(item.key);
          res.push({
            ...item,
            children: sub.length > 0 ? sub : item.children,
          });
        }
      } else if (matchSelf) {
        res.push(item);
      }
    }
    return res;
  }

  return { filtered: walk(items), matchedKeys };
}

export function AppLayout({ menu }: { menu: MenuItem[] }) {
  const { me, can, logout } = useAuth();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');

  const company = me?.tenants.find((t) => t.id === me.tenantId);
  const availableItems = useMemo(
    () => visibleMenu(menu, can, (f) => !!me?.sensitive.includes(f)),
    [menu, can, me?.sensitive],
  );

  const matched = useMemo(() => matchMenuRoute(availableItems, path), [availableItems, path]);
  const activeGroup = matched.group;
  const selectedKey = matched.selectedKey;

  const [openKeys, setOpenKeys] = useState<string[]>(() => (activeGroup ? [activeGroup.key] : []));
  const [searchOpenKeys, setSearchOpenKeys] = useState<string[]>([]);

  useEffect(() => {
    if (activeGroup) {
      const k = activeGroup.key;
      setOpenKeys((prev) => (prev.includes(k) ? prev : [...prev, k]));
    }
  }, [activeGroup?.key]);

  const { filtered: filteredItems, matchedKeys } = useMemo(
    () => filterMenuItems(availableItems, search),
    [availableItems, search],
  );

  useEffect(() => {
    if (search) {
      setSearchOpenKeys(matchedKeys);
    }
  }, [search, matchedKeys]);

  const toAntd = (items: MenuItem[]): { key: string; icon?: React.ReactNode; label: React.ReactNode; children?: unknown[] | undefined }[] =>
    items.map((i) => ({
      key: i.children ? i.key : i.to,
      icon: i.icon,
      label: i.children ? i.label : <Link to={i.to}>{i.label}</Link>,
      children: i.children ? toAntd(i.children) : undefined,
    }));

  const userMenuItems = [
    ...((me?.tenants?.length ?? 0) > 1
      ? [{ key: 'switch-tenant', label: 'Đổi công ty', onClick: () => void navigate({ to: '/chon-cong-ty' }) }]
      : []),
    {
      key: 'logout',
      danger: true,
      label: 'Đăng xuất',
      onClick: async () => {
        try {
          await logout();
        } catch {
          /* trạng thái cục bộ đã được xóa, vẫn thoát về trang đăng nhập */
        }
        void navigate({ to: '/dang-nhap' });
      },
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        width={240}
        theme="light"
        breakpoint="lg"
        collapsedWidth={0}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        style={{
          background: COLOR.surface,
          borderRight: 'none',
          height: '100vh',
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 100,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Đầu sidebar: 48px, tên công ty và mã */}
          <div
            style={{
              height: 48,
              padding: '0 16px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              borderBottom: `1px solid ${COLOR.border}`,
              flexShrink: 0,
            }}
          >
            <Typography.Text
              strong
              style={{
                fontSize: 13,
                lineHeight: '18px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {company?.name ?? 'Kế toán'}
            </Typography.Text>
            {company?.code && (
              <span
                style={{
                  fontSize: 11,
                  color: COLOR.textSecondary,
                  lineHeight: '14px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {company.code}
              </span>
            )}
          </div>

          {/* Ô tìm kiếm chức năng */}
          <div style={{ padding: '8px 12px', flexShrink: 0 }}>
            <Input
              size="small"
              aria-label="Tìm chức năng"
              placeholder="Tìm chức năng"
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Vùng menu cuộn riêng */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <Menu
              mode="inline"
              selectedKeys={[selectedKey]}
              openKeys={search ? searchOpenKeys : openKeys}
              onOpenChange={(keys) => {
                if (search) {
                  setSearchOpenKeys(keys);
                } else {
                  setOpenKeys(keys);
                }
              }}
              items={toAntd(filteredItems)}
              style={{ borderRight: 0 }}
            />
          </div>
        </div>
      </Layout.Sider>

      <Layout>
        {/* Thanh đầu 48px */}
        <Layout.Header
          style={{
            background: COLOR.surface,
            height: 48,
            lineHeight: '48px',
            padding: '0 16px',
            borderBottom: `1px solid ${COLOR.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {collapsed && (
              <Button
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setCollapsed(false)}
                aria-label="Mở menu"
                style={{ fontSize: 16 }}
              />
            )}
            {activeGroup && (
              <span style={{ fontSize: 13, color: COLOR.textSecondary }}>
                {activeGroup.label}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <ApprovalBadge />
            <Dropdown menu={{ items: userMenuItems }} trigger={['click']}>
              <Button type="text" style={{ padding: '0 8px', fontSize: 13, height: 32 }}>
                {me?.username} <DownOutlined style={{ fontSize: 10, color: COLOR.textSecondary }} />
              </Button>
            </Dropdown>
          </div>
        </Layout.Header>

        {/* Vùng nội dung màn hình */}
        <Layout.Content style={{ padding: 16 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
