import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import type * as ReactRouter from '@tanstack/react-router';
import { todayVn } from '@kt/domain';
import VoucherForm, { settleTargets, emptyLine, type Line } from '../src/pages/VoucherForm.js';
import VoucherList from '../src/pages/VoucherList.js';
import { routeTree } from '../src/router.js';

const mocks = vi.hoisted(() => {
  class ApiError extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } }
  return { api: vi.fn(), ApiError, route: { type: 'PT', id: 'moi' }, navigate: vi.fn() };
});
vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: () => true, loading: false }) }));
// Lưới AG Grid nặng trong jsdom: thay bằng danh sách mã tài khoản để quan sát dòng đối ứng được điền.
vi.mock('@kt/ui', () => ({
  // Hộp thoại Chọn chứng từ công nợ dùng cùng lưới: dòng có docNo là khoản công nợ, nút "Chọn <số>" đặt số đối trừ bằng đủ số còn dư (như Enter ở ô trống).
  KeyboardGrid: ({ rows, onRowsChange }: { rows: { accountCode?: string; docNo?: string; remain?: string }[]; onRowsChange: (r: object[]) => void }) => <ul>{rows.map((r, i) =>
    <li key={i} data-testid={r.docNo ? `khoan-${r.docNo}` : `tk-${i}`}>{r.accountCode}{r.docNo && <button onClick={() => onRowsChange(rows.map((x) => (x === r ? { ...x, pick: x.remain } : x)))}>Chọn {r.docNo}</button>}</li>)}</ul>,
  LookupSelect: () => null, VnNumberInput: ({ scale, ...p }: { scale?: number; value?: string }) => <input {...p} value={p.value ?? ''} readOnly data-scale={scale} />, useHotkeys: () => undefined, useRememberedFilter: (_k: string, init: unknown) => [init, () => undefined],
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

  it('chứng từ đã vào chuỗi băm dù kỳ còn mở: không Bỏ ghi sổ, không Đảo, không sửa, chỉ Nhân bản sang kỳ mở', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    mocks.api.mockImplementation(async (path: string) => (path === '/api/vouchers/v1' ? posted({ hashed: true, periodStatus: 'open' }) : path === '/api/fiscal-years' ? years : []));
    renderForm();
    expect(await screen.findByRole('button', { name: 'Nhân bản sang kỳ mở' }, slow)).toBeInTheDocument();
    for (const name of ['Bỏ ghi sổ', 'Đảo', 'Hủy']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Lưu/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Diễn giải')).toBeDisabled();
  });

  it('Ctrl+S và F9 không lưu hay ghi sổ khi đang mở hộp thoại Đảo', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    mocks.api.mockImplementation(async (path: string) => (path === '/api/vouchers/v1' ? posted({ periodStatus: 'soft_locked' }) : path === '/api/fiscal-years' ? years : []));
    renderForm();
    await userEvent.click(await screen.findByRole('button', { name: 'Đảo' }, slow));
    const dialog = await screen.findByRole('dialog', {}, slow);
    await userEvent.click(within(dialog).getByLabelText('Diễn giải chứng từ đảo'));
    await userEvent.keyboard('{Control>}s{/Control}{F9}');
    expect(mocks.api.mock.calls.filter(([p, init]) => p.startsWith('/api/vouchers/v1') && init?.method)).toEqual([]);
    // Đóng hộp thoại thì phím tắt hoạt động lại: kỳ khóa mềm sửa được diễn giải tại chỗ.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Không' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), slow);
    await userEvent.click(screen.getByLabelText('Diễn giải'));
    await userEvent.keyboard('{Control>}s{/Control}');
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/vouchers/v1', expect.objectContaining({ method: 'PUT' })), slow);
  });

  it('chứng từ ngoại tệ: tỷ giá nhập được tới 10 chữ số lẻ', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    mocks.api.mockImplementation(async (path: string) => (path === '/api/vouchers/v1' ? posted({ state: 'draft', currencyCode: 'USD', fxRate: '25000.0000000000' }) : path === '/api/fiscal-years' ? years : []));
    renderForm();
    expect(await screen.findByLabelText('Tỷ giá', {}, slow)).toHaveAttribute('data-scale', '10');
  });

  it('Giấy báo Nợ ngoại tệ, tỷ giá xuất quỹ bình quân di động: điền sẵn tỷ giá bình quân tại ngày hạch toán của tài khoản ngân hàng', async () => {
    mocks.route.type = 'BN'; mocks.route.id = 'v1';
    const draft = posted({ voucherType: 'BN', voucherNo: null, state: 'draft', currencyCode: 'USD', fxRate: null, bankAccountNo: '0022001', postingDate: '2026-01-20', documentDate: '2026-01-20' });
    let method = 'moving_average';
    mocks.api.mockImplementation(async (path: string) => path === '/api/vouchers/v1' ? draft : path === '/api/fiscal-years' ? years : path === '/api/settings' ? { fx_outflow_method: method }
      : path.startsWith('/api/fx/outflow-rate') ? { rate: '25200.0000000000', balance: '50400000', balanceCurrency: '2000.0000' } : []);
    const first = renderForm();
    await vi.waitFor(() => expect(screen.getByLabelText('Tỷ giá')).toHaveValue('25200.0000000000'), slow);
    const call = mocks.api.mock.calls.map(([p]) => String(p)).find((p) => p.startsWith('/api/fx/outflow-rate'))!;
    expect(Object.fromEntries(new URLSearchParams(call.split('?')[1]))).toEqual({ accountCode: '112', bankAccountNo: '0022001', currency: 'USD', date: '2026-01-20' });
    first.unmount(); mocks.api.mockClear();
    // tỷ giá đích danh: người dùng tự nhập, không hỏi tỷ giá bình quân
    method = 'specific';
    renderForm();
    expect(await screen.findByLabelText('Tỷ giá', {}, slow)).toHaveValue('');
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/settings'));
    expect(mocks.api.mock.calls.some(([p]) => String(p).startsWith('/api/fx/outflow-rate'))).toBe(false);
  });
});

