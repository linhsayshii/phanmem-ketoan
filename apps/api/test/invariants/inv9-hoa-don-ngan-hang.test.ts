import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { reconcilePending } from '../../src/modules/einvoice/reconcile.js';
import { providerFor, RETRY_GUARD_SEC } from '../../src/modules/einvoice/providers/index.js';
import { setupBankTenant, sepayBody } from '../bank/helpers.js';
import { runs, timeoutFor } from './helpers.js';

// Bất biến 9: hóa đơn điện tử và giao dịch ngân hàng.
//  (1) mỗi chứng từ có tối đa một hóa đơn sending|issued; hóa đơn issued có voucher_invoice đúng số, ký hiệu, ngày; sau đối soát không còn hóa đơn sending.
//  (2) chứng từ có hóa đơn issued luôn posted; hóa đơn replaced|cancelled thì chứng từ đã reversed hoặc còn cờ needs_reversal.
//  (3) số hóa đơn trong một ký hiệu duy nhất; nhà cung cấp giả lập cấp liên tục từ 1; mọi số phía phần mềm có ở nhà cung cấp và ngược lại (sau đối soát).
//  (4) webhook gửi lại k lần (kể cả đồng thời) chỉ tạo một bank_transaction cho mỗi external_id; giao dịch matched trỏ chứng từ posted, đúng tài khoản ngân hàng, đúng số tiền.
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

const MODES = ['ok', 'reject', 'timeout_before', 'timeout_after_create'] as const;
type Op =
  | { k: 'sale' } | { k: 'issue'; p: number } | { k: 'retry'; p: number } | { k: 'mode'; m: number } | { k: 'adjust'; p: number } | { k: 'replace'; p: number }
  | { k: 'cancel'; p: number } | { k: 'reconcile' } | { k: 'hook'; t: number; times: number; conc: boolean } | { k: 'create'; t: number } | { k: 'match'; t: number; p: number }
  | { k: 'unmatch'; t: number } | { k: 'unpost'; p: number } | { k: 'reverse'; p: number };
const nat = fc.nat(1000);
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ k: 'sale' } as Op) },
  { weight: 6, arbitrary: fc.record({ k: fc.constant('issue' as const), p: nat }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('retry' as const), p: nat }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('mode' as const), m: fc.integer({ min: 0, max: 3 }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('adjust' as const), p: nat }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('replace' as const), p: nat }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('cancel' as const), p: nat }) },
  { weight: 3, arbitrary: fc.constant({ k: 'reconcile' } as Op) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant('hook' as const), t: fc.integer({ min: 0, max: 3 }), times: fc.integer({ min: 1, max: 5 }), conc: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('create' as const), t: fc.integer({ min: 0, max: 3 }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('match' as const), t: fc.integer({ min: 0, max: 3 }), p: nat }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('unmatch' as const), t: fc.integer({ min: 0, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('unpost' as const), p: nat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('reverse' as const), p: nat }) });

// Bốn giao dịch cố định: hai vào, hai ra; số tiền khác nhau để match sai số tiền bị từ chối.
const TXNS = [{ id: 8001, type: 'in', amount: 5_000_000 }, { id: 8002, type: 'out', amount: 3_000_000 }, { id: 8003, type: 'in', amount: 2_000_000 }, { id: 8004, type: 'out', amount: 1_000_000 }] as const;

async function tenant() {
  const b = await setupBankTenant(ctx, `I9${Date.now()}${n++}`);
  const { cookie, tenantId } = b; const admin = ctx.t.admin;
  const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => ctx.app.inject({ method, url, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name, options) VALUES (${tenantId}::uuid, 'fake', 'Giả lập', '{}'::jsonb) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${providerId}, '1', 'K26TAA', 2026) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const mode = (m: string) => sql`UPDATE einvoice_provider SET options = ${JSON.stringify({ mode: m })}::jsonb WHERE id = ${providerId}`.execute(admin);
  const feed = (await call('POST', '/api/bank-feeds', { bankAccountId: b.accountId, provider: 'sepay', authKind: 'apikey' })).json() as { webhookUrl: string; apiKey: string };
  return { ...b, admin, call, seriesId, mode, hookPath: new URL(feed.webhookUrl).pathname, apiKey: feed.apiKey, providerId, cookie };
}

// Mọi phản hồi trừ 500 là kết quả nghiệp vụ chấp nhận được (409, 400, 502 khi nhà cung cấp lỗi...); 500 là lỗi không lường trước.
// Đếm số lần thành công theo loại thao tác (qua mọi lần chạy): chuỗi ngẫu nhiên phải thật sự phát hành, điều chỉnh, thay thế, hủy, đối chiếu.
const done = new Map<string, number>();
const ok = (r: { statusCode: number; body: string }, what: string) => {
  expect(r.statusCode, `${what}: ${r.body}`).not.toBe(500);
  if (r.statusCode < 300) done.set(what, (done.get(what) ?? 0) + 1);
  return r;
};
const ITEMS = [{ description: 'Dịch vụ', accountCode: '5113', amountCurrency: '1000000', taxCodes: ['V10'] }];

