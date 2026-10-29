import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BookFormsPage from '../src/pages/BookForms.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/auth.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../src/api/client.js', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>, useNavigate: () => vi.fn() }));
vi.mock('@kt/ui', async (orig) => ({ ...(await orig<object>()), LookupSelect: () => null, KeyboardGrid: () => null }));

const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BookFormsPage /></QueryClientProvider>);

describe('Hình thức sổ kế toán khi công ty chưa có năm tài chính', () => {
  beforeEach(() => { apiMock.mockReset(); apiMock.mockImplementation(async (path: string) => { if (path === '/api/fiscal-years') return []; throw new Error('không được gọi: ' + path); }); });

  it('báo bằng tiếng Việt, khóa nút chọn hình thức sổ, không gọi API với năm trống', async () => {
    renderPage();
    expect(await screen.findByText('Công ty chưa có năm tài chính')).toBeInTheDocument();
    for (const name of ['Nhật ký chung', 'Chứng từ ghi sổ', 'Nhật ký – Sổ Cái', 'Nhật ký – Chứng từ']) expect(screen.getByRole('radio', { name })).toBeDisabled();
    expect(screen.getByText(/chọn hình thức sổ kế toán/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thêm năm tài chính' })).toBeInTheDocument();
    expect(apiMock.mock.calls.map((c) => c[0])).toEqual(['/api/fiscal-years']);
  });

  it('có năm tài chính thì đọc hình thức sổ của năm đó và cho đổi', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return [{ fiscalYear: 2026, regime: 'TT99', dateFrom: '2026-01-01', dateTo: '2026-12-31' }];
      if (path === '/api/fiscal-years/2026/book-form') return { bookForm: 'NKC' };
      throw new Error('không được gọi: ' + path);
    });
    renderPage();
    expect(await screen.findByText(/Năm này dùng hình thức Nhật ký chung/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Chứng từ ghi sổ' })).toBeEnabled();
    expect(screen.queryByText(/chưa có năm tài chính/)).not.toBeInTheDocument();
  });
});
