import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { READ_SNAPSHOT, withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';

let t: TestDb; let tenantId: string;
beforeAll(async () => { t = await setupTestDb(); tenantId = await createTestTenant(t.admin, { code: `WT${Date.now()}`, name: 'Công ty WT' }); });
afterAll(async () => { await t.close(); });

const show = (trx: Parameters<Parameters<typeof withTenant>[2]>[0]) => sql<{ iso: string; ro: string }>`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`.execute(trx).then((r) => r.rows[0]!);

describe('withTenant: mức cô lập giao dịch', () => {
  it('mặc định read committed, đọc ghi', async () => {
    expect(await withTenant(t.db, { tenantId }, show)).toEqual({ iso: 'read committed', ro: 'off' });
  });
  it('READ_SNAPSHOT: repeatable read, chỉ đọc; vẫn đặt được biến phiên công ty', async () => {
    const r = await withTenant(t.db, { tenantId }, async (trx) => ({ ...(await show(trx)), tenant: (await sql<{ t: string }>`SELECT app_tenant()::text AS t`.execute(trx)).rows[0]!.t }), READ_SNAPSHOT);
    expect(r).toEqual({ iso: 'repeatable read', ro: 'on', tenant: tenantId });
  });
  it('repeatable read đọc ghi: ghi được; chỉ đọc thì ghi bị từ chối (25006)', async () => {
    expect(await withTenant(t.db, { tenantId }, show, { isolation: 'repeatable read' })).toEqual({ iso: 'repeatable read', ro: 'off' });
    await expect(withTenant(t.db, { tenantId }, (trx) => sql`CREATE TEMP TABLE _x(a int)`.execute(trx), READ_SNAPSHOT)).rejects.toMatchObject({ code: '25006' });
  });
});
