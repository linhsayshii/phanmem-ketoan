export const QUEUES = { backup: 'backup', recomputeBalances: 'balance.recompute' } as const;
export interface RecomputeBalancesJob { tenantId: string }

// Chính sách 'short': tối đa một job chờ (created) cho mỗi singletonKey (= công ty); job đang chạy không tính, nên ghi sổ trong lúc chạy vẫn xếp được job mới.
// Gửi dồn dập chỉ còn một job chờ vì job chờ chưa chạy sẽ thấy mốc bẩn của chúng. Hàng đợi đã có với chính sách khác được nâng lên bằng updateQueue; chỉ áp cho job gửi sau đó.
// Dùng kiểu cấu trúc để API và worker tự truyền PgBoss của mình mà @kt/db không phụ thuộc pg-boss.
type QueuePolicyOptions = { name: string; policy: 'short' }; // name: kiểu Queue của pg-boss bắt buộc có
export interface QueueAdmin {
  createQueue(name: string, options: QueuePolicyOptions): Promise<void>;
  updateQueue(name: string, options: QueuePolicyOptions): Promise<void>;
}
export async function ensureRecomputeQueue(boss: QueueAdmin): Promise<void> {
  const options: QueuePolicyOptions = { name: QUEUES.recomputeBalances, policy: 'short' };
  await boss.createQueue(QUEUES.recomputeBalances, options); // không làm gì nếu đã có
  await boss.updateQueue(QUEUES.recomputeBalances, options);
}
