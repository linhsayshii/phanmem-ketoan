import type { FastifyInstance } from 'fastify';
import { QUEUES, ensureRecomputeQueue } from '@kt/db';

// Báo worker tính lại số dư sau khi giao dịch đã commit. Hàng đợi (chính sách short) tạo/nâng cấp một lần cho mỗi PgBoss (mỗi ứng dụng/kiểm thử có boss riêng).
// Mỗi công ty tối đa một job chờ: gửi khi đã có job chờ thì bị bỏ, vì job chờ chưa chạy sẽ thấy mốc bẩn. Lỗi chỉ ghi log, không làm hỏng thao tác đã commit; promise trả về không bao giờ lỗi (kiểm thử đợi nó).
const queueReady = new WeakMap<object, Promise<void>>();
export function notifyRecompute(app: FastifyInstance, tenantId: string): Promise<void> {
  const boss = app.boss;
  if (!boss) return Promise.resolve();
  let ready = queueReady.get(boss);
  if (!ready) { ready = ensureRecomputeQueue(boss); queueReady.set(boss, ready); }
  return ready.then(() => boss.send(QUEUES.recomputeBalances, { tenantId }, { singletonKey: tenantId })).then(() => undefined, (e) => { queueReady.delete(boss); app.log.error(e); });
}
