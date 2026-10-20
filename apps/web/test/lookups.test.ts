import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountFetcherFor, regimeFor } from '../src/lookups.js';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const years = [
  { regime: 'TT133', dateFrom: '2025-01-01', dateTo: '2025-12-31' },
  { regime: 'TT99', dateFrom: '2026-01-01', dateTo: '2026-12-31' },
];
describe('chế độ kế toán theo ngày hạch toán', () => {
  it('lấy chế độ của năm tài chính chứa ngày; ngoài mọi năm hoặc chưa nhập thì năm cuối; chưa có năm nào thì TT99', () => {
    expect(regimeFor(years, '2025-06-30')).toBe('TT133');
    expect(regimeFor(years, '2026-01-01')).toBe('TT99');
    expect(regimeFor(years, '2030-01-01')).toBe('TT99');
    expect(regimeFor(years, undefined)).toBe('TT99');
    expect(regimeFor([], '2026-01-01')).toBe('TT99');
  });
});

describe('accountFetcherFor', () => {
  afterEach(() => { apiMock.mockReset(); });
  it('tra tài khoản của chế độ ứng với ngày hạch toán, bỏ tài khoản tổng hợp và ngừng dùng, lọc theo mã đầu hoặc tên', async () => {
    const acc = (id: number, code: string, name: string, extra: object = {}) => ({ id, code, name, isGroup: false, isActive: true, ...extra });
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/fiscal-years') return years;
      if (path === '/api/accounts?regime=TT133') return [acc(1, '6422', 'Chi phí quản lý doanh nghiệp'), acc(2, '642', 'Chi phí QLDN', { isGroup: true }), acc(3, '6423', 'Cũ', { isActive: false }), acc(4, '1111', 'Tiền mặt')];
      throw new Error(path);
    });
    const f = accountFetcherFor('2025-03-01');
    expect((await f('account', '')).map((r) => r.code)).toEqual(['6422', '1111']);
    expect((await f('account', '64')).map((r) => r.code)).toEqual(['6422']);
    expect((await f('account', 'tiền')).map((r) => r.code)).toEqual(['1111']);
    expect(apiMock).toHaveBeenCalledWith('/api/accounts?regime=TT133');
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/accounts?regime=TT133')).toHaveLength(1); // đã nhớ
  });
});
