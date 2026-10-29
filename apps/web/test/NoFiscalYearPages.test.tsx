import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import AccountsPage from '../src/pages/Accounts.js';
import AmortizationPage from '../src/pages/Amortization.js';
import AnalyticsPage from '../src/pages/Analytics.js';
import AssetOpeningPage from '../src/pages/AssetOpening.js';
import CostReportsPage from '../src/pages/CostReports.js';
import CostRunsPage from '../src/pages/CostRuns.js';
import CostingRunPage from '../src/pages/CostingRun.js';
import OpeningBalancePage from '../src/pages/OpeningBalance.js';
import OpeningStockPage from '../src/pages/OpeningStock.js';
import PeriodClosePage from '../src/pages/PeriodClose.js';
import ProjectAllocPage from '../src/pages/ProjectAlloc.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), navigate: vi.fn(), perms: { has: (_c: string): boolean => true } }));
vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: class extends Error {} }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => mocks.perms.has(c), me: { tenantId: 1, userId: 1, sensitive: ['view_cost'] } }) }));
vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<object>()), useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@kt/ui', async (orig) => ({ ...(await orig<object>()), KeyboardGrid: () => null, LookupSelect: () => null }));
vi.mock('../src/pages/charts.js', () => ({ Chart: () => null }));

// Công ty chưa có năm tài chính: mỗi trang cần chọn năm phải nói rõ vì sao trống và chỉ cách làm, thay vì bảng/ô chọn trống.
const PAGES: [string, ComponentType, RegExp][] = [
  ['Hệ thống tài khoản', AccountsPage, /xem hệ thống tài khoản/],
  ['Phân bổ khấu hao, chi phí trả trước', AmortizationPage, /chạy phân bổ/],
  ['Phân tích tài chính', AnalyticsPage, /xem phân tích tài chính/],
  ['Số dư đầu kỳ tài sản', AssetOpeningPage, /thẻ tài sản đầu kỳ/],
  ['Báo cáo giá thành', CostReportsPage, /xem báo cáo giá thành/],
  ['Chạy giá thành', CostRunsPage, /chạy giá thành/],
  ['Tính giá vốn', CostingRunPage, /tính giá vốn/],
  ['Số dư đầu kỳ', OpeningBalancePage, /nhập số dư đầu kỳ/],
  ['Tồn kho đầu kỳ', OpeningStockPage, /nhập tồn kho đầu kỳ/],
  ['Khóa kỳ (quy trình cuối kỳ)', PeriodClosePage, /chạy quy trình khóa kỳ/],
  ['Phân bổ dự án', ProjectAllocPage, /phân bổ chi phí cho vụ việc/],
];

describe('Công ty chưa có năm tài chính', () => {
  const renderPage = (Page: ComponentType) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Page /></QueryClientProvider>);
  beforeEach(() => {
    mocks.perms.has = () => true;
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? [] : []));
  });
  afterEach(() => { cleanup(); mocks.api.mockReset(); mocks.navigate.mockReset(); });

  it.each(PAGES)('%s: báo chưa có năm, chỉ vào Kỳ kế toán để thêm', async (_name, Page, purpose) => {
    renderPage(Page);
    expect(await screen.findByText('Công ty chưa có năm tài chính')).toBeInTheDocument();
    expect(screen.getByText(purpose)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thêm năm tài chính' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/so-cai/ky-ke-toan' });
  });

  it.each(PAGES)('%s: thiếu quyền period.create thì dặn liên hệ quản trị, không có nút', async (_name, Page) => {
    mocks.perms.has = (c) => c !== 'period.create';
    renderPage(Page);
    expect(await screen.findByText('Công ty chưa có năm tài chính')).toBeInTheDocument();
    expect(screen.getByText(/liên hệ quản trị viên/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm năm tài chính' })).not.toBeInTheDocument();
  });

  it('có năm tài chính thì không hiện thông báo trống', async () => {
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? [{ fiscalYear: 2026, regime: 'TT133', dateFrom: '2026-01-01', dateTo: '2026-12-31', periods: [] }] : []));
    renderPage(OpeningBalancePage);
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/opening-balance/2026'));
    expect(screen.queryByText('Công ty chưa có năm tài chính')).not.toBeInTheDocument();
  });
});
