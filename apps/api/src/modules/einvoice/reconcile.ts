import { sql, type Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { providerFor } from './providers/index.js';
import { refreshEInvoice, retryEInvoice, type ProviderFactory } from './issue.js';

// Đối soát nền (worker): hàng `sending` lâu không có kết quả thì thử lại theo transaction_uuid; hóa đơn ký hiệu C chờ mã thì tra mã của cơ quan thuế.
// Danh sách công ty lấy qua hàm SECURITY DEFINER (chỉ tenant_id), mọi thao tác sau đó chạy dưới RLS của từng công ty.
// Một hóa đơn lỗi không chặn các hóa đơn khác: lỗi được đếm vào `errors`, lần chạy sau thử lại.
export async function reconcilePending(db: Kysely<Database>, providerFactory: ProviderFactory = providerFor, opts: { olderThanSec: number; limit: number }):
  Promise<{ checked: number; issued: number; failed: number; errors: number }> {
  const out = { checked: 0, issued: 0, failed: 0, errors: 0 };
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
        } else await refreshEInvoice(db, { tenantId }, r.id, providerFactory);
      } catch {
        out.errors++;
      }
    }
  }
  return out;
}
