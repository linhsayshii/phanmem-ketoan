import './env.js';
import { z } from 'zod';
import { QUEUES, createDb, createPool, type RecomputeBalancesJob } from '@kt/db';
import { createBoss } from './boss.js';
import { runBackup } from './jobs/backup.js';
import { recomputeAndRequeue } from './jobs/recomputeBalances.js';

const env = z.object({ DATABASE_URL: z.string(), DATABASE_ADMIN_URL: z.string(), BACKUP_DIR: z.string().default('./backups'), BACKUP_CRON: z.string().default('0 2 * * *'), BACKUP_KEEP: z.coerce.number().int().min(1).default(14) }).parse(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

const pool = createPool(env.DATABASE_URL); // app_user: job tính lại số dư chạy qua RLS, không dùng quyền admin
// không có bộ nghe 'error' thì kết nối nhàn rỗi bị ngắt (khởi động lại PostgreSQL, pg_terminate_backend) làm sập cả worker, kể cả sao lưu đêm
pool.on('error', (e) => log('db pool error', { error: String(e) }));
const db = createDb(pool);
const boss = createBoss(env.DATABASE_ADMIN_URL);
boss.on('error', (e) => log('boss error', { error: String(e) }));
await boss.start();
await boss.createQueue(QUEUES.backup);
await boss.schedule(QUEUES.backup, env.BACKUP_CRON, {}, { tz: 'Asia/Ho_Chi_Minh' });
await boss.work(QUEUES.backup, async () => {
  try {
    const r = await runBackup({ adminUrl: env.DATABASE_ADMIN_URL, dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP });
    log('backup done', r);
  } catch (e) {
    log('backup failed', { error: String(e) });
    throw e; // để pg-boss ghi nhận thất bại và thử lại
  }
});
await boss.createQueue(QUEUES.recomputeBalances);
// batchSize 1: mỗi job là một công ty; singletonKey phía gửi đã gộp các lần gửi dồn dập. Lỗi để pg-boss thử lại (tính lại là idempotent).
await boss.work<RecomputeBalancesJob>(QUEUES.recomputeBalances, { batchSize: 1 }, async ([job]) => {
  try {
    const r = await recomputeAndRequeue(db, boss, job!.data);
    log('recompute done', { tenantId: job!.data.tenantId, ...r });
  } catch (e) {
    log('recompute failed', { tenantId: job!.data.tenantId, error: String(e) });
    throw e;
  }
});
// dừng êm: đợi job đang chạy xong (tối đa 60 giây) rồi mới thoát
for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => { void boss.stop({ graceful: true, timeout: 60000, wait: true }).finally(() => process.exit(0)); });
log('worker started', { cron: env.BACKUP_CRON, dir: env.BACKUP_DIR });
