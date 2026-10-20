import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExportPage from '../src/pages/Export.js';

const me = vi.hoisted(() => ({ sensitive: [] as string[] }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: me.sensitive }, can: () => true }) }));

describe('Xuất dữ liệu cho cơ quan thẩm quyền', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn(); // jsdom chưa hỗ trợ điều hướng/tải tệp
  });
  afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

  it('người thiếu cờ nhạy cảm: báo cờ còn thiếu và khóa nút xuất (tránh 403)', () => {
    me.sensitive = ['view_receivable'];
    render(<ExportPage />);
    expect(screen.getByText(/còn thiếu: view_payable, view_cost/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xuất gói dữ liệu' })).toBeDisabled();
  });

  it('người đủ ba cờ: gửi khoảng ngày lên máy chủ, tải xong mới thu hồi đường dẫn tạm', async () => {
    me.sensitive = ['view_receivable', 'view_payable', 'view_cost'];
    render(<ExportPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Xuất gói dữ liệu' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect([url, init.method]).toEqual(['/api/export/authority', 'POST']);
    expect(JSON.parse(init.body)).toEqual({ from: expect.stringMatching(/^\d{4}-01-01$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x'));
  });
});