describe('Chọn chứng từ công nợ trên phiếu thu/chi', () => {
  beforeEach(() => { mocks.route.type = 'PT'; mocks.route.id = 'v1'; });
  afterEach(() => { mocks.api.mockReset(); mocks.navigate.mockReset(); });
  const ln = (accountCode: string, debit: string, credit: string, partyCode: string | null = null): Line => ({ ...emptyLine(), accountCode, debit, credit, partyCode });
  const draftPt = { id: 'v1', voucherType: 'PT', voucherNo: null, postingDate: '2026-01-05', documentDate: '2026-01-05', state: 'draft', description: 'Thu tiền hàng', partyCode: 'KH01',
    currencyCode: 'VND', fxRate: null, version: 1, totalDebit: '600000', periodStatus: 'open', hashed: false, lines: [line(1, '1111', '600000', '0'), { ...line(2, '131', '0', '600000'), partyCode: 'KH01' }] };
  const item = { id: 7, voucherId: 'i1', voucherNo: 'BH00001', voucherType: 'BH', accountCode: '131', partyCode: 'KH01', docNo: 'HD01', docDate: '2025-12-20', dueDate: null,
    currency: 'VND', amount: '600000', amountCurrency: '0', residual: '600000', residualCurrency: '0' };

  it('settleTargets: chỉ dòng 131/331; bên khoản ngược bên dòng; dòng trống số tiền theo bản chất tài khoản; đối tượng dòng đè tiêu đề', () => {
    const t = settleTargets([ln('1111', '600000', '0'), ln('131', '0', '600000', 'KH01'), ln('331', '300000', '0'), ln('131', '0', '0'), ln('331', '0', '0')], 'NCC01');
    expect(t.map((x) => [x.index, x.accountCode, x.side, x.partyCode, x.amount])).toEqual([[1, '131', 'debit', 'KH01', '600000'], [2, '331', 'credit', 'NCC01', '300000'], [3, '131', 'debit', 'NCC01', null], [4, '331', 'credit', 'NCC01', null]]);
  });

  it('mở hộp thoại, chọn khoản của đối tượng và TK dòng 131, áp dụng rồi lưu: dòng mang kế hoạch đối trừ', async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return years;
      if (path === '/api/vouchers/v1') return draftPt;
      return path.startsWith('/api/open-items') ? [item] : [];
    });
    renderForm();
    const open = await screen.findByRole('button', { name: /Chọn chứng từ công nợ/ }, slow);
    await vi.waitFor(() => expect(open).toBeEnabled(), slow);
    await userEvent.click(open);
    const dialog = await screen.findByRole('dialog', {}, slow);
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Chọn HD01' }, slow));
    expect(within(dialog).getByText(/Tổng chọn đối trừ/)).toHaveTextContent('600.000');
    const q = new URLSearchParams(mocks.api.mock.calls.map(([p]) => String(p)).find((p) => p.startsWith('/api/open-items'))!.split('?')[1]);
    expect([q.get('accountCode'), q.get('partyCode'), q.get('onlyOpen'), q.get('asOf')]).toEqual(['131', 'KH01', 'true', '2026-01-05']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Áp dụng' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), slow);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/vouchers/v1', expect.objectContaining({ method: 'PUT' })), slow);
    const put = mocks.api.mock.calls.find(([, init]) => init?.method === 'PUT')![1] as { json: { lines: { accountCode: string; settle?: object[] }[] } };
    expect(put.json.lines.find((l) => l.accountCode === '131')?.settle).toEqual([{ openItemId: 7, amount: '600000' }]);
    expect(put.json.lines.find((l) => l.accountCode === '1111')).not.toHaveProperty('settle');
  });

  it('phiếu kế toán không có nút Chọn chứng từ công nợ', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'moi';
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : []));
    renderForm();
    await screen.findByText('Phiếu kế toán (mới)');
    expect(screen.queryByRole('button', { name: /Chọn chứng từ công nợ/ })).not.toBeInTheDocument();
  });
});

