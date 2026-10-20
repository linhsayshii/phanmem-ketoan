import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CashBooksPage from '../src/pages/CashBooks.js';

const apiMock = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ canPrint: true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: (p: string) => p !== 'report.print' || auth.canPrint }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

interface GridColumn { headerName?: string; field?: string; valueGetter?: (p: { data: unknown }) => unknown; valueFormatter?: (p: { value: unknown }) => string; onCellDoubleClicked?: (e: { data: unknown }) => void }
// Lưới giả: mỗi dòng một khối, mỗi cột một ô mang tên cột; nhấn đúp dòng gọi cột đầu như AG Grid. Ô tra danh mục giả là một ô nhập có nhãn là gợi ý.
vi.mock('@kt/ui', async () => {
  const { useState } = await import('react');
  return {
    KeyboardGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: GridColumn[] }) => (
      <div data-testid="grid">{rows.map((r, i) => (
        <div key={i} data-testid="row" onDoubleClick={() => columns[0]?.onCellDoubleClicked?.({ data: r })}>
          {columns.map((c) => { const raw = c.valueGetter ? c.valueGetter({ data: r }) : r[c.field ?? '']; return <span key={c.headerName} data-col={c.headerName}>{c.valueFormatter ? c.valueFormatter({ value: raw }) : String(raw ?? '')}</span>; })}
        </div>))}</div>),
    LookupSelect: ({ placeholder, value, onChange }: { placeholder?: string; value?: string | null; onChange?: (v: string | null) => void }) =>
      <input aria-label={placeholder} value={value ?? ''} onChange={(e) => onChange?.(e.target.value || null)} />,
    useRememberedFilter: (_key: string, initial: unknown) => useState(initial),
  };
});

const cashBook = {
  kind: 'cash', accountCode: '111', accountName: 'Tiền mặt', bankAccountNo: null, bankAccountLabel: null, bankName: null, branch: null, currency: null, from: '2026-01-01', to: '2026-01-31',
  opening: '1000000', openingCurrency: null, totalIn: '5000000', totalOut: '2000000', totalInCurrency: null, totalOutCurrency: null, closing: '4000000', closingCurrency: null,
  rows: [
    { date: '2026-01-05', documentDate: '2026-01-05', voucherId: 'v1', voucherType: 'PT', voucherNo: 'PT0001', receiptNo: 'PT0001', paymentNo: null, description: 'Thu tiền hàng', counterAccounts: '131', in: '5000000', out: '0', balance: '6000000', inCurrency: null, outCurrency: null, balanceCurrency: null },
    { date: '2026-01-06', documentDate: '2026-01-06', voucherId: 'v2', voucherType: 'PC', voucherNo: 'PC0001', receiptNo: null, paymentNo: 'PC0001', description: 'Chi tiền điện', counterAccounts: '642', in: '0', out: '2000000', balance: '4000000', inCurrency: null, outCurrency: null, balanceCurrency: null },
  ],
};
const usdBook = { ...cashBook, accountCode: '1112', currency: 'USD', openingCurrency: '100.0000', totalInCurrency: '200.0000', totalOutCurrency: '50.0000', closingCurrency: '250.0000',
  rows: [{ ...cashBook.rows[0]!, inCurrency: '200.0000', outCurrency: '0.0000', balanceCurrency: '300.0000' }] };
const bankBook = { ...cashBook, kind: 'bank', accountCode: '1121', bankAccountNo: '0011', bankAccountLabel: '0011 – Vietcombank', bankName: 'Vietcombank' };

