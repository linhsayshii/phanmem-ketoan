import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import type * as ReactRouter from '@tanstack/react-router';
import { todayVn } from '@kt/domain';
import VoucherForm from '../src/pages/VoucherForm.js';
import { routeTree } from '../src/router.js';

const mocks = vi.hoisted(() => {
  class ApiError extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } }
  return { api: vi.fn(), ApiError, route: { type: 'PT', id: 'moi' }, navigate: vi.fn() };
});
vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: () => true, loading: false }) }));
// Lưới AG Grid nặng trong jsdom: thay bằng danh sách mã tài khoản để quan sát dòng đối ứng được điền.
vi.mock('@kt/ui', () => ({
  KeyboardGrid: ({ rows }: { rows: { accountCode: string }[] }) => <ul>{rows.map((r, i) => <li key={i} data-testid={`tk-${i}`}>{r.accountCode}</li>)}</ul>,
  LookupSelect: () => null, useHotkeys: () => undefined, useRememberedFilter: (_k: string, init: unknown) => [init, () => undefined],
  useUnsavedChanges: () => (proceed: () => void) => proceed(),
}));
vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<typeof ReactRouter>()), useParams: () => mocks.route, useNavigate: () => mocks.navigate }));

vi.setConfig({ testTimeout: 60_000 });
const slow = { timeout: 20_000 }; // truy vấn theo vai trò trên cây DOM antd trong jsdom chậm, nhất là khi máy đang bận
const years = [{ fiscalYear: 2026, regime: 'TT133', dateFrom: '2026-01-01', dateTo: '2026-12-31' }];
const line = (lineNo: number, accountCode: string, debit: string, credit: string) => ({ lineNo, accountCode, accountName: accountCode, debit, credit, description: null, partyCode: null, departmentCode: null, projectCode: null, costItemCode: null });
const posted = (extra: object = {}) => ({ id: 'v1', voucherType: 'PKT', voucherNo: 'PKT00001', postingDate: '2026-01-05', documentDate: '2026-01-05', state: 'posted', description: 'Chi VPP', partyCode: null,
  currencyCode: 'VND', fxRate: null, version: 3, totalDebit: '1500000', periodStatus: 'open', hashed: false, lines: [line(1, '6422', '1500000', '0'), line(2, '1111', '0', '1500000')], ...extra });
const renderForm = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VoucherForm /></QueryClientProvider>);

describe('Màn hình chứng từ theo loại', () => {
  beforeEach(() => { mocks.route.type = 'PT'; mocks.route.id = 'moi'; });
  afterEach(() => { mocks.api.mockReset(); mocks.navigate.mockReset(); });

  it('Phiếu thu: hiện người nộp, lý do, kèm theo; chọn "Thu tiền khách hàng" điền 131 vào dòng đối ứng', async () => {
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : []));
    renderForm();
    expect(screen.getByText('Phiếu thu (mới)')).toBeInTheDocument();
    expect(screen.getByLabelText('Người nộp tiền')).toBeInTheDocument();
    expect(screen.getByLabelText('Lý do nộp')).toBeInTheDocument();
    expect(screen.getByLabelText(/kèm theo/)).toBeInTheDocument();
    expect(screen.getByTestId('tk-1')).toHaveTextContent(''); // dòng 2 (đối ứng) còn trống
    fireEvent.mouseDown(screen.getByLabelText('Mục đích'));
    fireEvent.click(await screen.findByText('Thu tiền khách hàng', { selector: '.ant-select-item-option-content' }));
    await vi.waitFor(() => expect(screen.getByTestId('tk-1')).toHaveTextContent('131'));
  });

  it('chứng từ đã ghi sổ ở kỳ khóa mềm: không có nút Bỏ ghi sổ, có Đảo; Đảo hỏi ngày và gửi ngày đã chọn', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/fiscal-years') return years;
      if (path === '/api/vouchers/v1/reverse' && init?.method === 'POST') return { ...posted({ id: 'v2', voucherNo: 'PKT00002', state: 'posted' }) };
      return path === '/api/vouchers/v1' ? posted({ periodStatus: 'soft_locked' }) : [];
    });
    renderForm();
    const reverse = await screen.findByRole('button', { name: 'Đảo' }, slow);
    expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ' })).not.toBeInTheDocument();
    await userEvent.click(reverse);
    const dialog = await screen.findByRole('dialog', {}, slow);
    const date = within(dialog).getByLabelText('Ngày hạch toán chứng từ đảo');
    const [y, m, d] = todayVn().split('-');
    expect(date).toHaveValue(`${d}/${m}/${y}`); // mặc định là hôm nay
    expect(within(dialog).getByLabelText('Diễn giải chứng từ đảo')).toHaveValue('Đảo chứng từ PKT00001 ngày 05/01/2026');
    await userEvent.clear(date); await userEvent.type(date, '10/02/2026{Enter}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lập chứng từ đảo' }));
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/vouchers/v1/reverse', { method: 'POST', json: { postingDate: '2026-02-10', description: 'Đảo chứng từ PKT00001 ngày 05/01/2026' } }));
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/chung-tu/$type/$id', params: { type: 'PKT', id: 'v2' } }));
  });

  it('kỳ khóa cứng: không có Bỏ ghi sổ và không có Đảo, chỉ có Nhân bản sang kỳ mở', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    mocks.api.mockImplementation(async (path: string) => (path === '/api/vouchers/v1' ? posted({ periodStatus: 'hard_locked' }) : path === '/api/fiscal-years' ? years : []));
    renderForm();
    expect(await screen.findByRole('button', { name: 'Nhân bản sang kỳ mở' }, slow)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đảo' })).not.toBeInTheDocument();
  });
});

describe('Đường dẫn chứng từ', () => {
  it('/chung-tu/phieu-ke-toan chuyển sang /chung-tu/PKT', async () => {
    mocks.api.mockImplementation(async (path: string) => (path === '/api/auth/me' ? { tenantId: 't1' } : []));
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/chung-tu/phieu-ke-toan'] }) });
    await router.load();
    expect(router.state.location.pathname).toBe('/chung-tu/PKT');
  });
});
