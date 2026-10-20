import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';
import { syncReferenceData } from './reference.js';

export const withDb = (url: string, name: string): string => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

async function exec(adminUrl: string, text: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(text); } finally { await c.end(); }
}

export interface TempDb { name: string; adminUrl: string; appUrl: string; drop(): Promise<void> }

// Tạo DB `ketoan_t_<8 hex>` đã migrate và nạp dữ liệu tham chiếu; lỗi giữa chừng thì xóa luôn. adminUrl/appUrl trỏ vào DB nào cũng được, chỉ lấy máy chủ và tài khoản.
export async function createTempDb(adminUrl: string, appUrl: string): Promise<TempDb> {
  const name = `ketoan_t_${randomBytes(4).toString('hex')}`;
  await exec(adminUrl, `CREATE DATABASE ${name}`);
  const tmpAdmin = withDb(adminUrl, name);
  const drop = () => exec(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  try {
    await migrate(tmpAdmin);
    await syncReferenceData(tmpAdmin);
  } catch (e) {
    await drop();
    throw e;
  }
  return { name, adminUrl: tmpAdmin, appUrl: withDb(appUrl, name), drop };
}
