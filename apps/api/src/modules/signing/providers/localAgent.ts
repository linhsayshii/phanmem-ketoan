import { X509Certificate } from 'node:crypto';
import { SigningProviderError } from './types.js';

// Tiện ích ký cục bộ chạy trên máy người dùng (127.0.0.1:18765, xem docs/dev/ky-so-cuc-bo.md); trình duyệt gọi nó, máy chủ không bao giờ thấy khóa riêng.
export const LOCAL_AGENT_URL = 'http://127.0.0.1:18765';

export interface CertInfo { der: Buffer; subject: string; serial: string; notAfter: Date }
export function describeCertificate(certB64: string): CertInfo {
  try {
    const der = Buffer.from(certB64, 'base64'); const c = new X509Certificate(der);
    if (c.publicKey.asymmetricKeyType !== 'rsa') throw new Error('không phải RSA');
    return { der: c.raw, subject: c.subject.split('\n').reverse().join(','), serial: c.serialNumber.toLowerCase(), notAfter: new Date(c.validTo) };
  } catch (e) {
    throw new SigningProviderError('CERTIFICATE_INVALID', `Chứng thư số không hợp lệ: ${e instanceof Error ? e.message : String(e)}`);
  }
}
