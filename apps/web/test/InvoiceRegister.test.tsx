import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InvoiceRegisterPage, { filterRegister, registerRows, urlSelection } from '../src/pages/InvoiceRegister.js';

const apiMock = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ canPrint: true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: (p: string) => p !== 'report.print' || auth.canPrint }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

interface GridColumn { headerName?: string; field?: string; valueGetter?: (p: { data: unknown }) => unknown; valueFormatter?: (p: { value: unknown }) => string }
vi.mock('@kt/ui', async () => {
  const { useState } = await import('react');
  return {
    KeyboardGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: GridColumn[] }) => (
      <div data-testid="grid">{rows.map((r, i) => (
        <div key={i} data-testid="row">
          {columns.map((c) => { const raw = c.valueGetter ? c.valueGetter({ data: r }) : r[c.field ?? '']; return <span key={c.headerName} data-col={c.headerName}>{c.valueFormatter ? c.valueFormatter({ value: raw }) : String(raw ?? '')}</span>; })}
        </div>))}</div>),
    useRememberedFilter: (_key: string, initial: unknown) => useState(initial),
  };
});

const line = (o: Record<string, unknown> = {}) => ({ stt: 1, groupCode: '01', groupName: 'HHDV khấu trừ', formNo: '01GTKT', serial: 'AA/26E', invoiceNo: '0000123', invoiceDate: '2026-03-05', partyName: 'Công ty A', partyTaxCode: '0100109106',
  baseAmount: '1000000', taxRate: '10', taxAmount: '100000', voucherId: 'v1', voucherNo: 'HDM00001', voucherType: 'HDM', kind: 'original', ...o });
const register = { label: 'Tháng 3/2026', groups: [{ code: '01', name: 'HHDV khấu trừ', rows: [line(), line({ stt: 2, invoiceNo: '0000124', baseAmount: '-500000', taxAmount: '-50000', kind: 'reversal' })], baseTotal: '500000', taxTotal: '50000' }],
  totals: { baseAmount: '500000', taxAmount: '50000' }, otherTaxes: { rows: [line({ stt: 1, invoiceNo: 'NK1', taxRate: null, baseAmount: '2000000', taxAmount: '200000' })], baseTotal: '2000000', taxTotal: '200000' } };
const reconcile = { purchaseTaxInvoices: '50000', debit1331: '60000', saleTaxInvoices: '0', credit33311: '0',
  differences: [{ voucherId: 'v9', voucherNo: 'PKT00009', voucherType: 'PKT', direction: 'purchase', invoiceTax: '0', ledgerTax: '10000' }] };

