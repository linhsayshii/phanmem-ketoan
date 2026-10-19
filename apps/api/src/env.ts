import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .env ở gốc repo; resolve theo vị trí file để `pnpm -F @kt/api cli|dev` (cwd = apps/api) vẫn đọc được
const root = fileURLToPath(new URL('../../../', import.meta.url));
config({ path: path.join(root, '.env') });
// BACKUP_DIR tương đối tính từ gốc repo, để api và worker (cwd khác nhau) cùng nhìn một thư mục
if (process.env.BACKUP_DIR && !path.isAbsolute(process.env.BACKUP_DIR)) process.env.BACKUP_DIR = path.resolve(root, process.env.BACKUP_DIR);
