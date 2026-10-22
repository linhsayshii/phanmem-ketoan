import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { message } from 'antd';
import FinancialPage from '../src/pages/Financial.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c) }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const row = (lineCode: string, label: string, over: object = {}) => ({ lineCode, label, parentLineCode: null, isBold: false, negate: false, noteRef: null, source: 'balance', formula: '111', current: '0', previous: '0', ...over });
const REPORT = { reportCode: 'B01', name: 'Báo cáo tình hình tài chính', formNo: 'B01a-DNN', issuedBy: 'Ban hành theo Thông tư số 133/2016/TT-BTC', regime: 'TT133', period: { from: '2026-01-01', to: '2026-12-31' }, rows: [
  row('100', 'A. TÀI SẢN', { isBold: true, source: 'lines', formula: '[111]', current: '1300', previous: '1000' }),
  row('111', 'Tiền', { parentLineCode: '100', current: '1234567', previous: '1000' }),
  row('312', 'Chi trả', { parentLineCode: '100', negate: true, current: '500', previous: '0' }),
  row('999', 'Lỗ', { parentLineCode: '100', current: '-250', previous: '0' }),
  row('TXT', 'Ghi chú', { formula: null, current: '0', previous: '0' }),
] };

describe('Màn hình báo cáo tài chính', () => {
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><FinancialPage /></QueryClientProvider>);
  beforeEach(() => {
    perms.has = () => true;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2025, regime: 'TT133', dateFrom: '2025-01-01', dateTo: '2025-12-31' }, { fiscalYear: 2026, regime: 'TT133', dateFrom: '2026-01-01', dateTo: '2026-12-31' }];
      if (path.startsWith('/api/reports/financial/B01/lines/111')) return { accounts: [{ accountCode: '1111', accountName: 'Tiền mặt', partyCode: null, amount: '1234567' }] };
      if (path.startsWith('/api/reports/financial/B01/lines/312')) return { accounts: [{ accountCode: '515', accountName: 'Doanh thu hoạt động tài chính', partyCode: null, amount: '600000' }, { kind: 'reval_net', accountCode: '515', accountName: 'Chênh lệch đánh giá lại ngoại tệ cuối kỳ (lãi thuần)', partyCode: null, amount: '50000' }] };
      if (path.startsWith('/api/reports/ledgers/account')) return { rows: [{ postingDate: '2026-02-01', voucherId: 'v1', voucherNo: 'PKT00001', description: 'Thu tiền', counterAccountCode: '131', debit: '100', credit: '0' }] };
      if (path.startsWith('/api/reports/financial/B01')) return REPORT;
      if (path.startsWith('/api/report-defs/B01/reload')) return { lines: 0 };
      if (path.startsWith('/api/report-defs/B01') && init?.method === 'PUT') return { ok: true };
      if (path.startsWith('/api/report-defs/B01')) return { lines: [{ lineCode: '100', label: 'A. TÀI SẢN', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[111]', sortOrder: 1, isBold: true, negate: false, noteRef: null }] };
      throw new Error('không mô phỏng ' + path);
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('lấy báo cáo năm mới nhất với số đầu năm, thụt lề theo dòng cha, in đậm, số âm và dòng negate trong ngoặc', async () => {
    renderPage();
    expect(await screen.findByText('Tiền')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/reports/financial/B01?from=2026-01-01&to=2026-12-31&comparePrevYear=false');
    expect(screen.getByText(/Mẫu số B01a-DNN/)).toBeInTheDocument();
    expect(screen.getAllByText('Số cuối kỳ').length).toBeGreaterThan(0); expect(screen.getAllByText('Số đầu năm').length).toBeGreaterThan(0); // tiêu đề cố định render hai lần
    expect(screen.getByText('A. TÀI SẢN')).toHaveStyle({ fontWeight: '700', paddingLeft: '0px' }); expect(screen.getByText('Tiền')).toHaveStyle({ paddingLeft: '16px' });
    expect(screen.getByText('1.234.567')).toBeInTheDocument();
    expect(screen.getByText('(500)')).toBeInTheDocument(); // dòng negate
    expect(screen.getByText('(250)')).toBeInTheDocument(); // số âm
    expect(screen.getByRole('button', { name: '1.234.567' })).toBeInTheDocument(); // số của dòng có công thức là nút truy ngược
    expect(screen.queryByRole('button', { name: '0' })).not.toBeInTheDocument(); // dòng không công thức (số 0) không truy ngược được
  });

  it('truy ngược: dòng số thuần đánh giá lại khác dòng tài khoản 515 thật, không có liên kết sang sổ Cái', async () => {
    renderPage();
    await userEvent.click(await screen.findByText('(500)'));
    expect(await screen.findByText('Chênh lệch đánh giá lại ngoại tệ cuối kỳ (lãi thuần)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '515' })).toHaveLength(1); // chỉ dòng tài khoản thật là liên kết; dòng số thuần là chữ thường
    expect(screen.getAllByText('515')).toHaveLength(2);
  });

  it('nhấn số truy ngược ra tài khoản, nhấn tài khoản mở sổ Cái', async () => {
    renderPage();
    await userEvent.click(await screen.findByText('1.234.567'));
    expect(await screen.findByText('Chỉ tiêu 111 - Tiền')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/reports/financial/B01/lines/111?from=2026-01-01&to=2026-12-31');
    await userEvent.click(await screen.findByText('1111'));
    expect(await screen.findByText('PKT00001')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/reports/ledgers/account?from=2026-01-01&to=2026-12-31&accountCode=1111&mode=voucher');
  });

  it('nạp lại mẫu chờ văn bản báo không có mẫu và giữ nguyên; sửa công thức lưu toàn bộ dòng', async () => {
    const info = vi.spyOn(message, 'info').mockImplementation((() => undefined) as never);
    const ok = vi.spyOn(message, 'success').mockImplementation((() => undefined) as never);
    renderPage();
    await screen.findByText('Tiền');
    await userEvent.click(screen.getByRole('button', { name: 'Nạp lại mẫu' }));
    await userEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Nạp lại mẫu' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/report-defs/B01/reload', { method: 'POST', json: { regime: 'TT133' } }));
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.stringContaining('chờ văn bản')));

    await userEvent.click(screen.getByRole('button', { name: 'Sửa công thức' }));
    expect(await screen.findByText(/chỉ đổi cách hiển thị/)).toBeInTheDocument(); // negate không đổi giá trị
    const formula = await screen.findByDisplayValue('[111]');
    await userEvent.clear(formula); await userEvent.click(formula); await userEvent.paste('[111]+[131]'); // type() hiểu [ là phím đặc biệt
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/report-defs/B01', { method: 'PUT', json: { regime: 'TT133', lines: [
      { lineCode: '100', label: 'A. TÀI SẢN', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[111]+[131]', isBold: true, negate: false, noteRef: null }] } }));
    await vi.waitFor(() => expect(ok).toHaveBeenCalledWith('Đã lưu công thức'));
    info.mockRestore(); ok.mockRestore();
  }, 30_000);

  it('đổi chế độ kế toán: cột so sánh hiện "—" kèm ghi chú thay vì số 0', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2027, regime: 'TT200', dateFrom: '2027-01-01', dateTo: '2027-12-31' }];
      if (path.startsWith('/api/reports/financial/B01')) return { ...REPORT, regime: 'TT200', previousNote: 'REGIME_CHANGED', rows: REPORT.rows.map((r) => ({ ...r, previous: null })) };
      throw new Error('không mô phỏng ' + path);
    });
    renderPage();
    expect(await screen.findByText('Năm trước dùng chế độ kế toán khác; cần chuyển đổi số dư')).toBeInTheDocument();
    expect(screen.getAllByText('Số đầu năm').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—')).toHaveLength(4); // 4 dòng có công thức; dòng ghi chú không công thức để trống
  });

  it('không có quyền sửa định nghĩa thì không thấy nút sửa/nạp lại', async () => {
    perms.has = (c) => c !== 'report_def.update';
    renderPage();
    await screen.findByText('Tiền');
    expect(screen.queryByRole('button', { name: 'Sửa công thức' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nạp lại mẫu' })).not.toBeInTheDocument();
  });
});
