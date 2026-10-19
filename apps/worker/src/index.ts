import './env.js';
import { z } from 'zod';
import { QUEUES } from '@kt/db';
import { createBoss } from './boss.js';
import { runBackup } from './jobs/backup.js';

const env = z.object({ DATABASE_ADMIN_URL: z.string(), BACKUP_DIR: z.string().default('./backups'), BACKUP_CRON: z.string().default('0 2 * * *'), BACKUP_KEEP: z.coerce.number().int().min(1).default(14) }).parse(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

const boss = createBoss(env.DATABASE_ADMIN_URL);
boss.on('error', (e) => log('boss error', { error: String(e) }));
await boss.start();
await boss.createQueue(QUEUES.backup);
await boss.schedule(QUEUES.backup, env.BACKUP_CRON, {}, { tz: 'Asia/Ho_Chi_Minh' });
await boss.work(QUEUES.backup, async () => {
  const r = await runBackup({ adminUrl: env.DATABASE_ADMIN_URL, dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP });
  log('backup done', r);
});
log('worker started', { cron: env.BACKUP_CRON, dir: env.BACKUP_DIR });
// Task 20 thêm boss.work(QUEUES.recomputeBalances, ...) tại đây.
