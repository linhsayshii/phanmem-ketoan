import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { cassoBody, cassoSign, createTestApp, sepayBody, sepaySign, setupBankTenant, type BankTenant } from './helpers.js';
import type { TestApp } from '../helpers.js';

let ctx: TestApp; let a: BankTenant; let b: BankTenant;
beforeAll(async () => {
  ctx = await createTestApp();
  a = await setupBankTenant(ctx, `BWA${Date.now()}`); b = await setupBankTenant(ctx, `BWB${Date.now()}`);
});
afterAll(async () => { await ctx.close(); });

const createFeed = async (t: BankTenant, body: object) => {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/bank-feeds', headers: { cookie: t.cookie }, payload: { bankAccountId: t.accountId, ...body } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: number; webhookUrl: string; secret?: string; apiKey?: string };
};
const path = (f: { webhookUrl: string }) => new URL(f.webhookUrl).pathname;
const hook = (f: { webhookUrl: string }, headers: Record<string, string>, payload: string) => ctx.app.inject({ method: 'POST', url: path(f), headers, payload });
const txns = async (t: BankTenant) => (await sql<{ source: string; external_id: string; amount_in: string; amount_out: string; value_date: string; txn_time: string; balance_after: string | null; payment_code: string | null; status: string }>`
  SELECT source, external_id, amount_in::text, amount_out::text, value_date::text, txn_time::text, balance_after::text, payment_code, status FROM bank_transaction WHERE tenant_id = ${t.tenantId}::uuid ORDER BY id`.execute(ctx.t.admin)).rows;
const logs = async (feedId: number) => (await sql<{ ok: boolean; http_status: number; error: string | null; body_sha256: string | null }>`SELECT ok, http_status, error, body_sha256 FROM bank_webhook_log WHERE feed_id = ${feedId} ORDER BY id`.execute(ctx.t.admin)).rows;

