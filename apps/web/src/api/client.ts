export class ApiError extends Error { constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); } }

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, { credentials: 'include', ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  if (res.status === 204) return undefined as T;
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = (body as { error?: { code: string; message: string; details?: unknown } }).error; throw new ApiError(e?.code ?? 'HTTP', e?.message ?? String(body), res.status, e?.details); }
  return body as T;
}
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new ApiError('HTTP', await res.text(), res.status);
  return res.blob();
}
