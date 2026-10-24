// VietQR (NAPAS/EMVCo) chuyển nhanh tới tài khoản. Cấu trúc: docs/dev/tich-hop/ngan-hang.md mục 3.
export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (const b of new TextEncoder().encode(s)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;

export const VIETQR_CONTENT_MAX = 25;
// Bỏ dấu tiếng Việt, chỉ giữ [A-Za-z0-9 ], cắt 25 ký tự.
export function vietQrContent(s: string): string {
  return s.replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D')).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VIETQR_CONTENT_MAX).trim();
}

export interface VietQrInput { bin: string; accountNo: string; amount?: string; content?: string; service?: 'QRIBFTTA' | 'QRIBFTTC' }
export function vietQrPayload(i: VietQrInput): string {
  if (!/^\d{6}$/.test(i.bin)) throw new Error('BIN ngân hàng phải gồm 6 chữ số');
  if (!/^[A-Za-z0-9]{1,19}$/.test(i.accountNo)) throw new Error('Số tài khoản không hợp lệ');
  if (i.amount !== undefined && !/^[1-9]\d{0,12}$/.test(i.amount)) throw new Error('Số tiền không hợp lệ');
  const content = i.content ? vietQrContent(i.content) : '';
  const m = tlv('00', 'A000000727') + tlv('01', tlv('00', i.bin) + tlv('01', i.accountNo)) + tlv('02', i.service ?? 'QRIBFTTA');
  const body = tlv('00', '01') + tlv('01', i.amount ? '12' : '11') + tlv('38', m) + tlv('53', '704') + (i.amount ? tlv('54', i.amount) : '') + tlv('58', 'VN') + (content ? tlv('62', tlv('08', content)) : '') + '6304';
  return body + crc16ccitt(body);
}
