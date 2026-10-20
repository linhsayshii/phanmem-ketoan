import 'dotenv/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import PgBoss from 'pg-boss';
import { createTestUser, setupTestDb, newId, type TestDb } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { closePdfBrowser } from '../src/modules/reporting/print/pdf.js';

export interface TestApp { app: FastifyInstance; t: TestDb; close(): Promise<void> }

export async function createTestApp(configOverrides: NodeJS.ProcessEnv = {}): Promise<TestApp> {
  const t = await setupTestDb();
  const boss = new PgBoss({ connectionString: process.env.DATABASE_ADMIN_URL!, schema: 'pgboss' });
  await boss.start();
  const attachmentDir = mkdtempSync(path.join(tmpdir(), 'kt-attachments-')); // tệp đính kèm của kiểm thử không làm bẩn thư mục dự án
  const app = await buildApp({ db: t.db, config: loadConfig({ ...process.env, SESSION_SECRET: 'test-secret-123', ATTACHMENT_DIR: attachmentDir, LOGIN_MAX_FAILS_IP: '1000000', ...configOverrides }), boss });
  await app.ready();
  return { app, t, close: async () => { await app.close(); await closePdfBrowser(); await boss.stop({ graceful: false }); await t.close(); rmSync(attachmentDir, { recursive: true, force: true }); } };
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
