import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { voucherTypeDef, type TaxDef, type TaxDistribution } from '@kt/domain';
import InvoiceEditor from '../src/pages/InvoiceForm.js';
import { declaredBody } from '../src/pages/DeclaredInvoices.js';

type Row = Record<string, string>;
const mocks = vi.hoisted(() => {
  class ApiError extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } }
  return { api: vi.fn(), ApiError, navigate: vi.fn(), grid: { props: null as null | { rows: Record<string, string>[]; onRowsChange(r: unknown[]): void; addRowTemplate(): Record<string, string> } },
    lookupRows: {} as Record<string, object> };
});
vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate, useParams: () => ({}) }));
// lưới AG Grid không chạy trong jsdom: mô phỏng đúng cách nó làm việc (ghi thẳng vào đối tượng dòng, rồi báo mảng mới); phím và ô sửa được kiểm bằng Playwright (e2e/hoa-don.spec.ts)
vi.mock('@kt/ui', async () => {
  const { createElement: h } = await import('react');
  return {
    KeyboardGrid: (p: typeof mocks.grid.props) => { mocks.grid.props = p; return null; },
    LookupSelect: (p: { catalog: string; onChange?: (c: string | null, r: object | null) => void }) =>
      h('input', { 'aria-label': `lookup-${p.catalog}`, onChange: (e: { target: { value: string } }) => p.onChange?.(e.target.value || null, mocks.lookupRows[e.target.value] ?? null) }),
    VnNumberInput: (p: { 'aria-label'?: string; onChange?: (v: string | null) => void }) => h('input', { 'aria-label': p['aria-label'], onChange: (e: { target: { value: string } }) => p.onChange?.(e.target.value || null) }),
    useUnsavedChanges: () => (proceed: () => void) => proceed(),
  };
});

vi.setConfig({ testTimeout: 60_000 }); // antd Form + Tabs + DatePicker trong jsdom chậm khi máy bận
const slow = { timeout: 20_000 };

// Phân bổ mặc định như seed_tenant_defaults: mua 1331, bán 33311.
const dist = (): TaxDistribution[] => (['invoice', 'refund'] as const).flatMap((documentType) => [
  { documentType, scope: 'purchase' as const, lineType: 'tax' as const, factorPercent: '100', accountCode: '1331', reportTag: 'purchase_tax' },
  { documentType, scope: 'sale' as const, lineType: 'tax' as const, factorPercent: '100', accountCode: '33311', reportTag: 'sale_tax' }]);
const taxRow = (code: string, rate: string | null, scope: 'sale' | 'purchase' | 'both' = 'both', extra: Partial<TaxDef> = {}) =>
  ({ code, name: `Thuế ${code}`, scope, isActive: true, def: { code, kind: 'vat', method: 'deduct', rate, priceInclude: false, distributions: dist(), ...extra } as TaxDef });
const TAX_DEFS = [taxRow('V0', '0.00'), taxRow('V5', '5.00'), taxRow('V10', '10.00'), taxRow('KCT', null, 'both', { method: 'none' })];
const GROUPS = [{ id: 1, scope: 'purchase', code: '01', name: 'HHDV dùng riêng', rate: null }, { id: 2, scope: 'sale', code: '10', name: 'Bán ra 10%', rate: '10.0000' },
  { id: 3, scope: 'sale', code: '05', name: 'Bán ra 5%', rate: '5.0000' }, { id: 4, scope: 'sale', code: 'KCT', name: 'Bán ra không chịu thuế', rate: null }];

const renderNew = (type: 'HDB' | 'HDM' | 'GGB' | 'GGM' = 'HDB') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InvoiceEditor def={voucherTypeDef(type)!} id="moi" /></QueryClientProvider>);
// Người dùng sửa ô: AG Grid ghi vào đối tượng dòng tại chỗ rồi báo mảng mới.
const edit = (i: number, patch: Row) => {
  act(() => { const g = mocks.grid.props!; if (!g.rows[i]) g.onRowsChange([...g.rows, g.addRowTemplate()]); });
  act(() => { const g = mocks.grid.props!; Object.assign(g.rows[i]!, patch); g.onRowsChange([...g.rows]); });
};
const taxCol = () => mocks.grid.props!.rows.map((r) => r.taxAmount);
const ledger = () => [...screen.getByTestId('ledger-preview').querySelectorAll('tbody tr.ant-table-row')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));
const ledgerSides = () => ledger().map((r) => [r[0], r[2], r[3]]); // [tài khoản, Nợ, Có]; ô 0 đồng để trống
const post = () => mocks.api.mock.calls.find(([p, init]) => p === '/api/invoices' && (init as { method?: string } | undefined)?.method === 'POST');

