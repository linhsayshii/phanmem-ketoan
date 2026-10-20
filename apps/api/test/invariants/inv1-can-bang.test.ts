import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, arbUnbalancedLines, postVoucher, setupLedgerTenant } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I1${Date.now()}`)); }, 60_000);
afterAll(async () => { await ctx.close(); });

describe('Bất biến 1: mọi chứng từ ghi sổ cân; chứng từ lệch bị từ chối', () => {
  it('chứng từ cân luôn ghi được và SUM(debit)=SUM(credit) trong DB', async () => {
    await fc.assert(fc.asyncProperty(arbDate2026, arbBalancedLines, async (date, lines) => {
      const r = await postVoucher(ctx, cookie, date, lines);
      expect(r.statusCode, r.body).toBe(201);
    }), { numRuns: 30 });
    const bad = await sql<{ n: number }>`SELECT count(*) AS n FROM (SELECT l.voucher_id FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${tenantId}::uuid GROUP BY l.voucher_id HAVING sum(l.debit) <> sum(l.credit)) x`.execute(ctx.t.admin);
    expect(bad.rows[0]!.n).toBe(0);
  }, 120_000);

  it('lệch một đồng ở bất kỳ dòng nào đều bị từ chối với VOUCHER_UNBALANCED và không để lại chứng từ', async () => {
    const count = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n;
    const before = await count();
    await fc.assert(fc.asyncProperty(arbDate2026, arbUnbalancedLines, async (date, lines) => {
      const r = await postVoucher(ctx, cookie, date, lines);
      expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('VOUCHER_UNBALANCED');
    }), { numRuns: 30 });
    expect(await count()).toBe(before);
  }, 120_000);
});
