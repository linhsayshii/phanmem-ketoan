import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ApprovalsPage from '../src/pages/Approvals.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c), me: { userId: 'u1' } }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock, apiBlob: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@kt/ui', async (orig) => ({ ...(await orig<object>()), LookupSelect: () => null, VnNumberInput: () => null }));

const req = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, kind: 'advance', kindLabel: 'Đề nghị tạm ứng', requestNo: `TU0000${n}`, requestDate: '2026-10-20', requesterName: 'Nhân viên', partyCode: null, partyName: null, payeeName: `Người nhận ${n}`,
  reason: 'Tạm ứng', currencyCode: 'VND', amountCurrency: '1000000', fxRate: null, amount: '1000000', accountCode: '141', payMethod: 'cash', bankAccountNo: null, dueDate: null, state: 'submitted', steps: [], currentStep: 1, rejectReason: null, voucherId: null, voucherNo: null, voucherType: null });

describe('Hộp duyệt: từ chối hàng loạt', () => {
  const realMatchMedia = window.matchMedia;
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApprovalsPage /></QueryClientProvider>);
  beforeEach(() => {
    perms.has = () => true;
    // màn hình rộng: Grid.useBreakpoint báo md, thanh công cụ hàng loạt mới hiện
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: true, media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; json?: { ids: string[]; reason: string } }) => {
      if (path === '/api/approvals/inbox/count') return { count: 3 };
      if (path.startsWith('/api/approvals?box=inbox')) return [req(1), req(2), req(3)];
      if (path === '/api/approvals/batch/reject') return { rejected: 1, failed: 1, results: [{ id: opts!.json!.ids[0], ok: true, state: 'rejected' }, { id: opts!.json!.ids[1], ok: false, message: 'Đề nghị đã được xử lý' }] };
      return [];
    });
  });
  afterEach(() => { cleanup(); apiMock.mockReset(); window.matchMedia = realMatchMedia; });

  it('chọn hai đề nghị, bắt buộc nhập lý do, gửi ids và lý do, báo kết quả từng đề nghị', async () => {
    renderPage();
    const reject = await screen.findByRole('button', { name: 'Từ chối hàng loạt' });
    expect(reject).toBeDisabled(); // chưa chọn đề nghị nào
    await userEvent.click(await screen.findByRole('row', { name: /TU00001/ }).then((r) => within(r).getByRole('checkbox')));
    await userEvent.click(within(screen.getByRole('row', { name: /TU00002/ })).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Từ chối 2 đề nghị đã chọn' }));

    const dlg = await screen.findByRole('dialog', { name: 'Từ chối hàng loạt' });
    const ok = within(dlg).getByRole('button', { name: 'Từ chối' });
    expect(ok).toBeDisabled(); // lý do bắt buộc
    await userEvent.type(within(dlg).getByLabelText('Lý do từ chối'), '  Thiếu chứng từ  ');
    expect(ok).toBeEnabled();
    await userEvent.click(ok);

    expect(apiMock).toHaveBeenCalledWith('/api/approvals/batch/reject', { method: 'POST', json: { ids: [req(1).id, req(2).id], reason: 'Thiếu chứng từ' } });
    expect(await screen.findByText('Kết quả từ chối hàng loạt')).toBeInTheDocument();
    expect(screen.getByText('Đã từ chối 1 đề nghị, 1 đề nghị không từ chối được')).toBeInTheDocument();
    expect(screen.getByText('TU00002: Đề nghị đã được xử lý')).toBeInTheDocument();
  });

  it('thiếu quyền duyệt thì không có hộp duyệt và nút từ chối hàng loạt', async () => {
    perms.has = (c) => c !== 'approval_request.approve';
    renderPage();
    await screen.findByText('Đề nghị thanh toán, tạm ứng');
    expect(screen.queryByRole('button', { name: /Từ chối/ })).not.toBeInTheDocument();
  });
});
