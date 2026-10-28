import './env.js';
import { z } from 'zod';
import { QUEUES, createDb, createPool, ensureRecomputeQueue, type RecomputeBalancesJob } from '@kt/db';
import { createBoss } from './boss.js';
import { runBackup } from './jobs/backup.js';
import { recomputeAndRequeue } from './jobs/recomputeBalances.js';
import { EINVOICE_RECONCILE_CRON, runEInvoiceReconcile } from './jobs/einvoiceReconcile.js';
import { RECURRING_CRON, runRecurringAll } from './jobs/recurringEntries.js';

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
await ensureRecomputeQueue(boss); // chính sách short: tối đa một job chờ mỗi công ty (hàng đợi cũ được nâng cấp)
// batchSize 1: mỗi job là một công ty; chính sách short đã gộp các lần gửi dồn dập (tối đa một job chờ mỗi công ty). Lỗi để pg-boss thử lại (tính lại là idempotent).
await boss.work<RecomputeBalancesJob>(QUEUES.recomputeBalances, { batchSize: 1 }, async ([job]) => {
  try {
    const r = await recomputeAndRequeue(db, boss, job!.data);
    log('recompute done', { tenantId: job!.data.tenantId, ...r });
  } catch (e) {
    log('recompute failed', { tenantId: job!.data.tenantId, error: String(e) });
    throw e;
  }
});
// stately: tối đa một job chờ và một job chạy, lượt cron sau không chồng lên lượt đang chạy lâu (worst case 200 hóa đơn x 60 giây).
await boss.createQueue(QUEUES.einvoiceReconcile, { name: QUEUES.einvoiceReconcile, policy: 'stately' });
await boss.updateQueue(QUEUES.einvoiceReconcile, { name: QUEUES.einvoiceReconcile, policy: 'stately' });
await boss.schedule(QUEUES.einvoiceReconcile, EINVOICE_RECONCILE_CRON, {}, { tz: 'Asia/Ho_Chi_Minh' });
// Lỗi từng hóa đơn đã được nuốt và đếm trong reconcilePending; lỗi còn lại (mất kết nối DB) để pg-boss ghi nhận, lượt 5 phút sau chạy lại.
await boss.work(QUEUES.einvoiceReconcile, async () => {
  const r = await runEInvoiceReconcile(db);
  const { errorDetails, notices, ...counts } = r;
  if (counts.checked) log('einvoice reconcile', counts);
  for (const d of errorDetails) log('einvoice reconcile error', { ...d });
  for (const d of notices) log('einvoice reconcile notice', { ...d });
});
// Bút toán định kỳ (GĐ7 nhóm 7): sinh chứng từ nháp theo kỳ đến hạn; stately để lượt sau không chồng lên lượt đang chạy.
await boss.createQueue(QUEUES.recurringEntries, { name: QUEUES.recurringEntries, policy: 'stately' });
await boss.updateQueue(QUEUES.recurringEntries, { name: QUEUES.recurringEntries, policy: 'stately' });
await boss.schedule(QUEUES.recurringEntries, RECURRING_CRON, {}, { tz: 'Asia/Ho_Chi_Minh' });
await boss.work(QUEUES.recurringEntries, async () => {
  const r = await runRecurringAll(db);
  const { details, ...counts } = r;
  if (counts.created || counts.skipped || counts.errors) log('recurring entries', counts);
  for (const d of details) log('recurring entries detail', { ...d });
});
// dừng êm: đợi job đang chạy xong (tối đa 60 giây) rồi mới thoát
for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => { void boss.stop({ graceful: true, timeout: 60000, wait: true }).finally(() => process.exit(0)); });
log('worker started', { cron: env.BACKUP_CRON, dir: env.BACKUP_DIR });
