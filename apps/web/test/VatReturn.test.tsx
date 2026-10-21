import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import VatReturnPage, { periodEnd, supplementNotes, type TaxReturn } from '../src/pages/VatReturn.js';
import { ApiError } from '../src/api/client.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ denied: new Set<string>() }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: (p: string) => !perms.denied.has(p) }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));
vi.mock('@kt/ui', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRememberedFilter: (_k: string, init: object) => [{ ...init, year: 2026, period: 7 }, () => undefined] }));

const TEMPLATE = { version: 'TT89', validFrom: '2026-07-01', source: 'TT 89/2026', lines: [
  { code: '21', label: 'Không phát sinh hoạt động mua, bán trong kỳ', section: 'A', kind: 'flag' },
  { code: '22', label: 'Thuế GTGT còn được khấu trừ kỳ trước chuyển sang', section: 'B', kind: 'carry' },
  { code: '25', label: 'Thuế GTGT mua vào được khấu trừ kỳ này', section: 'C.I.2', kind: 'invoice', overridable: true, invoice: { direction: 'purchase', groups: ['01', '03'], field: 'tax' } },
  { code: '32', label: 'Bán ra chịu thuế suất 10%', section: 'C.II.2.c', kind: 'invoice', invoice: { direction: 'sale', groups: ['10', '08'], field: 'base' } },
  { code: '36', label: 'Thuế GTGT phát sinh trong kỳ', section: 'C.III', kind: 'formula', formula: '[35]-[25]' },
  { code: '37', label: 'Điều chỉnh giảm', section: 'C.IV.1', kind: 'manual' },
  { code: '43', label: 'Còn được khấu trừ chuyển kỳ sau', section: 'C.VI.4.2', kind: 'formula', formula: '[41]-[42]' }] };
const ret = (o: Partial<TaxReturn> = {}): TaxReturn => ({ id: 1, formCode: '01/GTGT', templateVersion: 'TT89', periodKind: 'month', year: 2026, period: 7, revision: 0, status: 'draft',
  values: { '21': '', '22': '0', '25': '5000000', '32': '300000000', '36': '25000000', '37': '', '43': '0' }, overrides: {}, createdAt: '2026-08-01T01:00:00Z', finalizedAt: null, ...o });
let list: TaxReturn[] = []; let tplError: ApiError | null = null; let finalizeError: ApiError | null = null;
const PREVIEW = { hints: { '37': 'Gợi ý 1000000: tờ khai bổ sung tháng 5/2026 lần 1 làm giảm số thuế còn được khấu trừ' }, warnings: ['Chỉ tiêu [25] phân bổ thuế đầu vào dùng chung là gợi ý của phần mềm'], carryLocked: false, changed: [] as { code: string; stored: string | null; fresh: string | null }[] };
const calls = () => apiMock.mock.calls as [string, { method?: string; json?: Record<string, unknown> } | undefined][];

const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VatReturnPage /></QueryClientProvider>);

beforeEach(() => {
  list = [ret()]; tplError = null; finalizeError = null; PREVIEW.changed = []; PREVIEW.carryLocked = false; perms.denied = new Set();
  apiMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/settings') return { vat_period: 'month' };
    if (url.startsWith('/api/tax/vat-template')) { if (tplError) throw tplError; return TEMPLATE; }
    if (url === '/api/tax/vat-returns') return list;
    if (url === '/api/tax/xml-formats') return [{ id: 'htkk-01gtgt', formCode: '01/GTGT', verified: false }];
    if (url.endsWith('/hints')) return PREVIEW;
    if (url.endsWith('/finalize')) { if (finalizeError) throw finalizeError; return ret({ status: 'final' }); }
    if (init?.method === 'PUT') return ret();
    if (url === '/api/tax/vat-offset') return { date: '2026-07-31', amount: '1000000', laterOffsetDates: ['2026-08-31'], warnings: ['Chạy lại khấu trừ thuế theo thứ tự các ngày 31/08/2026'], unchanged: false, voucherId: 'v1' };
    return ret();
  });
});
afterEach(() => { apiMock.mockReset(); });

