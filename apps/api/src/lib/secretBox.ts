import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../plugins/errors.js';

// Mã hóa AES-256-GCM bí mật tích hợp (mật khẩu nhà cung cấp hóa đơn, khóa API ngân hàng). Định dạng: 'v1' | iv 12 | tag 16 | ciphertext.
const VERSION = Buffer.from('v1');

// Base64 chuẩn, giải ra đúng 32 byte (khứ hồi chặt: từ chối ký tự lạ, thiếu đệm).
export const isValidEncryptionKey = (k: string): boolean => Buffer.from(k, 'base64').length === 32 && Buffer.from(k, 'base64').toString('base64') === k;

function key(): Buffer | null {
  const b64 = process.env.DATA_ENCRYPTION_KEY;
  if (!b64) return null;
  if (!isValidEncryptionKey(b64)) throw new Error('DATA_ENCRYPTION_KEY phải là chuỗi base64 của đúng 32 byte');
  return Buffer.from(b64, 'base64');
}

export const hasEncryptionKey = (): boolean => key() !== null;

export function sealSecret(plain: string): Buffer {
  const k = key();
  if (!k) throw new AppError('ENCRYPTION_KEY_MISSING', 'Chưa cấu hình DATA_ENCRYPTION_KEY nên không lưu được mật khẩu, khóa bí mật', 409);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([VERSION, iv, c.getAuthTag(), ct]);
}

export function openSecret(sealed: Buffer): string {
  const k = key();
  if (!k) throw new AppError('ENCRYPTION_KEY_MISSING', 'Chưa cấu hình DATA_ENCRYPTION_KEY nên không đọc được mật khẩu, khóa bí mật', 409);
  if (sealed.length < 30 || !sealed.subarray(0, 2).equals(VERSION)) throw new Error('Bí mật đã mã hóa sai định dạng');
  const d = createDecipheriv('aes-256-gcm', k, sealed.subarray(2, 14));
  d.setAuthTag(sealed.subarray(14, 30));
  return Buffer.concat([d.update(sealed.subarray(30)), d.final()]).toString('utf8');
}
