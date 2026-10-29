import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { message } from 'antd';
import PeriodsPage from '../src/pages/Periods.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c) }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const row = (periodNo: number, status: string, extra: object = {}) => ({ fiscalYear: 2026, periodNo, dateFrom: '2026-01-01', dateTo: '2026-01-31', regime: 'TT133', status, lockedModules: [], hashTail: null, lockedAt: null, draftCount: 0, ...extra });

describe('Màn hình kỳ kế toán', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PeriodsPage /></QueryClientProvider>);
  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026 }];
      if (path === '/api/periods?year=2026') return [row(1, 'open', { draftCount: 2 }), row(2, 'hard_locked', { hashTail: 'ab12cd34ef56'.repeat(5) })];
      return { total: 3, mismatched: [] };
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('hiện trạng thái, 8 ký tự đầu của hash và nút theo trạng thái kỳ', async () => {
    renderPage();
    expect(await screen.findByText('Khóa cứng', { selector: '.ant-tag' })).toBeInTheDocument();
    expect(screen.getByText('ab12cd34')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Khóa sổ' })).toHaveLength(1); // chỉ kỳ mở
    expect(screen.getAllByRole('button', { name: 'Kiểm tra hash' })).toHaveLength(1); // chỉ kỳ khóa cứng
  });

  it('bỏ khóa kỳ khóa cứng cần cả period.unlock và period.unlock_hard', async () => {
    const unlockButtons = async (can: (c: string) => boolean) => { perms.has = can; renderPage(); await screen.findByText('ab12cd34'); const n = screen.queryAllByRole('button', { name: 'Bỏ khóa' }).length; cleanup(); return n; };
    expect(await unlockButtons((c) => c !== 'period.unlock_hard')).toBe(0);
    expect(await unlockButtons((c) => c !== 'period.unlock')).toBe(0);
    expect(await unlockButtons(() => true)).toBe(1);
  });

  it('kiểm tra hash khớp báo số chứng từ', async () => {
    const ok = vi.spyOn(message, 'success').mockImplementation((() => undefined) as never);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Kiểm tra hash' }));
    await vi.waitFor(() => expect(ok).toHaveBeenCalledWith('Toàn bộ 3 chứng từ khớp'));
    expect(apiMock).toHaveBeenCalledWith('/api/periods/2026/2/verify-hash');
    ok.mockRestore();
  });

  it('kiểm tra hash lệch hiện bảng chứng từ lệch, chịu được dòng không có mã chứng từ (so hash_tail)', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026 }];
      if (path === '/api/periods?year=2026') return [row(2, 'hard_locked', { hashTail: 'ab12cd34ef56'.repeat(5) })];
      return { total: 1, mismatched: [{ voucherId: null, voucherNo: '(hash_tail)', stored: 'aa'.repeat(32), computed: 'bb'.repeat(32) }, { voucherId: 'v1', voucherNo: null, stored: null, computed: 'cc'.repeat(32) }] };
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Kiểm tra hash' }));
    expect(await screen.findByText('(hash_tail)')).toBeInTheDocument();
    expect(screen.getByText('(chưa số)')).toBeInTheDocument();
  });

  it('thẻ Loại chứng từ và đánh số: hiện số tiếp theo, sửa cấu hình và đánh lại số theo năm đang chọn', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026 }];
      if (path === '/api/periods?year=2026') return [];
      if (path === '/api/voucher-types') return [{ code: 'PKT', name: 'Phiếu kế toán', prefix: 'PKT{YY}-', suffix: '', pad_length: 4 }];
      if (path === '/api/voucher-types/PKT/next-no?year=2026') return { preview: 'PKT26-0005' };
      if (path === '/api/vouchers/renumber') return { count: 4 };
      return init?.method === 'PUT' ? { ok: true } : {};
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Loại chứng từ và đánh số' }));
    expect(await screen.findByText('PKT26-0005')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sửa' }));
    const prefix = await screen.findByLabelText('Tiền tố'); await userEvent.clear(prefix); await userEvent.type(prefix, 'PC');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/voucher-types/PKT', { method: 'PUT', json: { name: 'Phiếu kế toán', prefix: 'PC', suffix: '', padLength: 4 } }));
    await userEvent.click(screen.getByRole('button', { name: 'Đánh lại số theo ngày' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Đánh lại số' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/vouchers/renumber', { method: 'POST', json: { voucherType: 'PKT', fiscalYear: 2026 } }));
  }, 20000);
});

describe('Kỳ kế toán khi công ty chưa có năm tài chính', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PeriodsPage /></QueryClientProvider>);
  const posts = () => apiMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/fiscal-years' && init?.method === 'POST') return { periods: 12 };
      if (path === '/api/fiscal-years') return [];
      if (path === '/api/regimes') return [];
      throw new Error('không được gọi: ' + path);
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('báo tiếng Việt, không gọi API kỳ với năm trống, có nút Thêm năm tài chính', async () => {
    renderPage();
    expect(await screen.findByText('Công ty chưa có năm tài chính')).toBeInTheDocument();
    expect(screen.getByText(/^Cần có năm tài chính để mở, khóa sổ các kỳ kế toán\. Bấm "Thêm năm tài chính"/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Thêm năm tài chính' })[0]).toBeEnabled();
    expect(apiMock.mock.calls.every(([p]) => !String(p).startsWith('/api/periods'))).toBe(true);
  });

  it('Thêm năm tài chính gửi POST /api/fiscal-years với năm và ngày bắt đầu mặc định', async () => {
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Thêm năm tài chính' }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Tạo năm tài chính' }));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    const [path, init] = posts()[0]!;
    const year = new Date().getFullYear();
    expect(path).toBe('/api/fiscal-years');
    expect(init.json).toEqual({ fiscalYear: year, dateFrom: `${year}-01-01`, months: 12, regime: 'TT133' });
  });

  it('không có quyền period.create thì không có nút thêm', async () => {
    perms.has = (c) => c !== 'period.create';
    renderPage();
    await screen.findByText('Công ty chưa có năm tài chính');
    expect(screen.getByText(/liên hệ quản trị viên/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm năm tài chính' })).not.toBeInTheDocument();
  });
});