describe('Tờ khai thuế GTGT', () => {
  it('nháp: [37] nhập tay sửa được, [36] tính từ công thức chỉ đọc; dòng dựng từ mẫu; gợi ý và cảnh báo hiện', async () => {
    renderPage();
    expect(await screen.findByRole('textbox', { name: 'Chỉ tiêu 37' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Chỉ tiêu 22' })).toBeInTheDocument(); // [22] kỳ trước chưa chốt: nhập tay
    expect(screen.getByRole('textbox', { name: 'Chỉ tiêu 25' })).toBeInTheDocument();  // ghi đè được
    expect(screen.queryByRole('textbox', { name: 'Chỉ tiêu 36' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Chỉ tiêu 32' })).toBeNull();
    const row36 = screen.getByText('[36]').closest('tr')!; expect(within(row36).getByText('25.000.000')).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBe(TEMPLATE.lines.length + 1); // tiêu đề + đúng các dòng của mẫu
    expect(await screen.findByText(/Gợi ý 1000000/)).toBeInTheDocument();
    expect(screen.getByText(/phân bổ thuế đầu vào dùng chung là gợi ý/)).toBeInTheDocument();
    const link = within(screen.getByText('[32]').closest('tr')!).getByRole('link');
    expect(link.getAttribute('href')).toBe('/thue/bang-ke-hoa-don?direction=sale&year=2026&period=7&periodKind=month&group=10%2C08&field=base');
  });

  it('Tính lại gửi chỉ tiêu nhập tay đã sửa kèm ghi đè hiện có', async () => {
    renderPage();
    const box = await screen.findByRole('textbox', { name: 'Chỉ tiêu 37' });
    await userEvent.type(box, '1500000'); await userEvent.tab();
    await userEvent.click(screen.getByRole('button', { name: /Tính lại/ }));
    const put = calls().find(([u, i]) => u === '/api/tax/vat-returns/1' && i?.method === 'PUT')!;
    expect(put[1]!.json).toEqual({ manual: { '22': '0', '37': '1500000' }, overrides: {} });
  });

  it('đã chốt: mọi ô khóa, không có ô nhập; Xuất XML và Lập bổ sung dùng được, Chốt ẩn', async () => {
    list = [ret({ status: 'final', finalizedAt: '2026-08-10T03:00:00Z' })];
    renderPage();
    await screen.findByText('[37]');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Xuất XML' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Lập bổ sung' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chốt' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Lập bổ sung' }));
    expect(calls().some(([u, i]) => u === '/api/tax/vat-returns' && i?.method === 'POST' && JSON.stringify(i.json) === JSON.stringify({ year: 2026, periodKind: 'month', period: 7, revision: 1 }))).toBe(true);
  });

  it('đã chốt: cảnh báo XML chưa kiểm chứng với HTKK hiện ngay cạnh nút, trước khi tải', async () => {
    list = [ret({ status: 'final', finalizedAt: '2026-08-10T03:00:00Z' })];
    renderPage();
    expect(await screen.findByText('XML chưa kiểm chứng với HTKK')).toBeInTheDocument();
    expect(calls().some(([u]) => u === '/api/tax/xml-formats')).toBe(true);
  });

  it('thiếu quyền tax.view: không có nút Xuất XML, không gọi danh sách định dạng', async () => {
    perms.denied = new Set(['tax.view']); list = [ret({ status: 'final', finalizedAt: '2026-08-10T03:00:00Z' })];
    renderPage();
    await screen.findByText('[37]');
    expect(screen.queryByRole('button', { name: 'Xuất XML' })).toBeNull();
    expect(calls().some(([u]) => u === '/api/tax/xml-formats')).toBe(false);
  });

  it('kỳ trước đã chốt (carryLocked): [22] khóa; Tính lại không gửi [22]; có sửa [37] vẫn gửi [37]', async () => {
    PREVIEW.carryLocked = true;
    renderPage();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Chỉ tiêu 37' }), '1500000'); await userEvent.tab();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Chỉ tiêu 22' })).toBeNull());
    expect(screen.getByText('Lấy từ tờ khai kỳ trước đã chốt')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Tính lại/ }));
    const put = calls().find(([u, i]) => u === '/api/tax/vat-returns/1' && i?.method === 'PUT')!;
    expect(put[1]!.json).toEqual({ manual: { '37': '1500000' }, overrides: {} });
  });

  it('nháp: Xuất XML bị khóa cho tới khi chốt', async () => {
    renderPage();
    await screen.findByText('[37]');
    expect(screen.getByRole('button', { name: 'Xuất XML' })).toBeDisabled();
  });

  it('chốt gặp 409 TAX_RETURN_STALE: nêu các chỉ tiêu lệch (đã lưu, theo sổ) và cho lưu lại nháp', async () => {
    finalizeError = new ApiError('TAX_RETURN_STALE', 'Số liệu sổ đã thay đổi', 409, { changed: [{ code: '32', stored: '300000000', fresh: '350000000' }, { code: '37', stored: null, fresh: '1000' }] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Chốt' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Chốt' })); // hộp xác nhận
    expect(await screen.findByText(/\[32\]: đã lưu 300\.000\.000 → theo sổ hiện tại 350\.000\.000/)).toBeInTheDocument();
    expect(screen.getByText(/\[37\]: đã lưu \(trống\) → theo sổ hiện tại 1\.000/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu lại nháp' }));
    expect(calls().some(([u, i]) => u === '/api/tax/vat-returns/1' && i?.method === 'PUT')).toBe(true);
  });

  it('kỳ trước 01/7/2026: hiện thông báo VAT_TEMPLATE_UNAVAILABLE của máy chủ, không dựng bảng', async () => {
    tplError = new ApiError('VAT_TEMPLATE_UNAVAILABLE', 'Không có mẫu tờ khai 01/GTGT áp dụng cho tháng 6/2026', 409);
    renderPage();
    expect(await screen.findByText('Không có mẫu tờ khai 01/GTGT áp dụng cho tháng 6/2026')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('chưa có tờ khai kỳ này: hiện nút Tính tờ khai', async () => {
    list = [];
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Tính tờ khai' }));
    expect(calls().some(([u, i]) => u === '/api/tax/vat-returns' && i?.method === 'POST' && JSON.stringify(i.json) === JSON.stringify({ year: 2026, periodKind: 'month', period: 7 }))).toBe(true);
  });

  it('khấu trừ thuế cuối kỳ: kết quả có ngày sau thì cảnh báo chạy lại theo thứ tự', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Khấu trừ thuế cuối kỳ' }));
    expect(await screen.findByDisplayValue('31/07/2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chạy khấu trừ' }));
    expect(await screen.findByText('Đã có khấu trừ các ngày sau tính trên số dư cũ')).toBeInTheDocument();
    expect(screen.getByText(/theo thứ tự các ngày 31\/08\/2026/)).toBeInTheDocument();
    expect(calls().some(([u, i]) => u === '/api/tax/vat-offset' && JSON.stringify(i?.json) === JSON.stringify({ date: '2026-07-31' }))).toBe(true);
  });
});

