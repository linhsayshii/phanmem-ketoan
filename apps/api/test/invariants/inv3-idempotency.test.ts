import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, postVoucher, runs, setupLedgerTenant, timeoutFor } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I3${Date.now()}`)); }, 60_000);
afterAll(async () => { await ctx.close(); });

describe('Bất biến 3: cùng idempotency_key lặp k lần', () => {
  it('đúng một chứng từ, tổng phát sinh không đổi', async () => {
    const sumDebit = async () => (await sql<{ s: string }>`SELECT coalesce(sum(debit),0)::text AS s FROM voucher_line WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.s;
    await fc.assert(fc.asyncProperty(arbDate2026, arbBalancedLines, fc.integer({ min: 2, max: 8 }), fc.uuid(), async (date, lines, k, key) => {
      const before = await sumDebit();
      const rs = await Promise.all(Array.from({ length: k }, () => postVoucher(ctx, cookie, date, lines, { idempotencyKey: key })));
      for (const r of rs) expect(r.statusCode, r.body).toBe(201);
      expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
      const n = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${key}`.execute(ctx.t.admin);
      expect(n.rows[0]!.n).toBe(1);
      const expected = BigInt(before) + lines.reduce((s, l) => s + BigInt(l.debit ?? '0'), 0n);
      expect(await sumDebit()).toBe(expected.toString());
    }), { numRuns: runs(20) });
  }, timeoutFor(120_000));
});
