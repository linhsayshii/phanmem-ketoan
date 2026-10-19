import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// .env nằm ở gốc repo; resolve theo vị trí file để `pnpm -F @kt/db test` (cwd = packages/db) vẫn đọc được
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
