import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AccountsPage, { buildTree } from '../src/pages/Accounts.js';

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

describe('Màn hình hệ thống tài khoản', () => {
  it('nạp tài khoản theo chế độ của năm tài chính mới nhất, hiện cây và mở rộng ra tài khoản con', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AccountsPage /></QueryClientProvider>);
    expect(await screen.findByText('Tiền mặt')).toBeInTheDocument();
    expect(screen.getByText('Tổng hợp')).toBeInTheDocument();
    expect(screen.queryByText('VND')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(await screen.findByText('VND')).toBeInTheDocument();
  });
});
