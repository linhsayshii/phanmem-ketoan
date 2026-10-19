import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// .env ở gốc repo; resolve theo vị trí file để `pnpm -F @kt/api cli|dev` (cwd = apps/api) vẫn đọc được
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
