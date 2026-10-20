import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookSetModal } from '../src/pages/Ledgers.js';

const apiMock = vi.hoisted(() => vi.fn());
const me = vi.hoisted(() => ({ sensitive: [] as string[] }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: me.sensitive }, can: () => true }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

describe('In cả bộ sổ năm', () => {
  const fetchMock = vi.fn();
  const renderModal = async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BookSetModal open onClose={vi.fn()} /></QueryClientProvider>);
    await screen.findByText('Năm 2026 (TT133)'); // năm tài chính đã tải xong
  };
  const sent = () => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { fiscalYear: number; include: string[]; format: string };
  beforeEach(() => {
    apiMock.mockResolvedValue([{ fiscalYear: 2026, regime: 'TT133' }]);
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn(); // jsdom chưa hỗ trợ điều hướng/tải tệp
  });
  afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); apiMock.mockReset(); });

  it('người thiếu cờ nhạy cảm: Nhật ký chung và Sổ Cái bị khóa, không được tích và không gửi lên (tránh 403)', async () => {
    me.sensitive = ['view_cost'];
    await renderModal();
    for (const name of ['Sổ Nhật ký chung', 'Sổ Cái (mọi tài khoản có số liệu)']) {
      const box = screen.getByRole('checkbox', { name }); expect(box).toBeDisabled(); expect(box).not.toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: 'Bảng cân đối số phát sinh' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'In' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent()).toEqual({ fiscalYear: 2026, include: ['trial'], format: 'pdf' });
  });

  it('người thiếu cờ bỏ tích mục còn lại thì không còn gì để in: nút In bị khóa', async () => {
    me.sensitive = [];
    await renderModal();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bảng cân đối số phát sinh' }));
    expect(screen.getByRole('button', { name: 'In' })).toBeDisabled();
  });

  it('người đủ ba cờ: gửi cả Nhật ký chung, Sổ Cái; tải xong mới thu hồi đường dẫn tạm', async () => {
    me.sensitive = ['view_receivable', 'view_payable', 'view_cost'];
    await renderModal();
    expect(screen.getByRole('checkbox', { name: 'Sổ Nhật ký chung' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'In' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().include).toEqual(['journal', 'ledgers', 'trial']);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x'));
  });
});
