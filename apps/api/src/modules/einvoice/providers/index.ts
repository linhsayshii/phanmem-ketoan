import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { AppError } from '../../../plugins/errors.js';
import { fakeProvider } from './fake.js';
import type { EInvoiceProvider, ProviderCtx, ProviderRow } from './types.js';

export * from './types.js';

export function providerFor(row: ProviderRow): EInvoiceProvider {
  if (row.code === 'fake') return fakeProvider(row.options);
  // 'sinvoice' do Task 7 đăng ký.
  throw new AppError('EINVOICE_PROVIDER_UNSUPPORTED', `Chưa hỗ trợ nhà cung cấp hóa đơn điện tử "${row.code}"`, 409);
}

// Ngữ cảnh gọi nhà cung cấp: `log` ghi einvoice_log (người gọi đã che bí mật khỏi yêu cầu/phản hồi). `db` là bộ thực thi dưới RLS của công ty.
export function makeProviderCtx(db: Kysely<Database>, p: { tenantId: string; providerId: number; einvoiceId: number | null; userId?: string | null }): ProviderCtx {
  return {
    db,
    async log(e) {
      await db.insertInto('einvoice_log').values({ tenant_id: p.tenantId, einvoice_id: p.einvoiceId, provider_id: p.providerId, action: e.action, request: JSON.stringify(e.request ?? null),
        response: JSON.stringify(e.response ?? null), http_status: e.httpStatus, ok: e.ok, error: e.error ?? null, ms: e.ms, created_by: p.userId ?? null }).execute();
    },
  };
}

// Chạy một lần gọi nhà cung cấp trong giao dịch riêng của công ty và COMMIT cả khi nhà cung cấp ném lỗi (rồi ném lại): nhật ký einvoice_log
// và kho giả lập (timeout_after_create) phải sống sót qua lỗi. Không gọi từ trong giao dịch đang giữ khóa nghiệp vụ.
export async function withProviderCtx<T>(db: Kysely<Database>, p: { tenantId: string; userId?: string | null; providerId: number; einvoiceId: number | null }, fn: (ctx: ProviderCtx) => Promise<T>): Promise<T> {
  const r = await withTenant(db, { tenantId: p.tenantId, ...(p.userId ? { userId: p.userId } : {}) }, async (trx) => {
    try { return { ok: true as const, value: await fn(makeProviderCtx(trx, p)) }; } catch (e) { return { ok: false as const, error: e }; }
  });
  if (!r.ok) throw r.error;
  return r.value;
}
