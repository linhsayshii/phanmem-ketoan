import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, arbUnbalancedLines, arbWideBalancedLines, arbWideUnbalancedLines, MAX_LINE_VND, postVoucher, runs, setupLedgerTenant, timeoutFor } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I1${Date.now()}`)); }, 60_000);
afterAll(async () => { await ctx.close(); });

// Một nửa số lần dùng số tiền rất lớn (hàng triệu tỷ đồng): phép cộng và so sánh Nợ/Có phải chính xác tuyệt đối.
const anyBalanced = fc.oneof(arbBalancedLines, arbWideBalancedLines);
const anyUnbalanced = fc.oneof(arbUnbalancedLines, arbWideUnbalancedLines);

describe('Bất biến 1: mọi chứng từ ghi sổ cân; chứng từ lệch bị từ chối', () => {
  it('chứng từ cân luôn ghi được và SUM(debit)=SUM(credit) trong DB', async () => {
    await fc.assert(fc.asyncProperty(arbDate2026, anyBalanced, async (date, lines) => {
      const r = await postVoucher(ctx, cookie, date, lines);
      expect(r.statusCode, r.body).toBe(201);
    }), { numRuns: runs(30) });
    const bad = await sql<{ n: number }>`SELECT count(*) AS n FROM (SELECT l.voucher_id FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${tenantId}::uuid GROUP BY l.voucher_id HAVING sum(l.debit) <> sum(l.credit)) x`.execute(ctx.t.admin);
    expect(bad.rows[0]!.n).toBe(0);
  }, timeoutFor(120_000));

  it('lệch một đồng ở bất kỳ dòng nào đều bị từ chối với VOUCHER_UNBALANCED và không để lại chứng từ', async () => {
    const count = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n;
    const before = await count();
    await fc.assert(fc.asyncProperty(arbDate2026, anyUnbalanced, async (date, lines) => {
      const r = await postVoucher(ctx, cookie, date, lines);
      expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('VOUCHER_UNBALANCED');
    }), { numRuns: runs(30) });
    expect(await count()).toBe(before);
  }, timeoutFor(120_000));

  it('giới hạn một dòng VND là 10^16 − 1 đồng: đúng mức giới hạn ghi sổ được, vượt một đồng bị từ chối 400 và không để lại chứng từ', async () => {
    // amount_currency numeric(20,4) (migration 0004) mang cả Nợ − Có của dòng VND nên tràn từ 10^16; API chỉ trả VALIDATION chung vì regex tiền nhận tới 20 chữ số.
    const count = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n;
    const pair = (amt: bigint) => [{ accountCode: '1111', debit: amt.toString() }, { accountCode: '4111', credit: amt.toString() }];
    const before = await count();
    const ok = await postVoucher(ctx, cookie, '2026-01-05', pair(MAX_LINE_VND));
    expect(ok.statusCode, ok.body).toBe(201);
    const over = await postVoucher(ctx, cookie, '2026-01-05', pair(MAX_LINE_VND + 1n));
    expect(over.statusCode, over.body).toBe(400); expect(over.json().error.code).toBe('VALIDATION');
    expect(await count()).toBe(before + 1);
  }, timeoutFor(60_000));
});
