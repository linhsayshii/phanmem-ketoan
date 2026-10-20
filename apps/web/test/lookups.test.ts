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
    expect((await f('')).map((r) => r.code)).toEqual(['6422', '1111']);
    expect((await f('64')).map((r) => r.code)).toEqual(['6422']);
    expect((await f('tiền')).map((r) => r.code)).toEqual(['1111']);
    expect(apiMock).toHaveBeenCalledWith('/api/accounts?regime=TT133');
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/accounts?regime=TT133')).toHaveLength(1); // đã nhớ
  });
  it('includeGroups: thêm tài khoản tổng hợp (sổ Cái của cả nhóm), vẫn bỏ tài khoản ngừng dùng', async () => {
    const acc = (id: number, code: string, extra: object = {}) => ({ id, code, name: `TK ${code}`, isGroup: false, isActive: true, ...extra });
    apiMock.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : [acc(1, '6422'), acc(2, '642', { isGroup: true }), acc(3, '6423', { isActive: false })]));
    const f = accountFetcherFor('2026-03-01', true);
    expect((await f('642')).map((r) => r.code)).toEqual(['6422', '642']);
  });
  it('includeInactive: thêm tài khoản ngưng dùng và đánh dấu inactive; mặc định thì không có', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_000); // quá hạn bộ nhớ đệm 30 giây của các phép thử trước
    try {
      const acc = (id: number, code: string, extra: object = {}) => ({ id, code, name: `TK ${code}`, isGroup: false, isActive: true, ...extra });
      apiMock.mockImplementation(async (path: string) => (path === '/api/fiscal-years' ? years : [acc(1, '6422'), acc(3, '6423', { isActive: false })]));
      expect((await accountFetcherFor('2026-03-01', true, true)('64')).map((r) => [r.code, r.inactive])).toEqual([['6422', undefined], ['6423', true]]);
      expect((await accountFetcherFor('2026-03-01', true)('64')).map((r) => r.code)).toEqual(['6422']);
    } finally { vi.useRealTimers(); }
  });
});
