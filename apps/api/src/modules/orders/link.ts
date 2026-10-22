import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';

type Trx = Transaction<Database>;

// Tính lại delivered_qty và trạng thái của các đơn liên quan: số đã giao = tổng số lượng ở các liên kết còn chứng từ nháp hoặc đã ghi sổ.
// Chứng từ bị hủy, đã đảo hoặc bị xóa trả số lượng về đơn. Bỏ ghi sổ đưa chứng từ về nháp nên vẫn giữ chỗ.
export async function syncOrders(trx: Trx, orderIds: string[]): Promise<void> {
  for (const id of orderIds) {
    await sql`SELECT 1 FROM doc_order WHERE id = ${id}::uuid FOR UPDATE`.execute(trx); // khóa đơn trước, cùng thứ tự với convertOrder, để thấy liên kết vừa thêm
    await sql`UPDATE doc_order_line l SET delivered_qty = coalesce((SELECT sum(k.quantity) FROM doc_order_link k JOIN voucher v ON v.tenant_id = k.tenant_id AND v.id = k.voucher_id
      WHERE k.tenant_id = l.tenant_id AND k.order_line_id = l.id AND v.state IN ('draft','posted')), 0) WHERE l.order_id = ${id}::uuid`.execute(trx);
    await sql`UPDATE doc_order o SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM doc_order_line l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id AND l.delivered_qty < l.quantity) THEN 'done'
        WHEN EXISTS (SELECT 1 FROM doc_order_line l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id AND l.delivered_qty > 0) THEN 'partial'
        ELSE 'confirmed' END
      WHERE o.id = ${id}::uuid AND o.status IN ('confirmed','partial','done')`.execute(trx);
  }
}

const ordersOf = async (trx: Trx, voucherId: string): Promise<string[]> =>
  (await sql<{ id: string }>`SELECT DISTINCT l.order_id::text AS id FROM doc_order_link k JOIN doc_order_line l ON l.tenant_id = k.tenant_id AND l.id = k.order_line_id WHERE k.voucher_id = ${voucherId}::uuid`.execute(trx)).rows.map((r) => r.id);

// Gọi sau khi chứng từ đổi trạng thái (hủy, đảo, bỏ ghi sổ).
export async function syncOrdersOfVoucher(trx: Trx, voucherId: string): Promise<void> { await syncOrders(trx, await ordersOf(trx, voucherId)); }

// Gọi trước khi xóa chứng từ nháp: bỏ liên kết rồi trả số lượng.
export async function releaseOrderLinks(trx: Trx, voucherId: string): Promise<void> {
  const orders = await ordersOf(trx, voucherId);
  if (!orders.length) return;
  for (const id of orders) await sql`SELECT 1 FROM doc_order WHERE id = ${id}::uuid FOR UPDATE`.execute(trx);
  await sql`DELETE FROM doc_order_link WHERE voucher_id = ${voucherId}::uuid`.execute(trx);
  await syncOrders(trx, orders);
}
