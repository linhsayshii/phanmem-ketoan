import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import VoucherPage from '../src/pages/Voucher.js';

const mocks = vi.hoisted(() => {
  class ApiError extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } }
  return { api: vi.fn(), ApiError, id: { v: 'moi' }, perms: { has: (_c: string): boolean => true } };
});
vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => mocks.perms.has(c) }) }));
// lưới AG Grid và ô tra danh mục nặng trong jsdom và không thuộc điều đang kiểm tra (nút theo trạng thái/quyền); đường nhập phím được kiểm bằng Playwright
vi.mock('@kt/ui', () => ({ KeyboardGrid: () => null, LookupSelect: () => null }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ id: mocks.id.v }), useNavigate: () => vi.fn() }));

const voucher = (state: string, extra: object = {}) => ({ id: 'v1', voucherType: 'PKT', voucherNo: state === 'draft' ? null : 'PKT00001', postingDate: '2026-01-05', documentDate: '2026-01-05', state, description: 'Chi VPP',
  partyCode: null, currencyCode: 'VND', fxRate: null, version: 3, totalDebit: '1500000',
  lines: [{ lineNo: 1, accountCode: '6422', accountName: 'CP QLDN', debit: '1500000', credit: '0', description: null, partyCode: null, departmentCode: null, projectCode: null, costItemCode: null },
    { lineNo: 2, accountCode: '1111', accountName: 'Tiền mặt', debit: '0', credit: '1500000', description: null, partyCode: null, departmentCode: null, projectCode: null, costItemCode: null }], ...extra });

vi.setConfig({ testTimeout: 30_000 }); // antd Form + DatePicker trong jsdom chậm khi máy bận