async function run(ops: Op[]) {
  const t = await tenant();
  const delivered = new Set<number>();
  const sale = async (type = 'HDB', adjusts?: number) => {
    const r = await t.call('POST', '/api/invoices', { voucherType: type, postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001', autoPost: true, items: ITEMS,
      invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '10', einvoiceSeriesId: t.seriesId, ...(adjusts && { adjustsInvoiceId: adjusts }) }, idempotencyKey: `i9-${n++}` });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; invoices: { id: number }[] };
  };
  const q = <R>(s: ReturnType<typeof sql<R>>) => s.execute(t.admin).then((r) => r.rows);
  const sales = async () => (await q<{ id: string }>(sql`SELECT id::text FROM voucher WHERE tenant_id = ${t.tenantId}::uuid AND voucher_type = 'HDB' ORDER BY created_at, id`)).map((x) => x.id);
  const einvs = () => q<{ id: number; status: string; voucher_id: string; relation: string; invoice_id: number | null }>(sql`SELECT e.id::int, e.status, e.voucher_id::text, e.relation,
    (SELECT i.id FROM voucher_invoice i WHERE i.voucher_id = e.voucher_id ORDER BY i.id LIMIT 1)::int AS invoice_id FROM einvoice e WHERE e.tenant_id = ${t.tenantId}::uuid ORDER BY e.id`);
  const bankVouchers = async () => (await q<{ id: string }>(sql`SELECT id::text FROM voucher WHERE tenant_id = ${t.tenantId}::uuid AND voucher_type IN ('BC', 'BN') ORDER BY created_at, id`)).map((x) => x.id);
  const age = () => sql`UPDATE einvoice SET last_attempt_at = now() - make_interval(secs => ${RETRY_GUARD_SEC + 10}) WHERE tenant_id = ${t.tenantId}::uuid AND status = 'sending'`.execute(t.admin);
  const reconcile = async () => { await age(); await reconcilePending(ctx.app.db, providerFor, { olderThanSec: RETRY_GUARD_SEC + 5, limit: 100 }); };
  const txnRow = async (i: number) => (await q<{ id: number }>(sql`SELECT id::int FROM bank_transaction WHERE tenant_id = ${t.tenantId}::uuid AND external_id = ${String(TXNS[i]!.id)}`))[0];
  const pick = <X>(a: X[], p: number): X | undefined => (a.length ? a[p % a.length] : undefined);

  for (const op of ops) {
    const es = await einvs();
    switch (op.k) {
      case 'sale': await sale(); break;
      case 'issue': {
        let all = await sales(); if (!all.length) { await sale(); all = await sales(); }
        const free = (await q<{ id: string }>(sql`SELECT v.id::text FROM voucher v JOIN voucher_invoice i ON i.voucher_id = v.id WHERE v.tenant_id = ${t.tenantId}::uuid AND v.voucher_type = 'HDB' AND v.state = 'posted'
          AND i.einvoice_pending AND i.einvoice_series_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM einvoice e WHERE e.voucher_id = v.id AND e.status <> 'failed') ORDER BY v.created_at, v.id`)).map((x) => x.id);
        const ri = await t.call('POST', '/api/einvoices', { voucherId: pick(free.length && op.p % 4 !== 0 ? free : all, op.p)!, issueDate: '2026-03-10' }); ok(ri, 'issue'); break;
      }
      case 'retry': {
        const sending = es.filter((x) => x.status === 'sending'); const e = pick(sending.length && op.p % 4 !== 0 ? sending : es, op.p); await age(); if (e) { const r = await t.call('POST', `/api/einvoices/${e.id}/retry`); ok(r, 'retry'); } break; }
      case 'mode': await t.mode(MODES[op.m]!); break;
      case 'adjust': {
        const e = pick(es.filter((x) => x.status === 'issued' && x.relation === 'original'), op.p); if (!e) break;
        const g = await sale('GGB', e.invoice_id!);
        ok(await t.call('POST', `/api/einvoices/${e.id}/adjust`, { voucherId: g.id, adjust: 'decrease', reason: 'Giảm giá', issueDate: '2026-03-10' }), 'adjust'); break;
      }
      case 'replace': {
        const e = pick(es.filter((x) => x.status === 'issued'), op.p); if (!e) break;
        const v = await sale();
        ok(await t.call('POST', `/api/einvoices/${e.id}/replace`, { voucherId: v.id, reason: 'Sai thông tin', issueDate: '2026-03-10' }), 'replace'); break;
      }
      case 'cancel': { const e = pick(es.filter((x) => x.status === 'issued'), op.p); if (e) ok(await t.call('POST', `/api/einvoices/${e.id}/cancel`, { reason: 'Lập nhầm', date: '2026-03-10' }), 'cancel'); break; }
      case 'reconcile': await reconcile(); break;
      case 'hook': {
        const d = TXNS[op.t]!;
        const body = sepayBody({ id: d.id, transferType: d.type, transferAmount: d.amount, transactionDate: '2026-03-10 09:00:00', code: null, content: `giao dich ${d.id}` });
        const send = () => ctx.app.inject({ method: 'POST', url: t.hookPath, headers: { 'content-type': 'application/json', authorization: `Apikey ${t.apiKey}` }, payload: body });
        const rs = op.conc ? await Promise.all(Array.from({ length: op.times }, send)) : await (async () => { const out = []; for (let i = 0; i < op.times; i++) out.push(await send()); return out; })();
        for (const r of rs) { expect(r.statusCode, r.body).toBe(200); expect(r.json()).toEqual({ success: true }); }
        delivered.add(d.id); break;
      }
      case 'create': {
        const x = await txnRow(op.t); if (!x) break;
        const d = TXNS[op.t]!;
        ok(await t.call('POST', `/api/bank-transactions/${x.id}/create-voucher`, { post: true, postingDate: '2026-03-10', counterAccountCode: d.type === 'in' ? '5113' : '6422' }), 'create-voucher'); break;
      }
      case 'match': { const x = await txnRow(op.t); const v = pick(await bankVouchers(), op.p); if (x && v) ok(await t.call('POST', `/api/bank-transactions/${x.id}/match`, { voucherId: v }), 'match'); break; }
      case 'unmatch': { const x = await txnRow(op.t); if (x) ok(await t.call('POST', `/api/bank-transactions/${x.id}/unmatch`), 'unmatch'); break; }
      case 'unpost': { const v = pick([...await sales(), ...await bankVouchers()], op.p); if (v) ok(await t.call('POST', `/api/vouchers/${v}/unpost`), 'unpost'); break; }
      case 'reverse': { const v = pick([...await sales(), ...await bankVouchers()], op.p); if (v) ok(await t.call('POST', `/api/vouchers/${v}/reverse`, { postingDate: '2026-03-20' }), 'reverse'); break; }
    }
  }

  // Dọn: nhà cung cấp trả lời bình thường, đối soát hết hóa đơn đang gửi (hai lượt vì hóa đơn thay thế/điều chỉnh có thể sinh việc tiếp).
  await t.mode('ok');
  await reconcile(); await reconcile();

  const bad: unknown[] = [];
  const push = (a: string, rows: unknown[]) => { if (rows.length) bad.push({ a, rows }); };
  // (1)
  push('1: chứng từ có hơn một hóa đơn sending|issued', await q(sql`SELECT voucher_id, count(*)::int AS n FROM einvoice WHERE tenant_id = ${t.tenantId}::uuid AND status IN ('sending', 'issued') GROUP BY 1 HAVING count(*) > 1`));
  push('1: hóa đơn issued thiếu hoặc sai voucher_invoice', await q(sql`SELECT e.id, e.invoice_no, e.issue_date::text FROM einvoice e JOIN einvoice_series s ON s.id = e.series_id WHERE e.tenant_id = ${t.tenantId}::uuid AND e.status = 'issued'
    AND NOT EXISTS (SELECT 1 FROM voucher_invoice i WHERE i.voucher_id = e.voucher_id AND i.invoice_no = e.invoice_no AND i.serial = s.serial AND i.form_no = s.form_no AND i.invoice_date = e.issue_date AND NOT i.einvoice_pending)`));
  push('1: còn hóa đơn sending sau đối soát', await q(sql`SELECT id, status FROM einvoice WHERE tenant_id = ${t.tenantId}::uuid AND status = 'sending'`));
  // (2)
  push('2: hóa đơn issued nhưng chứng từ không posted', await q(sql`SELECT e.id, v.state FROM einvoice e JOIN voucher v ON v.id = e.voucher_id WHERE e.tenant_id = ${t.tenantId}::uuid AND e.status = 'issued' AND v.state <> 'posted'`));
  push('2: hóa đơn replaced|cancelled, chứng từ chưa đảo và không còn cờ needs_reversal', await q(sql`SELECT e.id, e.status, v.state FROM einvoice e JOIN voucher v ON v.id = e.voucher_id
    WHERE e.tenant_id = ${t.tenantId}::uuid AND e.status IN ('replaced', 'cancelled') AND v.state <> 'reversed' AND NOT e.needs_reversal`));
  // (3)
  push('3: trùng số hóa đơn trong ký hiệu', await q(sql`SELECT series_id, invoice_no, count(*)::int AS n FROM einvoice WHERE tenant_id = ${t.tenantId}::uuid AND invoice_no IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`));
  const store = (await q<{ no: string }>(sql`SELECT invoice_no AS no FROM einvoice_fake_store WHERE tenant_id = ${t.tenantId}::uuid AND serial = 'K26TAA' ORDER BY invoice_no`)).map((x) => x.no);
  expect(store, '3: nhà cung cấp cấp số liên tục từ 1').toEqual(store.map((_, i) => String(i + 1).padStart(7, '0')));
  const local = (await q<{ no: string }>(sql`SELECT invoice_no AS no FROM einvoice WHERE tenant_id = ${t.tenantId}::uuid AND invoice_no IS NOT NULL ORDER BY invoice_no`)).map((x) => x.no);
  expect(local, '3: số phía phần mềm = số phía nhà cung cấp').toEqual(store);
  // (4)
  const txns = await q<{ external_id: string; n: number }>(sql`SELECT external_id, count(*)::int AS n FROM bank_transaction WHERE tenant_id = ${t.tenantId}::uuid GROUP BY 1`);
  expect(txns.map((x) => Number(x.external_id)).sort(), '4: mỗi external_id một giao dịch').toEqual([...delivered].sort());
  expect(txns.every((x) => x.n === 1)).toBe(true);
  push('4: giao dịch matched sai chứng từ, tài khoản hoặc số tiền', await q(sql`SELECT b.id, b.status, v.state FROM bank_transaction b LEFT JOIN voucher v ON v.id = b.voucher_id WHERE b.tenant_id = ${t.tenantId}::uuid AND b.status = 'matched'
    AND NOT (v.state = 'posted' AND (SELECT coalesce(sum(CASE WHEN b.amount_in > 0 THEN l.debit ELSE l.credit END), 0) FROM voucher_line l WHERE l.voucher_id = v.id AND l.bank_account_id = b.bank_account_id) = (CASE WHEN b.amount_in > 0 THEN b.amount_in ELSE b.amount_out END)
      AND EXISTS (SELECT 1 FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN bank_account ba ON ba.id = b.bank_account_id WHERE l.voucher_id = v.id AND l.bank_account_id = b.bank_account_id AND a.code = ba.gl_account_code))`));
  expect(bad, JSON.stringify(ops)).toEqual([]);
}

