import { sql, type Kysely } from 'kysely';
import type { Database } from '@kt/db';
import { runRecurring, type RunItem } from '@kt/api/recurring';

// Bút toán định kỳ: mỗi ngày 01:30 (giờ Việt Nam) sinh chứng từ NHÁP cho các kỳ đã đến hạn của mọi mẫu đang chạy. Idempotent: chạy lại không sinh trùng.
export const RECURRING_CRON = '30 1 * * *';
export interface RecurringSummary { tenants: number; created: number; skipped: number; errors: number; details: { tenantId: string; entry: string; period: string; status: RunItem['status']; code?: string | undefined; message?: string | undefined }[] }

export async function runRecurringAll(db: Kysely<Database>): Promise<RecurringSummary> {
  const tenants = (await sql<{ tenant_id: string }>`SELECT tenant_id FROM fn_recurring_tenants()`.execute(db)).rows;
  const out: RecurringSummary = { tenants: tenants.length, created: 0, skipped: 0, errors: 0, details: [] };
  for (const { tenant_id: tenantId } of tenants) {
    try {
      for (const i of await runRecurring(db, tenantId, { trigger: 'worker' })) {
        if (i.status === 'created') out.created++;
        else if (i.status === 'skipped') out.skipped++;
        else if (i.status === 'error') out.errors++;
        else continue;
        if (i.status !== 'created' && out.details.length < 50) out.details.push({ tenantId, entry: i.entryCode, period: i.periodKey, status: i.status, code: i.reasonCode, message: i.message });
      }
    } catch (e) { // lỗi cả công ty (mất kết nối, mẫu bị xóa giữa chừng) không chặn công ty khác
      out.errors++;
      if (out.details.length < 50) out.details.push({ tenantId, entry: '*', period: '', status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
