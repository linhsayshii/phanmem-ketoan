import './env.js';
import { createTempDb } from './temp-db.js';

// Mỗi lần chạy kiểm thử có DB tạm riêng `ketoan_t_<8 hex>`, đã migrate và nạp dữ liệu tham chiếu; DB phát triển không bị ghi.
// Chạy từ gốc, ba project dùng chung một tiến trình: lần đầu tạo và đặt KT_TEST_DB, các lần sau dùng lại và không xóa.
export default async function setup(): Promise<() => Promise<void>> {
  // Chỉ dùng lại khi DATABASE_URL đã trỏ vào đúng DB tạm đó: KT_TEST_DB cũ còn trong môi trường không được dẫn kiểm thử vào DB phát triển.
  const reuse = process.env.KT_TEST_DB;
  if (reuse && process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === `/${reuse}`) return async () => {};
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error('Thiếu DATABASE_URL hoặc DATABASE_ADMIN_URL: đặt trong môi trường hoặc tệp .env ở gốc repo (xem .env.example) để tạo cơ sở dữ liệu kiểm thử tạm.');
  const tmp = await createTempDb(adminUrl, appUrl);
  const name = tmp.name;
  process.env.KT_TEST_DB = name;
  process.env.DATABASE_ADMIN_URL = tmp.adminUrl;
  process.env.DATABASE_URL = tmp.appUrl;
  return async () => {
    if (process.env.KT_TEST_KEEP_DB === '1') { console.error(`KT_TEST_KEEP_DB=1: giữ lại cơ sở dữ liệu kiểm thử ${name}`); return; }
    await tmp.drop();
  };
}
