import type { FastifyInstance } from 'fastify';
import { QUEUES } from '@kt/db';

// Báo worker tính lại số dư sau khi giao dịch đã commit. Hàng đợi tạo một lần cho mỗi PgBoss (mỗi ứng dụng/kiểm thử có boss riêng); lỗi chỉ ghi log, không làm hỏng thao tác đã commit.
const queueReady = new WeakMap<object, Promise<void>>();
export function notifyRecompute(app: FastifyInstance, tenantId: string): void {
  const boss = app.boss;
  if (!boss) return;
  let ready = queueReady.get(boss);
  if (!ready) { ready = boss.createQueue(QUEUES.recomputeBalances); queueReady.set(boss, ready); }
  ready.then(() => boss.send(QUEUES.recomputeBalances, { tenantId }, { singletonKey: tenantId, singletonSeconds: 5 })).catch((e) => { queueReady.delete(boss); app.log.error(e); });
}
