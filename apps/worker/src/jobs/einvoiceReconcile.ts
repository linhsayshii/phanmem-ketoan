import type { Kysely } from 'kysely';
import type { Database } from '@kt/db';
import { reconcilePending } from '@kt/api/einvoice-reconcile';

// Đối soát hóa đơn điện tử 5 phút một lần: hàng `sending` không có kết quả quá 120 giây (lời gọi phát hành chậm nhất 60 giây), hóa đơn ký hiệu C chờ mã CQT.
export const EINVOICE_RECONCILE_CRON = '*/5 * * * *';
export const runEInvoiceReconcile = (db: Kysely<Database>) => reconcilePending(db, undefined, { olderThanSec: 120, limit: 200 });
