import { AppError } from '../../../plugins/errors.js';

// Chính sách nhà cung cấp hóa đơn điện tử đọc từ môi trường (config.ts đã kiểm hợp lệ khi khởi động; worker dùng chung nên không lấy qua Fastify).
export interface EInvoicePolicy { hosts: string[]; allowHttp: boolean; production: boolean }
const DEFAULT_HOSTS = ['api-vinvoice.viettel.vn']; // docs/dev/tich-hop/sinvoice.md: địa chỉ duy nhất có trong nguồn; môi trường demo thêm bằng EINVOICE_ALLOWED_HOSTS
export const einvoicePolicy = (env: NodeJS.ProcessEnv = process.env): EInvoicePolicy => {
  const hosts = (env.EINVOICE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return { hosts: hosts.length ? hosts : DEFAULT_HOSTS, allowHttp: env.EINVOICE_ALLOW_HTTP === 'true' && env.NODE_ENV !== 'production', production: env.NODE_ENV === 'production' };
};

// Chống SSRF: baseUrl SInvoice do người dùng nhập. Chỉ https (http khi cờ kiểm thử), tên miền trong danh sách, cổng mặc định, không tài khoản:mật khẩu, không query/fragment.
export function assertEInvoiceUrl(raw: string, p: EInvoicePolicy = einvoicePolicy()): void {
  const bad = () => new AppError('EINVOICE_URL_NOT_ALLOWED', 'Địa chỉ máy chủ hóa đơn điện tử không nằm trong danh sách cho phép (https, tên miền của nhà cung cấp, không kèm tài khoản, tham số hay cổng)', 400);
  let u: URL;
  try { u = new URL(raw); } catch { throw bad(); }
  const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && p.allowHttp);
  if (!okScheme || u.username || u.password || u.search || u.hash || /[?#]/.test(raw) || (u.port !== '' && !p.allowHttp) || !p.hosts.includes(u.hostname.toLowerCase())) throw bad();
}

export function assertEInvoiceFakeAllowed(p: EInvoicePolicy = einvoicePolicy()): void {
  if (p.production) throw new AppError('EINVOICE_FAKE_DISABLED', 'Nhà cung cấp hóa đơn điện tử giả lập không dùng ở môi trường chính thức', 400);
}
