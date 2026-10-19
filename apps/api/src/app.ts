import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Kysely } from 'kysely';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Database } from '@kt/db';
import type { Config } from './config.js';
import errorsPlugin from './plugins/errors.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/core/users.js';
import roleRoutes from './modules/core/roles.js';
import tenantRoutes from './modules/core/tenants.js';
import fiscalYearRoutes from './modules/core/fiscalYears.js';
import settingRoutes from './modules/core/settings.js';
import coaRoutes from './modules/coa/routes.js';

declare module 'fastify' { interface FastifyInstance { config: Config } }

export async function buildApp(opts: { db: Kysely<Database>; config: Config }) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', opts.config);
  await app.register(errorsPlugin);
  await app.register(cors, { origin: opts.config.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: opts.config.SESSION_SECRET });
  await app.register(dbPlugin, { db: opts.db });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(roleRoutes);
  await app.register(tenantRoutes);
  await app.register(fiscalYearRoutes);
  await app.register(settingRoutes);
  await app.register(coaRoutes);
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