describe('Màn hình Phiếu kế toán: nút theo trạng thái và quyền', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VoucherPage /></QueryClientProvider>);
  const stateOf = (state: string) => mocks.api.mockImplementation(async (path: string) => (path === '/api/vouchers/v1' ? voucher(state) : []));
  beforeEach(() => { mocks.perms.has = () => true; mocks.id.v = 'v1'; });
  afterEach(() => { mocks.api.mockReset(); });

  it('chứng từ mới: có Lưu và Ghi sổ, chưa có Nhân bản/In/Đính kèm', () => {
    mocks.id.v = 'moi';
    renderPage();
    expect(screen.getByText('Phiếu kế toán (mới)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lưu/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ghi sổ/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nhân bản' })).not.toBeInTheDocument();
    expect(screen.queryByText('Đính kèm:')).not.toBeInTheDocument();
  });

  it('nháp: Ghi sổ (F9), Hủy, Nhân bản; không có Bỏ ghi sổ/Đảo', async () => {
    stateOf('draft'); renderPage();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Ghi sổ (F9)' })).toBeEnabled()); // nút khóa tới khi chứng từ tải xong
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nhân bản' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đảo' })).not.toBeInTheDocument();
    expect(await screen.findByText('Tổng Nợ: 1.500.000')).toBeInTheDocument();
  });

  it('đã ghi sổ: Bỏ ghi sổ cần cả unpost và edit_posted; không còn Ghi sổ/Hủy', async () => {
    stateOf('posted'); renderPage();
    expect(await screen.findByRole('button', { name: 'Bỏ ghi sổ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đảo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ghi sổ \(F9\)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hủy' })).not.toBeInTheDocument();
  });
  it('đã ghi sổ, thiếu quyền sửa sau ghi sổ: không có Bỏ ghi sổ', async () => {
    mocks.perms.has = (c) => c !== 'voucher.edit_posted'; stateOf('posted'); renderPage();
    await screen.findByRole('button', { name: 'Đảo' });
    expect(screen.queryByRole('button', { name: 'Bỏ ghi sổ' })).not.toBeInTheDocument();
  });
  it('đã đảo: chỉ xem (không Lưu)', async () => {
    stateOf('reversed'); renderPage();
    await screen.findByText('Đã đảo');
    expect(screen.queryByRole('button', { name: /Lưu/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nhân bản' })).toBeInTheDocument();
  });

  // lời gọi ghi (PUT/POST) tới máy chủ; GET không tính
  const writes = () => mocks.api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method);
  const gets = () => mocks.api.mock.calls.filter(([p, init]) => p === '/api/vouchers/v1' && !(init as { method?: string } | undefined)?.method);

  it('chưa tải xong chứng từ: Lưu và Ghi sổ bị khóa, Ctrl+S và F9 không gọi máy chủ', () => {
    mocks.api.mockImplementation(() => new Promise(() => undefined)); // GET treo
    renderPage();
    expect(screen.getByRole('button', { name: /Lưu/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Ghi sổ/ })).toBeDisabled();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true }); fireEvent.keyDown(window, { key: 'F9' });
    expect(writes()).toHaveLength(0);
  });

  it('VERSION_CONFLICT: hiện hộp thoại có nút Tải lại, bấm thì tải lại chứng từ', async () => {
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new mocks.ApiError('VERSION_CONFLICT', 'Chứng từ đã được người khác sửa, hãy tải lại');
      return path === '/api/vouchers/v1' ? voucher('draft') : [];
    });
    renderPage();
    const save = await screen.findByRole('button', { name: /Lưu/ });
    await vi.waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    const reload = await screen.findByRole('button', { name: 'Tải lại' });
    expect(gets()).toHaveLength(1);
    await userEvent.click(reload);
    await vi.waitFor(() => expect(gets()).toHaveLength(2));
  });

  it('lưu xong thì chờ tải lại xong mới nhận Ctrl+S tiếp (không gửi version cũ)', async () => {
    let release: () => void = () => undefined;
    let n = 0;
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return voucher('draft', { version: 4 });
      if (path !== '/api/vouchers/v1') return [];
      return ++n === 1 ? voucher('draft') : new Promise((r) => { release = () => r(voucher('draft', { version: 4 })); }); // lần tải lại sau khi lưu bị giữ
    });
    renderPage();
    const save = await screen.findByRole('button', { name: /Lưu/ });
    await vi.waitFor(() => expect(save).toBeEnabled());
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    await vi.waitFor(() => expect(gets()).toHaveLength(2)); // đang tải lại
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
    expect(save).toHaveClass('ant-btn-loading'); // vẫn đang chờ tải lại
    release();
    await vi.waitFor(() => expect(save).not.toHaveClass('ant-btn-loading'));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await vi.waitFor(() => expect(writes()).toHaveLength(2));
  });

  it('F9 khi chưa cân không gọi API ghi sổ và báo lệch', async () => {
    const line = (lineNo: number, accountCode: string, debit: string, credit: string) => ({ lineNo, accountCode, accountName: accountCode, debit, credit, description: null, partyCode: null, departmentCode: null, projectCode: null, costItemCode: null });
    mocks.api.mockImplementation(async (path: string) => (path === '/api/vouchers/v1' ? voucher('draft', { lines: [line(1, '6422', '1500000', '0'), line(2, '1111', '0', '1000000')] }) : []));
    renderPage();
    expect(await screen.findByText('Tổng Nợ: 1.500.000')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /Lưu/ })).toBeEnabled());
    fireEvent.keyDown(window, { key: 'F9' });
    expect(await screen.findByText('Chứng từ chưa cân: tổng Nợ 1.500.000 khác tổng Có 1.000.000')).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it('thiếu ngày hạch toán: thông báo là chữ lỗi của trường, không phải [object Object]', async () => {
    mocks.id.v = 'moi';
    renderPage();
    const date = screen.getByLabelText('Ngày hạch toán');
    fireEvent.click(date.closest('.ant-picker')!.querySelector('.ant-picker-clear')!); // nút xóa ngày: trường rỗng
    await vi.waitFor(() => expect(date).toHaveValue(''));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await screen.findByText('Nhập ngày hạch toán', { selector: '.ant-message-custom-content span' })).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });
});
