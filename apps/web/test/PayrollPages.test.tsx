import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PayrollRunsPage from '../src/pages/PayrollRuns.js';
import PayrollStructuresPage from '../src/pages/PayrollStructures.js';
import PayrollParamsPage from '../src/pages/PayrollParams.js';

const apiMock = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ sensitive: [] as string[], perms: new Set<string>() }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { tenantId: 't', userId: 'u', sensitive: auth.sensitive }, can: (c: string) => auth.perms.has(c) }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

const renderPage = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('màn hình lương', () => {
  beforeEach(() => { auth.sensitive = []; auth.perms = new Set(['payroll.view', 'payroll.update', 'payroll.create', 'payroll.param']); apiMock.mockImplementation(async () => []); });
  afterEach(() => { cleanup(); apiMock.mockReset(); });

  it('thiếu cờ xem lương: Bảng lương và Cấu trúc báo không có quyền và không gọi API', async () => {
    renderPage(<PayrollRunsPage />);
    expect(screen.getByText('Không có quyền xem lương')).toBeInTheDocument();
    cleanup(); renderPage(<PayrollStructuresPage />);
    expect(screen.getByText('Không có quyền xem lương')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('Tham số lương: banner nêu không có mặc định; hộp thoại thêm mới trống trơn và cảnh báo khi nguồn là dữ liệu minh họa', async () => {
    const { ApiError } = await import('../src/api/client.js');
    apiMock.mockImplementation(async (path: string) => { if (path.includes('/effective')) throw new ApiError('PAYROLL_PARAM_MISSING', 'thiếu', 409); return []; });
    renderPage(<PayrollParamsPage />);
    expect(screen.getByTestId('params-banner')).toHaveTextContent('Giá trị do người dùng nhập từ văn bản gốc; phần mềm không có mặc định.');
    expect((await screen.findAllByText('Chưa có')).length).toBeGreaterThan(0);

    await userEvent.click(screen.getAllByText('Nhập', { selector: 'a' })[0]!); // dòng đầu: biểu thuế lũy tiến
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Bậc 1 thuế suất')).toHaveValue('');
    expect(within(dialog).getByText('Không giới hạn')).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Nguồn văn bản'), 'Dữ liệu minh họa kiểm thử');
    expect(await within(dialog).findByText(/không phải văn bản pháp lý/)).toBeInTheDocument();
  });
});
