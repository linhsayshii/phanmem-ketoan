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
  { id: 's1', regime: 'TT200', stepOrder: 1, name: 'Kết chuyển doanh thu', mode: 'transfer', fromAccounts: ['511', '515'], toAccount: '911', keepBalance: '0', byDimension: null, ratioSource: null, runAt: 'period_end', isActive: true },
  { id: 's2', regime: 'TT200', stepOrder: 2, name: 'Phân bổ chi phí trả trước', mode: 'allocate', fromAccounts: ['242'], toAccount: null, keepBalance: '0', byDimension: null, runAt: 'period_end', isActive: true,
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
      if (path.startsWith('/api/closing/steps?') && !init) return STEPS;
      if (path.startsWith('/api/closing/runs')) return RUNS;
      if (path === '/api/closing/run-all') return { steps: [{ stepId: 's1', voucherIds: ['a', 'b'] }, { stepId: 's2', voucherIds: [] }] };
      return init?.method === 'PUT' ? { ok: true } : { voucherIds: ['a'] };
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('hiện bước (đích hoặc tỷ lệ phân bổ) và nhật ký chạy, bước đã xóa vẫn có tên', async () => {
    renderPage();
    expect(await screen.findByText('Phân bổ chi phí trả trước')).toBeInTheDocument();
    expect(screen.getByText('Sơ đồ TT200')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(`/api/closing/steps?date=${endOfMonth}`);
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
    // findBy: nút còn loading (tên có thêm "loading") tới khi lần chạy trước trả về
    await userEvent.click(await screen.findByRole('button', { name: 'Chạy tất cả bước cuối kỳ' }));
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

  it('Chạy lại: hộp xác nhận nhắc các bước sau không tự chạy lại; kết quả có laterStepsDone thì hiện cảnh báo liệt kê tên bước', async () => {
    perms.has = (c) => c !== 'closing_step.update';
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith('/api/closing/steps?') && !init) return STEPS;
      if (path.startsWith('/api/closing/runs')) return RUNS;
      return { voucherIds: ['a'], laterStepsDone: ['Phân bổ chi phí trả trước', 'Kết chuyển lãi lỗ'] };
    });
    renderPage();
    await screen.findByText('Phân bổ chi phí trả trước');
    await userEvent.click(screen.getAllByRole('button', { name: 'Chạy lại (đảo cũ)' })[0]!);
    expect(await screen.findByText(/Các bước sau của sơ đồ đã chạy cùng ngày không tự chạy lại/)).toBeInTheDocument();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Đảo và chạy lại' })).at(-1)!);
    expect(await screen.findByText('Các bước sau đã chạy trước đó: Phân bổ chi phí trả trước, Kết chuyển lãi lỗ; hãy chạy lại các bước này hoặc Chạy tất cả')).toBeInTheDocument();
  }, 30_000);

  it('Chạy lại không có bước sau nào đã chạy thì không hiện cảnh báo; Nạp lại mẫu không ghi cứng số bước', async () => {
    renderPage(); // mặc định: { voucherIds: ['a'] }
    await screen.findByText('Phân bổ chi phí trả trước');
    await userEvent.click(screen.getAllByRole('button', { name: 'Chạy lại (đảo cũ)' })[0]!);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Đảo và chạy lại' })).at(-1)!);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/rerun', expect.anything()));
    expect(screen.queryByText(/Các bước sau đã chạy trước đó/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Nạp lại mẫu' }));
    expect(await screen.findByText(/hiện tại bị thay bằng sơ đồ mẫu/)).toBeInTheDocument();
    expect(screen.queryByText(/5 bước/)).toBeNull();
  }, 60_000); // dựng cả biểu mẫu sơ đồ: truy vấn role chậm trên máy 2 CPU

  it('lưu sơ đồ: bước chuyển có TK đích, bước phân bổ gửi ratioSource và toAccount null, giữ mã bước; tổng tỷ lệ khác 100 bị chặn', async () => {
    renderPage();
    const save = await screen.findByRole('button', { name: 'Lưu sơ đồ' });
    await userEvent.click(save);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/steps', { method: 'PUT', json: { steps: [
      { id: 's1', stepOrder: 1, name: 'Kết chuyển doanh thu', mode: 'transfer', fromAccounts: ['511', '515'], toAccount: '911', keepBalance: '0', byDimension: null, ratioSource: null, runAt: 'period_end', isActive: true },
      { id: 's2', stepOrder: 2, name: 'Phân bổ chi phí trả trước', mode: 'allocate', fromAccounts: ['242'], toAccount: null, keepBalance: '0', byDimension: null, runAt: 'period_end', isActive: true,
        ratioSource: { ratios: [{ account: '6421', percent: '60' }, { account: '6422', percent: '40' }] } }], date: endOfMonth } }));
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
  it('đổi ngày kết chuyển khi sơ đồ đang sửa dở: hỏi trước; Ở lại giữ ngày và phần đã nhập, Tiếp tục nạp sơ đồ của ngày mới', async () => {
    renderPage();
    const name = (await screen.findAllByDisplayValue('Kết chuyển doanh thu'))[0]!;
    await userEvent.clear(name); await userEvent.type(name, 'Kết chuyển doanh thu sửa dở');
    const picker = document.querySelector<HTMLInputElement>('.ant-picker input')!;
    const newDay = dayjs().endOf('month').subtract(1, 'month').endOf('month');
    await userEvent.clear(picker); await userEvent.type(picker, `${newDay.format('DD/MM/YYYY')}{Enter}`);
    expect(await screen.findByText('Bỏ thay đổi chưa lưu?', { selector: '.ant-modal-confirm-title' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ở lại' }));
    expect(screen.getByDisplayValue('Kết chuyển doanh thu sửa dở')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith(`/api/closing/steps?date=${newDay.format('YYYY-MM-DD')}`);
    await userEvent.clear(picker); await userEvent.type(picker, `${newDay.format('DD/MM/YYYY')}{Enter}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Tiếp tục' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/api/closing/steps?date=${newDay.format('YYYY-MM-DD')}`));
  }, 60_000);

  it('sửa sơ đồ rồi lưu xong: đổi ngày không còn hỏi, kể cả khi máy chủ trả lại đúng dữ liệu cũ', async () => {
    renderPage();
    const name = (await screen.findAllByDisplayValue('Kết chuyển doanh thu'))[0]!;
    await userEvent.clear(name); await userEvent.type(name, 'Kết chuyển doanh thu sửa');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu sơ đồ' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/closing/steps', expect.objectContaining({ method: 'PUT' })));
    expect(await screen.findByText('Đã lưu sơ đồ')).toBeInTheDocument();
    const picker = document.querySelector<HTMLInputElement>('.ant-picker input')!;
    const newDay = dayjs().endOf('month').subtract(1, 'month').endOf('month');
    await userEvent.clear(picker); await userEvent.type(picker, `${newDay.format('DD/MM/YYYY')}{Enter}`);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/api/closing/steps?date=${newDay.format('YYYY-MM-DD')}`));
    expect(screen.queryByText('Bỏ thay đổi chưa lưu?', { selector: '.ant-modal-confirm-title' })).not.toBeInTheDocument();
  }, 60_000);

  it('đổi ngày khi chưa sửa gì: đổi ngay, không hỏi', async () => {
    renderPage();
    await screen.findAllByDisplayValue('Kết chuyển doanh thu');
    const picker = document.querySelector<HTMLInputElement>('.ant-picker input')!;
    const newDay = dayjs().endOf('month').subtract(1, 'month').endOf('month');
    await userEvent.clear(picker); await userEvent.type(picker, `${newDay.format('DD/MM/YYYY')}{Enter}`);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/api/closing/steps?date=${newDay.format('YYYY-MM-DD')}`));
    expect(screen.queryByText('Bỏ thay đổi chưa lưu?', { selector: '.ant-modal-confirm-title' })).not.toBeInTheDocument();
  }, 60_000);
});
