export class ApiError extends Error { constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); } }

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'include', ...rest,
      headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  } catch { throw new ApiError('NETWORK', 'Không kết nối được máy chủ', 0); }
  if (res.status === 204) return undefined as T;
  let body: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  if (res.headers.get('content-type')?.includes('application/json')) { try { body = await res.json(); } catch { /* thân JSON hỏng: xử lý như không có thân */ } }
  if (!res.ok) throw new ApiError(body?.error?.code ?? 'HTTP_' + res.status, body?.error?.message ?? 'Lỗi hệ thống (' + res.status + ')', res.status, body?.error?.details);
  return body as T;
}
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new ApiError('HTTP', await res.text(), res.status);
  return res.blob();
}