const calls = () => apiMock.mock.calls.map((c) => String(c[0]));
const lastCall = (path: string) => { const u = calls().filter((c) => c.startsWith(path)).at(-1); return u ? new URLSearchParams(u.split('?')[1]) : undefined; };
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InvoiceRegisterPage /></QueryClientProvider>);
const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-col="${col}"]`)?.textContent;

describe('Bảng kê hóa đơn', () => {
  beforeEach(() => {
    auth.canPrint = true;
    apiMock.mockImplementation(async (url: string) => (url.startsWith('/api/tax/reconcile') ? reconcile : register));
  });
  afterEach(() => { apiMock.mockReset(); });

  it('Mua vào: gọi đúng chiều và kỳ, hiện dòng nhóm, hóa đơn, cộng nhóm, tổng cộng và thuế nhập khẩu tách riêng', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('row');
    const q = lastCall('/api/tax/invoices')!;
    expect([q.get('direction'), q.get('periodKind'), q.get('year')]).toEqual(['purchase', 'month', String(new Date().getFullYear())]);
    expect(rows.map((r) => cell(r, 'Tên người bán/mua'))).toEqual(['Nhóm 01 – HHDV khấu trừ', 'Công ty A', 'Công ty A', 'Cộng nhóm 01', 'Tổng cộng', expect.stringContaining('Thuế nhập khẩu'), 'Công ty A', 'Cộng']);
    expect([cell(rows[1]!, 'Số hóa đơn'), cell(rows[1]!, 'Thuế suất'), cell(rows[1]!, 'Thuế GTGT'), cell(rows[1]!, 'Ngày')]).toEqual(['0000123', '10%', '100.000', '05/03/2026']);
    expect(cell(rows[2]!, 'Số chứng từ')).toBe('HDM00001 (đảo)');
    expect([cell(rows[3]!, 'Giá trị chưa thuế'), cell(rows[4]!, 'Thuế GTGT')]).toEqual(['500.000', '50.000']);
  });

  it('Bán ra gọi direction=sale; ghi chú của máy chủ về kỳ kê khai theo quý được hiển thị', async () => {
    apiMock.mockImplementation(async () => ({ ...register, note: 'Hóa đơn của kỳ kê khai theo quý hiển thị ở tháng cuối quý.' }));
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Bán ra' }));
    await screen.findAllByTestId('row');
    expect(lastCall('/api/tax/invoices?direction=sale')!.get('periodKind')).toBe('month');
    expect(screen.getByText(/tháng cuối quý/)).toBeTruthy();
  });

  it('Đối chiếu: hiện bốn số tổng và chứng từ lệch', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Đối chiếu' }));
    const rows = await screen.findAllByTestId('row');
    expect(screen.getByText(/Thuế GTGT đầu vào trên sổ cái/).textContent).toContain('60.000');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await userEvent.click(screen.getByRole('button', { name: 'Xuất Excel' }));
    expect(String(open.mock.calls[0]![0])).toMatch(/^\/api\/tax\/reconcile\?.*&format=xlsx$/);
    open.mockRestore();
    expect([cell(rows[0]!, 'Số chứng từ'), cell(rows[0]!, 'Thuế trên hóa đơn'), cell(rows[0]!, 'Thuế trên sổ cái'), cell(rows[0]!, 'Chênh lệch')]).toEqual(['PKT00009', '0', '10.000', '10.000']);
  });

  it('Nút Xuất Excel chỉ hiện khi có quyền in', async () => {
    auth.canPrint = false;
    renderPage();
    await screen.findAllByTestId('row');
    expect(screen.queryByRole('button', { name: 'Xuất Excel' })).toBeNull();
  });

  it('urlSelection: đọc chiều, kỳ, nhóm, hàng nhập khẩu và chỉ tiêu từ đường dẫn; tham số sai bị bỏ qua', () => {
    expect(urlSelection('?direction=sale&year=2026&period=7&periodKind=month&group=10,%2008')).toEqual({ tab: 'sale', sel: { periodKind: 'month', year: 2026, period: 7 }, groups: ['10', '08'], importOnly: false, field: null });
    expect(urlSelection('?direction=purchase&year=2026&period=7&periodKind=month&group=01&importOnly=1&field=tax')).toMatchObject({ groups: ['01'], importOnly: true, field: 'tax' });
    expect(urlSelection('?direction=x&year=2026&period=13&periodKind=month&field=x')).toEqual({ tab: null, sel: null, groups: [], importOnly: false, field: null });
    expect(urlSelection('')).toEqual({ tab: null, sel: null, groups: [], importOnly: false, field: null });
  });

  it('filterRegister: lọc nhóm và hàng nhập khẩu, cộng nhóm và tổng cộng tính lại từ dòng còn lại', () => {
    const g = (code: string, rows: unknown[]) => ({ code, name: code, rows, baseTotal: '0', taxTotal: '0' });
    const r = { ...register, groups: [g('01', [line({ baseAmount: '1000', taxAmount: '100', isImport: true }), line({ baseAmount: '5000', taxAmount: '500' })]), g('02', [line({ baseAmount: '300', taxAmount: '30', isImport: true })])],
      totals: { baseAmount: '6300', taxAmount: '630' } } as never;
    expect(filterRegister(r, { groups: [], importOnly: false })).toBe(r);
    const imp = filterRegister(r, { groups: [], importOnly: true });
    expect([imp.groups.map((x) => [x.code, x.rows.length, x.baseTotal, x.taxTotal]), imp.totals]).toEqual([[['01', 1, '1000', '100'], ['02', 1, '300', '30']], { baseAmount: '1300', taxAmount: '130' }]);
    const g1 = filterRegister(r, { groups: ['01'], importOnly: false });
    expect([g1.groups.map((x) => x.code), g1.totals]).toEqual([['01'], { baseAmount: '6000', taxAmount: '600' }]);
  });

  it('mở từ tờ khai: gọi đúng chiều và kỳ trên đường dẫn, chỉ giữ nhóm được chọn, Bỏ lọc trả đủ nhóm', async () => {
    window.history.pushState({}, '', '/thue/bang-ke-hoa-don?direction=sale&year=2026&period=7&periodKind=month&group=02');
    try {
      apiMock.mockImplementation(async (url: string) => (url.startsWith('/api/tax/reconcile') ? reconcile : { ...register, groups: [...register.groups, { code: '02', name: 'Nhóm 02', rows: [line({ groupCode: '02', stt: 3, invoiceNo: 'X3' })], baseTotal: '1000000', taxTotal: '100000' }] }));
      renderPage();
      expect(await screen.findByText(/Đang lọc theo nhóm kê khai 02/)).toBeInTheDocument();
      const q = lastCall('/api/tax/invoices')!;
      expect([q.get('direction'), q.get('year'), q.get('period'), q.get('periodKind')]).toEqual(['sale', '2026', '7', 'month']);
      expect((await screen.findAllByTestId('row')).map((r) => cell(r, 'Tên người bán/mua'))).toEqual(['Nhóm 02 – Nhóm 02', 'Công ty A', 'Cộng nhóm 02', 'Tổng cộng']);
      await userEvent.click(screen.getByRole('button', { name: 'Bỏ lọc' }));
      expect((await screen.findAllByTestId('row')).length).toBeGreaterThan(4);
    } finally { window.history.pushState({}, '', '/'); }
  });

  it('registerRows: kỳ không có hóa đơn thì không có dòng tổng', () => {
    expect(registerRows({ ...register, groups: [], otherTaxes: { rows: [], baseTotal: '0', taxTotal: '0' } } as never)).toEqual([]);
  });
});