describe('Tồn quỹ và cảnh báo tồn quỹ âm', () => {
  beforeEach(() => { mocks.route.type = 'PT'; mocks.route.id = 'moi'; });
  afterEach(() => { mocks.api.mockReset(); mocks.navigate.mockReset(); });
  const balanceCalls = () => mocks.api.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/api/cash/balance'));

  it('Phiếu thu: hiện tồn quỹ cuối ngày hạch toán của TK 1111; âm thì tô đỏ', async () => {
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : path.startsWith('/api/cash/balance') ? { balance: '12500000', balanceCurrency: '0' } : []));
    const first = renderForm();
    const tag = await screen.findByText(/Tồn quỹ cuối ngày/, {}, slow);
    expect(tag).toHaveTextContent('12.500.000');
    expect(tag).toHaveTextContent('(chưa kể phiếu này)');
    const q = new URLSearchParams(balanceCalls()[0]!.split('?')[1]);
    expect([q.get('accountCode'), q.get('asOf')]).toEqual(['1111', todayVn()]);
    expect(tag.closest('.ant-tag')).not.toHaveClass('ant-tag-red');
    first.unmount();
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : path.startsWith('/api/cash/balance') ? { balance: '-300000', balanceCurrency: '0' } : []));
    renderForm();
    expect((await screen.findByText(/Tồn quỹ cuối ngày/, {}, slow)).closest('.ant-tag')).toHaveClass('ant-tag-red');
  });

  it('chứng từ không phải phiếu thu/chi/giấy báo thì không hỏi tồn quỹ', async () => {
    mocks.route.type = 'PKT';
    mocks.api.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : []));
    renderForm();
    await screen.findByText('Phiếu kế toán (mới)', {}, slow);
    expect(balanceCalls()).toEqual([]);
  });

  it('ghi sổ được kèm cảnh báo CASH_NEGATIVE: hiện cảnh báo của máy chủ sau thông báo Đã ghi sổ', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    const warning = 'Tồn quỹ TK 1111 âm -500.000 sau khi ghi sổ ngày 05/01/2026';
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return years;
      if (path === '/api/vouchers/v1/post') return posted({ warnings: [{ code: 'CASH_NEGATIVE', message: warning }] });
      return path === '/api/vouchers/v1' ? posted({ state: 'draft', version: 1 }) : [];
    });
    renderForm();
    await userEvent.click(await screen.findByRole('button', { name: /Ghi sổ/ }, slow));
    expect(await screen.findByText(warning, {}, slow)).toBeInTheDocument();
    expect(screen.getByText('Đã ghi sổ')).toBeInTheDocument();
  });

  it('bỏ ghi sổ làm tồn quỹ âm (chế độ warn): hiện cảnh báo của máy chủ sau thông báo Đã bỏ ghi sổ', async () => {
    mocks.route.type = 'PKT'; mocks.route.id = 'v1';
    const warning = 'Bỏ ghi sổ làm tồn quỹ tiền mặt TK 1111 âm 600.000 đ tại ngày 06/01/2026';
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return years;
      if (path === '/api/vouchers/v1/unpost') return posted({ state: 'draft', warnings: [{ code: 'CASH_NEGATIVE', message: warning }] });
      return path === '/api/vouchers/v1' ? posted() : [];
    });
    renderForm();
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ghi sổ' }, slow));
    expect(await screen.findByText(warning, {}, slow)).toBeInTheDocument();
    expect(screen.getByText('Đã bỏ ghi sổ')).toBeInTheDocument();
  });
});

describe('Loại chứng từ không có', () => {
  beforeEach(() => { mocks.route.id = 'moi'; });
  afterEach(() => { mocks.api.mockReset(); });

  it.each(['constructor', '__proto__', 'pt'])('/chung-tu/%s: màn hình nhập và danh sách báo "Không có loại chứng từ"', (type) => {
    mocks.route.type = type; mocks.api.mockResolvedValue([]);
    const msg = `Không có loại chứng từ "${type}"`;
    const form = renderForm(); expect(screen.getByText(msg)).toBeInTheDocument(); form.unmount();
    render(<QueryClientProvider client={new QueryClient()}><VoucherList /></QueryClientProvider>); expect(screen.getByText(msg)).toBeInTheDocument();
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
