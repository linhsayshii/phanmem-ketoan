import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, postVoucher, recompute, setupLedgerTenant, snapshot, sumFromLines, type Line } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I2${Date.now()}`)); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Op = { kind: 'post'; date: string; lines: Line[] } | { kind: 'reverse' } | { kind: 'unpost' } | { kind: 'backdate'; lines: Line[] };
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('post' as const), date: arbDate2026, lines: arbBalancedLines }),
  fc.record({ kind: fc.constant('reverse' as const) }), fc.record({ kind: fc.constant('unpost' as const) }),
  fc.record({ kind: fc.constant('backdate' as const), lines: arbBalancedLines }));

describe('Bất biến 2: chuỗi post/reverse/unpost/ghi lùi ngày ngẫu nhiên', () => {
  it('snapshot = SUM dòng tại mọi ngày; gốc + đảo = 0 theo tài khoản và đối tượng', async () => {
    const posted: { id: string; date: string }[] = [];
    await fc.assert(fc.asyncProperty(fc.array(arbOp, { minLength: 5, maxLength: 15 }), async (ops) => {
      for (const op of ops) {
        if (op.kind === 'post') { const r = await postVoucher(ctx, cookie, op.date, op.lines); if (r.statusCode === 201) posted.push({ id: r.json().id, date: op.date }); }
        else if (op.kind === 'backdate') { const r = await postVoucher(ctx, cookie, '2026-01-02', op.lines); if (r.statusCode === 201) posted.push({ id: r.json().id, date: '2026-01-02' }); }
        else if (op.kind === 'reverse' && posted.length) {
          const v = posted[posted.length - 1]!;
          const r = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: v.date } });
          if (r.statusCode === 201) posted.pop();
        } else if (op.kind === 'unpost' && posted.length) {
          const v = posted.shift()!;
          const u = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } });
          if (u.statusCode === 200) { const p = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/post`, headers: { cookie } }); if (p.statusCode === 200) posted.push(v); }
        }
      }
      await recompute(ctx, cookie);
      for (const d of ['2026-01-15', '2026-03-31', '2026-07-31', '2026-12-31']) expect(await snapshot(ctx, cookie, d), d).toEqual(await sumFromLines(ctx, tenantId, d));
    }), { numRuns: 20 });
    const pairs = await sql<{ n: number }>`SELECT count(*) AS n FROM (
      SELECT l.account_id, l.party_id, sum(l.debit - l.credit) AS s FROM voucher v JOIN voucher r ON r.reversal_of_id = v.id JOIN voucher_line l ON l.voucher_id IN (v.id, r.id)
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state = 'reversed' GROUP BY l.account_id, l.party_id HAVING sum(l.debit - l.credit) <> 0) x`.execute(ctx.t.admin);
    expect(pairs.rows[0]!.n).toBe(0);
    // kiểm tra trên không rỗng: chuỗi ngẫu nhiên đã thực sự đảo và bỏ ghi sổ chứng từ
    const done = await sql<{ reversed: number; unposted: number }>`SELECT count(*) FILTER (WHERE state = 'reversed') AS reversed, (SELECT count(*) FROM voucher_line_history WHERE tenant_id = ${tenantId}::uuid) AS unposted FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    expect(done.rows[0]!.reversed).toBeGreaterThan(0); expect(done.rows[0]!.unposted).toBeGreaterThan(0);
  }, 300_000);
});
