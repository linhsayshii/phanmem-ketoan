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
});
