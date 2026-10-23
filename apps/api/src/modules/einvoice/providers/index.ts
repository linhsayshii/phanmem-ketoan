import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { AppError } from '../../../plugins/errors.js';
import { openSecret } from '../../../lib/secretBox.js';
import { fakeProvider } from './fake.js';
import { SInvoiceProvider } from './sinvoice.js';
import type { EInvoiceProvider, ProviderCtx, ProviderRow } from './types.js';

export * from './types.js';

export function providerFor(row: ProviderRow): EInvoiceProvider {
  if (row.code === 'fake') return fakeProvider(row.options);
  if (row.code === 'sinvoice') {
    if (!row.secret) throw new AppError('EINVOICE_PROVIDER_NO_SECRET', 'Nhà cung cấp SInvoice chưa có mật khẩu: nhập mật khẩu trong cài đặt nhà cung cấp hóa đơn điện tử', 409);
    return new SInvoiceProvider({ baseUrl: row.base_url.replace(/\/+$/, ''), username: row.username, password: openSecret(row.secret), sellerTaxCode: row.seller_tax_code });
  }
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

// Chạy một lần gọi nhà cung cấp. Nhà cung cấp `fake` dùng kho trong DB nên chạy trong một giao dịch công ty và COMMIT cả khi ném lỗi (nhật ký và kho giả lập sống sót qua lỗi).
// Nhà cung cấp thật KHÔNG giữ giao dịch qua lời gọi HTTP: `ctx.db` bị chặn (ném lỗi nếu dùng) và mỗi dòng nhật ký einvoice_log ghi trong một giao dịch ngắn riêng,
// commit độc lập với kết quả lời gọi. Không gọi từ trong giao dịch đang giữ khóa nghiệp vụ.
export async function withProviderCtx<T>(db: Kysely<Database>, p: { tenantId: string; userId?: string | null; providerId: number; einvoiceId: number | null }, fn: (ctx: ProviderCtx) => Promise<T>): Promise<T> {
  const tctx = { tenantId: p.tenantId, ...(p.userId ? { userId: p.userId } : {}) };
  const code = (await withTenant(db, tctx, (trx) => trx.selectFrom('einvoice_provider').select('code').where('id', '=', p.providerId).executeTakeFirst()))?.code;
  if (code && code !== 'fake') {
    const noDb = new Proxy({}, { get() { throw new Error('Nhà cung cấp thật không được dùng ctx.db: không giữ giao dịch DB khi gọi HTTP'); } }) as Kysely<Database>;
    return fn({ db: noDb, log: (e) => withTenant(db, tctx, (trx) => makeProviderCtx(trx, p).log(e)) });
  }
  const r = await withTenant(db, tctx, async (trx) => {
    try { return { ok: true as const, value: await fn(makeProviderCtx(trx, p)) }; } catch (e) { return { ok: false as const, error: e }; }
  });
  if (!r.ok) throw r.error;
  return r.value;
}
