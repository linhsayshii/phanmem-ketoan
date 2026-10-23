export class NetworkError extends Error {
  constructor(public kind: 'timeout' | 'network', message: string) { super(message); }
}

export async function httpJson<T>(url: string, init: { method: string; headers?: Record<string, string>; body?: unknown; timeoutMs: number; redirect?: RequestRedirect }): Promise<{ status: number; body: T; raw: string; ms: number }> {
  const t0 = Date.now();
  let status: number;
  let raw: string;
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: { ...(init.body !== undefined && { 'content-type': 'application/json' }), accept: 'application/json', ...init.headers },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
      ...(init.redirect && { redirect: init.redirect }),
    });
    status = res.status;
    raw = await res.text();
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new NetworkError(timeout ? 'timeout' : 'network', timeout ? `Hết thời gian chờ ${init.timeoutMs} ms: ${url}` : `Lỗi mạng khi gọi ${url}: ${(e as Error).message}`);
  }
  let body: unknown = null;
  try { body = raw === '' ? null : JSON.parse(raw); } catch { /* không phải JSON: người gọi đọc raw */ }
  return { status, body: body as T, raw, ms: Date.now() - t0 };
}

// Thay giá trị khóa nhạy cảm bằng "***" ở mọi cấp (trước khi ghi nhật ký gọi ngoài).
export function redact(obj: unknown, keys: string[]): unknown {
  if (Array.isArray(obj)) return obj.map((v) => redact(v, keys));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, keys.includes(k) ? '***' : redact(v, keys)]));
  return obj;
}
