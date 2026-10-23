import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { providerFor, withProviderCtx, type ProviderCtx, ProviderError, type EInvoiceDoc, type OriginalRef } from '../../src/modules/einvoice/providers/index.js';
import { NetworkError } from '../../src/lib/http.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

const row = (options: object = {}) => ({ code: 'fake', base_url: '', username: '', secret: null, seller_tax_code: '', options });
const doc = (uuid: string, serial = 'C26TAA'): EInvoiceDoc => ({ transactionUuid: uuid, formNo: '1', serial, providerTemplate: null, issueDate: '2026-03-10', currency: 'VND', fxRate: '1', paymentMethod: 'TM/CK',
  seller: { name: 'A', taxCode: '0100109106', address: null }, buyer: { name: 'B', taxCode: null, address: null }, lines: [], taxGroups: [],
  totals: { beforeTax: '0', tax: '0', discount: '0', total: '0', totalInWords: '' }, relation: { kind: 'original' } });

async function tenant() {
  const b = await bootstrapTenant(ctx, { code: `FP${Date.now()}${n++}` });
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name) VALUES (${b.tenantId}::uuid, 'fake', 'Giả lập') RETURNING id::int`.execute(ctx.t.admin)).rows[0]!.id;
  const run = <T>(fn: (c: ProviderCtx) => Promise<T>) => withProviderCtx(ctx.t.db, { tenantId: b.tenantId, userId: b.userId, providerId, einvoiceId: null }, fn);
  return { ...b, providerId, run };
}
const uuid = () => crypto.randomUUID();

describe('nhà cung cấp giả lập', () => {
  it('create cùng transactionUuid hai lần trả cùng số; uuid khác tăng số; ký hiệu khác đếm riêng', async () => {
    const t = await tenant(); const p = providerFor(row()); const u = uuid();
    const a = await t.run((c) => p.create(c, doc(u)));
    expect(a).toMatchObject({ invoiceNo: '0000001', cqtCode: null, cqtStatus: 'none' });
    expect((await t.run((c) => p.create(c, doc(u)))).invoiceNo).toBe('0000001');
    expect((await t.run((c) => p.create(c, doc(uuid())))).invoiceNo).toBe('0000002');
    expect((await t.run((c) => p.create(c, doc(uuid(), 'C26TBB')))).invoiceNo).toBe('0000001');
    const logs = await ctx.t.admin.selectFrom('einvoice_log').select('ok').where('tenant_id', '=', t.tenantId).execute();
    expect(logs).toHaveLength(4);
  });

  it('timeout_after_create: ném NetworkError nhưng đã lưu; findByTransaction trả số đã cấp; timeout_before không lưu', async () => {
    const t = await tenant(); const u = uuid();
    const after = providerFor(row({ mode: 'timeout_after_create' }));
    await expect(t.run((c) => after.create(c, doc(u)))).rejects.toBeInstanceOf(NetworkError);
    const found = await t.run((c) => providerFor(row()).findByTransaction(c, doc(u)));
    expect(found).toMatchObject({ invoiceNo: '0000001' });
    const u2 = uuid();
    await expect(t.run((c) => providerFor(row({ mode: 'timeout_before' })).create(c, doc(u2)))).rejects.toMatchObject({ kind: 'timeout' });
    expect(await t.run((c) => providerFor(row()).findByTransaction(c, doc(u2)))).toBeNull();
  });

  it('reject → ProviderError FAKE_REJECT retriable false', async () => {
    const t = await tenant();
    const err = await t.run((c) => providerFor(row({ mode: 'reject' })).create(c, doc(uuid()))).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'FAKE_REJECT', retriable: false });
  });

  it('withCode: cqtCode 34 ký tự hex, cqtStatus accepted; getFile xml có MCCQT, pdf là HTML; cancel đánh dấu hủy', async () => {
    const t = await tenant(); const p = providerFor(row({ withCode: true }));
    const r = await t.run((c) => p.create(c, doc(uuid())));
    expect(r.cqtCode).toMatch(/^[0-9A-F]{34}$/); expect(r.cqtStatus).toBe('accepted');
    const ref: OriginalRef = { formNo: '1', serial: 'C26TAA', invoiceNo: r.invoiceNo, issueDate: r.issueDate, providerRef: r.providerRef };
    const xml = (await t.run((c) => p.getFile(c, ref, 'xml'))).toString();
    expect(xml).toContain(`<MCCQT Id="MCCQT">${r.cqtCode}</MCCQT>`);
    expect((await t.run((c) => p.getFile(c, ref, 'pdf'))).toString()).toContain('<html>');
    expect(await t.run((c) => p.refreshStatus(c, ref))).toEqual({ cqtCode: r.cqtCode, cqtStatus: 'accepted' });
    await t.run((c) => p.cancel!(c, ref, 'sai', '2026-03-11'));
    expect((await ctx.t.admin.selectFrom('einvoice_fake_store').select('cancelled').where('tenant_id', '=', t.tenantId).executeTakeFirstOrThrow()).cancelled).toBe(true);
  });

  it('kho tách theo công ty (RLS): công ty khác không thấy hóa đơn đã cấp', async () => {
    const a = await tenant(); const b = await tenant(); const p = providerFor(row()); const u = uuid();
    await a.run((c) => p.create(c, doc(u)));
    expect(await b.run((c) => p.findByTransaction(c, doc(u)))).toBeNull();
  });

  it('POST /providers/:id/test: fake → ok; sinvoice chưa có adapter → ok false (200); không tìm thấy → 404', async () => {
    const t = await tenant();
    const call = (id: number) => ctx.app.inject({ method: 'POST', url: `/api/einvoice/providers/${id}/test`, headers: { cookie: t.cookie } });
    const ok = await call(t.providerId);
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json()).toMatchObject({ ok: true });
    const sid = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name) VALUES (${t.tenantId}::uuid, 'sinvoice', 'S') RETURNING id::int`.execute(ctx.t.admin)).rows[0]!.id;
    const bad = await call(sid);
    expect(bad.statusCode).toBe(200); expect(bad.json().ok).toBe(false);
    expect((await call(999999)).statusCode).toBe(404);
  });
});
