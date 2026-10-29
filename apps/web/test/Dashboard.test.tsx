import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../src/pages/Dashboard.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('../src/auth.js', () => ({
  useAuth: () => ({ can: (c: string) => perms.has(c) }),
}));

vi.mock('../src/api/client.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: apiMock,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
}));

const OVERVIEW = {
  fiscalYear: 2026,
  month: 10,
  regime: 'TT133',
  hidden: [],
  months: [
    { month: 1, dateTo: '2026-01-31', revenue: '100000000', expense: '80000000', profit: '20000000', cash: '50000000', receivable: '30000000', payable: '25000000' },
  ],
  summary: {
    revenue: '100000000',
    expense: '80000000',
    profit: '20000000',
    cash: '50000000',
    receivable: '30000000',
    payable: '25000000',
  },
};

describe('DashboardPage', () => {
  const renderPage = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DashboardPage />
      </QueryClientProvider>,
    );

  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026 }];
      if (path.startsWith('/api/analytics/overview')) return OVERVIEW;
      if (path.startsWith('/api/approvals/inbox/count')) return { count: 3 };
      if (path.startsWith('/api/vouchers')) {
        return {
          total: 2,
          rows: [
            { id: 'v1', voucherType: 'PT', voucherNo: 'PT00001', postingDate: '2026-10-15', state: 'draft', description: 'Thu tiền bán hàng', partyName: 'Khách A', totalDebit: '10000000' },
            { id: 'v2', voucherType: 'PC', voucherNo: null, postingDate: '2026-10-20', state: 'draft', description: 'Chi tạm ứng', partyName: 'Nhân viên B', totalDebit: '5000000' },
          ],
        };
      }
      throw new Error('không mô phỏng ' + path);
    });
  });

  afterEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
  });

  it('render đầy đủ đầu trang, hàng số liệu, biểu đồ và khối việc cần làm', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Tổng quan' })).toBeDefined();
    expect(await screen.findByText('Tiền cuối tháng')).toBeDefined();
    expect(await screen.findByTestId('stat-cash')).toBeDefined();
    expect(await screen.findByTestId('chart-dashboard')).toBeDefined();
    expect(await screen.findByText('Việc cần làm')).toBeDefined();
    expect(await screen.findByText('PT PT00001')).toBeDefined();
    expect(await screen.findByText('PC (nháp)')).toBeDefined();
    expect(screen.getByRole('button', { name: /Lập chứng từ/ })).toBeDefined();
  });

  it('khi không có năm tài chính thì hiện thông báo chung hướng dẫn thêm năm tài chính', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [];
      if (path.startsWith('/api/approvals/inbox/count')) return { count: 0 };
      if (path.startsWith('/api/vouchers')) return { total: 0, rows: [] };
      return {};
    });
    renderPage();
    expect(await screen.findByText('Công ty chưa có năm tài chính')).toBeDefined();
    expect(screen.getByText(/xem số liệu tổng quan/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Thêm năm tài chính' })).toBeDefined();
  });

  it('khi không có quyền report.view thì ẩn hàng số liệu và biểu đồ', async () => {
    perms.has = (c: string) => c !== 'report.view';
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Tổng quan' })).toBeDefined();
    expect(screen.queryByTestId('stat-cash')).toBeNull();
    expect(screen.queryByTestId('chart-dashboard')).toBeNull();
    expect(await screen.findByText('Việc cần làm')).toBeDefined();
  });

  it('khi không có quyền voucher.view thì ẩn dòng chứng từ nháp trong tháng', async () => {
    perms.has = (c: string) => c !== 'voucher.view';
    renderPage();
    expect(await screen.findByText('Việc cần làm')).toBeDefined();
    expect(screen.queryByText('Chứng từ nháp trong tháng')).toBeNull();
    expect(screen.queryByText('PT PT00001')).toBeNull();
  });

  it('khi có hơn 5 chứng từ nháp thì hiện thông báo số lượng còn lại', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026 }];
      if (path.startsWith('/api/analytics/overview')) return OVERVIEW;
      if (path.startsWith('/api/approvals/inbox/count')) return { count: 0 };
      if (path.startsWith('/api/vouchers')) {
        return {
          total: 8,
          rows: [
            { id: 'v1', voucherType: 'PT', voucherNo: 'PT01', postingDate: '2026-10-01', state: 'draft', description: 'D1', partyName: null, totalDebit: '1000' },
            { id: 'v2', voucherType: 'PT', voucherNo: 'PT02', postingDate: '2026-10-02', state: 'draft', description: 'D2', partyName: null, totalDebit: '1000' },
            { id: 'v3', voucherType: 'PT', voucherNo: 'PT03', postingDate: '2026-10-03', state: 'draft', description: 'D3', partyName: null, totalDebit: '1000' },
            { id: 'v4', voucherType: 'PT', voucherNo: 'PT04', postingDate: '2026-10-04', state: 'draft', description: 'D4', partyName: null, totalDebit: '1000' },
            { id: 'v5', voucherType: 'PT', voucherNo: 'PT05', postingDate: '2026-10-05', state: 'draft', description: 'D5', partyName: null, totalDebit: '1000' },
          ],
        };
      }
      return {};
    });
    renderPage();
    expect(await screen.findByText('Còn 3 chứng từ nháp khác')).toBeDefined();
    expect(screen.queryByRole('link', { name: /Xem tất cả/ })).toBeNull();
  });

  it('khi tải chứng từ nháp lỗi thì hiện Alert báo lỗi', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026 }];
      if (path.startsWith('/api/analytics/overview')) return OVERVIEW;
      if (path.startsWith('/api/approvals/inbox/count')) return { count: 0 };
      if (path.startsWith('/api/vouchers')) {
        throw new Error('Lỗi máy chủ');
      }
      return {};
    });
    renderPage();
    expect(await screen.findByText('Lỗi máy chủ')).toBeDefined();
    expect(screen.queryByText('Chứng từ nháp trong tháng')).toBeNull();
  });
});
