import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ApprovalDelegationsPage from '../src/pages/ApprovalDelegations.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c), me: { userId: 'u1' } }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const d = (id: number, status: string, extra: object = {}) => ({ id, delegatorId: 'u1', delegator: 'ktt', delegateId: 'u2', delegate: 'kv2', dateFrom: '2026-10-28', dateTo: '2026-10-30', reason: 'Đi công tác', status, ...extra });

describe('Màn hình ủy quyền duyệt', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApprovalDelegationsPage /></QueryClientProvider>);
  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.startsWith('/api/approval-delegations?scope=')) return [d(1, 'active'), d(2, 'expired'), d(3, 'active', { delegatorId: 'u9', delegator: 'khac' })];
      if (path === '/api/approval-delegations/candidates') return [{ id: 'u2', username: 'kv2', fullName: 'Kế toán viên 2' }];
      if (opts?.method === 'POST') return { ok: true };
      return {};
    });
  });
  afterEach(() => { cleanup(); apiMock.mockReset(); });

  it('hiện trạng thái và chỉ cho thu hồi ủy quyền còn hiệu lực của chính mình (hoặc quản trị)', async () => {
    perms.has = (c) => c === 'approval_request.approve';
    renderPage();
    expect(await screen.findByText('Hết hạn')).toBeInTheDocument();
    expect(screen.getAllByText('Đang hiệu lực')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Thu hồi ủy quyền cho/ })).toHaveLength(1); // dòng của người khác và dòng hết hạn không có nút
  });

  it('thu hồi gọi API thu hồi', async () => {
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /Thu hồi ủy quyền cho/ }))[0]!);
    await userEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: 'Thu hồi' }));
    expect(apiMock).toHaveBeenCalledWith('/api/approval-delegations/1/revoke', { method: 'POST', json: {} });
  });

  it('thiếu quyền duyệt thì báo, không gọi API', () => {
    perms.has = () => false;
    renderPage();
    expect(screen.getByText('Cần quyền duyệt đề nghị để lập ủy quyền duyệt')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
