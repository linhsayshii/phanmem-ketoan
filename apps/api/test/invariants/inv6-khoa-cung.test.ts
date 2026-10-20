import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { createTestApp, type TestApp } from '../helpers.js';
import { postVoucher, setupLedgerTenant } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string; let posted: string; let before: { vouchers: number; lines: number };
const counts = async () => (await sql<{ vouchers: number; lines: number }>`SELECT (SELECT count(*) FROM voucher WHERE tenant_id = ${tenantId}::uuid) AS vouchers, (SELECT count(*) FROM voucher_line WHERE tenant_id = ${tenantId}::uuid) AS lines`.execute(ctx.t.admin)).rows[0]!;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I6${Date.now()}`));
  const ob = await ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie }, payload: { rows: [{ accountCode: '1111', debit: '1000' }, { accountCode: '4111', credit: '1000' }] } });
  expect(ob.statusCode, ob.body).toBe(200);
  const dk = await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
  expect(dk.statusCode, dk.body).toBe(200);
  const v = await postVoucher(ctx, cookie, '2026-01-10', [{ accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '100' }]);
  expect(v.statusCode, v.body).toBe(201); posted = v.json().id;
  // khóa cứng phải đi tuần tự: kỳ 0 (số dư đầu kỳ) rồi kỳ 1
  for (const no of [0, 1]) { const l = await ctx.app.inject({ method: 'POST', url: `/api/periods/2026/${no}/lock`, headers: { cookie }, payload: { level: 'hard' } }); expect(l.statusCode, l.body).toBe(200); }
  before = await counts();
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('Bất biến 6: kỳ khóa cứng từ chối mọi ghi', () => {
  const expectLocked = (r: { statusCode: number; json: () => { error: { code: string } } }) => { expect(r.statusCode).toBe(409); expect(['PERIOD_HARD_LOCKED', 'VOUCHER_HASHED', 'LINE_IMMUTABLE']).toContain(r.json().error.code); };

  it('qua API: tạo, ghi sổ, bỏ ghi sổ, đảo, sửa diễn giải, ghi lại số dư đầu kỳ', async () => {
    expectLocked(await postVoucher(ctx, cookie, '2026-01-20', [{ accountCode: '6422', debit: '1' }, { accountCode: '1111', credit: '1' }]));
    expectLocked(await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted}/unpost`, headers: { cookie } }));
    expectLocked(await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted}/reverse`, headers: { cookie }, payload: { postingDate: '2026-01-31' } }));
    expectLocked(await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-01' } })); // đảo sang kỳ mở vẫn phải chặn vì chứng từ gốc nằm trong kỳ khóa
    const v = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${posted}`, headers: { cookie } })).json();
    expectLocked(await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${posted}`, headers: { cookie }, payload: { version: v.version, description: 'sửa' } }));
    expectLocked(await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } }));
  });

  it('qua SQL với vai trò ứng dụng: insert/update/delete dòng và header đều bị từ chối', async () => {
    const asApp = (fn: (trx: Transaction<Database>) => Promise<unknown>) => ctx.t.db.transaction().execute(async (trx) => { await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx); return fn(trx); });
    await expect(asApp((trx) => sql`UPDATE voucher_line SET description = 'x' WHERE voucher_id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/PERIOD_HARD_LOCKED|LINE_IMMUTABLE/);
    await expect(asApp((trx) => sql`DELETE FROM voucher_line WHERE voucher_id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/LINE_IMMUTABLE/);
    await expect(asApp((trx) => sql`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency) SELECT tenant_id, voucher_id, 9, account_id, posting_date, 1, 0, 1 FROM voucher_line WHERE voucher_id = ${posted}::uuid LIMIT 1`.execute(trx))).rejects.toThrow(/LINE_IMMUTABLE/);
    await expect(asApp((trx) => sql`UPDATE voucher SET description = 'x' WHERE id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/PERIOD_HARD_LOCKED/);
    await expect(asApp((trx) => sql`DELETE FROM voucher WHERE id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/VOUCHER_DELETE_FORBIDDEN/);
  });

  it('sau mọi lần ghi bị từ chối: số chứng từ và số dòng không đổi, chuỗi hash của kỳ 1 vẫn khớp', async () => {
    expect(await counts()).toEqual(before);
    const h = await sql<{ voucher_id: string | null; ok: boolean }>`SELECT voucher_id, ok FROM verify_period_hash(${tenantId}::uuid, 2026, 1)`.execute(ctx.t.admin);
    expect(h.rows.filter((r) => r.voucher_id !== null).length).toBeGreaterThan(0); // có chứng từ được kiểm tra (không rỗng)
    expect(h.rows.filter((r) => !r.ok)).toEqual([]); // kể cả dòng so hash cuối chuỗi với hash_tail
  });
});
