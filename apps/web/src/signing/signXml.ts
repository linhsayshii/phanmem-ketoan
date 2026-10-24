import { ApiError, api } from '../api/client.js';

export interface SigningProfile { id: number; kind: 'local_agent' | 'smartca' | 'fake'; label: string; certSubject: string; certSerial: string; certNotAfter: string; isDefault: boolean; hasCredentials: boolean; expired: boolean }
interface Session { id: string; status: 'pending' | 'signed' | 'failed' | 'expired'; mode: 'client' | 'server'; digestB64: string; agentUrl?: string; error?: string }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ký một chứng từ. Tiện ích cục bộ: trình duyệt gọi tiện ích (127.0.0.1) để ký băm rồi gửi chữ ký lên máy chủ. SmartCA/giả lập: máy chủ ký, trình duyệt hỏi kết quả.
// Khóa riêng không bao giờ qua trình duyệt hay máy chủ. Trả mã phiên đã ký.
export async function signDocument(a: { docKind: 'vat_return' | 'cit_return'; docRef: string; profileId?: number }, onStatus: (text: string) => void = () => undefined): Promise<string> {
  const profiles = await api<SigningProfile[]>('/api/signing/profiles');
  const profile = a.profileId ? profiles.find((p) => p.id === a.profileId) : profiles.find((p) => p.isDefault);
  if (!profile) throw new ApiError('SIGNING_PROFILE_MISSING', 'Chưa có hồ sơ ký số: thêm chứng thư ở Cài đặt ký số', 409);
  onStatus('Đang dựng tệp cần ký');
  const s = await api<Session>('/api/signing/sessions', { method: 'POST', json: { docKind: a.docKind, docRef: a.docRef, profileId: profile.id } });
  if (s.mode === 'client') {
    onStatus('Chờ tiện ích ký số xác nhận (xem cửa sổ dòng lệnh của tiện ích)');
    let r: Response;
    try {
      r = await fetch(`${s.agentUrl}/v1/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ certSerial: profile.certSerial, digestB64: s.digestB64, algorithm: 'RSA-SHA256' }) });
    } catch { throw new ApiError('AGENT_UNREACHABLE', 'Không kết nối được tiện ích ký số trên máy này. Kiểm tra tiện ích đã chạy chưa (docs/dev/ky-so-cuc-bo.md).', 0); }
    const body = (await r.json().catch(() => ({}))) as { signatureB64?: string; error?: string };
    if (!r.ok || !body.signatureB64) throw new ApiError(body.error ?? 'AGENT_ERROR', body.error === 'USER_DECLINED' ? 'Bạn đã từ chối ký trên tiện ích' : `Tiện ích ký số từ chối (${body.error ?? r.status})`, r.status);
    onStatus('Đang kiểm tra chữ ký');
    await api(`/api/signing/sessions/${s.id}/complete`, { method: 'POST', json: { signatureB64: body.signatureB64 } });
    return s.id;
  }
  onStatus(profile.kind === 'smartca' ? 'Xác nhận giao dịch trên ứng dụng VNPT SmartCA' : 'Đang ký bằng khóa thử');
  for (let i = 0; i < 300; i++) { // phiên hết hạn sau 10 phút: máy chủ trả 409 và vòng lặp dừng
    const p = await api<Session>(`/api/signing/sessions/${s.id}/poll`, { method: 'POST' });
    if (p.status === 'signed') return s.id;
    await wait(2000);
  }
  throw new ApiError('SIGNING_TIMEOUT', 'Hết thời gian chờ xác nhận ký số', 408);
}

// Tải bản đã ký về máy: xmlUrl là đường tải XML của tờ khai (01/GTGT, 03/TNDN), thêm signedSession.
export async function downloadSigned(xmlUrl: string, sessionId: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${xmlUrl}${xmlUrl.includes('?') ? '&' : '?'}signedSession=${sessionId}`, { credentials: 'include' });
  if (!res.ok) throw new ApiError('HTTP', 'Không tải được XML đã ký', res.status);
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = name ? decodeURIComponent(name) : fallbackName; a.click(); URL.revokeObjectURL(url);
}
export const downloadSignedVatReturn = (returnId: number, sessionId: string): Promise<void> => downloadSigned(`/api/tax/vat-returns/${returnId}/xml`, sessionId, 'to-khai-01-gtgt_signed.xml');
