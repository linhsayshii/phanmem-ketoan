import { sql, type Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { providerFor } from './providers/index.js';

export { RETRY_GUARD_SEC } from './providers/index.js';
import { refreshEInvoice, retryEInvoice, type ProviderFactory } from './issue.js';

// Đối soát nền (worker): hàng `sending` lâu không có kết quả thì thử lại theo transaction_uuid; hóa đơn ký hiệu C chờ mã thì tra mã của cơ quan thuế.
// Danh sách công ty lấy qua hàm SECURITY DEFINER (chỉ tenant_id), mọi thao tác sau đó chạy dưới RLS của từng công ty.
// Một hóa đơn lỗi không chặn các hóa đơn khác: lỗi được đếm vào `errors` và kê chi tiết (tối đa MAX_ERROR_DETAILS) cho worker ghi log; lần chạy sau thử lại.
// Cảnh báo của hóa đơn đã xử lý (vd. hóa đơn thay thế phát hành xong, chứng từ gốc chờ đảo) kê ở `notices` (cùng giới hạn) cho worker ghi log.
const MAX_ERROR_DETAILS = 50;
export interface ReconcileError { tenantId: string; einvoiceId: number; code: string | null; message: string }
export interface ReconcileNotice { tenantId: string; einvoiceId: number; code: string; message: string }
export async function reconcilePending(db: Kysely<Database>, providerFactory: ProviderFactory = providerFor, opts: { olderThanSec: number; limit: number }):
  Promise<{ checked: number; issued: number; failed: number; errors: number; errorDetails: ReconcileError[]; notices: ReconcileNotice[] }> {
  const out = { checked: 0, issued: 0, failed: 0, errors: 0, errorDetails: [] as ReconcileError[], notices: [] as ReconcileNotice[] };
  const tenants = (await sql<{ tenant_id: string }>`SELECT tenant_id FROM fn_einvoice_pending_tenants(${opts.olderThanSec}::int)`.execute(db)).rows;
  for (const { tenant_id: tenantId } of tenants) {
    if (out.checked >= opts.limit) break;
    const rows = await withTenant(db, { tenantId }, (trx) => trx.selectFrom('einvoice').select(['id', 'status'])
      .where((w) => w.or([w('status', '=', 'sending'), w.and([w('status', '=', 'issued'), w('cqt_status', '=', 'waiting')])]))
      .where(sql<boolean>`coalesce(last_attempt_at, created_at) < now() - make_interval(secs => ${opts.olderThanSec}::int)`)
      .orderBy('id').limit(opts.limit - out.checked).execute());
    for (const r of rows) {
      out.checked++;
      try {
        if (r.status === 'sending') {
          const dto = await retryEInvoice(db, { tenantId }, r.id, providerFactory);
          if (dto.status === 'issued') out.issued++;
          else if (dto.status === 'failed') out.failed++;
          for (const w of dto.warnings ?? []) if (out.notices.length < MAX_ERROR_DETAILS) out.notices.push({ tenantId, einvoiceId: r.id, ...w });
        } else await refreshEInvoice(db, { tenantId }, r.id, providerFactory);
      } catch (e) {
        out.errors++;
        if (out.errorDetails.length < MAX_ERROR_DETAILS) out.errorDetails.push({ tenantId, einvoiceId: r.id, code: e instanceof AppError ? e.code : null, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}
