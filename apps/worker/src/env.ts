import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// .env ở gốc repo; resolve theo vị trí file để chạy từ bất kỳ cwd nào (trong Docker không có .env, biến môi trường đã có sẵn)
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
