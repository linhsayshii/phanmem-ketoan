import './env.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { createDb, createPool } from './client.js';
import { migrate } from './migrate.js';
import { syncReferenceData } from './reference.js';
import type { Database } from './types.js';

export interface TestDb { admin: Kysely<Database>; db: Kysely<Database>; close(): Promise<void> }

export const newId = (): string => randomUUID();

export async function setupTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_ADMIN_URL!;
  const appUrl = process.env.DATABASE_URL!;
  await migrate(adminUrl);
  await syncReferenceData(adminUrl);
  // Kiểm thử lương của API dùng tham số minh họa của công ty (payroll_param, kỳ 2026) và kỳ vọng tính tay theo đó; legal_param thắng payroll_param nên gỡ các dòng
  // lương, TNCN, BHXH thật khỏi DB kiểm thử khi KT_TEST_ILLUSTRATIVE_PAYROLL=1 (apps/api/vitest.config.ts). Kiểm thử tham số thật dựng lại từ tệp: apps/api/test/payroll/legalParams.test.ts.
  if (process.env.KT_TEST_ILLUSTRATIVE_PAYROLL === '1') {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try { await c.query(`DELETE FROM legal_param WHERE code ~ '^(pit_|si_|min_wage|ot_|payroll)'`); } finally { await c.end(); }
  }
  const adminPool = createPool(adminUrl);
  const appPool = createPool(appUrl);
  return {
    admin: createDb(adminPool),
    db: createDb(appPool),
    close: async () => { await adminPool.end(); await appPool.end(); },
  };
}

export async function createTestUser(admin: Kysely<Database>, input: { username: string; passwordHash: string }): Promise<string> {
  const r = await admin.insertInto('app_user')
    .values({ username: input.username, full_name: input.username, password_hash: input.passwordHash })
    .returning('id').executeTakeFirstOrThrow();
  return r.id;
}

export async function createTestTenant(admin: Kysely<Database>, input: { code: string; name: string; ownerUserId?: string }): Promise<string> {
  const owner = input.ownerUserId ?? (await createTestUser(admin, { username: `u_${input.code}_${newId().slice(0, 8)}`, passwordHash: 'x' }));
  const r = await sql<{ id: string }>`SELECT create_tenant(${input.code}, ${input.name}, NULL, ${owner}::uuid) AS id`.execute(admin);
  return r.rows[0]!.id;
}
