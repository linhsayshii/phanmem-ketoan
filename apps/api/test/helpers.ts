import 'dotenv/config';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { createTestUser, setupTestDb, newId, type TestDb } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';

export interface TestApp { app: FastifyInstance; t: TestDb; close(): Promise<void> }

export async function createTestApp(): Promise<TestApp> {
  const t = await setupTestDb();
  const app = await buildApp({ db: t.db, config: loadConfig({ ...process.env, SESSION_SECRET: 'test-secret-123' }) });
  await app.ready();
  return { app, t, close: async () => { await app.close(); await t.close(); } };
}

export const TEST_PASSWORD = 'Matkhau1!';

export async function bootstrapTenant(ctx: TestApp, input: { code: string }) {
  const username = `admin_${input.code}_${newId().slice(0, 6)}`.toLowerCase();
  const userId = await createTestUser(ctx.t.admin, { username, passwordHash: await hashPassword(TEST_PASSWORD) });
  const r = await sql<{ id: string }>`SELECT create_tenant(${input.code}, ${'Công ty ' + input.code}, NULL, ${userId}::uuid) AS id`.execute(ctx.t.admin);
  const tenantId = r.rows[0]!.id;
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login thất bại: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'sid')!;
  return { tenantId, userId, username, cookie: `sid=${cookie.value}` };
}
