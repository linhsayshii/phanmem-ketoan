import './env.js';
import PgBoss from 'pg-boss';
import { createDb, createPool } from '@kt/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closePdfBrowser } from './modules/reporting/print/pdf.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
pool.on('error', (e) => console.error('db pool', e)); // không có bộ nghe 'error' thì kết nối nhàn rỗi bị ngắt làm sập tiến trình
const db = createDb(pool);
// pg-boss tạo schema pgboss nên cần quyền quản trị, không dùng app_user
const boss = new PgBoss({ connectionString: process.env.DATABASE_ADMIN_URL!, schema: 'pgboss' });
boss.on('error', (e) => console.error('pg-boss', e)); // không có bộ nghe 'error' thì lỗi kết nối làm sập tiến trình
await boss.start();
const app = await buildApp({ db, config, boss });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
// dừng êm khi nhận SIGTERM/SIGINT (docker stop): đóng HTTP rồi mới ngắt hàng đợi
for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => { void app.close().then(() => Promise.all([boss.stop({ graceful: false, wait: false }), closePdfBrowser()])).finally(() => process.exit(0)); });
