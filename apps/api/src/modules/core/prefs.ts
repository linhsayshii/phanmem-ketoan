import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/prefs/:key', { preHandler: app.requireAuth, schema: { params: z.object({ key: z.string().max(200) }) } }, async (req) =>
    app.withTenant(req, async (trx) => ({ value: (await trx.selectFrom('user_pref').select('value').where('user_id', '=', req.auth!.userId).where('tenant_id', '=', req.auth!.tenantId!).where('key', '=', req.params.key).executeTakeFirst())?.value ?? null })));
  app.put('/api/prefs/:key', { preHandler: app.requireAuth, schema: { params: z.object({ key: z.string().max(200) }), body: z.object({ value: z.unknown().refine((v) => v !== undefined, 'Thiếu giá trị') }) } }, async (req) => {
    await app.withTenant(req, (trx) => trx.insertInto('user_pref').values({ user_id: req.auth!.userId, tenant_id: req.auth!.tenantId!, key: req.params.key, value: JSON.stringify(req.body.value) })
      .onConflict((oc) => oc.columns(['user_id', 'tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(req.body.value) })).execute());
    return { ok: true };
  });
};
export default routes;
