import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { todayVn } from '@kt/domain';
import FxToolsPage from '../src/pages/FxTools.js';
import { ApiError } from '../src/api/client.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: () => true }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

interface GridColumn { headerName?: string; field?: string; valueGetter?: (p: { data: unknown }) => unknown; valueFormatter?: (p: { value: unknown }) => string }
vi.mock('@kt/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    KeyboardGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: GridColumn[] }) => (
      <div data-testid="grid">{rows.map((r, i) => (
        <div key={i} data-testid="row">
          {columns.map((c) => { const raw = c.valueGetter ? c.valueGetter({ data: r }) : r[c.field ?? '']; return <span key={c.headerName} data-col={c.headerName}>{c.valueFormatter ? c.valueFormatter({ value: raw }) : String(raw ?? '')}</span>; })}
        </div>))}</div>),
    VnNumberInput: ({ value, onChange, ...rest }: { value?: string | null; onChange?: (v: string | null) => void; 'aria-label'?: string }) =>
      <input aria-label={rest['aria-label']} value={value ?? ''} onChange={(e) => onChange?.(e.target.value || null)} />,
  };
});

const YEARS = (regime = 'TT133') => [{ fiscalYear: 2026, regime, dateFrom: '2026-01-01', dateTo: '2026-12-31', periods: [
  { periodNo: 1, dateFrom: '2026-01-01', dateTo: '2026-01-31', status: 'open' }, { periodNo: 2, dateFrom: '2026-02-01', dateTo: '2026-02-28', status: 'open' }] }];
const run = (o: Record<string, unknown>) => ({ id: 5, kind: 'outflow', fiscalYear: 2026, periodNo: 1, runDate: '2026-02-01', voucherIds: ['vold'], voucherNos: ['XQ00009'], reversedVoucherIds: [], reversedVoucherNos: [], createdAt: '2026-02-01T01:00:00Z', ...o });
const PREVIEW = { dryRun: true, date: '2026-02-28', fiscalYear: 2026, periodNo: 2, unchanged: false, totals: { gain: '660000', loss: '0', net: '660000' },
  rates: [{ currency: 'USD', rateType: 'sell', rate: '25600', rateDate: '2026-02-26' }], warnings: ['Tỷ giá USD lấy ngày 26/02/2026, cũ hơn ngày đánh giá lại'],
  lines: [{ kind: 'bank', accountCode: '1121', bankAccountNo: '0011', partyCode: null, openItemId: null, docNo: null, currency: 'USD', balanceCurrency: '1000', balance: '25000000', rateType: 'buy', rate: '25600', revalued: '25600000', difference: '600000' },
    { kind: 'receivable', accountCode: '131', partyCode: 'KH001', openItemId: 3, docNo: 'HD009', currency: 'USD', balanceCurrency: '100', balance: '2500000', rateType: 'sell', rate: '25600', revalued: '2560000', difference: '60000' }] };
// Kết quả chạy có cảnh báo và tỷ giá riêng (khác bản xem trước) để biết màn hình hiện đúng của lần chạy.
const RUN_WARNING = 'Cảnh báo khi chạy: tỷ giá USD lấy ngày 25/02/2026';
const RUN_RATES = [{ currency: 'USD', rateType: 'sell', rate: '25600', rateDate: '2026-02-25' }];
let years = YEARS(); let settings: Record<string, unknown> = {}; let failWith: ApiError | null = null; let putGate: Promise<unknown> | null = null;

const calls = () => apiMock.mock.calls as [string, { method?: string; json?: Record<string, unknown> } | undefined][];
const posts = (prefix: string) => calls().filter(([u, i]) => u.startsWith(prefix) && i?.method === 'POST');
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><FxToolsPage /></QueryClientProvider>);
const choose = async (label: string, option: string) => { fireEvent.mouseDown(screen.getByRole('combobox', { name: label })); const opts = await screen.findAllByText(option, { selector: '.ant-select-item-option-content' }); fireEvent.click(opts.find((o) => !o.closest('.ant-select-dropdown-hidden')) ?? opts[0]!); };
const openReval = async () => { renderPage(); await userEvent.click(screen.getByRole('tab', { name: 'Đánh giá lại ngoại tệ' })); await screen.findByDisplayValue('25500'); };
const runButton = () => screen.getByRole('button', { name: 'Chạy đánh giá lại' });
const previewButton = () => screen.getByRole('button', { name: 'Xem trước' });
const rateTypesAsked = () => calls().filter(([u]) => u.startsWith('/api/fx/rate')).map(([u]) => new URLSearchParams(u.split('?')[1]).get('type'));

