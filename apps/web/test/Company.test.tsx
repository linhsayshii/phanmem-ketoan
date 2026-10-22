import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CompanyPage from '../src/pages/Company.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ me: { userId: 'u', tenantId: 't', sensitive: [] }, can: () => false }) }));
vi.mock('../src/api/client.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: apiMock }));

const SETTINGS = { book_form: 'NKC', costing_method: 'avg_period', base_currency: 'VND', fx_rate_type: 'transfer_avg', cash_negative: 'warn', fx_outflow_method: 'moving_average', vat_period: 'month', hidden_modules: [], extra_dims: [] };

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((url: string) => Promise.resolve(url === '/api/company' ? { code: 'ABC', name: 'Công ty ABC', taxCode: null, address: null, legalRep: null, chiefAccountant: null, phone: null, email: null } : url === '/api/settings' ? SETTINGS : {}));
});

describe('Thông tin công ty: tùy chọn hệ thống', () => {
  it('đổi kỳ khai thuế GTGT sang theo quý và lưu vat_period', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CompanyPage /></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('tab', { name: 'Tùy chọn hệ thống' }));
    expect(screen.getByText('Theo tháng')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Kỳ khai thuế GTGT' }));
    fireEvent.click(await screen.findByText('Theo quý', { selector: '.ant-select-item-option-content' }));
    const saves = screen.getAllByRole('button', { name: 'Lưu' });
    await userEvent.click(saves[saves.length - 1]!);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT', json: expect.objectContaining({ vat_period: 'quarter' }) })));
  });
});
