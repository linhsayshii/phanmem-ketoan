import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, byAccount, postVoucher, recompute, runs, setupLedgerTenant, snapshot, snapshotByAccount, sumFromLines, timeoutFor, type Line } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I2${Date.now()}`)); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Op = { kind: 'post'; date: string; lines: Line[] } | { kind: 'reverse' } | { kind: 'unpost' } | { kind: 'backdate'; lines: Line[] };
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('post' as const), date: arbDate2026, lines: arbBalancedLines }),
  fc.record({ kind: fc.constant('reverse' as const) }), fc.record({ kind: fc.constant('unpost' as const) }),
  fc.record({ kind: fc.constant('backdate' as const), lines: arbBalancedLines }));

describe('Bất biến 2: chuỗi post/reverse/unpost/ghi lùi ngày ngẫu nhiên', () => {
  it('snapshot theo (tài khoản, đối tượng, tiền tệ) = SUM dòng tại mọi ngày; gốc + đảo = 0 theo tài khoản và đối tượng', async () => {
    // Mô hình trạng thái: `posted` là các chứng từ đang ghi sổ và chưa bị đảo. Mọi thao tác trên mô hình đều phải thành công đúng mã trạng thái:
    // lỗi 5xx hoặc 4xx bất ngờ làm hỏng kiểm thử thay vì bị bỏ qua lặng lẽ (nếu không, chuỗi ngẫu nhiên có thể không làm gì mà vẫn xanh).
    const posted: { id: string; date: string }[] = [];
    await fc.assert(fc.asyncProperty(fc.array(arbOp, { minLength: 5, maxLength: 15 }), async (ops) => {
      for (const op of ops) {
        if (op.kind === 'post' || op.kind === 'backdate') {
          const date = op.kind === 'post' ? op.date : '2026-01-02';
          const r = await postVoucher(ctx, cookie, date, op.lines);
          expect(r.statusCode, `${op.kind}: ${r.body}`).toBe(201); posted.push({ id: r.json().id, date });
        } else if (op.kind === 'reverse' && posted.length) {
          const v = posted[posted.length - 1]!;
          const r = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: v.date } });
          expect(r.statusCode, `reverse: ${r.body}`).toBe(201); posted.pop(); // đảo trả 201 vì tạo ra chứng từ đảo mới
        } else if (op.kind === 'unpost' && posted.length) {
          const v = posted.shift()!;
          const u = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } });
          expect(u.statusCode, `unpost: ${u.body}`).toBe(200);
          const p = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/post`, headers: { cookie } });
          expect(p.statusCode, `repost: ${p.body}`).toBe(200); posted.push(v);
        }
      }
      await recompute(ctx, cookie);
      for (const d of ['2026-01-15', '2026-03-31', '2026-07-31', '2026-12-31']) {
        const expected = await sumFromLines(ctx, tenantId, d);
        expect(await snapshot(ctx, cookie, d), d).toEqual(expected);
        expect(await snapshotByAccount(ctx, cookie, d), d).toEqual(byAccount(expected));
      }
    }), { numRuns: runs(20) });
    // Mỗi cặp (gốc, đảo) tự triệt tiêu theo tài khoản và đối tượng (nhóm theo từng chứng từ gốc nên một cặp lệch không bị cặp khác bù).
    const pairs = await sql<{ n: number }>`SELECT count(*) AS n FROM (
      SELECT v.id, l.account_id, l.party_id, sum(l.debit - l.credit) AS s FROM voucher v JOIN voucher r ON r.reversal_of_id = v.id JOIN voucher_line l ON l.voucher_id IN (v.id, r.id)
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state = 'reversed' GROUP BY v.id, l.account_id, l.party_id HAVING sum(l.debit - l.credit) <> 0) x`.execute(ctx.t.admin);
    expect(pairs.rows[0]!.n).toBe(0);
    // kiểm tra trên không rỗng: chuỗi ngẫu nhiên đã thực sự đảo và bỏ ghi sổ chứng từ, và có số dư theo đối tượng
    const done = await sql<{ reversed: number; unposted: number; withParty: number }>`SELECT count(*) FILTER (WHERE state = 'reversed') AS reversed,
      (SELECT count(*) FROM voucher_line_history WHERE tenant_id = ${tenantId}::uuid) AS unposted,
      (SELECT count(*) FROM voucher_line WHERE tenant_id = ${tenantId}::uuid AND party_id IS NOT NULL) AS "withParty" FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    expect(done.rows[0]!.reversed).toBeGreaterThan(0); expect(done.rows[0]!.unposted).toBeGreaterThan(0); expect(done.rows[0]!.withParty).toBeGreaterThan(0);
  }, timeoutFor(300_000));
});