describe('Công cụ tỷ giá', () => {
  beforeEach(() => {
    years = YEARS(); settings = { fx_reval_rate_asset: null, fx_reval_rate_liability: 'sell' }; failWith = null; putGate = null;
    apiMock.mockImplementation(async (url: string, init?: { method?: string; json?: Record<string, unknown> }) => {
      if (url === '/api/fiscal-years') return years;
      if (url.startsWith('/api/fx/runs')) return url.includes('kind=revaluation') ? [run({ id: 6, kind: 'revaluation', runDate: '2026-01-31', voucherNos: ['DG00001', 'DG00002'] })] : [run({})];
      if (url === '/api/fx/outflow-adjust') {
        if (failWith) throw failWith;
        return { runId: 7, voucherIds: ['vxq'], reversedVoucherIds: [], unchanged: false, stalePeriods: [3], staleRevaluations: ['2026-02-28'], groups: [] };
      }
      if (url.startsWith('/api/fx/revaluation')) {
        if (failWith) throw failWith;
        if (url.includes('dryRun=true')) return PREVIEW;
        return { runId: 8, date: '2026-02-28', voucherIds: ['vdg1', 'vdg2'], reversedVoucherIds: [], unchanged: false, staleRevaluations: [], totals: PREVIEW.totals, rates: RUN_RATES, warnings: [RUN_WARNING] };
      }
      if (url.startsWith('/api/vouchers/')) return { voucherNo: { vxq: 'XQ00001', vdg1: 'DG00005', vdg2: 'DG00006' }[url.split('/').pop()!] };
      if (url === '/api/settings') { if (init?.method === 'PUT') { Object.assign(settings, init.json); return putGate ?? { ok: true }; } return settings; }
      if (url.startsWith('/api/catalogs/currency')) return { rows: [{ code: 'VND', name: 'Đồng' }, { code: 'USD', name: 'Đô la Mỹ' }, { code: 'EUR', name: 'Euro' }] };
      if (url.startsWith('/api/fx/rate')) {
        if (url.includes('currency=EUR')) throw new ApiError('FX_RATE_MISSING', 'Chưa có tỷ giá của EUR', 409);
        return { currency: 'USD', type: 'transfer_avg', rateDate: '2026-02-27', rate: '25500' };
      }
      throw new Error(`api không giả lập: ${url}`);
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  describe('Tỷ giá xuất quỹ', () => {
    it('chọn kỳ rồi chạy: gửi năm và kỳ, hiện số chứng từ XQ, nhắc kỳ sau và đánh giá lại cần chạy lại; lịch sử có số chứng từ các lần trước', async () => {
      renderPage();
      expect(await screen.findByRole('link', { name: 'XQ00009' })).toHaveAttribute('href', '/chung-tu/XQ/vold');
      const go = screen.getByRole('button', { name: 'Chạy điều chỉnh tỷ giá xuất quỹ' });
      expect(go).toBeDisabled(); // chưa chọn kỳ
      await choose('Kỳ kế toán', 'Kỳ 2 (01/02 - 28/02)');
      await userEvent.click(go);
      const link = await screen.findByRole('link', { name: 'XQ00001' });
      expect(link).toHaveAttribute('href', '/chung-tu/XQ/vxq');
      expect(posts('/api/fx/outflow-adjust').map(([, i]) => i!.json)).toEqual([{ fiscalYear: 2026, periodNo: 2 }]);
      expect(screen.getByText(/chạy lại.*kỳ 3/i)).toBeInTheDocument();
      expect(screen.getByText(/28\/02\/2026/)).toBeInTheDocument();
    });

    it('lỗi máy chủ (phương pháp đích danh) hiện nguyên thông báo tiếng Việt', async () => {
      failWith = new ApiError('FX_OUTFLOW_METHOD_SPECIFIC', 'Công ty dùng phương pháp xuất quỹ đích danh, không có điều chỉnh tỷ giá xuất quỹ', 409);
      renderPage(); await screen.findByRole('link', { name: 'XQ00009' });
      await choose('Kỳ kế toán', 'Kỳ 1 (01/01 - 31/01)');
      await userEvent.click(screen.getByRole('button', { name: 'Chạy điều chỉnh tỷ giá xuất quỹ' }));
      expect(await screen.findByText(/đích danh/)).toBeInTheDocument();
    });
  });

  describe('Đánh giá lại ngoại tệ', () => {
    it('bảng tỷ giá điền sẵn từ danh mục kèm ngày tỷ giá; loại tiền chưa có tỷ giá được báo', async () => {
      await openReval();
      expect(screen.getByLabelText('Tỷ giá USD')).toHaveValue('25500');
      expect(screen.getByText('27/02/2026')).toBeInTheDocument();
      expect(screen.getByLabelText('Tỷ giá EUR')).toHaveValue('');
      expect(await screen.findByText(/Chưa có tỷ giá của EUR/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Tỷ giá VND')).not.toBeInTheDocument();
      expect(runButton()).toBeDisabled(); // chưa xem trước
    });

    it('Xem trước hiện chênh lệch, tỷ giá áp dụng kèm ngày và cảnh báo; Chạy chỉ bật sau khi xem trước và tắt lại khi đổi tỷ giá nhập tay', async () => {
      await openReval();
      await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
      expect(await screen.findByText(/cũ hơn ngày đánh giá lại/)).toBeInTheDocument();
      expect(posts('/api/fx/revaluation').map(([u, i]) => [u, i!.json])).toEqual([['/api/fx/revaluation?dryRun=true', { date: todayVn() }]]);
      expect(screen.getByText('26/02/2026')).toBeInTheDocument(); // ngày của tỷ giá máy chủ áp dụng
      const rows = screen.getAllByTestId('row');
      expect(rows).toHaveLength(2);
      expect([rows[0]!.querySelector('[data-col="Tài khoản"]')?.textContent, rows[0]!.querySelector('[data-col="Chênh lệch"]')?.textContent]).toEqual(['1121', '600.000']);
      expect(rows[1]!.querySelector('[data-col="Số chứng từ"]')?.textContent).toBe('HD009');
      expect(screen.getByText(/Tổng chênh lệch/).textContent).toContain('660.000');
      expect(runButton()).toBeEnabled();
      fireEvent.change(screen.getByLabelText('Tỷ giá USD'), { target: { value: '25600' } });
      expect(runButton()).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
      await vi.waitFor(() => expect(runButton()).toBeEnabled());
      expect(posts('/api/fx/revaluation').at(-1)![1]!.json).toEqual({ date: todayVn(), rates: { USD: '25600' } }); // chỉ tỷ giá người dùng sửa mới gửi
      await userEvent.click(runButton());
      expect(await screen.findByRole('link', { name: 'DG00005' })).toHaveAttribute('href', '/chung-tu/DG/vdg1');
      expect(screen.getByRole('link', { name: 'DG00006' })).toBeInTheDocument();
      expect(posts('/api/fx/revaluation').at(-1)).toEqual(['/api/fx/revaluation', { method: 'POST', json: { date: todayVn(), rates: { USD: '25600' } } }]);
    });

    it('sau khi chạy vẫn hiện cảnh báo và tỷ giá áp dụng kèm ngày tỷ giá của lần chạy (không còn của bản xem trước)', async () => {
      await openReval();
      await userEvent.click(previewButton());
      expect(await screen.findByText(/cũ hơn ngày đánh giá lại/)).toBeInTheDocument();
      await vi.waitFor(() => expect(runButton()).toBeEnabled());
      await userEvent.click(runButton());
      expect(await screen.findByRole('link', { name: 'DG00005' })).toBeInTheDocument();
      expect(screen.getByText(RUN_WARNING)).toBeInTheDocument();
      expect(screen.getByText('25/02/2026')).toBeInTheDocument(); // ngày tỷ giá trong kết quả chạy
      expect(screen.getByText('Tỷ giá bán')).toBeInTheDocument();
      expect(screen.queryByText(/cũ hơn ngày đánh giá lại/)).not.toBeInTheDocument();
      expect(screen.queryByText('26/02/2026')).not.toBeInTheDocument();
    });

    it('lỗi khi chạy (không phải khi xem trước): hiện nguyên thông báo, không hiện kết quả thành công', async () => {
      await openReval();
      await userEvent.click(previewButton());
      await vi.waitFor(() => expect(runButton()).toBeEnabled());
      const text = 'Khoản công nợ của chứng từ HD009 đã được đối trừ sau ngày 28/02/2026: hủy đối trừ các chứng từ sau ngày 28/02/2026, chạy đánh giá lại, rồi đối trừ lại';
      failWith = new ApiError('FX_REVALUATION_SETTLED_AFTER', text, 409);
      await userEvent.click(runButton());
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByText('Đã đánh giá lại ngoại tệ')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'DG00005' })).not.toBeInTheDocument();
    });

    it('tỷ giá điền sẵn lấy theo loại tỷ giá tài sản của công ty (chưa chọn thì transfer_avg); đổi cài đặt thì lấy lại theo loại mới', async () => {
      await openReval();
      expect(new Set(rateTypesAsked())).toEqual(new Set(['transfer_avg']));
      await choose('Tỷ giá đánh giá lại tài sản', 'Tỷ giá mua');
      await vi.waitFor(() => expect(rateTypesAsked()).toContain('buy'));
    });

    it('tỷ giá nhập tay bằng số điền sẵn vẫn được gửi như tỷ giá nhập tay', async () => {
      await openReval();
      fireEvent.change(screen.getByLabelText('Tỷ giá USD'), { target: { value: '25500.0' } }); // bằng 25.500 điền sẵn về giá trị
      await userEvent.click(previewButton());
      await vi.waitFor(() => expect(posts('/api/fx/revaluation')).toHaveLength(1));
      expect(posts('/api/fx/revaluation')[0]![1]!.json).toEqual({ date: todayVn(), rates: { USD: '25500.0' } });
    });

    it('đang lưu cài đặt loại tỷ giá thì khóa Xem trước và Chạy; lưu xong mở lại', async () => {
      await openReval();
      await userEvent.click(previewButton());
      await vi.waitFor(() => expect(runButton()).toBeEnabled());
      let release!: () => void; putGate = new Promise((resolve) => { release = () => { resolve({ ok: true }); }; });
      await choose('Tỷ giá đánh giá lại tài sản', 'Tỷ giá mua');
      await vi.waitFor(() => expect(previewButton()).toBeDisabled());
      expect(runButton()).toBeDisabled();
      release();
      await vi.waitFor(() => expect(previewButton()).toBeEnabled());
    });

    it('hai cài đặt loại tỷ giá lưu qua cài đặt chung; đổi cài đặt làm bản xem trước hết hiệu lực', async () => {
      await openReval();
      await vi.waitFor(() => expect(screen.getByRole('combobox', { name: 'Tỷ giá đánh giá lại nợ phải trả' }).closest('.ant-select')).toHaveTextContent('Tỷ giá bán'));
      expect(screen.getByRole('combobox', { name: 'Tỷ giá đánh giá lại tài sản' }).closest('.ant-select')).toHaveTextContent('Theo quy định của chế độ');
      await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
      await vi.waitFor(() => expect(runButton()).toBeEnabled());
      await choose('Tỷ giá đánh giá lại tài sản', 'Tỷ giá mua');
      await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/settings', { method: 'PUT', json: { fx_reval_rate_asset: 'buy' } }));
      await choose('Tỷ giá đánh giá lại nợ phải trả', 'Theo quy định của chế độ');
      await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/settings', { method: 'PUT', json: { fx_reval_rate_liability: null } }));
      expect(runButton()).toBeDisabled();
    });

    it.each([
      ['FX_REVALUATION_SETTLED', 'Khoản HD009 đã đối trừ sau ngày đánh giá lại, không đánh giá lại được'],
      ['FX_REVALUATION_SETTLED_AFTER', 'Khoản công nợ của chứng từ HD009 đã được đối trừ sau ngày 28/02/2026: hủy đối trừ các chứng từ sau ngày 28/02/2026, chạy đánh giá lại, rồi đối trừ lại'],
      ['PERIOD_SOFT_LOCKED', 'Kỳ 2/2026 đã khóa sổ, cần quyền ghi lùi ngày'],
      ['FX_RATE_MISSING', 'Chưa có tỷ giá bán của USD đến ngày 28/02/2026'],
    ])('lỗi %s: hiện nguyên thông báo máy chủ, Chạy vẫn khóa', async (code, text) => {
      await openReval(); failWith = new ApiError(code, text, 409);
      await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(runButton()).toBeDisabled();
    });

    it('chế độ TT200: nhắc quy tắc đánh giá lại chưa đối chiếu văn bản gốc; chế độ khác không nhắc', async () => {
      years = YEARS('TT200');
      await openReval();
      expect(screen.getByText(/chưa được đối chiếu với văn bản gốc/)).toBeInTheDocument();
    });

    it('chế độ TT133 không có nhắc TT200', async () => {
      await openReval();
      expect(screen.queryByText(/chưa được đối chiếu với văn bản gốc/)).not.toBeInTheDocument();
    });

    it('lịch sử các lần đánh giá lại có số DG', async () => {
      await openReval();
      expect(within(screen.getByRole('tabpanel', { name: 'Đánh giá lại ngoại tệ' })).getByRole('link', { name: 'DG00001' })).toBeInTheDocument();
    });
  });
});
