import type { Kysely } from 'kysely';
import type { Database } from '@kt/db';
import { reconcilePending, RETRY_GUARD_SEC } from '@kt/api/einvoice-reconcile';

// Đối soát hóa đơn điện tử 5 phút một lần: hàng `sending` không có kết quả quá RETRY_GUARD_SEC (hai lời gọi tối đa + dự phòng), hóa đơn ký hiệu C chờ mã CQT.
export const EINVOICE_RECONCILE_CRON = '*/5 * * * *';
export const runEInvoiceReconcile = (db: Kysely<Database>) => reconcilePending(db, undefined, { olderThanSec: RETRY_GUARD_SEC, limit: 200 });
