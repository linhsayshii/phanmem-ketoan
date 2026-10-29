import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ArapReportsPage from '../src/pages/ArapReports.js';

const apiMock = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ canPrint: true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: (p: string) => p !== 'report.print' || auth.canPrint }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

interface GridColumn { headerName?: string; field?: string; valueGetter?: (p: { data: unknown }) => unknown; valueFormatter?: (p: { value: unknown }) => string }
// Lưới giả: mỗi dòng một khối, mỗi cột một ô mang tên cột. Ô tra danh mục giả là một ô nhập có nhãn là gợi ý.
vi.mock('@kt/ui', async (importOriginal) => {
  const { useState } = await import('react');
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    KeyboardGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: GridColumn[] }) => (
      <div data-testid="grid">{rows.map((r, i) => (
        <div key={i} data-testid="row">
          {columns.map((c) => { const raw = c.valueGetter ? c.valueGetter({ data: r }) : r[c.field ?? '']; return <span key={c.headerName} data-col={c.headerName}>{c.valueFormatter ? c.valueFormatter({ value: raw }) : String(raw ?? '')}</span>; })}
        </div>))}</div>),
    LookupSelect: ({ placeholder, value, onChange }: { placeholder?: string; value?: string | null; onChange?: (v: string | null) => void }) =>
      <input aria-label={placeholder} value={value ?? ''} onChange={(e) => onChange?.(e.target.value || null)} />,
    useRememberedFilter: (_key: string, initial: unknown) => useState(initial),
  };
});

const detail = { kind: 'receivable', accountCode: '131', partyCode: 'KH001', partyName: 'Khách 1', currency: null, from: '2026-01-01', to: '2026-01-31', opening: '0', openingCurrency: null, totalDebit: '31000', totalCredit: '700',
  totalDebitCurrency: null, totalCreditCurrency: null, closing: '30300', closingCurrency: null,
  rows: [{ date: '2026-01-05', voucherId: 'v1', voucherType: 'PKT', voucherNo: 'PKT00001', description: 'Bán hàng', counterAccounts: '5113', debit: '31000', credit: '0', balance: '31000', debitCurrency: null, creditCurrency: null, balanceCurrency: null },
    { date: '2026-01-20', voucherId: 'v2', voucherType: 'PT', voucherNo: 'PT00001', description: 'Thu tiền', counterAccounts: '1111', debit: '0', credit: '700', balance: '30300', debitCurrency: null, creditCurrency: null, balanceCurrency: null }] };
const summary = { rows: [{ partyCode: 'KH001', partyName: 'Khách 1', openingDebit: '0', openingCredit: '0', periodDebit: '31000', periodCredit: '700', closingDebit: '30300', closingCredit: '0' },
  { partyCode: 'NCC001', partyName: 'NCC 1', openingDebit: '0', openingCredit: '0', periodDebit: '0', periodCredit: '300', closingDebit: '0', closingCredit: '300' }],
  totals: { openingDebit: '0', openingCredit: '0', periodDebit: '31000', periodCredit: '1000', closingDebit: '30300', closingCredit: '300' }, closingNet: '30000', accountNet: '30000', matches: true };
const aging = { kind: 'receivable', columns: [{ key: 'notDue', label: 'Chưa đến hạn' }, { key: 'b0', label: '1–30' }, { key: 'credit', label: 'Trả trước / dư Có' }, { key: 'total', label: 'Tổng' }],
  rows: [{ partyCode: 'KH001', partyName: 'Khách 1', notDue: '1000', b0: '4000', credit: '0', total: '5000' }], totals: { notDue: '1000', b0: '4000', credit: '-300', total: '4700' } };
const agingWithItems = { ...aging, items: [{ itemId: 1, docNo: 'PKT00002', docDate: '2026-01-05', dueDate: '2026-02-10', residual: '4000', ageDays: 49, bucket: 'b1' }] };