const calls = () => apiMock.mock.calls.map((c) => String(c[0]));
const lastBookCall = (path: string) => { const u = calls().filter((c) => c.startsWith(path)).at(-1); return u ? { path: u.split('?')[0], q: new URLSearchParams(u.split('?')[1]) } : undefined; };
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CashBooksPage /></QueryClientProvider>);
const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-col="${col}"]`)?.textContent;

describe('Sổ quỹ và tiền gửi', () => {
  beforeEach(() => { auth.canPrint = true; apiMock.mockImplementation(async (url: string) => (url.startsWith('/api/reports/bank-book') ? bankBook : url.includes('currency=USD') ? usdBook : cashBook)); });
  afterEach(() => { apiMock.mockReset(); vi.unstubAllGlobals(); });

  it('mở ra tab Sổ quỹ: gọi sổ quỹ TK 111 của tháng này, hiện tồn đầu, thu, chi, tồn cuối và từng dòng; số 0 để trống', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('row');
    const call = lastBookCall('/api/reports/cash-book')!;
    expect(call.q.get('accountCode')).toBe('111');
    expect(call.q.get('from')).toMatch(/^\d{4}-\d{2}-01$/);
    for (const t of ['Tồn đầu kỳ', 'Tồn cuối kỳ']) expect(screen.getByText(new RegExp(t))).toBeInTheDocument();
    expect(screen.getByText(/Tồn đầu kỳ/).textContent).toContain('1.000.000');
    expect(screen.getByText(/Tồn cuối kỳ/).textContent).toContain('4.000.000');
    expect(rows).toHaveLength(2);
    expect([cell(rows[0]!, 'Số phiếu thu'), cell(rows[0]!, 'Thu'), cell(rows[0]!, 'Chi'), cell(rows[0]!, 'Tồn')]).toEqual(['PT0001', '5.000.000', '', '6.000.000']);
    expect([cell(rows[1]!, 'Số phiếu chi'), cell(rows[1]!, 'Thu'), cell(rows[1]!, 'Chi'), cell(rows[1]!, 'Tồn')]).toEqual(['PC0001', '', '2.000.000', '4.000.000']);
    expect(cell(rows[0]!, 'Ngày ghi sổ')).toBe('05/01/2026');
  });

  it('nhấn đúp một dòng mở đúng chứng từ (loại và mã) ở tab mới', async () => {
    const open = vi.fn(); vi.stubGlobal('open', open);
    renderPage();
    fireEvent.doubleClick((await screen.findAllByTestId('row'))[1]!);
    expect(open).toHaveBeenCalledWith('/chung-tu/PC/v2', '_blank', 'noopener');
  });

  it('tab Sổ tiền gửi: chưa chọn tài khoản ngân hàng thì nhắc chọn và chưa gọi máy chủ; chọn rồi gọi sổ tiền gửi theo số tài khoản', async () => {
    renderPage();
    await screen.findAllByTestId('row');
    await userEvent.click(screen.getByRole('tab', { name: 'Sổ tiền gửi' }));
    expect(await screen.findByText('Chọn tài khoản ngân hàng để xem sổ')).toBeInTheDocument();
    expect(calls().some((c) => c.startsWith('/api/reports/bank-book'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Tài khoản ngân hàng'), { target: { value: '0011' } });
    await screen.findAllByTestId('row');
    const call = lastBookCall('/api/reports/bank-book')!;
    expect(call.q.get('bankAccountNo')).toBe('0011');
    expect(call.q.has('accountCode')).toBe(false);
    expect(cell(screen.getAllByTestId('row')[0]!, 'Số chứng từ')).toBe('PT0001');
  });

  it('tab Sổ tiền gửi: bật "chưa gán tài khoản ngân hàng" xem khoản của TK 112 không gắn tài khoản', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Sổ tiền gửi' }));
    await userEvent.click(await screen.findByRole('switch', { name: /Chưa gán tài khoản ngân hàng/ }));
    await screen.findAllByTestId('row');
    const call = lastBookCall('/api/reports/bank-book')!;
    expect(call.q.get('accountCode')).toBe('112');
    expect(call.q.has('bankAccountNo')).toBe(false);
  });

  it('sổ ngoại tệ: hiện thêm tồn đầu, thu, chi, tồn theo nguyên tệ', async () => {
    renderPage();
    await screen.findAllByTestId('row');
    fireEvent.change(screen.getByLabelText('Loại tiền'), { target: { value: 'USD' } });
    await waitFor(() => expect(lastBookCall('/api/reports/cash-book')?.q.get('currency')).toBe('USD'));
    await waitFor(() => expect(cell(screen.getAllByTestId('row')[0]!, 'Thu (nguyên tệ)')).toBe('200'));
    expect(cell(screen.getAllByTestId('row')[0]!, 'Tồn (nguyên tệ)')).toBe('300');
    expect(screen.getByText(/Tồn cuối kỳ/).textContent).toContain('250');
  });

  it('In PDF và Xuất Excel mở đúng đường dẫn cùng bộ lọc; thiếu quyền report.print thì không có hai nút', async () => {
    const open = vi.fn(); vi.stubGlobal('open', open);
    const first = renderPage();
    await screen.findAllByTestId('row');
    await userEvent.click(screen.getByRole('button', { name: 'In PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xuất Excel' }));
    const [pdf, xlsx] = open.mock.calls.map((c) => new URL(String(c[0]), 'http://x'));
    expect(pdf!.pathname).toBe('/api/reports/cash-book');
    expect([pdf!.searchParams.get('format'), xlsx!.searchParams.get('format'), pdf!.searchParams.get('accountCode')]).toEqual(['pdf', 'xlsx', '111']);
    first.unmount();
    auth.canPrint = false;
    renderPage();
    await screen.findAllByTestId('row');
    expect(screen.queryByRole('button', { name: 'In PDF' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Xuất Excel' })).not.toBeInTheDocument();
  });

  it('lỗi từ máy chủ hiện thành thông báo, không để trang trắng', async () => {
    apiMock.mockRejectedValue(new Error('Không có quyền xem tài khoản này'));
    renderPage();
    expect(await screen.findByText('Không có quyền xem tài khoản này')).toBeInTheDocument();
  });
});
