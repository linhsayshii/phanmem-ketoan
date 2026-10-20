import './env.js';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashPassword } from './modules/auth/service.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  username: { type: 'string' }, password: { type: 'string' }, 'full-name': { type: 'string' },
  'tenant-code': { type: 'string' }, 'tenant-name': { type: 'string' }, 'tax-code': { type: 'string' }, year: { type: 'string' }, period: { type: 'string' } } });

if (positionals[0] === 'verify-hash') {
  // Độc lập với API: chỉ cần DATABASE_ADMIN_URL. Mã thoát 1 nếu có chứng từ lệch hash hoặc không kiểm tra được.
  const { 'tenant-code': code, year, period } = values;
  if (!code || !/^\d+$/.test(year ?? '') || !/^\d+$/.test(period ?? '')) { console.error('Dùng: cli verify-hash --tenant-code ... --year 2026 --period 3'); process.exit(1); }
  const db = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await db.connect();
  try {
    const t = await db.query('SELECT id FROM tenant WHERE code = $1', [code]);
    if (!t.rows[0]) { console.error(`Không có công ty mã ${code}`); process.exit(1); }
    await db.query("SELECT set_config('app.current_tenant', $1, false)", [t.rows[0].id]);
    const r = await db.query(`SELECT voucher_no, ok, encode(stored, 'hex') AS stored, encode(computed, 'hex') AS computed FROM verify_period_hash($1::uuid, $2::int, $3::int)`, [t.rows[0].id, year, period]);
    const bad = r.rows.filter((x) => !x.ok);
    for (const x of bad) console.log(`LỆCH ${x.voucher_no}: lưu ${x.stored ?? '(trống)'}, tính lại ${x.computed}`);
    console.log(bad.length ? `Kỳ ${period}/${year}: ${bad.length}/${r.rows.length} chứng từ lệch hash` : `Kỳ ${period}/${year}: toàn bộ ${r.rows.length} chứng từ khớp`);
    process.exitCode = bad.length ? 1 : 0;
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await db.end(); }
  process.exit();
}
if (positionals[0] !== 'create-admin') { console.error('Dùng: cli create-admin --username ... --password ... --tenant-code ... --tenant-name ...\n     cli verify-hash --tenant-code ... --year ... --period ...'); process.exit(1); }
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
