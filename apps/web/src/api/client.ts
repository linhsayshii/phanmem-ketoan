import { friendlyMessage } from './errors.js';

// `raw` giữ thông báo gốc của máy chủ để tra lỗi; `message` luôn là tiếng Việt cho người dùng.
export class ApiError extends Error { constructor(public code: string, message: string, public status: number, public details?: unknown, public raw?: string) { super(message); } }

// Đường dẫn chứa tham số chưa có (năm/kỳ/id = undefined hoặc NaN) là lỗi lập trình hoặc dữ liệu chưa khởi tạo: chặn ngay ở máy khách, không gửi lên máy chủ.
const MISSING_PARAM = /\/(?:undefined|NaN)(?=[/?#]|$)|[?&][^=&]+=(?:undefined|NaN)(?=&|#|$)/;

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  if (MISSING_PARAM.test(path)) throw new ApiError('MISSING_PARAM', 'Chưa chọn đủ thông tin (năm, kỳ hoặc đối tượng) để thực hiện thao tác này', 0);
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'include', ...rest,
      headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  } catch { throw new ApiError('NETWORK', friendlyMessage({ status: 0, code: 'NETWORK' }), 0); }
  if (res.status === 204) return undefined as T;
  let body: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  if (res.headers.get('content-type')?.includes('application/json')) { try { body = await res.json(); } catch { /* thân JSON hỏng: xử lý như không có thân */ } }
  if (!res.ok) {
    const e = { status: res.status, code: body?.error?.code ?? 'HTTP_' + res.status, message: body?.error?.message, details: body?.error?.details };
    throw new ApiError(e.code, friendlyMessage(e), res.status, e.details, e.message);
  }
  return body as T;
}
export async function apiBlob(path: string): Promise<Blob> {
  if (MISSING_PARAM.test(path)) throw new ApiError('MISSING_PARAM', 'Chưa chọn đủ thông tin (năm, kỳ hoặc đối tượng) để thực hiện thao tác này', 0);
  let res: Response;
  try { res = await fetch(path, { credentials: 'include' }); } catch { throw new ApiError('NETWORK', friendlyMessage({ status: 0, code: 'NETWORK' }), 0); }
  if (!res.ok) {
    let err: { code?: string; message?: string; details?: unknown } | undefined;
    try { err = (JSON.parse(await res.text()) as { error?: typeof err }).error; } catch { /* thân không phải JSON */ }
    const e = { status: res.status, code: err?.code ?? 'HTTP', message: err?.message, details: err?.details };
    throw new ApiError(e.code, friendlyMessage(e), res.status, e.details, e.message);
  }
  return res.blob();
}