describe('tờ khai bổ sung và kỳ phát hiện', () => {
  const first = (o: Partial<TaxReturn>) => ret({ status: 'final', finalizedAt: '2026-08-05T00:00:00Z', ...o });
  const disc = (period: number) => ({ discovery: { year: 2026, periodKind: 'month' as const, period } }); // kỳ phát hiện do máy chủ tính
  it('ngày cuối kỳ', () => {
    expect([periodEnd('month', 2026, 2), periodEnd('quarter', 2026, 3)]).toEqual(['2026-02-28', '2026-09-30']);
  });
  it('bổ sung đã chốt: chênh lệch [43] so với lần trước; kỳ phát hiện đã có tờ khai chốt thì nhắc không khai lại', () => {
    const all = [first({ id: 1, period: 5, values: { '43': '4000000' } }), first({ id: 2, period: 5, revision: 1, values: { '43': '3000000' }, finalizedAt: '2026-08-12T02:00:00Z', ...disc(8) }), first({ id: 3, period: 8, finalizedAt: '2026-09-05T00:00:00Z' })];
    const notes = supplementNotes(all);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.delta).toBe('-1000000'); expect(notes[0]!.foundIn).toEqual({ year: 2026, period: 8, kind: 'month' }); expect(notes[0]!.foundFinal?.id).toBe(3);
    expect(supplementNotes(all.filter((r) => r.id !== 3))[0]!.foundFinal).toBeNull();
  });
  it('màn hình hiện nhắc nhở khi kỳ phát hiện đã chốt', async () => {
    list = [ret({ id: 3, period: 7 }), first({ id: 1, period: 5, values: { '43': '4000000' } }), first({ id: 2, period: 5, revision: 1, values: { '43': '3000000' }, finalizedAt: '2026-08-12T02:00:00Z', ...disc(8) }), first({ id: 4, period: 8, finalizedAt: '2026-09-05T00:00:00Z' })];
    renderPage();
    expect(await screen.findByText(/Tờ khai kỳ đó đã chốt: nếu đã khai \[37\]\/\[38\] cho chênh lệch này thì không khai lại/)).toBeInTheDocument();
  });
});
