import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DataCheckPage from '../src/pages/DataCheck.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c) }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, params }: { children: React.ReactNode; params: { type: string; id: string } }) => <a href={`/chung-tu/${params.type}/${params.id}`}>{children}</a> }));

const RULES = [
  { id: 1, code: 'CT_KHONG_CAN', name: 'Chứng từ không cân', severity: 'error', sql: 'SELECT 1 /* cân */', message: 'Tổng Nợ khác tổng Có', fix_hint: 'Cân lại', is_system: true, is_enabled: true },
  { id: 2, code: 'SO_DU_SAI_LOAI', name: 'Số dư trái loại dư', severity: 'warning', sql: 'SELECT 2', message: 'Dư trái loại', fix_hint: null, is_system: true, is_enabled: false },
];
const RESULTS = { ran: 1, truncated: ['CT_KHONG_CAN'], results: [
  { ruleCode: 'CT_KHONG_CAN', ruleName: 'Chứng từ không cân', severity: 'error', message: 'Tổng Nợ khác tổng Có', fixHint: 'Cân lại', voucherId: 'v1', voucherNo: 'PKT00007', ref: 'PKT00007', detail: 'Nợ 100 / Có 90' },
] };
const writes = () => apiMock.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PUT');

describe('Màn hình soát lỗi dữ liệu', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DataCheckPage /></QueryClientProvider>);
  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith('/api/catalogs/data_check_rule') && !init) return { rows: RULES, total: 2 };
      if (path === '/api/data-check/run') return RESULTS;
      return { ok: true };
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('không có nút thêm quy tắc, có ghi chú an toàn, SQL chỉ xem trong hàng mở rộng', async () => {
    renderPage();
    expect(await screen.findByText('Chứng từ không cân')).toBeInTheDocument();
    expect(screen.getByText('Quy tắc tùy chỉnh bằng SQL chưa hỗ trợ vì lý do an toàn dữ liệu')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thêm/i })).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: /expand row/i })[0]!);
    expect(await screen.findByText('SELECT 1 /* cân */')).toBeInTheDocument();
  });

  it('Soát lỗi chỉ gửi quy tắc đang bật và đang chọn; kết quả nhóm theo quy tắc kèm liên kết sửa chứng từ', async () => {
    renderPage();
    await screen.findByText('Chứng từ không cân');
    await userEvent.click(screen.getByRole('button', { name: 'Soát lỗi' }));
    const link = await screen.findByRole('link', { name: 'Sửa chứng từ' });
    expect(link).toHaveAttribute('href', '/chung-tu/PKT/v1');
    expect(screen.getByText('Nợ 100 / Có 90')).toBeInTheDocument();
    expect(screen.getByText('Chỉ hiển thị 1000 kết quả đầu')).toBeInTheDocument();
    const [, init] = writes()[0]!;
    expect(JSON.parse(JSON.stringify(init.json)).codes).toEqual(['CT_KHONG_CAN']);
  });

  it('quy tắc bị bỏ qua do thiếu cờ nhạy cảm được liệt kê kèm lý do, kể cả khi không có kết quả nào', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith('/api/catalogs/data_check_rule') && !init) return { rows: RULES, total: 2 };
      if (path === '/api/data-check/run') return { ran: 1, truncated: [], results: [], skipped: [{ code: 'CT_KHONG_CAN', reason: 'Bỏ qua do thiếu quyền xem công nợ' }] };
      return { ok: true };
    });
    renderPage();
    await screen.findByText('Chứng từ không cân');
    await userEvent.click(screen.getByRole('button', { name: 'Soát lỗi' }));
    expect(await screen.findByText('Chứng từ không cân: Bỏ qua do thiếu quyền xem công nợ')).toBeInTheDocument();
    expect(screen.getByText('Đã chạy 1 quy tắc, không phát hiện vấn đề')).toBeInTheDocument();
  });

  it('mọi quy tắc đều bị bỏ qua: chỉ hiện cảnh báo, không hiện "Đã chạy 0 quy tắc, không phát hiện vấn đề"', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith('/api/catalogs/data_check_rule') && !init) return { rows: RULES, total: 2 };
      if (path === '/api/data-check/run') return { ran: 0, truncated: [], results: [], skipped: [{ code: 'CT_KHONG_CAN', reason: 'Bỏ qua do thiếu quyền xem công nợ' }] };
      return { ok: true };
    });
    renderPage();
    await screen.findByText('Chứng từ không cân');
    await userEvent.click(screen.getByRole('button', { name: 'Soát lỗi' }));
    expect(await screen.findByText('Chứng từ không cân: Bỏ qua do thiếu quyền xem công nợ')).toBeInTheDocument();
    expect(screen.queryByText(/Đã chạy 0 quy tắc/)).toBeNull();
  });

  it('công tắc Bật chỉ gửi is_enabled; sửa quy tắc không gửi code hay sql', async () => {
    renderPage();
    await screen.findByText('Chứng từ không cân');
    await userEvent.click(screen.getAllByRole('switch')[1]!);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/catalogs/data_check_rule/2', { method: 'PUT', json: { is_enabled: true } }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Sửa' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Thông điệp'));
    await userEvent.type(within(dialog).getByLabelText('Thông điệp'), 'Lệch Nợ Có');
    expect(within(dialog).getByDisplayValue('SELECT 1 /* cân */')).toHaveAttribute('readonly');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/catalogs/data_check_rule/1', { method: 'PUT',
      json: { name: 'Chứng từ không cân', severity: 'error', message: 'Lệch Nợ Có', fix_hint: 'Cân lại' } }));
  }, 30_000);

  it('thiếu quyền data_check.manage: vẫn xem và chạy được, nhưng công tắc bị khóa và không có nút Sửa', async () => {
    perms.has = (c) => c !== 'data_check.manage';
    renderPage();
    await screen.findByText('Chứng từ không cân');
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Sửa' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Soát lỗi' })).toBeEnabled();
  });
});
