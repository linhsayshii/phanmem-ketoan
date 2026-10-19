import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { message } from 'antd';
import AuditLogPage, { diffJson } from '../src/pages/AuditLog.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { tenantId: 't1', userId: 'u1' }, can: () => true }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

describe('diffJson', () => {
  it('chỉ liệt kê khóa thay đổi', () => {
    expect(diffJson({ name: 'A', code: 'X' }, { name: 'B', code: 'X' })).toEqual([{ key: 'name', before: 'A', after: 'B' }]);
    expect(diffJson(null, { name: 'A' })).toEqual([{ key: 'name', before: undefined, after: 'A' }]);
  });
});

describe('Màn hình nhật ký kiểm toán', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuditLogPage /></QueryClientProvider>);
  beforeEach(() => {
    // bộ lọc nhớ trên máy chủ: có bản lưu (bản 404 sẽ chạm localStorage, Node 26 in cảnh báo thử nghiệm)
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ value: { entity: 'department' } }) })));
    apiMock.mockImplementation(async (path: string) => path.startsWith('/api/audit/logins')
      ? { rows: [{ ts: '2026-10-20 12:00:00+00', username: 'kt1', success: false, ip: '1.2.3.4' }], total: 1 }
      : { rows: [{ id: 1, ts: '2026-10-20 12:00:00+00', username: 'kt1', action: 'update', entity: 'department', entityId: '7', before: { name: 'Hành chính', code: 'HC' }, after: { name: 'Hành chính nhân sự', code: 'HC' }, ip: null }], total: 1 });
  });
  // không dùng vi.restoreAllMocks: nó xóa cả bản giả matchMedia của vitest.setup
  afterEach(() => { vi.unstubAllGlobals(); apiMock.mockReset(); });

  it('hiện dòng nhật ký với hành động tiếng Việt và chỉ các khóa thay đổi', async () => {
    renderPage();
    expect(await screen.findByText('Sửa')).toBeInTheDocument();
    expect(screen.getByText('department')).toBeInTheDocument();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('entity=department')));
    expect(screen.getByText('20/10/2026', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('name').closest('li')).toHaveTextContent('name: "Hành chính" → "Hành chính nhân sự"');
    expect(screen.queryByText('code')).not.toBeInTheDocument();
  });

  it('tab đăng nhập hiện kết quả thất bại', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhật ký đăng nhập' }));
    expect(await screen.findByText('Thất bại')).toBeInTheDocument();
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
  });

  it('báo lỗi API bằng message.error', async () => {
    const err = vi.spyOn(message, 'error').mockImplementation((() => undefined) as never);
    apiMock.mockRejectedValue(new Error('Không có quyền'));
    renderPage();
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('Không có quyền'));
    err.mockRestore();
  });
});
