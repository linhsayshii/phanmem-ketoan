import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AccountsPage, { buildTree, filterTree } from '../src/pages/Accounts.js';

vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../src/api/client.js', () => ({
  api: vi.fn(async (path: string) => path === '/api/fiscal-years' ? [{ fiscalYear: 2026, regime: 'TT133' }] : [
    { id: 1, code: '111', name: 'Tiền mặt', parentId: null, isGroup: true, normalBalance: 'debit', trackCurrency: false, subledgerKind: null, isActive: true },
    { id: 2, code: '1111', name: 'VND', parentId: 1, isGroup: false, normalBalance: 'debit', trackCurrency: false, subledgerKind: 'cash', isActive: true }]),
}));

describe('buildTree', () => {
  it('xếp tài khoản con dưới cha', () => {
    const t = buildTree([
      { id: 1, code: '111', name: 'Tiền mặt', parentId: null, isGroup: true, normalBalance: 'debit', trackCurrency: false, subledgerKind: null, isActive: true },
      { id: 2, code: '1111', name: 'VND', parentId: 1, isGroup: false, normalBalance: 'debit', trackCurrency: false, subledgerKind: 'cash', isActive: true },
      { id: 3, code: '131', name: 'Phải thu', parentId: null, isGroup: false, normalBalance: 'both', trackCurrency: false, subledgerKind: 'receivable', isActive: true }]);
    expect(t).toHaveLength(2); expect(t[0]!.children![0]!.code).toBe('1111'); expect(t[1]!.children).toBeUndefined();
  });
});

describe('filterTree', () => {
  const tree = buildTree([
    { id: 1, code: '111', name: 'Tiền mặt', parentId: null, isGroup: true, normalBalance: 'debit', trackCurrency: false, subledgerKind: null, isActive: true },
    { id: 2, code: '1111', name: 'Tiền Việt Nam', parentId: 1, isGroup: false, normalBalance: 'debit', trackCurrency: false, subledgerKind: 'cash', isActive: true },
    { id: 3, code: '131', name: 'Phải thu của khách hàng', parentId: null, isGroup: false, normalBalance: 'both', trackCurrency: false, subledgerKind: 'receivable', isActive: true },
  ]);

  it('lọc theo đầu số hiệu tài khoản và mở nhánh cha', () => {
    const res = filterTree(tree, '111');
    expect(res.filtered).toHaveLength(1);
    expect(res.filtered[0]!.code).toBe('111');
    expect(res.filtered[0]!.children).toHaveLength(1);
    expect(res.filtered[0]!.children![0]!.code).toBe('1111');
    expect(res.expandedKeys).toContain(1);
  });

  it('lọc theo tên không dấu và mở nhánh cha', () => {
    const res = filterTree(tree, 'viet nam');
    expect(res.filtered).toHaveLength(1);
    expect(res.filtered[0]!.code).toBe('111');
    expect(res.filtered[0]!.children![0]!.code).toBe('1111');
    expect(res.expandedKeys).toContain(1);
  });

  it('chuỗi tìm kiếm rỗng thì giữ nguyên cây và không bắt buộc mở nhánh', () => {
    const res = filterTree(tree, '  ');
    expect(res.filtered).toBe(tree);
    expect(res.expandedKeys).toHaveLength(0);
  });
});

describe('Màn hình hệ thống tài khoản', () => {
  it('nạp tài khoản theo chế độ của năm tài chính mới nhất, hiện cây và mở rộng ra tài khoản con', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AccountsPage /></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'Hệ thống tài khoản' })).toBeInTheDocument();
    expect(await screen.findByText('Tiền mặt')).toBeInTheDocument();
    expect(screen.getByText('Tổng hợp')).toBeInTheDocument();
    expect(screen.queryByText('VND')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(await screen.findByText('VND')).toBeInTheDocument();
  });

  it('thao tác trên dòng là nút (tới được bằng Tab), không phải liên kết trần', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AccountsPage /></QueryClientProvider>);
    await screen.findByText('Tiền mặt');
    for (const name of ['Thêm tiểu khoản', 'Đổi số hiệu']) expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Ghép' })).not.toBeInTheDocument(); // 111 là tài khoản tổng hợp: chưa mở rộng thì chưa có dòng 1111
  });

  it('tìm kiếm bằng ô tìm kiếm lọc cây và tự mở nhánh khớp', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AccountsPage /></QueryClientProvider>);
    await screen.findByText('Tiền mặt');
    const searchInput = screen.getByPlaceholderText('Tìm số hiệu, tên…');
    await userEvent.type(searchInput, '111');
    expect(await screen.findByText('VND')).toBeInTheDocument();
  });
});
