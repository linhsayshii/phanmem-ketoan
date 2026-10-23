import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isValidEncryptionKey } from './lib/secretBox.js';

// ATTACHMENT_DIR tương đối tính từ gốc repo (như BACKUP_DIR), để API, kiểm thử và công cụ dòng lệnh (cwd khác nhau) cùng nhìn một thư mục
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(8),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  BACKUP_DIR: z.string().default('./backups'),
  ATTACHMENT_DIR: z.string().default('./attachments').transform((p) => path.resolve(repoRoot, p)),
  // Khóa AES-256 (base64 của 32 byte, ví dụ `openssl rand -base64 32`) mã hóa mật khẩu nhà cung cấp hóa đơn, khóa API ngân hàng; production bắt buộc.
  DATA_ENCRYPTION_KEY: z.string().optional(),
  // Địa chỉ công khai của hệ thống, dùng in URL webhook cho người dùng cấu hình bên nhà cung cấp.
  PUBLIC_BASE_URL: z.string().url().optional(),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
  LOGIN_MAX_FAILS_USER: z.coerce.number().int().positive().default(5),
  LOGIN_MAX_FAILS_USER_ALL: z.coerce.number().int().positive().default(50),
  LOGIN_MAX_FAILS_IP: z.coerce.number().int().positive().default(20),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  NODE_ENV: z.string().default('development'),
  // Mặc định không tin X-Forwarded-For (tránh giả IP ghi vào nhật ký đăng nhập); sau reverse proxy đặt số bước proxy hoặc danh sách IP/CIDR của proxy; không đặt 'true' (người gọi giả được IP)
  TRUST_PROXY: z.string().default('false').transform((v): boolean | number | string => {
    const t = v.trim();
    if (t === '' || t === 'false') return false;
    if (t === 'true') return true;
    return /^\d+$/.test(t) ? Number(t) : t;
  }),
}).superRefine((c, ctx) => {
  if (c.DATA_ENCRYPTION_KEY && !isValidEncryptionKey(c.DATA_ENCRYPTION_KEY)) ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'DATA_ENCRYPTION_KEY phải là base64 chuẩn của đúng 32 byte (openssl rand -base64 32)' });
  if (c.NODE_ENV !== 'production') return;
  if (c.SESSION_SECRET.length < 32 || c.SESSION_SECRET === 'doi-chuoi-nay-khi-trien-khai') ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET phải dài ít nhất 32 ký tự và khác giá trị mẫu khi chạy production' });
  if (!c.DATA_ENCRYPTION_KEY) ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'DATA_ENCRYPTION_KEY là bắt buộc khi chạy production' });
  if (c.COOKIE_SECURE !== 'true') ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE phải là true khi chạy production' });
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config { return schema.parse(env); }
