import type { Config } from '../../../config.js';
import { AppError } from '../../../plugins/errors.js';
import { SigningProviderError } from './types.js';

// Chính sách ký số lấy từ cấu hình ứng dụng (không đọc process.env trực tiếp).
export interface SigningPolicy { smartcaHosts: string[]; smartcaAllowHttp: boolean; production: boolean }
export const policyOf = (c: Config): SigningPolicy => ({
  smartcaHosts: c.SMARTCA_ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  smartcaAllowHttp: c.SMARTCA_ALLOW_HTTP === 'true',
  production: c.NODE_ENV === 'production',
});

// Chống SSRF: baseUrl SmartCA do người dùng nhập. Chỉ https (http khi cờ kiểm thử), tên miền nằm trong danh sách, không kèm tài khoản:mật khẩu.
export function assertSmartcaUrl(raw: string, p: SigningPolicy): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SigningProviderError('SMARTCA_URL_NOT_ALLOWED', 'Địa chỉ máy chủ SmartCA không hợp lệ'); }
  const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && p.smartcaAllowHttp);
  if (!okScheme || u.username || u.password || !p.smartcaHosts.includes(u.hostname.toLowerCase())) {
    throw new SigningProviderError('SMARTCA_URL_NOT_ALLOWED', 'Địa chỉ máy chủ SmartCA không nằm trong danh sách cho phép (https tới cổng của VNPT)');
  }
}

export function assertFakeAllowed(p: SigningPolicy): void {
  if (p.production) throw new AppError('SIGNING_FAKE_DISABLED', 'Hồ sơ ký giả lập không dùng ở môi trường chính thức', 400);
}
