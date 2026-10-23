import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

export const SETTINGS = z.object({
  book_form: z.enum(['NKC']).default('NKC'),
  costing_method: z.enum(['avg_period', 'avg_moving', 'fifo', 'specific']).default('avg_period'),
  base_currency: z.literal('VND').default('VND'),
  hidden_modules: z.array(z.string()).default([]),
  extra_dims: z.array(z.object({ key: z.string().regex(/^[a-z_]+$/), label: z.string().min(1) })).default([]),
  fx_rate_type: z.enum(['transfer_avg', 'buy', 'sell']).default('transfer_avg'),
  // Tra MST người bán hóa đơn đầu vào: off = không gửi MST ra ngoài (mặc định), vietqr = tra qua dịch vụ VietQR (bên thứ ba).
  tax_code_lookup: z.enum(['off', 'vietqr']).default('off'),
  // Ghi sổ làm tồn quỹ tiền mặt hoặc số dư tiền gửi âm: warn = ghi sổ và cảnh báo, block = chặn (409 CASH_NEGATIVE).
  cash_negative: z.enum(['warn', 'block']).default('warn'),
  // Tỷ giá ghi Có tài khoản tiền ngoại tệ: moving_average = bình quân di động (điền sẵn trên phiếu chi, tính lại cuối kỳ bằng chứng từ XQ), specific = người dùng nhập tỷ giá.
  fx_outflow_method: z.enum(['moving_average', 'specific']).default('moving_average'),
  // Loại tỷ giá đánh giá lại ngoại tệ cuối kỳ cho tài sản (tiền, phải thu) và nợ phải trả; null = theo chế độ kế toán (fx-rules.json). Chọn lại khi chế độ chưa đối chiếu văn bản gốc.
  fx_reval_rate_asset: z.enum(['transfer_avg', 'buy', 'sell']).nullable().default(null),
  fx_reval_rate_liability: z.enum(['transfer_avg', 'buy', 'sell']).nullable().default(null),
  // Kỳ kê khai thuế GTGT: hóa đơn ghi declare_period theo tháng (1-12) hoặc quý (1-4).
  vat_period: z.enum(['month', 'quarter']).default('month'),
  // Xuất kho làm tồn âm: forbid = chặn, warn = ghi sổ và cảnh báo, allow = cho phép.
  stock_negative: z.enum(['forbid', 'warn', 'allow']).default('forbid'),
  // Cách tính khấu hao tháng đầu/tháng cuối: day = theo số ngày thực tế, month = tròn tháng.
  fa_proration: z.enum(['day', 'month']).default('day'),
});
export type Settings = z.infer<typeof SETTINGS>;

export async function getSettings(trx: Transaction<Database>, tenantId: string): Promise<Settings> {
  const rows = await trx.selectFrom('tenant_setting').select(['key', 'value']).where('tenant_id', '=', tenantId).execute();
  return SETTINGS.parse(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/settings', { preHandler: app.requireAuth }, async (req) => app.withTenant(req, (trx) => getSettings(trx, req.auth!.tenantId!)));
  app.put('/api/settings', { preHandler: app.requirePermission('setting.update'), schema: { body: SETTINGS.partial().strict() } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      // Cách tính khấu hao tháng đầu/cuối đổi khi đã có lần chạy KH hiệu lực: lịch các kỳ đã chạy lệch lặng lẽ → chỉ đổi trước lần chạy đầu tiên (khóa tư vấn như chạy kỳ).
      if (req.body.fa_proration !== undefined) {
        await sql`SELECT pg_advisory_xact_lock(hashtext('asset_run'), hashtext(${tenantId}))`.execute(trx);
        if (req.body.fa_proration !== (await getSettings(trx, tenantId)).fa_proration
          && await trx.selectFrom('period_run').select('id').where('kind', '=', 'depreciation').where('status', '=', 'active').limit(1).executeTakeFirst())
          throw new AppError('FA_PRORATION_LOCKED', 'Đã có lần chạy khấu hao TSCĐ: không đổi được cách tính khấu hao tháng đầu, tháng cuối (chỉ đổi trước lần chạy khấu hao đầu tiên)', 409);
      }
      for (const [key, value] of Object.entries(req.body)) {
        await trx.insertInto('tenant_setting').values({ tenant_id: tenantId, key, value: JSON.stringify(value) })
          .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(value), updated_at: new Date().toISOString() })).execute();
      }
    });
    return { ok: true };
  });
};
export default routes;