// Kịch bản cố định (chạy thành ca riêng, không đưa vào examples để khỏi chạy hai lần): mỗi loại thao tác thành công ít nhất một lần.
const SCENARIO: Op[] = [{ k: 'sale' }, { k: 'issue', p: 0 }, { k: 'sale' }, { k: 'issue', p: 1 }, { k: 'sale' }, { k: 'issue', p: 2 }, { k: 'cancel', p: 2 }, { k: 'adjust', p: 0 }, { k: 'replace', p: 1 },
  { k: 'mode', m: 2 }, { k: 'sale' }, { k: 'issue', p: 6 }, { k: 'mode', m: 0 }, { k: 'retry', p: 0 }, { k: 'retry', p: 1 }, { k: 'retry', p: 2 }, { k: 'retry', p: 3 }, { k: 'retry', p: 4 }, { k: 'retry', p: 5 },
  { k: 'mode', m: 3 }, { k: 'sale' }, { k: 'issue', p: 5 }, { k: 'mode', m: 0 }, { k: 'reconcile' },
  { k: 'hook', t: 0, times: 4, conc: true }, { k: 'hook', t: 1, times: 3, conc: false }, { k: 'hook', t: 2, times: 2, conc: true }, { k: 'create', t: 0 }, { k: 'match', t: 1, p: 0 }, { k: 'unmatch', t: 0 }, { k: 'match', t: 0, p: 0 },
  { k: 'unpost', p: 7 }, { k: 'reverse', p: 0 }];

describe('Bất biến 9: hóa đơn điện tử và giao dịch ngân hàng', () => {
  it('kịch bản cố định bao phủ mọi loại thao tác: phát hành, thử lại, điều chỉnh, thay thế, hủy, tạo chứng từ, đối chiếu, gỡ đối chiếu', async () => {
    done.clear();
    await run(SCENARIO);
    for (const k of ['issue', 'adjust', 'replace', 'cancel', 'retry', 'create-voucher', 'match', 'unmatch']) expect(done.get(k) ?? 0, k).toBeGreaterThan(0);
  }, timeoutFor(300_000));

  it('chuỗi ngẫu nhiên phát hành, thử lại, hết thời gian chờ, điều chỉnh, thay thế, hủy, đối soát, webhook gửi lặp, đối chiếu: 4 tính chất giữ nguyên', async () => {
    await fc.assert(fc.asyncProperty(fc.array(arbOp, { minLength: 6, maxLength: 20 }), async (ops) => { await run(ops); }), { numRuns: runs(12) });
  }, timeoutFor(900_000));
});
