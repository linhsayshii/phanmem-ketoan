import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { createDb, createPool } from './client.js';
import { migrate } from './migrate.js';
import type { Database } from './types.js';

export interface TestDb { admin: Kysely<Database>; db: Kysely<Database>; close(): Promise<void> }

export const newId = (): string => randomUUID();

export async function setupTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_ADMIN_URL!;
  const appUrl = process.env.DATABASE_URL!;
  await migrate(adminUrl);
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
