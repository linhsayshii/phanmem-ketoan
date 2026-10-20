import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config { return schema.parse(env); }
