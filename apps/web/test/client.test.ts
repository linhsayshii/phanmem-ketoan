import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';

const mockFetch = (res: Response | Error) => {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { if (res instanceof Error) throw res; return res; });
  vi.stubGlobal('fetch', fn);
  return fn;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

afterEach(() => vi.unstubAllGlobals());

describe('api()', () => {
  it('đổi phong bì lỗi JSON của API thành ApiError', async () => {
    mockFetch(json({ error: { code: 'USERNAME_TAKEN', message: 'Tên đăng nhập đã tồn tại', details: { field: 'username' } } }, 409));
    const e = await api('/api/users', { method: 'POST', json: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'USERNAME_TAKEN', message: 'Tên đăng nhập đã tồn tại', status: 409, details: { field: 'username' } });
  });

  it('thân HTML 502 của proxy thành thông báo tiếng Việt', async () => {
    mockFetch(new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const e = await api('/api/users').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'HTTP_502', message: 'Lỗi hệ thống (502)', status: 502 });
  });

  it('mất kết nối thì ném ApiError NETWORK', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const e = await api('/api/users').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'NETWORK', message: 'Không kết nối được máy chủ', status: 0 });
  });

  it('204 trả về undefined', async () => {
    mockFetch(new Response(null, { status: 204 }));
    expect(await api('/api/auth/logout', { method: 'POST' })).toBeUndefined();
  });

  it('thành công trả về JSON đã phân tích, gửi cookie và thân JSON', async () => {
    const fetchMock = mockFetch(json([{ id: 'u1' }]));
    expect(await api('/api/users', { method: 'POST', json: { a: 1 } })).toEqual([{ id: 'u1' }]);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/users');
    expect(init).toMatchObject({ credentials: 'include', method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  });
});