describe('Màn hình hóa đơn dịch vụ: thuế và bút toán xem trước bằng động cơ thuế của @kt/domain', () => {
  beforeEach(() => {
    mocks.grid.props = null; mocks.navigate.mockReset();
    mocks.lookupRows = { KH001: { id: 1, code: 'KH001', name: 'Công ty A', tax_code: '0100109106', address: '12 Phố Huế, Hà Nội', default_account_code: null } };
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/invoices/tax-defs') return TAX_DEFS;
      if (path.startsWith('/api/catalogs/invoice_group')) return { rows: GROUPS, total: GROUPS.length };
      if (path === '/api/invoices' && init?.method === 'POST') return { id: 'i1', voucherType: 'HDB', voucherNo: null, state: 'draft', version: 1 };
      return [];
    });
  });
  afterEach(() => { mocks.api.mockReset(); });

  it('nhập 2 dòng: tiền thuế từng dòng ghi vào cột tự tính, bút toán xem trước Nợ 131 / Có 5113 / Có 33311', async () => {
    renderNew();
    expect(await screen.findByRole('tab', { name: 'Hàng tiền' })).toBeInTheDocument();
    for (const t of ['Thuế', 'Hóa đơn', 'Hạch toán']) expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
    edit(0, { description: 'Phí tư vấn', accountCode: '5113', amount: '1000000', taxCodes: 'V10' });
    edit(1, { description: 'Phí đào tạo', accountCode: '5113', amount: '500000', taxCodes: 'V10' });
    await vi.waitFor(() => expect(taxCol()).toEqual(['100000', '50000']), slow);
    expect(ledgerSides()).toEqual([['5113', '', '1.000.000'], ['5113', '', '500.000'], ['33311', '', '150.000'], ['131', '1.650.000', '']]);
  }, 60_000);

  it('đổi mã thuế V10 sang V5: tiền thuế và bút toán đổi theo', async () => {
    renderNew();
    edit(0, { accountCode: '5113', amount: '1000000', taxCodes: 'V10' });
    await vi.waitFor(() => expect(taxCol()[0]).toBe('100000'), slow);
    edit(0, { taxCodes: 'V5' });
    await vi.waitFor(() => expect(taxCol()[0]).toBe('50000'), slow);
    expect(ledgerSides()).toEqual([['5113', '', '1.000.000'], ['33311', '', '50.000'], ['131', '1.050.000', '']]);
  }, 60_000);

  it('thành tiền = số lượng × đơn giá, chiết khấu theo %, thuế tính trên tiền sau chiết khấu; sửa tay chiết khấu thì bỏ %', async () => {
    renderNew();
    edit(0, { accountCode: '5113', quantity: '3', unitPrice: '200000', taxCodes: 'V10' });
    await vi.waitFor(() => expect(mocks.grid.props!.rows[0]!.amount).toBe('600000'), slow);
    edit(0, { discountRate: '10' });
    await vi.waitFor(() => expect(mocks.grid.props!.rows[0]!.discount).toBe('60000'), slow);
    await vi.waitFor(() => expect(taxCol()[0]).toBe('54000'), slow);
    edit(0, { discount: '100000' });
    await vi.waitFor(() => expect(taxCol()[0]).toBe('50000'), slow);
    expect(mocks.grid.props!.rows[0]!.discountRate).toBe('');
  }, 60_000);

  it('thuế ghi trên hóa đơn lệch 1 đồng thì không lỗi (dồn vào dòng thuế), lệch 1.000 đồng thì báo TAX_DECLARED_MISMATCH', async () => {
    renderNew();
    edit(0, { accountCode: '5113', amount: '1000000', taxCodes: 'V10' });
    await vi.waitFor(() => expect(taxCol()[0]).toBe('100000'), slow);
    const declared = await screen.findByLabelText('Thuế ghi trên hóa đơn V10');
    fireEvent.change(declared, { target: { value: '100001' } });
    await vi.waitFor(() => expect(ledgerSides()).toEqual([['5113', '', '1.000.000'], ['33311', '', '100.001'], ['131', '1.100.001', '']]), slow);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(declared, { target: { value: '101000' } });
    expect(await screen.findByText(/TAX_DECLARED_MISMATCH/, undefined, slow)).toBeInTheDocument();
  }, 60_000);

  it('dung sai thuế ghi trên hóa đơn bằng số dòng mang mã: 2 dòng lệch 2 đồng được, lệch 3 đồng thì lỗi', async () => {
    renderNew();
    edit(0, { accountCode: '5113', amount: '333333', taxCodes: 'V10' });
    edit(1, { accountCode: '5113', amount: '333333', taxCodes: 'V10' });
    await vi.waitFor(() => expect(taxCol()).toEqual(['33333', '33333']), slow);
    const declared = await screen.findByLabelText('Thuế ghi trên hóa đơn V10');
    fireEvent.change(declared, { target: { value: '66668' } });
    await vi.waitFor(() => expect(ledger().map((r) => r[3])).toContain('66.668'), slow);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(declared, { target: { value: '66669' } });
    expect(await screen.findByText(/TAX_DECLARED_MISMATCH/, undefined, slow)).toBeInTheDocument();
  }, 60_000);

  it('mã số thuế, tên và địa chỉ ở tab Hóa đơn lấy từ đối tượng đã chọn', async () => {
    renderNew();
    fireEvent.change(screen.getByLabelText('lookup-party'), { target: { value: 'KH001' } });
    expect(await screen.findByDisplayValue('0100109106')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Công ty A')).toBeInTheDocument();
    expect(screen.getByDisplayValue('12 Phố Huế, Hà Nội')).toBeInTheDocument();
  }, 60_000);

  it('Lưu gửi POST /api/invoices: dòng hàng, mã thuế, nhóm kê khai mặc định theo thuế suất và thuế ghi trên hóa đơn', async () => {
    renderNew();
    fireEvent.change(screen.getByLabelText('lookup-party'), { target: { value: 'KH001' } });
    edit(0, { description: 'Phí tư vấn', accountCode: '5113', amount: '1000000', taxCodes: 'V10' });
    await vi.waitFor(() => expect(taxCol()[0]).toBe('100000'), slow);
    fireEvent.change(await screen.findByLabelText('Thuế ghi trên hóa đơn V10'), { target: { value: '100001' } });
    fireEvent.change(screen.getByLabelText('Số hóa đơn'), { target: { value: '0000123' } });
    fireEvent.click(screen.getByRole('button', { name: /Lưu/ }));
    await vi.waitFor(() => expect(post()).toBeDefined(), slow);
    const json = (post()![1] as { json: Record<string, unknown> }).json;
    expect(json).toMatchObject({ voucherType: 'HDB', partyCode: 'KH001', currencyCode: 'VND',
      items: [{ description: 'Phí tư vấn', accountCode: '5113', amountCurrency: '1000000', discountCurrency: '0', taxCodes: ['V10'] }],
      invoice: { invoiceNo: '0000123', invoiceGroupCode: '10', declaredTax: { V10: '100001' } } });
    expect((json['items'] as unknown[]).length).toBe(1); // dòng trống không gửi
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/chung-tu/$type/$id', params: { type: 'HDB', id: 'i1' } }), slow);
  }, 60_000);

  it('hóa đơn mua trùng: thông báo kèm liên kết mở chứng từ đã nhập', async () => {
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/invoices/tax-defs') return TAX_DEFS;
      if (path.startsWith('/api/catalogs/invoice_group')) return { rows: GROUPS, total: GROUPS.length };
      if (path === '/api/invoices' && init?.method === 'POST') throw new mocks.ApiError('INVOICE_DUPLICATE', 'Hóa đơn 01GTKT 1C26TAA 0000123 đã nhập ở chứng từ HDM00007');
      if (path.startsWith('/api/vouchers?')) return { rows: [{ id: 'v7', voucherType: 'HDM', voucherNo: 'HDM00007' }], total: 1 };
      return [];
    });
    renderNew('HDM');
    fireEvent.change(screen.getByLabelText('lookup-party'), { target: { value: 'KH001' } });
    edit(0, { accountCode: '6422', amount: '1000000', taxCodes: 'V10' });
    await vi.waitFor(() => expect(taxCol()[0]).toBe('100000'), slow);
    fireEvent.change(screen.getByLabelText('Số hóa đơn'), { target: { value: '0000123' } });
    fireEvent.click(screen.getByRole('button', { name: /Lưu/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mở chứng từ HDM00007' }, slow));
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/chung-tu/$type/$id', params: { type: 'HDM', id: 'v7' } }), slow);
    expect(mocks.api).toHaveBeenCalledWith('/api/vouchers?q=HDM00007&size=5');
  }, 60_000);
});

