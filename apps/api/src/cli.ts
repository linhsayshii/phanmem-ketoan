import 'dotenv/config';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashPassword } from './modules/auth/service.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  username: { type: 'string' }, password: { type: 'string' }, 'full-name': { type: 'string' },
  'tenant-code': { type: 'string' }, 'tenant-name': { type: 'string' }, 'tax-code': { type: 'string' } } });

if (positionals[0] !== 'create-admin') { console.error('Dùng: cli create-admin --username ... --password ... --tenant-code ... --tenant-name ...'); process.exit(1); }
const { username, password, 'tenant-code': tenantCode, 'tenant-name': tenantName } = values;
if (!username || !password || !tenantCode || !tenantName) { console.error('Thiếu tham số'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
const u = await client.query(
  `INSERT INTO app_user(username, full_name, password_hash) VALUES ($1, $2, $3)
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
  [username, values['full-name'] ?? username, await hashPassword(password)]);
const t = await client.query('SELECT create_tenant($1, $2, $3, $4) AS id', [tenantCode, tenantName, values['tax-code'] ?? null, u.rows[0].id]);
console.log(`Đã tạo công ty ${tenantCode} (${t.rows[0].id}) với quản trị ${username}`);
await client.end();
