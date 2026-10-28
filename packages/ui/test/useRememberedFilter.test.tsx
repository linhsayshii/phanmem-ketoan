import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRememberedFilter } from '../src/useRememberedFilter.js';

const defaults = { q: '' };
let store: Record<string, string>;
const fetchMock = vi.fn();
const answer = (value: unknown) => ({ ok: true, status: 200, json: async () => ({ value }) });

beforeEach(() => {
  store = {};
  fetchMock.mockReset();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('useRememberedFilter', () => {
  it('hai phạm vi (công ty:người dùng) cùng khóa không dùng chung giá trị lưu cục bộ', async () => {
    fetchMock.mockRejectedValue(new Error('offline')); // chỉ dùng bản lưu cục bộ
    const a = renderHook(() => useRememberedFilter('catalog:party', defaults, 't1:u1'));
    act(() => a.result.current[1]({ q: 'của A' }));
    expect(store['filter:t1:u1:catalog:party']).toBe('{"q":"của A"}');
    const b = renderHook(() => useRememberedFilter('catalog:party', defaults, 't1:u2'));
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[1]?.method === undefined)).toHaveLength(2)); // GET của A và của B
    await act(async () => { await Promise.resolve(); }); // cho nhánh dự phòng của B chạy xong
    expect(b.result.current[0]).toEqual(defaults);
    const a2 = renderHook(() => useRememberedFilter('catalog:party', defaults, 't1:u1'));
    await waitFor(() => expect(a2.result.current[0]).toEqual({ q: 'của A' }));
  });

  it('máy chủ trả { value: null } thì dùng mặc định và xóa bản cục bộ dù đang có', async () => {
    store['filter:s:k'] = '{"q":"cũ"}';
    fetchMock.mockResolvedValue(answer(null));
    const { result } = renderHook(() => useRememberedFilter('k', defaults, 's'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(store['filter:s:k']).toBeUndefined());
    expect(result.current[0]).toEqual(defaults);
  });

  it('máy chủ trả 404 cũng như chưa có: mặc định và xóa bản cục bộ', async () => {
    store['filter:s:k'] = '{"q":"cũ"}';
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const { result } = renderHook(() => useRememberedFilter('k', defaults, 's'));
    await waitFor(() => expect(store['filter:s:k']).toBeUndefined());
    expect(result.current[0]).toEqual(defaults);
  });

  it('người dùng đổi bộ lọc trước khi bản nạp từ máy chủ về: bản nạp về muộn không ghi đè', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => (init?.method === 'PUT' ? Promise.resolve({ ok: true, status: 200 }) : new Promise((r) => { release = r; })));
    const { result } = renderHook(() => useRememberedFilter('k', defaults, 's'));
    act(() => result.current[1]({ q: 'vừa nhập' }));
    await act(async () => { release(answer({ q: 'bản cũ máy chủ' })); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current[0]).toEqual({ q: 'vừa nhập' });
  });

  it('máy chủ trả giá trị thì trộn lên mặc định', async () => {
    fetchMock.mockResolvedValue(answer({ q: 'máy chủ' }));
    const { result } = renderHook(() => useRememberedFilter('k', { q: '', page: 1 }, 's'));
    await waitFor(() => expect(result.current[0]).toEqual({ q: 'máy chủ', page: 1 }));
  });

  it('GET lỗi (mất mạng hoặc 401) thì dùng bản lưu cục bộ', async () => {
    store['filter:s:k'] = '{"q":"cục bộ"}';
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offline = renderHook(() => useRememberedFilter('k', defaults, 's'));
    await waitFor(() => expect(offline.result.current[0]).toEqual({ q: 'cục bộ' }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const unauth = renderHook(() => useRememberedFilter('k', defaults, 's'));
    await waitFor(() => expect(unauth.result.current[0]).toEqual({ q: 'cục bộ' }));
    expect(store['filter:s:k']).toBe('{"q":"cục bộ"}');
  });

  it('lưu: ghi cục bộ và PUT lên khóa không kèm phạm vi; đổi khóa thì nạp lại', async () => {
    fetchMock.mockResolvedValue(answer(null));
    const { result, rerender } = renderHook(({ k }) => useRememberedFilter(k, defaults, 's'), { initialProps: { k: 'a' } });
    act(() => result.current[1]({ q: 'xx' }));
    expect(result.current[0]).toEqual({ q: 'xx' });
    expect(fetchMock).toHaveBeenCalledWith('/api/prefs/filter%3Aa', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: { q: 'xx' } }) }));
    rerender({ k: 'b' });
    await waitFor(() => expect(result.current[0]).toEqual(defaults));
  });
});
