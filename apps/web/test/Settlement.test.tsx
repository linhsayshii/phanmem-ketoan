import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettlementPage from '../src/pages/Settlement.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: () => true }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

interface GridColumn {
  headerName?: string; field?: string; editable?: boolean; valueGetter?: (p: { data: unknown }) => unknown; valueFormatter?: (p: { value: unknown }) => string;
  valueParser?: (p: { newValue: string; oldValue: unknown; data: unknown }) => unknown;
}
// Lưới giả: mỗi dòng một khối, mỗi cột một ô mang tên cột; cột sửa được là ô nhập (Enter hoặc rời ô chốt qua valueParser như AG Grid, ghi thẳng vào đối tượng dòng).
vi.mock('@kt/ui', async (importOriginal) => {
  const { useState } = await import('react');
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    KeyboardGrid: ({ rows, columns, onRowsChange }: { rows: Record<string, unknown>[]; columns: GridColumn[]; onRowsChange: (r: Record<string, unknown>[]) => void }) => (
      <div data-testid="grid">{rows.map((r, i) => (
        <div key={i} data-testid="row">
          {columns.map((c) => {
            const raw = c.valueGetter ? c.valueGetter({ data: r }) : r[c.field ?? ''];
            if (c.editable === true && c.field) {
              const field = c.field;
              const commit = (text: string) => { const next = c.valueParser ? c.valueParser({ newValue: text, oldValue: r[field], data: r }) : text; if (next !== r[field]) { r[field] = next; onRowsChange([...rows]); } };
              return <input key={`${c.headerName}-${String(raw)}`} data-col={c.headerName} aria-label={`${c.headerName} ${String(r['docNo'])}`} defaultValue={String(raw ?? '')}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value); }} onBlur={(e) => commit(e.currentTarget.value)} />;
            }
            return <span key={c.headerName} data-col={c.headerName}>{c.valueFormatter ? c.valueFormatter({ value: raw }) : String(raw ?? '')}</span>;
          })}
        </div>))}</div>),
    LookupSelect: ({ placeholder, value, onChange }: { placeholder?: string; value?: string | null; onChange?: (v: string | null) => void }) =>
      <input aria-label={placeholder} value={value ?? ''} onChange={(e) => onChange?.(e.target.value || null)} />,
    useRememberedFilter: (_key: string, initial: unknown) => useState(initial),
  };
});

const item = (o: Record<string, unknown>) => ({ voucherId: 'v', voucherNo: null, voucherType: 'PKT', accountCode: '131', partyCode: 'KH001', dueDate: null, currency: 'VND', amountCurrency: '0', residualCurrency: '0', ...o });
const HD001 = item({ id: 1, docNo: 'HD001', docDate: '2026-03-01', dueDate: '2026-04-01', amount: '1000000', residual: '1000000' });
const PT001 = item({ id: 2, voucherType: 'PT', docNo: 'PT001', docDate: '2026-03-05', amount: '-600000', residual: '-600000' });
const USD_HD = item({ id: 3, docNo: 'HDUSD', docDate: '2026-03-02', currency: 'USD', amount: '2500000', amountCurrency: '100', residual: '2500000', residualCurrency: '100' });
const USD_PT = item({ id: 4, voucherType: 'PT', docNo: 'PTUSD', docDate: '2026-03-06', currency: 'USD', amount: '-2550000', amountCurrency: '-100', residual: '-2550000', residualCurrency: '-100' });
// khoản con của đánh giá lại: không còn nguyên tệ, chỉ còn dư VND, đi theo khoản gốc, không hiện ở màn đối trừ ngoại tệ
const USD_CHILD = item({ id: 5, voucherType: 'DG', docNo: 'DGUSD', docDate: '2026-03-31', currency: 'USD', amount: '50000', amountCurrency: '0', residual: '50000', residualCurrency: '0' });
let items: Record<string, unknown>[] = [];
let history: Record<string, unknown>[] = [];
let postResult: Record<string, unknown> = { groupId: 'g1', settlementIds: [1], fxVoucherId: null };