describe('webhook ngân hàng', () => {
  it('SePay HMAC đúng: 1 giao dịch new amount_in "5000000"; gửi lại 7 lần (3 đồng thời) → vẫn 1; phản hồi {"success":true}', async () => {
    const f = await createFeed(a, { provider: 'sepay', authKind: 'hmac', secret: 'khoa-bi-mat-sepay' });
    expect(f.webhookUrl).toContain('/api/hooks/bank/');
    const body = sepayBody();
    const first = await hook(f, sepaySign('khoa-bi-mat-sepay', body), body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ success: true });
    const burst = await Promise.all([1, 2, 3].map(() => hook(f, sepaySign('khoa-bi-mat-sepay', body), body)));
    for (const r of burst) expect(r.json()).toEqual({ success: true });
    for (let i = 0; i < 3; i++) expect((await hook(f, sepaySign('khoa-bi-mat-sepay', body), body)).statusCode).toBe(200);
    const rows = await txns(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'sepay', external_id: '92704', amount_in: '5000000.0000', amount_out: '0.0000', status: 'new', value_date: '2024-07-02', balance_after: '105000000.0000', payment_code: 'SEVN63DC8E5C' });
    expect(new Date(rows[0]!.txn_time).toISOString()).toBe('2024-07-02T04:08:33.000Z'); // 11:08:33 +07:00
    expect((await logs(f.id)).filter((l) => l.ok)).toHaveLength(7);
  });

  it('chữ ký sai / token sai / feed tắt / thời gian lệch / chữ ký sai định dạng → 401 cùng một thân, không ghi bank_transaction; log ok=false không giữ thân thô', async () => {
    const f = await createFeed(b, { provider: 'sepay', authKind: 'hmac', secret: 'khoa-b-bi-mat' });
    const body = sepayBody({ id: 1 });
    const bad = [
      await hook(f, sepaySign('khoa-sai', body), body),
      await hook(f, sepaySign('khoa-b-bi-mat', body, Math.floor(Date.now() / 1000) - 400), body),
      await hook(f, { ...sepaySign('khoa-b-bi-mat', body), 'x-sepay-signature': 'sha256=abc' }, body),
      await hook(f, { 'content-type': 'application/json' }, body),
      await hook({ webhookUrl: 'http://x/api/hooks/bank/khong-co-token' }, sepaySign('khoa-b-bi-mat', body), body),
    ];
    for (const r of bad) { expect(r.statusCode).toBe(401); expect(r.body).toBe(bad[0]!.body); }
    await ctx.app.inject({ method: 'PUT', url: `/api/bank-feeds/${f.id}`, headers: { cookie: b.cookie }, payload: { isActive: false } });
    const off = await hook(f, sepaySign('khoa-b-bi-mat', body), body);
    expect(off.statusCode).toBe(401); expect(off.body).toBe(bad[0]!.body);
    expect(await txns(b)).toHaveLength(0);
    const l = await logs(f.id);
    expect(l.filter((x) => !x.ok && x.http_status === 401).length).toBe(4); // 4 lượt xác thực sai ghi log; token lạ và feed tắt không có feed hoạt động để gắn log
    expect(l[0]!.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(l)).not.toContain('NGUYEN');
  });

  it('Casso apikey header đúng: giao dịch out ghi amount_out; sai khóa → 401', async () => {
    const f = await createFeed(a, { provider: 'casso', authKind: 'apikey' });
    expect(f.apiKey).toBeTruthy();
    const body = cassoBody({ id: 777, amount: -250000 });
    const bad = await hook(f, { 'content-type': 'application/json', 'secure-token': 'sai' }, body);
    expect(bad.statusCode).toBe(401);
    const ok = await hook(f, { 'content-type': 'application/json', 'secure-token': f.apiKey! }, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ success: true });
    const r = (await txns(a)).find((x) => x.source === 'casso')!;
    expect(r).toMatchObject({ external_id: '777', amount_in: '0.0000', amount_out: '250000.0000', balance_after: '25000000.0000' });
  });

  it('Casso V2 HMAC-SHA512 trên JSON khóa sắp xếp; lệch thời gian > 300 s → 401; SePay apikey Authorization', async () => {
    const f = await createFeed(a, { provider: 'casso', authKind: 'hmac', secret: 'khoa-casso' });
    const body = cassoBody({ id: 888 });
    expect((await hook(f, cassoSign('khoa-casso', body), body)).statusCode).toBe(200);
    expect((await hook(f, cassoSign('khoa-casso', body, Date.now() - 600_000), body)).statusCode).toBe(401);
    expect((await hook(f, cassoSign('sai', body), body)).statusCode).toBe(401);
    expect((await txns(a)).filter((x) => x.external_id === '888')).toHaveLength(1);
    const s = await createFeed(a, { provider: 'sepay', authKind: 'apikey' });
    const sb = sepayBody({ id: 4242, transferType: 'out', transferAmount: 1200 });
    expect((await hook(s, { 'content-type': 'application/json', authorization: `Apikey ${s.apiKey}` }, sb)).statusCode).toBe(200);
    expect((await txns(a)).find((x) => x.external_id === '4242')).toMatchObject({ amount_out: '1200.0000', amount_in: '0.0000' });
  });

  it('token của công ty A không ghi được vào công ty B (RLS): giao dịch thuộc tenant của feed', async () => {
    const f = await createFeed(a, { provider: 'sepay', authKind: 'apikey' });
    const before = (await txns(b)).length;
    const body = sepayBody({ id: 31337 });
    expect((await hook(f, { 'content-type': 'application/json', authorization: `Apikey ${f.apiKey}` }, body)).statusCode).toBe(200);
    expect((await txns(b)).length).toBe(before);
    expect((await txns(a)).some((x) => x.external_id === '31337')).toBe(true);
    const listB = await ctx.app.inject({ method: 'GET', url: '/api/bank-transactions', headers: { cookie: b.cookie } });
    expect(listB.body).not.toContain('31337');
  });

  it('số TK khác TK của feed → bỏ qua, log ACCOUNT_MISMATCH, trả 200', async () => {
    const f = await createFeed(a, { provider: 'sepay', authKind: 'apikey' });
    const body = sepayBody({ id: 999001, accountNumber: '9999999999' });
    const r = await hook(f, { 'content-type': 'application/json', authorization: `Apikey ${f.apiKey}` }, body);
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ success: true });
    expect((await txns(a)).some((x) => x.external_id === '999001')).toBe(false);
    expect((await logs(f.id)).some((l) => l.error === 'ACCOUNT_MISMATCH')).toBe(true);
  });

  it('số tiền không hợp lệ (âm, thập phân, vượt 2^53, 0) → 400, không ghi', async () => {
    const f = await createFeed(a, { provider: 'sepay', authKind: 'apikey' });
    const h = { 'content-type': 'application/json', authorization: `Apikey ${f.apiKey}` };
    for (const amt of ['-5', '10.5', '9007199254740993', '0']) {
      const r = await hook(f, h, sepayBody({ id: 700 + amt.length }).replace('5000000', amt));
      expect(r.statusCode, amt).toBe(400);
    }
  });

  it('GET /api/bank-feeds không trả token, secret, băm; rotate làm URL cũ thành 401; audit không lộ khóa', async () => {
    const f = await createFeed(a, { provider: 'sepay', authKind: 'hmac' });
    expect(f.secret).toBeTruthy(); // không gửi secret → sinh và trả một lần
    const list = await ctx.app.inject({ method: 'GET', url: '/api/bank-feeds', headers: { cookie: a.cookie } });
    expect(list.statusCode).toBe(200);
    const text = list.body;
    expect(text).not.toContain(f.secret!);
    expect(text).not.toContain(path(f).split('/').pop()!);
    for (const k of ['token', 'secret', 'token_hash', 'tokenHash', 'apikey_hash', 'apiKey']) expect(text).not.toContain(`"${k}"`);
    expect(list.json().find((x: { id: number }) => x.id === f.id)).toMatchObject({ provider: 'sepay', authKind: 'hmac', hasSecret: true, isActive: true });
    const rot = await ctx.app.inject({ method: 'POST', url: `/api/bank-feeds/${f.id}/rotate`, headers: { cookie: a.cookie } });
    expect(rot.statusCode).toBe(200);
    const body = sepayBody({ id: 5150 });
    expect((await hook(f, sepaySign(f.secret!, body), body)).statusCode).toBe(401);
    expect((await hook(rot.json(), sepaySign(f.secret!, body), body)).statusCode).toBe(200);
    const audit = (await sql<{ b: string }>`SELECT (coalesce(before::text, '') || coalesce(after::text, '')) AS b FROM audit_event WHERE tenant_id = ${a.tenantId}::uuid AND entity = 'bank_feed'`.execute(ctx.t.admin)).rows.map((r) => r.b).join();
    expect(audit).toContain('"***"');
    expect(audit).not.toMatch(/\\x[0-9a-f]{20}/);
  });

  it('hộp thư: lọc, bỏ qua / hoàn bỏ qua, nhập tay', async () => {
    const f = await createFeed(a, { provider: 'sepay', authKind: 'apikey' });
    await hook(f, { 'content-type': 'application/json', authorization: `Apikey ${f.apiKey}` }, sepayBody({ id: 60001, content: 'tien hang thang 7' }));
    const list = await ctx.app.inject({ method: 'GET', url: `/api/bank-transactions?bankAccountId=${a.accountId}&status=new&q=thang%207`, headers: { cookie: a.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    const row = list.json().find((x: { externalId: string }) => x.externalId === '60001');
    expect(row).toMatchObject({ amountIn: '5000000.0000', status: 'new', source: 'sepay' });
    const ig = await ctx.app.inject({ method: 'POST', url: `/api/bank-transactions/${row.id}/ignore`, headers: { cookie: a.cookie } });
    expect(ig.json().status).toBe('ignored');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/bank-transactions/${row.id}/ignore`, headers: { cookie: a.cookie } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/bank-transactions/${row.id}/unignore`, headers: { cookie: a.cookie } })).json().status).toBe('new');
    const man = await ctx.app.inject({ method: 'POST', url: '/api/bank-transactions', headers: { cookie: a.cookie }, payload: { bankAccountId: a.accountId, valueDate: '2026-01-05', amountOut: '1500000', description: 'Phí', reference: 'P1' } });
    expect(man.statusCode, man.body).toBe(201);
    expect(man.json()).toMatchObject({ source: 'manual', amountOut: '1500000.0000', amountIn: '0.0000' });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/bank-transactions', headers: { cookie: a.cookie }, payload: { bankAccountId: a.accountId, valueDate: '2026-01-05', amountIn: '1', amountOut: '2' } });
    expect(bad.statusCode).toBe(400);
  });
});