describe('Hóa đơn kê khai nhập tay trên PC/BN/PKT: declaredBody', () => {
  const row = (o: Record<string, string> = {}) => ({ formNo: '01GTKT', serial: 'AA/26E', invoiceNo: '12', invoiceDate: '2026-01-05', invoiceGroupCode: '01', taxCode: 'V10', baseAmount: '1000000', taxAmount: '100000', partyCode: '', note: '', ...o });
  it('bỏ dòng trống, đổi dòng đủ thông tin sang thân yêu cầu (đối tượng trống thì không gửi)', () => {
    expect(declaredBody([row(), { ...row(), formNo: '', serial: '', invoiceNo: '', invoiceDate: '', invoiceGroupCode: '', taxCode: '', baseAmount: '', taxAmount: '' }])).toEqual([
      { formNo: '01GTKT', serial: 'AA/26E', invoiceNo: '12', invoiceDate: '2026-01-05', invoiceGroupCode: '01', taxCode: 'V10', baseAmount: '1000000', taxAmount: '100000' }]);
    expect(declaredBody([row({ partyCode: 'NCC1', note: 'ghi chú' })])[0]).toMatchObject({ partyCode: 'NCC1', note: 'ghi chú' });
  });
  it('dòng thiếu thông tin bắt buộc: lỗi tiếng Việt nêu số dòng và trường', () => {
    expect(() => declaredBody([row(), row({ invoiceNo: '' })])).toThrow('Hóa đơn dòng 2: nhập số hóa đơn');
    expect(() => declaredBody([row({ invoiceDate: '' })])).toThrow('Hóa đơn dòng 1: nhập ngày hóa đơn');
    expect(() => declaredBody([row({ taxCode: '' })])).toThrow('Hóa đơn dòng 1: chọn mã thuế');
  });
});