const calls = () => apiMock.mock.calls as [string, { method?: string; json?: Record<string, unknown> } | undefined][];
const posts = () => calls().filter(([u, i]) => u === '/api/settlements' && i?.method === 'POST').map(([, i]) => i!.json);
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SettlementPage /></QueryClientProvider>);
const debitSide = () => within(screen.getByRole('region', { name: 'Phát sinh Nợ còn dư' }));
const creditSide = () => within(screen.getByRole('region', { name: 'Phát sinh Có còn dư' }));
const pickParty = () => fireEvent.change(screen.getByLabelText('Đối tượng (F4)'), { target: { value: 'KH001' } });
// Gõ số đối trừ rồi Enter; để trống rồi Enter là lấy đủ số còn dư của khoản.
const enter = async (docNo: string, text: string) => {
  const input = screen.getByLabelText(`Số đối trừ ${docNo}`); await userEvent.clear(input);
  if (text) await userEvent.type(input, text);
  await userEvent.keyboard('{Enter}');
};
const settleButton = () => screen.getByRole('button', { name: /^Đối trừ \(Ctrl\+S\)/ });

describe('Đối trừ chứng từ', () => {
  beforeEach(() => {
    items = [HD001, PT001, USD_HD, USD_PT, USD_CHILD]; history = []; postResult = { groupId: 'g1', settlementIds: [1], fxVoucherId: null };
    apiMock.mockImplementation(async (url: string, init?: { method?: string; json?: Record<string, unknown> }) => {
      if (url.startsWith('/api/open-items')) return items;
      if (url === '/api/settlements' && init?.method === 'POST') return postResult;
      if (url.startsWith('/api/settlements/auto')) return { groups: 2, more: false };
      if (url.startsWith('/api/settlements/groups/')) return undefined;
      if (url.startsWith('/api/settlements')) return history;
      if (url.startsWith('/api/vouchers/')) return { voucherNo: 'CL00001' };
      throw new Error(`api không giả lập: ${url}`);
    });
  });
  afterEach(() => { apiMock.mockReset(); });

  it('chưa chọn đối tượng thì nhắc chọn; chọn rồi hai lưới chỉ liệt kê khoản đúng tài khoản, đối tượng và loại tiền (VND), Số đối trừ để trống', async () => {
    renderPage();
    expect(screen.getByText('Chọn đối tượng (F4) để xem các khoản còn dư')).toBeInTheDocument();
    expect(calls().filter(([u]) => u.startsWith('/api/open-items'))).toHaveLength(0);
    pickParty();
    expect(await debitSide().findByText('HD001')).toBeInTheDocument();
    expect(creditSide().getByText('PT001')).toBeInTheDocument();
    expect(screen.queryByText('HDUSD')).not.toBeInTheDocument();
    expect(screen.queryByText('PTUSD')).not.toBeInTheDocument();
    const q = new URLSearchParams(calls().filter(([u]) => u.startsWith('/api/open-items')).at(-1)![0].split('?')[1]);
    expect([q.get('accountCode'), q.get('partyCode')]).toEqual(['131', 'KH001']);
    const row = debitSide().getByTestId('row');
    expect([row.querySelector('[data-col="Ngày chứng từ"]')?.textContent, row.querySelector('[data-col="Hạn thanh toán"]')?.textContent, row.querySelector('[data-col="Dư VND"]')?.textContent])
      .toEqual(['01/03/2026', '01/04/2026', '1.000.000']);
    expect(screen.getByLabelText('Số đối trừ HD001')).toHaveValue('0'); // ô trống: Enter lấy đủ số còn dư
    expect(settleButton()).toBeDisabled();
  });

  it('nhập số đối trừ, Enter ở ô trống lấy đủ số còn dư; Nợ bằng Có thì Đối trừ gửi đúng một cặp', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await enter('HD001', '600000');
    expect(screen.getByText(/Tổng Nợ chọn/).textContent).toContain('600.000');
    await enter('PT001', ''); // đủ 600.000
    expect(screen.getByLabelText('Số đối trừ PT001')).toHaveValue('600000');
    expect(screen.getByText(/Tổng Có chọn/).textContent).toContain('600.000');
    expect(screen.getByText(/Chênh lệch/).textContent).toContain('0');
    expect(settleButton()).toBeEnabled();
    await userEvent.click(settleButton());
    await screen.findByText(/Đã đối trừ 1 cặp/);
    expect(posts()).toEqual([{ debitItemId: 1, creditItemId: 2, amount: '600000' }]);
  });

  it('Nợ chọn khác Có chọn thì khóa nút Đối trừ và hiện số chênh; số vượt số còn dư bị báo', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await enter('HD001', '600000'); await enter('PT001', '500000');
    expect(screen.getByText(/Chênh lệch/).textContent).toContain('100.000');
    expect(settleButton()).toBeDisabled();
    await enter('PT001', '700000'); // còn dư của PT001 chỉ 600.000
    expect(screen.getByText(/vượt số còn dư/).textContent).toContain('PT001');
    expect(settleButton()).toBeDisabled();
    await userEvent.click(settleButton());
    expect(posts()).toHaveLength(0);
  });

  it('nhiều khoản Nợ đối với một khoản Có: ghép lần lượt từng cặp theo thứ tự', async () => {
    items = [item({ id: 1, docNo: 'A', docDate: '2026-03-01', amount: '100000', residual: '100000' }), item({ id: 2, docNo: 'B', docDate: '2026-03-02', amount: '50000', residual: '50000' }),
      item({ id: 3, voucherType: 'PT', docNo: 'C', docDate: '2026-03-05', amount: '-150000', residual: '-150000' })];
    renderPage(); pickParty(); await debitSide().findByText('A');
    await enter('A', ''); await enter('B', ''); await enter('C', '');
    await userEvent.click(settleButton());
    await screen.findByText(/Đã đối trừ 2 cặp/);
    expect(posts()).toEqual([{ debitItemId: 1, creditItemId: 3, amount: '100000' }, { debitItemId: 2, creditItemId: 3, amount: '50000' }]);
  });

  it('ngoại tệ: chọn loại tiền thì hiện khoản nguyên tệ (bỏ khoản con đánh giá lại), gửi amountCurrency và hiện số chứng từ chênh lệch tỷ giá CL máy chủ tạo', async () => {
    postResult = { groupId: 'g1', settlementIds: [1, 2], fxVoucherId: 'vcl' };
    renderPage(); pickParty();
    fireEvent.change(screen.getByLabelText('Loại tiền (F4)'), { target: { value: 'USD' } });
    expect(await debitSide().findByText('HDUSD')).toBeInTheDocument();
    expect(screen.queryByText('HD001')).not.toBeInTheDocument();
    expect(screen.queryByText('DGUSD')).not.toBeInTheDocument();
    expect(debitSide().getByTestId('row').querySelector('[data-col="Nguyên tệ còn lại"]')?.textContent).toBe('100');
    await enter('HDUSD', ''); await enter('PTUSD', '');
    await userEvent.click(settleButton());
    expect(await screen.findByText(/CL00001/)).toBeInTheDocument();
    expect(posts()).toEqual([{ debitItemId: 3, creditItemId: 4, amountCurrency: '100' }]);
    expect(calls().some(([u]) => u === '/api/vouchers/vcl')).toBe(true);
  });

  it('Ctrl+S chạy Đối trừ khi đã cân', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await enter('HD001', '600000'); await enter('PT001', '');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByText(/Đã đối trừ 1 cặp/);
    expect(posts()).toEqual([{ debitItemId: 1, creditItemId: 2, amount: '600000' }]);
  });

  it('Ctrl+S khi ô lưới đang gõ dở (chưa Enter): chốt ô trước rồi mới đối trừ', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await enter('HD001', '600000');
    const input = screen.getByLabelText('Số đối trừ PT001'); await userEvent.clear(input); await userEvent.type(input, '600000');
    expect(input).toHaveFocus();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByText(/Đã đối trừ 1 cặp/);
    expect(posts()).toEqual([{ debitItemId: 1, creditItemId: 2, amount: '600000' }]);
  });

  it('Ctrl+S khi Nợ chọn khác Có chọn: không đối trừ, báo lý do', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await enter('HD001', '600000'); await enter('PT001', '500000');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await screen.findByText(/Tổng Nợ chọn khác tổng Có chọn, chênh lệch 100\.000/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('Ctrl+S ở thẻ Đã đối trừ không đối trừ dù lựa chọn ở thẻ Chọn vẫn còn, và báo phải quay lại thẻ Chọn', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await enter('HD001', '600000'); await enter('PT001', '');
    expect(settleButton()).toBeEnabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Đã đối trừ' }));
    expect(settleButton()).toBeDisabled();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await screen.findByText('Chuyển sang thẻ "Chọn để đối trừ" để đối trừ')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20)); // chờ lệnh hoãn của Ctrl+S (setTimeout 0)
    expect(posts()).toHaveLength(0);
    await userEvent.click(screen.getByRole('tab', { name: 'Chọn để đối trừ' })); // quay lại: vẫn đối trừ được
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByText(/Đã đối trừ 1 cặp/);
    expect(posts()).toHaveLength(1);
  });

  it('Đối trừ tự động: lời xác nhận nói rõ ghép mọi loại tiền của tài khoản, không riêng loại tiền đang chọn', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    fireEvent.change(screen.getByLabelText('Loại tiền (F4)'), { target: { value: 'USD' } });
    await userEvent.click(screen.getByRole('button', { name: 'Đối trừ tự động' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/TK 131 \(kể cả tài khoản con\), mọi loại tiền, đối tượng KH001/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Ngày đối trừ chọn tay thì gửi kèm date', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    fireEvent.change(screen.getByPlaceholderText('Mặc định theo chứng từ'), { target: { value: '31/03/2026' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Mặc định theo chứng từ'), { key: 'Enter' });
    await enter('HD001', '600000'); await enter('PT001', '');
    await userEvent.click(settleButton());
    await screen.findByText(/Đã đối trừ 1 cặp/);
    expect(posts()).toEqual([{ debitItemId: 1, creditItemId: 2, amount: '600000', date: '2026-03-31' }]);
  });

  it('Đối trừ tự động: hỏi xác nhận rồi gửi tài khoản, đối tượng và ngày', async () => {
    renderPage(); pickParty(); await debitSide().findByText('HD001');
    await userEvent.click(screen.getByRole('button', { name: 'Đối trừ tự động' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls().some(([u]) => u === '/api/settlements/auto')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Thực hiện' }));
    expect(await screen.findByText(/2 nhóm/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/settlements/auto', { method: 'POST', json: { accountCode: '131', partyCode: 'KH001', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });
  });

  it('Đã đối trừ: mỗi nhóm một dòng kèm số CL; Hủy đối trừ phải xác nhận mới gọi máy chủ; đối trừ đảo không hủy được', async () => {
    const row = (o: Record<string, unknown>) => ({ accountCode: '131', partyCode: 'KH001', currency: 'VND', amountCurrency: '0', fxVoucherId: null, fxVoucherNo: null, settleDate: '2026-03-05', ...o });
    history = [row({ id: 10, groupId: 'g1', kind: 'manual', debitDocNo: 'HD001', creditDocNo: 'PT001', amount: '600000' }),
      row({ id: 11, groupId: 'g2', kind: 'reversal', debitDocNo: 'HD002', creditDocNo: 'PT002', amount: '10000' }),
      row({ id: 12, groupId: 'g3', kind: 'manual', debitDocNo: 'HD003', creditDocNo: 'PT003', amount: '20000', fxVoucherId: 'vcl', fxVoucherNo: 'CL00007' }),
      row({ id: 13, groupId: 'g3', kind: 'fx', debitDocNo: 'HD003', creditDocNo: 'DG003', amount: '500', fxVoucherId: 'vcl', fxVoucherNo: 'CL00007' })];
    renderPage(); // không chọn đối tượng: lịch sử vẫn xem được theo tài khoản (đối tượng không bắt buộc)
    await userEvent.click(screen.getByRole('tab', { name: 'Đã đối trừ' }));
    expect(await screen.findByText('HD001')).toBeInTheDocument();
    expect(screen.getAllByText('CL00007')).toHaveLength(1); // dòng con fx gộp vào nhóm của nó
    const buttons = screen.getAllByRole('button', { name: 'Hủy đối trừ' });
    expect(buttons).toHaveLength(3);
    expect(buttons[1]).toBeDisabled();
    await userEvent.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(calls().some(([u]) => u.startsWith('/api/settlements/groups/'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/settlements/groups/g1', { method: 'DELETE' }));
  });
});
