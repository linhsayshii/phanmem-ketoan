import './env.js';
import PgBoss from 'pg-boss';
import { createDb, createPool } from '@kt/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = createDb(createPool(config.DATABASE_URL));
// pg-boss tạo schema pgboss nên cần quyền quản trị, không dùng app_user
const boss = new PgBoss({ connectionString: process.env.DATABASE_ADMIN_URL!, schema: 'pgboss' });
boss.on('error', (e) => console.error('pg-boss', e)); // không có bộ nghe 'error' thì lỗi kết nối làm sập tiến trình
await boss.start();
const app = await buildApp({ db, config, boss });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
