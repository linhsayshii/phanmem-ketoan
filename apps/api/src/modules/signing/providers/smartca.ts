import { httpJson, NetworkError } from '../../../lib/http.js';
import { assertSmartcaUrl, type SigningPolicy } from './policy.js';
import { SigningProviderError } from './types.js';

// VNPT SmartCA v4.1 (docs/dev/tich-hop/ngan-hang.md mục 7): chỉ ký băm (sign_type=hash), người dùng xác nhận trên ứng dụng SmartCA.
// CHƯA THỬ TRÊN MÔI TRƯỜNG THẬT: kiểm bằng máy giả lập theo tài liệu. Chưa rõ trong tài liệu: {tranId} của /status là tran_code hay transaction_id (dùng tran_code),
// trạng thái chờ/từ chối trả bằng message nào, và SmartCA có tự bọc DigestInfo vào băm hay không (giả định có, RSASSA-PKCS1-v1_5 trên băm).
export const SMARTCA_UAT_URL = 'https://rmgateway.vnptit.vn/sca/sp769';
export interface SmartCaCfg { baseUrl: string; spId: string; spPassword: string; userId: string; serial?: string }
const TIMEOUT_MS = 30_000;

interface Envelope<T> { status_code?: number; message?: string; data?: T }
// message của thượng nguồn không tin được: chỉ giữ chữ, số và vài dấu, cắt 80 ký tự.
const clean = (m: unknown) => String(m ?? '').replace(/[^\p{L}\p{N} _.,:()-]/gu, '').slice(0, 80).trim();

// Kiểm địa chỉ trước MỖI lần gọi (cấu hình đã lưu có thể cũ hơn danh sách cho phép); không theo chuyển hướng.
async function call<T>(cfg: SmartCaCfg, pol: SigningPolicy, path: string, body: Record<string, unknown>): Promise<T> {
  assertSmartcaUrl(cfg.baseUrl, pol);
  let r;
  try { r = await httpJson<Envelope<T>>(`${cfg.baseUrl.replace(/\/+$/, '')}/${path}`, { method: 'POST', body: { sp_id: cfg.spId, sp_password: cfg.spPassword, ...body }, timeoutMs: TIMEOUT_MS, redirect: 'error' }); }
  catch (e) { if (e instanceof NetworkError) throw new SigningProviderError('SMARTCA_UNREACHABLE', 'Không kết nối được VNPT SmartCA'); throw e; }
  const code = r.body?.status_code ?? r.status;
  if (r.status >= 400 || code >= 400) throw new SigningProviderError('SMARTCA_ERROR', `VNPT SmartCA từ chối (${code}): ${clean(r.body?.message) || 'không rõ lý do'}`);
  return (r.body?.data ?? {}) as T;
}

export interface SmartCaCert { serial: string; certB64: string; status: string }
export async function getCertificates(cfg: SmartCaCfg, pol: SigningPolicy): Promise<SmartCaCert[]> {
  const d = await call<{ user_certificates?: { serial_number: string; cert_data: string; cert_status?: string }[] }>(cfg, pol, 'v1/credentials/get_certificate',
    { user_id: cfg.userId, ...(cfg.serial && { serial_number: cfg.serial }), transaction_id: `KT-CERT-${Date.now()}` });
  return (d.user_certificates ?? []).map((c) => ({ serial: c.serial_number, certB64: c.cert_data, status: c.cert_status ?? '' }));
}

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
// Gửi băm SHA-256 (hex) cần ký; trả tran_code để hỏi trạng thái.
export async function startSign(cfg: SmartCaCfg, pol: SigningPolicy, a: { transactionId: string; docId: string; digestB64: string; desc: string }): Promise<string> {
  const d = await call<{ tran_code?: string }>(cfg, pol, 'v1/signatures/sign', { user_id: cfg.userId, transaction_id: a.transactionId, transaction_desc: a.desc, ...(cfg.serial && { serial_number: cfg.serial }),
    time_stamp: stamp(new Date()), sign_files: [{ file_type: 'xml', data_to_be_signed: Buffer.from(a.digestB64, 'base64').toString('hex'), doc_id: a.docId, sign_type: 'hash' }] });
  if (!d.tran_code) throw new SigningProviderError('SMARTCA_ERROR', 'VNPT SmartCA không trả mã giao dịch ký');
  return d.tran_code;
}

// null = người dùng chưa xác nhận.
export async function pollSign(cfg: SmartCaCfg, pol: SigningPolicy, tranCode: string, docId: string): Promise<string | null> {
  const d = await call<{ signatures?: { doc_id: string; signature_value?: string | null }[] }>(cfg, pol, `v1/signatures/sign/${encodeURIComponent(tranCode)}/status`, {});
  return d.signatures?.find((s) => s.doc_id === docId)?.signature_value ?? null;
}
