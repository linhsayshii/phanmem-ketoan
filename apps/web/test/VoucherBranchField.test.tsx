import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Form } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VoucherBranchField } from '../src/pages/VoucherBranchField.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const list = { headOffice: { inScope: true }, rows: [{ id: 5, code: 'HN', name: 'Chi nhánh Hà Nội', taxCode: null, parentCode: null, isActive: true, inScope: true }] };
const setup = (branches: object, voucherBranch: 'HO' | number = 5) => apiMock.mockImplementation(async (path: string) => {
  if (path === '/api/branches') return branches;
  if (path === '/api/me/branch') return { scope: null, working: 'HO' };
  if (path.endsWith('/branch')) return { branch: voucherBranch };
  return {};
});
const renderField = (props: { voucherId?: string; editable: boolean; onPick?: (b: 'HO' | number | undefined) => void }) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Form layout="vertical"><VoucherBranchField voucherId={props.voucherId} editable={props.editable} onPick={props.onPick} /></Form></QueryClientProvider>);

describe('Ô chi nhánh trên chứng từ', () => {
  afterEach(() => { cleanup(); apiMock.mockReset(); });

  it('công ty chưa có chi nhánh: không hiện ô', async () => {
    setup({ headOffice: { inScope: true }, rows: [] });
    renderField({ editable: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Chi nhánh')).not.toBeInTheDocument();
  });

  it('chứng từ đã ghi sổ: chỉ xem tên chi nhánh', async () => {
    setup(list);
    renderField({ voucherId: 'v1', editable: false });
    expect(await screen.findByTestId('voucher-branch')).toHaveTextContent('Chi nhánh Hà Nội');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('chứng từ nháp: đổi chi nhánh gọi PUT /api/vouchers/:id/branch', async () => {
    setup(list);
    renderField({ voucherId: 'v1', editable: true });
    const box = await screen.findByRole('combobox', { name: 'Chi nhánh của chứng từ' });
    await userEvent.click(box);
    await userEvent.click(await screen.findByText('Trụ sở chính', { selector: '.ant-select-item-option-content' }));
    expect(apiMock).toHaveBeenCalledWith('/api/vouchers/v1/branch', { method: 'PUT', json: { branch: 'HO' } });
  });

  it('chứng từ mới: chọn chi nhánh khác chi nhánh làm việc thì báo qua onPick; chọn lại chi nhánh làm việc thì báo undefined', async () => {
    setup(list);
    const onPick = vi.fn();
    renderField({ editable: true, onPick });
    const box = await screen.findByRole('combobox', { name: 'Chi nhánh của chứng từ' });
    await userEvent.click(box);
    await userEvent.click(await screen.findByText('HN – Chi nhánh Hà Nội', { selector: '.ant-select-item-option-content' }));
    expect(onPick).toHaveBeenLastCalledWith(5);
    await userEvent.click(box);
    const ho = await screen.findAllByText('Trụ sở chính', { selector: '.ant-select-item-option-content' });
    await userEvent.click(ho[0]!);
    expect(onPick).toHaveBeenLastCalledWith(undefined);
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/branch'), expect.objectContaining({ method: 'PUT' }));
  });
});
