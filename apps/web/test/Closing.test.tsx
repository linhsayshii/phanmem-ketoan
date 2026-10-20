import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dayjs from 'dayjs';
import ClosingPage from '../src/pages/Closing.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c) }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const STEPS = [
  { id: 's1', stepOrder: 1, name: 'Kết chuyển doanh thu', mode: 'transfer', fromAccounts: ['511', '515'], toAccount: '911', keepBalance: '0', byDimension: null, ratioSource: null, runAt: 'period_end', isActive: true },
  { id: 's2', stepOrder: 2, name: 'Phân bổ chi phí trả trước', mode: 'allocate', fromAccounts: ['242'], toAccount: null, keepBalance: '0', byDimension: null, runAt: 'period_end', isActive: true,
    ratioSource: { ratios: [{ account: '6421', percent: '60' }, { account: '6422', percent: '40' }] } },
];
const RUNS = [{ id: 2, stepName: 'Bước đã xóa', postingDate: '2026-12-31', voucherNo: 'KC00001', voucherId: 'v1', status: 'reversed', createdAt: '2027-01-02T03:04:05Z' }];
const posts = () => apiMock.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PUT');

describe('Màn hình kết chuyển cuối kỳ', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ClosingPage /></QueryClientProvider>);
  const endOfMonth = dayjs().endOf('month').format('YYYY-MM-DD');
  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/closing/steps' && !init) return STEPS;
      if (path.startsWith('/api/closing/runs')) return RUNS;
      if (path === '/api/closing/run-all') return { steps: [{ stepId: 's1', voucherIds: ['a', 'b'] }, { stepId: 's2', voucherIds: [] }] };
      return init?.method === 'PUT' ? { ok: true } : { voucherIds: ['a'] };
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('hiện bước (đích hoặc tỷ lệ phân bổ) và nhật ký chạy, bước đã xóa vẫn có tên', async () => {
    renderPage();
    expect(await screen.findByText('Phân bổ chi phí trả trước')).toBeInTheDocument();
    expect(screen.getByText('511, 515')).toBeInTheDocument();
    expect(screen.getByText('6421 60%, 6422 40%')).toBeInTheDocument();
    expect(await screen.findByText('Bước đã xóa')).toBeInTheDocument();
    expect(screen.getByText('KC00001')).toBeInTheDocument();
    expect(screen.getByText('Đã đảo')).toBeInTheDocument();
  });

  it('Chạy một bước và Chạy tất cả gửi đúng bước, ngày kết chuyển', async () => {
    perms.has = (c) => c !== 'closing_step.update'; // không dựng biểu mẫu sơ đồ: DOM nhỏ thì truy vấn role nhanh
    renderPage();
    await screen.findByText('Phân bổ chi phí trả trước');
    await userEvent.click(screen.getAllByRole('button', { name: 'Chạy' })[1]!);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/run', { method: 'POST', json: { stepId: 's2', postingDate: endOfMonth } }));
    await userEvent.click(screen.getByRole('button', { name: 'Chạy tất cả bước cuối kỳ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Chạy tất cả' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/run-all', { method: 'POST', json: { postingDate: endOfMonth } }));
  }, 30_000);

  it('Chạy lại hỏi xác nhận rồi gọi rerun', async () => {
    perms.has = (c) => c !== 'closing_step.update';
    renderPage();
    await screen.findByText('Phân bổ chi phí trả trước');
    await userEvent.click(screen.getAllByRole('button', { name: 'Chạy lại (đảo cũ)' })[0]!);
    expect(posts()).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Đảo và chạy lại' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/rerun', { method: 'POST', json: { stepId: 's1', postingDate: endOfMonth } }));
  }, 30_000);

  it('lưu sơ đồ: bước chuyển có TK đích, bước phân bổ gửi ratioSource và toAccount null, giữ mã bước; tổng tỷ lệ khác 100 bị chặn', async () => {
    renderPage();
    const save = await screen.findByRole('button', { name: 'Lưu sơ đồ' });
    await userEvent.click(save);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/steps', { method: 'PUT', json: { steps: [
      { id: 's1', stepOrder: 1, name: 'Kết chuyển doanh thu', mode: 'transfer', fromAccounts: ['511', '515'], toAccount: '911', keepBalance: '0', byDimension: null, ratioSource: null, runAt: 'period_end', isActive: true },
      { id: 's2', stepOrder: 2, name: 'Phân bổ chi phí trả trước', mode: 'allocate', fromAccounts: ['242'], toAccount: null, keepBalance: '0', byDimension: null, runAt: 'period_end', isActive: true,
        ratioSource: { ratios: [{ account: '6421', percent: '60' }, { account: '6422', percent: '40' }] } }] } }));
    apiMock.mockClear();
    const percent = screen.getAllByPlaceholderText('Tỷ lệ')[1]!; // 40
    await userEvent.clear(percent); await userEvent.type(percent, '30');
    await userEvent.click(save);
    expect(await screen.findByText(/tổng tỷ lệ phân bổ phải bằng 100%/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  }, 30_000);

  it('không có quyền chạy thì ẩn nút chạy; không có quyền sửa sơ đồ thì ẩn thẻ Sơ đồ', async () => {
    perms.has = (c) => c !== 'closing.run' && c !== 'closing_step.update';
    renderPage();
    const table = (await screen.findByText('Phân bổ chi phí trả trước')).closest('table')!;
    expect(within(table).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chạy tất cả bước cuối kỳ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lưu sơ đồ' })).toBeNull();
  });
});
