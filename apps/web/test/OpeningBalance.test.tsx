import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OpeningBalancePage from '../src/pages/OpeningBalance.js';

const mocks = vi.hoisted(() => {
  class ApiError extends Error { constructor(public code: string, message: string, public status = 409, public details?: unknown) { super(message); } }
  return { api: vi.fn(), ApiError, perms: { has: (_c: string): boolean => true }, grid: { columns: [] as { field?: string; editable?: unknown }[] } };
});
vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => mocks.perms.has(c) }) }));
// lưới AG Grid và ô tra danh mục nặng trong jsdom và không thuộc điều đang kiểm tra (nút theo quyền/trạng thái tải); đường nhập phím được kiểm bằng trình duyệt
vi.mock('@kt/ui', () => ({ KeyboardGrid: (p: { columns: { field?: string; editable?: unknown }[] }) => { mocks.grid.columns = p.columns; return null; }, LookupSelect: () => null }));

vi.setConfig({ testTimeout: 30_000 });
const years = [{ fiscalYear: 2026, regime: 'TT133', dateFrom: '2026-01-01' }];

describe('Màn hình Số dư đầu kỳ', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OpeningBalancePage /></QueryClientProvider>);
  const apiFor = (saved: () => Promise<unknown>) => mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : path === '/api/opening-balance/2026' ? saved() : []));
  beforeEach(() => { mocks.perms.has = () => true; });
  afterEach(() => { mocks.api.mockReset(); });

  it('người chỉ xem: Kiểm tra đọc thẳng bản đã lưu, không gửi PUT; không có Lưu, Ghi sổ, Nhập Excel', async () => {
    mocks.perms.has = (c) => c === 'opening_balance.view';
    apiFor(async () => []);
    renderPage();
    const check = await screen.findByRole('button', { name: 'Kiểm tra' });
    await waitFor(() => expect(check).toBeEnabled());
    await userEvent.click(check);
    expect(await screen.findByText('Số dư đầu kỳ hợp lệ')).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledWith('/api/opening-balance/2026/check');
    expect(mocks.api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PUT')).toHaveLength(0);
    for (const name of ['Lưu', 'Ghi sổ số dư đầu kỳ', 'Nhập Excel']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('Lưu, Kiểm tra, Ghi sổ, Nhập Excel bị khóa trong lúc tải số dư của năm và khi tải lỗi, mở khi đã tải xong', async () => {
    const buttons = () => ['Lưu', 'Kiểm tra', 'Ghi sổ số dư đầu kỳ', 'Nhập Excel'].map((name) => screen.getByRole('button', { name }));
    let done: ((v: unknown) => void) | undefined;
    apiFor(() => new Promise((r) => { done = r; }));
    renderPage();
    await waitFor(() => expect(done).toBeDefined()); // năm đã tải, yêu cầu số dư của năm đang treo
    for (const b of buttons()) expect(b).toBeDisabled();
    done!([]);
    await waitFor(() => { for (const b of buttons()) expect(b).toBeEnabled(); });
  });

  it('tải số dư lỗi thì giữ các nút khóa và hiện lỗi', async () => {
    apiFor(() => Promise.reject(new Error('Không tải được')));
    renderPage();
    expect(await screen.findByText('Không tải được')).toBeInTheDocument();
    for (const name of ['Lưu', 'Kiểm tra', 'Ghi sổ số dư đầu kỳ', 'Nhập Excel']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });
  // Chứng từ số dư đầu kỳ (loại DK) mang ngày hạch toán là ngày liền trước ngày đầu năm tài chính.
  const DK_QUERY = '/api/vouchers?type=DK&state=posted&from=2025-12-31&to=2025-12-31&size=1';
  const apiWithDk = (dk: { posted: boolean }) => mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === '/api/fiscal-years') return years;
    if (path === DK_QUERY) return { rows: dk.posted ? [{ id: 'dk1' }] : [], total: dk.posted ? 1 : 0 };
    if (init?.method === 'POST') { dk.posted = false; return { id: 'dk1', state: 'draft' }; }
    return [];
  });

  it('Bỏ ghi sổ số dư đầu kỳ: hỏi xác nhận rồi gọi unpost của năm; xong thì nút biến mất vì chứng từ không còn ghi sổ', async () => {
    apiWithDk({ posted: true });
    renderPage();
    const unpost = await screen.findByRole('button', { name: 'Bỏ ghi sổ số dư đầu kỳ' });
    await waitFor(() => expect(unpost).toBeEnabled());
    await userEvent.click(unpost);
    expect(mocks.api).not.toHaveBeenCalledWith('/api/opening-balance/2026/unpost', expect.anything());
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ghi sổ' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/opening-balance/2026/unpost', { method: 'POST', json: {} }));
    expect(await screen.findByText('Đã bỏ ghi sổ số dư đầu kỳ, sửa số dư rồi ghi sổ lại')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ số dư đầu kỳ' })).not.toBeInTheDocument());
  });

  it('chưa ghi sổ số dư đầu kỳ: không có nút Bỏ ghi sổ số dư đầu kỳ', async () => {
    apiWithDk({ posted: false });
    renderPage();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(DK_QUERY));
    await screen.findByRole('button', { name: 'Ghi sổ số dư đầu kỳ' });
    expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ số dư đầu kỳ' })).not.toBeInTheDocument();
  });

  it('thiếu quyền bỏ ghi sổ chứng từ: không có nút Bỏ ghi sổ số dư đầu kỳ', async () => {
    mocks.perms.has = (c) => c !== 'voucher.unpost';
    apiFor(async () => []);
    renderPage();
    await screen.findByRole('button', { name: 'Ghi sổ số dư đầu kỳ' });
    expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ số dư đầu kỳ' })).not.toBeInTheDocument();
  });

  describe('số dư theo tài khoản ngân hàng', () => {
    const saved1121 = { accountCode: '1121', accountName: 'Tiền gửi ngân hàng', partyCode: null, partyName: null, bankAccountNo: '0011001', bankName: 'Vietcombank', currencyCode: 'VND', debit: '100', credit: '0', debitCurrency: '0', creditCurrency: '0' };
    const accounts = [{ code: '1121', subledgerKind: 'bank' }, { code: '131', subledgerKind: 'receivable' }, { code: '1111', subledgerKind: null }];
    const apiBank = (check: unknown[] = []) => mocks.api.mockImplementation(async (path: string) =>
      path === '/api/fiscal-years' ? years : path === '/api/opening-balance/2026' ? [saved1121] : path === '/api/accounts?regime=TT133' ? accounts : path === '/api/opening-balance/2026/check' ? check : []);

    it('cột TK ngân hàng chỉ sửa được ở dòng tài khoản ngân hàng', async () => {
      apiBank();
      renderPage();
      await waitFor(() => expect(mocks.grid.columns.find((c) => c.field === 'bankAccountNo')).toBeDefined());
      const editable = () => mocks.grid.columns.find((c) => c.field === 'bankAccountNo')!.editable as (p: { data: { accountCode: string } }) => boolean;
      await waitFor(() => expect(editable()({ data: { accountCode: '1121' } })).toBe(true)); // đợi danh sách tài khoản tải xong
      expect(editable()({ data: { accountCode: '131' } })).toBe(false);
      expect(editable()({ data: { accountCode: '1111' } })).toBe(false);
      expect(editable()({ data: { accountCode: '' } })).toBe(false);
    });

    it('Lưu gửi kèm bankAccountNo của dòng', async () => {
      apiBank();
      renderPage();
      const save = await screen.findByRole('button', { name: 'Lưu' });
      await waitFor(() => expect(save).toBeEnabled());
      await userEvent.click(save);
      await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/opening-balance/2026', { method: 'PUT', json: { rows: [expect.objectContaining({ accountCode: '1121', bankAccountNo: '0011001' })] } }));
    });

    it('cảnh báo chưa gán tài khoản ngân hàng hiện riêng, không tính là lỗi chặn ghi sổ', async () => {
      const warn = { code: 'BANK_ACCOUNT_MISSING', warning: true, message: 'Tài khoản 1121 chưa gán tài khoản ngân hàng: sổ tiền gửi theo tài khoản ngân hàng sẽ thiếu số dư đầu' };
      apiBank([warn]);
      renderPage();
      const check = await screen.findByRole('button', { name: 'Kiểm tra' });
      await waitFor(() => expect(check).toBeEnabled());
      await userEvent.click(check);
      expect(await screen.findByText('Số dư đầu kỳ hợp lệ')).toBeInTheDocument();
      expect(screen.getByText(warn.message)).toBeInTheDocument();
      expect(screen.queryByText(/lỗi, chưa ghi sổ được/)).not.toBeInTheDocument();
    });
  });
});
