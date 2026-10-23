import { X509Certificate } from 'node:crypto';
import { verifyEnveloped } from '../signing/xmldsig.js';

// Kết quả kiểm chữ ký hóa đơn đầu vào. Chỉ kiểm mật mã (chữ ký, băm vùng được ký); KHÔNG kiểm chuỗi tin cậy CA hay thu hồi (QĐ 524):
// caChain luôn 'unchecked' và giao diện ghi "hợp lệ (chưa kiểm CA)".
export interface SigCheck { valid: boolean; subject: string | null; taxCodeInCert: string | null; signingTime: string | null; caChain: 'unchecked'; reason?: string }

// MST trong chứng thư số: CA Việt Nam ghi MST ở thuộc tính UID / OID 0.9.2342.19200300.100.1.1 dạng "MST:0101234567" (hoặc "MNS:" mã ngân sách) trong Subject;
// một số CA ghi "MST:" trong CN hoặc OU. Ưu tiên UID, sau đó mẫu "MST:<số>" ở bất kỳ thuộc tính nào. Chuẩn hóa: bỏ khoảng trắng.
const UID_RE = /(?:^|\n)(?:UID|userId|OID\.0\.9\.2342\.19200300\.100\.1\.1|0\.9\.2342\.19200300\.100\.1\.1)=(?:MST:|MST-|MST)?\s*(\d[\d-]{8,13})\s*(?:$|\n)/i;
const MST_RE = /MST\s*[:=]\s*(\d[\d-]{8,13})/i;
export function certTaxCode(certDer: Buffer): string | null {
  try {
    const subject = new X509Certificate(certDer).subject;
    const m = UID_RE.exec(subject) ?? MST_RE.exec(subject);
    return m ? m[1]!.replace(/\s/g, '') : null;
  } catch { return null; }
}

// Mã số thuế so sánh không phân biệt dấu gạch (0101234567-001 ~ 0101234567001).
export const normTaxCode = (t: string | null | undefined): string => (t ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export interface SigVerification { check: SigCheck; covered: Element[] }

// hdonPath: đường dẫn tên cục bộ từ phần tử gốc tới đúng HDon đang đọc. Mọi dữ liệu nghiệp vụ phải lấy từ `covered` (nút được chữ ký phủ), không tra lại theo đường dẫn.
// who='NBan': ký DLHDon. who='CQT': ký DLHDon và MCCQT; nếu hóa đơn có MCCQT mà chữ ký không phủ nó thì không hợp lệ.
export function verifyInvoiceSignature(xml: string, hdonPath: string[], who: 'NBan' | 'CQT', hasMccqt: boolean): SigVerification {
  const targets = who === 'NBan' ? ['DLHDon'] : ['DLHDon', 'MCCQT'];
  const v = verifyEnveloped(xml, { signaturePath: [...hdonPath, 'DSCKS', who, 'Signature'], targets });
  const fail = (reason: string): SigVerification => ({ check: { valid: false, subject: v.subject, taxCodeInCert: null, signingTime: v.signingTime, caChain: 'unchecked', reason }, covered: [] });
  if (!v.valid) return fail(v.reason ?? 'Chữ ký không hợp lệ');
  const names = v.covered.map((c) => c.localName);
  if (!names.includes('DLHDon')) return fail('Chữ ký không phủ DLHDon');
  if (who === 'CQT' && hasMccqt && !names.includes('MCCQT')) return fail('Chữ ký cơ quan thuế không phủ MCCQT');
  return { check: { valid: true, subject: v.subject, taxCodeInCert: v.certDer ? certTaxCode(v.certDer) : null, signingTime: v.signingTime, caChain: 'unchecked' }, covered: v.covered };
}
