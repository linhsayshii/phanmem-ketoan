import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';

export const SETTINGS = z.object({
  book_form: z.enum(['NKC']).default('NKC'),
  costing_method: z.enum(['avg_period', 'avg_moving', 'fifo', 'specific']).default('avg_period'),
  base_currency: z.literal('VND').default('VND'),
  hidden_modules: z.array(z.string()).default([]),
  extra_dims: z.array(z.object({ key: z.string().regex(/^[a-z_]+$/), label: z.string().min(1) })).default([]),
  fx_rate_type: z.enum(['transfer_avg', 'buy', 'sell']).default('transfer_avg'),
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
      for (const [key, value] of Object.entries(req.body)) {
        await trx.insertInto('tenant_setting').values({ tenant_id: tenantId, key, value: JSON.stringify(value) })
          .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(value), updated_at: new Date().toISOString() })).execute();
      }
    });
    return { ok: true };
  });
};
export default routes;
