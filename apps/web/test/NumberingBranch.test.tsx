import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NumberingBranchPanel } from '../src/pages/NumberingBranch.js';

const apiMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ has: (_c: string): boolean => true }));
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: (c: string) => perms.has(c) }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const branches = { headOffice: { inScope: true }, rows: [{ id: 5, code: 'HN', name: 'Hà Nội', taxCode: null, parentCode: null, isActive: true, inScope: true }] };
const setup = (b: object, s: object = { perBranch: false, hqCode: 'TSC' }) => apiMock.mockImplementation(async (path: string) => (path === '/api/branches' ? b : path === '/api/voucher-numbering/settings' ? s : { ok: true }));
const renderPanel = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NumberingBranchPanel /></QueryClientProvider>);

describe('Đánh số theo chi nhánh (cấu hình)', () => {
  afterEach(() => { cleanup(); apiMock.mockReset(); perms.has = () => true; });

  it('công ty chưa có chi nhánh: không hiện', async () => {
    setup({ headOffice: { inScope: true }, rows: [] });
    renderPanel();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Đánh số theo chi nhánh')).not.toBeInTheDocument();
  });

  it('bật công tắc, nhập mã trụ sở chính rồi lưu gọi PUT cấu hình', async () => {
    setup(branches);
    renderPanel();
    const sw = await screen.findByRole('switch', { name: 'Đánh số theo chi nhánh' });
    expect(sw).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Lưu cách đánh số' })).toBeDisabled();
    await userEvent.click(sw);
    const hq = await screen.findByLabelText('Mã trụ sở chính');
    await userEvent.clear(hq); await userEvent.type(hq, 'HO1');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu cách đánh số' }));
    expect(apiMock).toHaveBeenCalledWith('/api/voucher-numbering/settings', { method: 'PUT', json: { perBranch: true, hqCode: 'HO1' } });
  });

  it('thiếu quyền sửa tùy chọn: công tắc khóa, không có nút lưu', async () => {
    perms.has = (c) => c !== 'setting.update';
    setup(branches, { perBranch: true, hqCode: 'TSC' });
    renderPanel();
    expect(await screen.findByRole('switch', { name: 'Đánh số theo chi nhánh' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Lưu cách đánh số' })).not.toBeInTheDocument();
  });
});