const calls = () => apiMock.mock.calls.map((c) => String(c[0]));
const lastCall = (path: string) => { const u = calls().filter((c) => c.startsWith(path)).at(-1); return u ? new URLSearchParams(u.split('?')[1]) : undefined; };
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ArapReportsPage /></QueryClientProvider>);
const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-col="${col}"]`)?.textContent;
const pickParty = (label = 'Đối tượng (F4)') => fireEvent.change(screen.getByLabelText(label), { target: { value: 'KH001' } });

describe('Báo cáo công nợ', () => {
  beforeEach(() => {
    auth.canPrint = true;
    apiMock.mockImplementation(async (url: string) => (url.startsWith('/api/reports/arap/summary') ? summary : url.startsWith('/api/reports/arap/aging') ? (url.includes('partyCode') ? agingWithItems : aging) : detail));
  });
  afterEach(() => { apiMock.mockReset(); vi.unstubAllGlobals(); });

  it('Sổ chi tiết: chưa chọn đối tượng thì nhắc chọn và chưa gọi máy chủ; chọn rồi hiện dư đầu, phát sinh, dư cuối và dư Nợ / dư Có từng dòng', async () => {
    renderPage();
    expect(screen.getByText('Chọn đối tượng (F4) để xem')).toBeInTheDocument();
    expect(calls()).toHaveLength(0);
    pickParty();
    const rows = await screen.findAllByTestId('row');
    const q = lastCall('/api/reports/arap/detail')!;
    expect([q.get('accountCode'), q.get('partyCode'), q.get('from')]).toEqual(['131', 'KH001', expect.stringMatching(/^\d{4}-\d{2}-01$/)]);
    expect(screen.getByText(/Dư cuối kỳ/).textContent).toContain('30.300');
    expect([cell(rows[0]!, 'Số chứng từ'), cell(rows[0]!, 'Phát sinh Nợ'), cell(rows[0]!, 'Dư Nợ'), cell(rows[0]!, 'Dư Có')]).toEqual(['PKT00001', '31.000', '31.000', '']);
    expect([cell(rows[1]!, 'Phát sinh Có'), cell(rows[1]!, 'Dư Nợ')]).toEqual(['700', '30.300']);
    expect(cell(rows[0]!, 'Ngày ghi sổ')).toBe('05/01/2026');
  });

  it('Tổng hợp: gọi tổng hợp không cần đối tượng, hiện tổng hai bên Nợ Có và báo khớp số dư tài khoản', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Tổng hợp' }));
    const rows = await screen.findAllByTestId('row');
    expect(lastCall('/api/reports/arap/summary')!.get('accountCode')).toBe('131');
    expect(rows).toHaveLength(2);
    expect([cell(rows[1]!, 'Dư cuối kỳ Nợ'), cell(rows[1]!, 'Dư cuối kỳ Có')]).toEqual(['', '300']);
    expect(screen.getByText(/Khớp số dư tài khoản 131/).textContent).toContain('30.000');
  });

  it('Tổng hợp: lệch số dư tài khoản thì cảnh báo', async () => {
    apiMock.mockImplementation(async () => ({ ...summary, matches: false, closingNet: '29000' }));
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Tổng hợp' }));
    expect(await screen.findByText(/lệch số dư tài khoản 131/)).toBeInTheDocument();
  });

  it('Tuổi nợ: cột theo máy chủ trả về, mốc mặc định 30,60,90,180 theo hạn; đổi mốc chỉ tính lại khi Enter; chọn đối tượng hiện các khoản còn nợ', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Tuổi nợ' }));
    const rows = await screen.findAllByTestId('row');
    let q = lastCall('/api/reports/arap/aging')!;
    expect([q.get('by'), q.get('buckets'), q.has('partyCode')]).toEqual(['due', '30,60,90,180', false]);
    expect([cell(rows[0]!, 'Chưa đến hạn'), cell(rows[0]!, '1–30'), cell(rows[0]!, 'Tổng')]).toEqual(['1.000', '4.000', '5.000']);
    expect(screen.getByText(/Trả trước \/ dư Có/).textContent).toContain('-300');

    const before = calls().length;
    const buckets = screen.getByLabelText('Mốc tuổi nợ (ngày)');
    await userEvent.clear(buckets); await userEvent.type(buckets, '15,45');
    expect(calls()).toHaveLength(before);
    await userEvent.type(buckets, '{Enter}');
    await vi.waitFor(() => expect(lastCall('/api/reports/arap/aging')!.get('buckets')).toBe('15,45'));

    pickParty('Đối tượng (không bắt buộc)');
    expect(await screen.findByText(/Các khoản còn nợ của đối tượng KH001/)).toBeInTheDocument();
    q = lastCall('/api/reports/arap/aging')!;
    expect(q.get('partyCode')).toBe('KH001');
    const item = (await screen.findAllByTestId('row')).at(-1)!;
    expect([cell(item, 'Số chứng từ'), cell(item, 'Hạn thanh toán'), cell(item, 'Còn nợ'), cell(item, 'Số ngày quá hạn')]).toEqual(['PKT00002', '10/02/2026', '4.000', '49']);
  });

  it('Đối chiếu: hiện kết luận ai còn nợ ai; In biên bản và Thư nhắc nợ mở đúng đường dẫn cùng bộ lọc', async () => {
    const open = vi.fn(); vi.stubGlobal('open', open);
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Đối chiếu' }));
    expect(screen.getByRole('button', { name: 'In biên bản' })).toBeDisabled();
    pickParty();
    expect(await screen.findByText(/Đối tượng còn nợ công ty 30\.300 đồng/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'In biên bản' }));
    const statement = new URL(String(open.mock.calls[0]![0]), 'http://x');
    expect(statement.pathname).toBe('/api/reports/arap/statement');
    expect([statement.searchParams.get('accountCode'), statement.searchParams.get('partyCode')]).toEqual(['131', 'KH001']);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Thư nhắc nợ' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Thư nhắc nợ' }));
    const reminder = new URL(String(open.mock.calls[1]![0]), 'http://x');
    expect(reminder.pathname).toBe('/api/reports/arap/reminder');
    expect([reminder.searchParams.get('partyCode'), reminder.searchParams.get('asOf')]).toEqual(['KH001', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
  });

  it('Thư nhắc nợ: tắt khi đối tượng không có khoản quá hạn, nút nêu lý do và máy chủ không bị gọi lấy JSON 404', async () => {
    const open = vi.fn(); vi.stubGlobal('open', open);
    apiMock.mockImplementation(async (url: string) => (url.startsWith('/api/reports/arap/aging') ? { ...aging, items: [{ ...agingWithItems.items[0]!, ageDays: 0 }, { ...agingWithItems.items[0]!, itemId: 2, ageDays: null, dueDate: null }] } : detail));
    renderPage();
    expect(screen.getByRole('button', { name: 'Thư nhắc nợ' })).toBeDisabled();
    pickParty();
    await vi.waitFor(() => expect(calls().some((c) => c.startsWith('/api/reports/arap/aging') && c.includes('by=due'))).toBe(true));
    const button = screen.getByRole('button', { name: 'Thư nhắc nợ' });
    await vi.waitFor(() => expect(button.getAttribute('title')).toMatch(/không có khoản nợ quá hạn/));
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(open).not.toHaveBeenCalled();
  });

  it('Phải trả (331): gọi tài khoản 331 và không có nút Thư nhắc nợ', async () => {
    renderPage();
    await userEvent.click(screen.getByText('Phải trả (331)'));
    pickParty();
    await screen.findAllByTestId('row');
    expect(lastCall('/api/reports/arap/detail')!.get('accountCode')).toBe('331');
    expect(screen.queryByRole('button', { name: 'Thư nhắc nợ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'In biên bản' })).toBeInTheDocument();
  });

  it('thiếu quyền in thì không có nút in; lỗi 403 của máy chủ hiện nguyên văn', async () => {
    auth.canPrint = false;
    apiMock.mockRejectedValue(new Error('Không có quyền xem công nợ phải thu'));
    renderPage();
    pickParty();
    expect(await screen.findByText('Không có quyền xem công nợ phải thu')).toBeInTheDocument();
    for (const n of ['In PDF', 'Xuất Excel', 'In biên bản', 'Thư nhắc nợ']) expect(screen.queryByRole('button', { name: n })).toBeNull();
  });
});
