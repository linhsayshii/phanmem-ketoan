import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { postVoucher, setupLedgerTenant } from '../invariants/helpers.js';
import { cancelEInvoice, issueReplacement } from '../../src/modules/einvoice/lifecycle.js';
import { reconcilePending } from '../../src/modules/einvoice/reconcile.js';
import { providerFor, RETRY_GUARD_SEC, type EInvoiceProvider, type ProviderRow } from '../../src/modules/einvoice/providers/index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any; cookies: { name: string; value: string }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const ITEMS = (amount: string, name = 'Dịch vụ') => [{ description: name, accountCode: '5113', amountCurrency: amount, taxCodes: ['V10'] }];

// Công ty riêng, nhà cung cấp giả lập, ký hiệu C26TAA. withCode: cơ quan thuế cấp mã ngay khi phát hành (cqt_status accepted).
async function tenant(withCode = true) {
  const { cookie, tenantId, userId } = await setupLedgerTenant(ctx, `EL${Date.now()}${n++}`);
  const admin = ctx.t.admin;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name, options) VALUES (${tenantId}::uuid, 'fake', 'Giả lập', ${JSON.stringify({ withCode })}::jsonb) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${providerId}, '1', 'C26TAA', 2026) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const sale = async (o: { type?: string; date?: string; party?: string; items?: object[]; adjusts?: number; draft?: boolean; counter?: string } = {}) => {
    const date = o.date ?? '2026-03-10';
    const r = await call('POST', '/api/invoices', { voucherType: o.type ?? 'HDB', postingDate: date, documentDate: date, partyCode: o.party ?? 'KH001', autoPost: !o.draft, items: o.items ?? ITEMS('10000000'), ...(o.counter && { counterAccountCode: o.counter }),
      invoice: { invoiceDate: date, invoiceGroupCode: '10', einvoiceSeriesId: seriesId, ...(o.adjusts && { adjustsInvoiceId: o.adjusts }) }, idempotencyKey: `k${n++}` });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; invoices: { id: number }[] };
  };
  const issue = async (voucherId: string) => { const r = await call('POST', '/api/einvoices', { voucherId, issueDate: '2026-03-10' }); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = async (id: number) => (await sql<{ status: string; adjusted: boolean; needs_reversal: boolean; paid: boolean; payload: any }>`
    SELECT status, adjusted, needs_reversal, paid, payload FROM einvoice WHERE id = ${id}`.execute(admin)).rows[0]!;
  const voucher = async (id: string) => (await sql<{ state: string; reversed_by: string | null; rev_date: string | null; rev_desc: string | null }>`
    SELECT v.state, v.reversed_by_id::text AS reversed_by, r.posting_date::text AS rev_date, r.description AS rev_desc FROM voucher v LEFT JOIN voucher r ON r.id = v.reversed_by_id WHERE v.id = ${id}::uuid`.execute(admin)).rows[0]!;
  const period = (no: number, status: string) => sql`UPDATE fiscal_period SET status = ${status} WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = ${no}`.execute(admin);
  const mode = (options: object) => sql`UPDATE einvoice_provider SET options = ${JSON.stringify({ withCode, ...options })}::jsonb WHERE id = ${providerId}`.execute(admin);
  const age = (id: number) => sql`UPDATE einvoice SET last_attempt_at = now() - make_interval(secs => ${RETRY_GUARD_SEC + 10}) WHERE id = ${id}`.execute(admin);
  // Kế toán viên có einvoice.issue nhưng không có quyền ghi sổ (voucher.post).
  const noPostUser = async () => {
    const username = `nopost_${Date.now()}_${n++}`;
    expect((await call('POST', '/api/users', { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    await sql`DELETE FROM role_permission WHERE tenant_id = ${tenantId}::uuid AND permission_code = 'voucher.post' AND role_id = (SELECT id FROM role WHERE tenant_id = ${tenantId}::uuid AND code = 'ketoan_vien')`.execute(admin);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } }) as unknown as Res;
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    return (url: string, payload?: object): Promise<Res> => ctx.app.inject({ method: 'POST', url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  };
  // Thay thế mà nhà cung cấp hết thời gian chờ sau khi đã cấp số: hóa đơn thay thế ở `sending`, gốc chưa đổi.
  const pendingReplacement = async () => {
    const v = await sale();
    const o = await issue(v.id);
    const r2 = await sale({ date: '2026-03-20' });
    await mode({ mode: 'timeout_after_create' });
    const rep = await call('POST', `/api/einvoices/${o.id}/replace`, { voucherId: r2.id, reason: 'Sai đơn giá', issueDate: '2026-03-20' });
    expect(rep.statusCode, rep.body).toBe(201);
    expect(rep.json().status).toBe('sending');
    await mode({});
    await age(rep.json().id);
    return { v, o, rid: rep.json().id as number };
  };
  return { cookie, tenantId, userId, admin, call, sale, issue, row, voucher, period, mode, age, noPostUser, pendingReplacement, ectx: { tenantId, userId } };
}

describe('hóa đơn điều chỉnh, thay thế, hủy', () => {
  it('điều chỉnh giảm: GGB 1.000.000 + thuế trỏ hóa đơn gốc → einvoice adjustment decrease issued; gốc adjusted; payload.relation.original.invoiceNo = số gốc', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    expect(o).toMatchObject({ status: 'issued', invoiceNo: '0000001', cqtStatus: 'accepted' });
    const g = await t.sale({ type: 'GGB', items: ITEMS('1000000', 'Giảm giá'), adjusts: v.invoices[0]!.id });
    // giảm giá là hóa đơn điều chỉnh: không phát hành như hóa đơn gốc
    expect(err(await t.call('POST', '/api/einvoices', { voucherId: g.id }))).toEqual([409, 'EINVOICE_ADJUSTMENT_REQUIRED']);
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/adjust`, { voucherId: g.id, adjust: 'info', reason: 'Sai địa chỉ' }))).toEqual([400, 'EINVOICE_ADJUST_INFO_UNSUPPORTED']);
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/adjust`, { voucherId: g.id, adjust: 'increase', reason: 'x' }))).toEqual([400, 'EINVOICE_ADJUST_KIND']);
    const r = await t.call('POST', `/api/einvoices/${o.id}/adjust`, { voucherId: g.id, adjust: 'decrease', reason: 'Giảm giá theo biên bản', agreementNo: 'BB01', agreementDate: '2026-03-15', issueDate: '2026-03-16' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ relation: 'adjustment', originalId: o.id, status: 'issued', invoiceNo: '0000002', total: '1100000', voucherId: g.id });
    const a = await t.row(r.json().id);
    expect(a.payload.relation).toMatchObject({ kind: 'adjustment', adjust: 'decrease', original: { invoiceNo: '0000001', serial: 'C26TAA', issueDate: '2026-03-10' }, reason: 'Giảm giá theo biên bản', agreementNo: 'BB01', agreementDate: '2026-03-15' });
    expect(await t.row(o.id)).toMatchObject({ status: 'issued', adjusted: true });
    expect((await t.call('GET', `/api/einvoices/${o.id}`)).json()).toMatchObject({ adjusted: true, needsReversal: false });
    // thay đổi ghi audit_event
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'einvoice' AND entity_id = ${String(o.id)} AND after->>'adjusted' = 'true'`.execute(t.admin)).rows[0]!.n).toBe(1);
    // đã điều chỉnh thì lần sau cũng điều chỉnh, không thay thế (TT 91/2026 Điều 10 khoản 6 điểm a)
    const h = await t.sale({ date: '2026-03-20' });
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/replace`, { voucherId: h.id, reason: 'x' }))).toEqual([409, 'EINVOICE_ALREADY_ADJUSTED']);
  });

  it('điều chỉnh tăng bằng HDB adjustsInvoiceId cùng khách → increase; khác khách → 409', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    const h = await t.sale({ items: ITEMS('2000000', 'Bổ sung'), adjusts: v.invoices[0]!.id });
    expect(err(await t.call('POST', '/api/einvoices', { voucherId: h.id }))).toEqual([409, 'EINVOICE_ADJUSTMENT_REQUIRED']);
    const r = await t.call('POST', `/api/einvoices/${o.id}/adjust`, { voucherId: h.id, adjust: 'increase', reason: 'Bổ sung khối lượng' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ relation: 'adjustment', status: 'issued', total: '2200000' });
    expect((await t.row(r.json().id)).payload.relation).toMatchObject({ kind: 'adjustment', adjust: 'increase', original: { invoiceNo: '0000001' } });
    // HDB trỏ hóa đơn của khách khác: không lập được chứng từ
    const bad = await t.call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH002', autoPost: true, items: ITEMS('100000'),
      invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '10', adjustsInvoiceId: v.invoices[0]!.id, invoiceNo: '1', formNo: '1', serial: 'C26TAA' } });
    expect(err(bad)).toEqual([404, 'INVOICE_NOT_FOUND']);
    // chứng từ của khách khác dùng làm điều chỉnh
    const other = await t.sale({ party: 'KH002', items: ITEMS('500000') });
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/adjust`, { voucherId: other.id, adjust: 'increase', reason: 'x' }))).toEqual([409, 'EINVOICE_PARTY_MISMATCH']);
    // cùng khách nhưng không trỏ hóa đơn gốc
    const loose = await t.sale({ items: ITEMS('500000') });
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/adjust`, { voucherId: loose.id, adjust: 'increase', reason: 'x' }))).toEqual([409, 'EINVOICE_ADJUST_MISMATCH']);
  });

  it('thay thế: gốc replaced, chứng từ gốc reversed bằng đảo ngày gốc (kỳ mở); tờ khai kỳ gốc không còn doanh thu gốc', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    const before = (await t.call('GET', '/api/tax/invoices?direction=sale&year=2026&period=3')).json();
    expect(before.totals.baseAmount).toBe('10000000');
    const r2 = await t.sale({ date: '2026-04-05', items: ITEMS('9000000') });
    const r = await t.call('POST', `/api/einvoices/${o.id}/replace`, { voucherId: r2.id, reason: 'Sai đơn giá', agreementNo: 'BB02', agreementDate: '2026-04-01', issueDate: '2026-04-05' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ relation: 'replacement', originalId: o.id, status: 'issued', invoiceNo: '0000002' });
    expect(r.json().warnings).toBeUndefined();
    expect((await t.row(r.json().id)).payload.relation).toMatchObject({ kind: 'replacement', original: { invoiceNo: '0000001' }, reason: 'Sai đơn giá', agreementNo: 'BB02' });
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: false });
    const vo = await t.voucher(v.id);
    expect(vo).toMatchObject({ state: 'reversed', rev_date: '2026-03-10' });
    expect(vo.rev_desc).toContain('bị thay thế bởi hóa đơn số 0000002');
    const after = (await t.call('GET', '/api/tax/invoices?direction=sale&year=2026&period=3')).json();
    expect(after.totals.baseAmount).toBe('0');
    expect(after.groups.flatMap((g: { rows: { voucherId: string }[] }) => g.rows).filter((x: { voucherId: string }) => x.voucherId === v.id)).toEqual([]);
    expect((await t.call('GET', '/api/tax/invoices?direction=sale&year=2026&period=4')).json().totals.baseAmount).toBe('9000000');
  });

  it('thay thế khi kỳ gốc khóa mềm và không có quyền ghi lùi: đảo ngày chứng từ thay thế', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    const r2 = await t.sale({ date: '2026-04-05', items: ITEMS('9000000') });
    await t.period(3, 'soft_locked');
    const dto = await issueReplacement(ctx.t.db, { ...t.ectx, canBackdate: false }, o.id, { voucherId: r2.id, reason: 'Sai mã số thuế' });
    expect(dto).toMatchObject({ status: 'issued', relation: 'replacement' });
    expect(await t.voucher(v.id)).toMatchObject({ state: 'reversed', rev_date: '2026-04-05' });
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: false });
  });

  it('thay thế hóa đơn đã replaced → 409 EINVOICE_NOT_ACTIVE; ký hiệu C chưa có mã CQT → 409 EINVOICE_CQT_PENDING', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    const r2 = await t.sale({ date: '2026-03-20' });
    expect((await t.call('POST', `/api/einvoices/${o.id}/replace`, { voucherId: r2.id, reason: 'Sai' })).statusCode).toBe(201);
    const r3 = await t.sale({ date: '2026-03-21' });
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/replace`, { voucherId: r3.id, reason: 'Sai' }))).toEqual([409, 'EINVOICE_NOT_ACTIVE']);
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/cancel`, { reason: 'Sai', date: '2026-03-21' }))).toEqual([409, 'EINVOICE_NOT_ACTIVE']);
    expect(err(await t.call('POST', '/api/einvoices/999999/replace', { voucherId: r3.id, reason: 'Sai' }))).toEqual([404, 'EINVOICE_NOT_FOUND']);

    const p = await tenant(false);
    const pv = await p.sale();
    const po = await p.issue(pv.id);
    expect(po.cqtStatus).toBe('waiting');
    const pr = await p.sale({ date: '2026-03-20' });
    expect(err(await p.call('POST', `/api/einvoices/${po.id}/replace`, { voucherId: pr.id, reason: 'Sai' }))).toEqual([409, 'EINVOICE_CQT_PENDING']);
    const pg = await p.sale({ type: 'GGB', items: ITEMS('1000000', 'Giảm giá'), adjusts: pv.invoices[0]!.id });
    expect(err(await p.call('POST', `/api/einvoices/${po.id}/adjust`, { voucherId: pg.id, adjust: 'decrease', reason: 'Sai' }))).toEqual([409, 'EINVOICE_CQT_PENDING']);
  });

  it('hủy với nhà cung cấp không hỗ trợ → 409 PROVIDER_UNSUPPORTED; fake hỗ trợ: cancelled, chứng từ đảo', async () => {
    const t = await tenant(false);
    const v = await t.sale();
    const o = await t.issue(v.id);
    const noCancel = (r: ProviderRow): EInvoiceProvider => { const p = providerFor(r); delete p.cancel; return p; };
    await expect(cancelEInvoice(ctx.t.db, t.ectx, o.id, { reason: 'Lập nhầm', date: '2026-03-12' }, noCancel)).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED', status: 409 });
    expect(await t.row(o.id)).toMatchObject({ status: 'issued' });
    const r = await t.call('POST', `/api/einvoices/${o.id}/cancel`, { reason: 'Lập nhầm', date: '2026-03-12' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'cancelled', needsReversal: false });
    expect(await t.voucher(v.id)).toMatchObject({ state: 'reversed', rev_date: '2026-03-10' });
    expect((await sql<{ cancelled: boolean }>`SELECT cancelled FROM einvoice_fake_store WHERE tenant_id = ${t.tenantId}::uuid`.execute(t.admin)).rows).toEqual([{ cancelled: true }]);
    expect((await sql<{ action: string }>`SELECT action FROM einvoice_log WHERE einvoice_id = ${o.id} ORDER BY id`.execute(t.admin)).rows.map((x) => x.action)).toEqual(['create', 'cancel']);
    // hóa đơn đã có mã của cơ quan thuế: không hủy, phải điều chỉnh hoặc thay thế
    const c = await tenant(true);
    const co = await c.issue((await c.sale()).id);
    const cr = await c.call('POST', `/api/einvoices/${co.id}/cancel`, { reason: 'Lập nhầm', date: '2026-03-12' });
    expect(err(cr)).toEqual([409, 'EINVOICE_CANCEL_NOT_ALLOWED']);
    expect(cr.json().error.message).toContain('điều chỉnh hoặc thay thế');
  });

  it('đảo hỏng ở pha 3 (giả lập lỗi): einvoice vẫn issued, needs_reversal true; reverse-original thành công xóa cờ', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    const r2 = await t.sale({ date: '2026-03-20' });
    // kỳ 3 bị khóa cứng giữa pha 1 và pha 3 (sau khi nhà cung cấp đã cấp số)
    const locking = (r: ProviderRow): EInvoiceProvider => { const p = providerFor(r); return { ...p, create: async (c, d) => { const res = await p.create(c, d); await t.period(3, 'hard_locked'); return res; } }; };
    const dto = await issueReplacement(ctx.t.db, { ...t.ectx, canBackdate: true }, o.id, { voucherId: r2.id, reason: 'Sai đơn giá', issueDate: '2026-03-20' }, locking);
    expect(dto).toMatchObject({ status: 'issued', relation: 'replacement', invoiceNo: '0000002' });
    expect(dto.warnings).toMatchObject([{ code: 'EINVOICE_REVERSAL_FAILED' }]);
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: true });
    expect((await t.voucher(v.id)).state).toBe('posted');
    // vẫn khóa: không bỏ ghi sổ qua route chung
    await t.period(3, 'open');
    expect(err(await t.call('POST', `/api/vouchers/${v.id}/unpost`))).toEqual([409, 'EINVOICE_ISSUED']);
    const ok = await t.call('POST', `/api/einvoices/${o.id}/reverse-original`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'replaced', needsReversal: false });
    expect(await t.voucher(v.id)).toMatchObject({ state: 'reversed', rev_date: '2026-03-10' });
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/reverse-original`))).toEqual([409, 'EINVOICE_NO_REVERSAL_NEEDED']);
  });

  it('trạng thái thanh toán: lưu paid, chỉ hóa đơn đã phát hành', async () => {
    const t = await tenant();
    const v = await t.sale();
    const o = await t.issue(v.id);
    const r = await t.call('POST', `/api/einvoices/${o.id}/paid`, { paid: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ paid: true });
    expect((await t.row(o.id)).paid).toBe(true);
    expect((await t.call('POST', `/api/einvoices/${o.id}/paid`, { paid: false })).json()).toMatchObject({ paid: false });
  });

  it('worker đối soát hoàn tất hóa đơn thay thế đang gửi: gốc replaced, needs_reversal true, chứng từ gốc chưa đảo, có notice', async () => {
    const t = await tenant();
    const { v, o, rid } = await t.pendingReplacement();
    expect(await t.row(o.id)).toMatchObject({ status: 'issued', needs_reversal: false });
    const res = await reconcilePending(ctx.t.db, providerFor, { olderThanSec: RETRY_GUARD_SEC, limit: 10_000 });
    expect(res.errorDetails.filter((d) => d.einvoiceId === rid)).toEqual([]);
    expect(res.notices).toContainEqual(expect.objectContaining({ tenantId: t.tenantId, einvoiceId: rid, code: 'EINVOICE_REVERSAL_PENDING' }));
    expect(await t.row(rid)).toMatchObject({ status: 'issued' });
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: true });
    expect((await t.voucher(v.id)).state).toBe('posted');
  });

  it('người thiếu voucher.post: /retry hoàn tất thay thế nhưng không đảo; replace, cancel, reverse-original → 403', async () => {
    const t = await tenant();
    const { v, o, rid } = await t.pendingReplacement();
    const vien = await t.noPostUser();
    const r = await vien(`/api/einvoices/${rid}/retry`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'issued', warnings: [{ code: 'EINVOICE_REVERSAL_PENDING' }] });
    expect(r.json().warnings[0].message).toContain('Đảo chứng từ gốc');
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: true });
    expect((await t.voucher(v.id)).state).toBe('posted');
    expect(err(await vien(`/api/einvoices/${o.id}/reverse-original`))).toEqual([403, 'FORBIDDEN']);
    expect(err(await vien(`/api/einvoices/${rid}/replace`, { voucherId: v.id, reason: 'x' }))).toEqual([403, 'FORBIDDEN']);
    expect(err(await vien(`/api/einvoices/${rid}/cancel`, { reason: 'x', date: '2026-03-21' }))).toEqual([403, 'FORBIDDEN']);
    const ok = await t.call('POST', `/api/einvoices/${o.id}/reverse-original`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await t.voucher(v.id)).toMatchObject({ state: 'reversed', rev_date: '2026-03-10' });
  });

  it('chuỗi thay thế: A bị R1 thay (chưa đảo), R1 bị R2 thay; reverse-original A vẫn tìm được hóa đơn thay thế, không lỗi 500', async () => {
    const t = await tenant();
    const v = await t.sale();
    const a = await t.issue(v.id);
    const r1v = await t.sale({ date: '2026-03-20' });
    const locking = (r: ProviderRow): EInvoiceProvider => { const p = providerFor(r); return { ...p, create: async (c, d) => { const res = await p.create(c, d); await t.period(3, 'hard_locked'); return res; } }; };
    const r1 = await issueReplacement(ctx.t.db, { ...t.ectx, canBackdate: true }, a.id, { voucherId: r1v.id, reason: 'Sai', issueDate: '2026-03-20' }, locking);
    expect(await t.row(a.id)).toMatchObject({ status: 'replaced', needs_reversal: true });
    await t.period(3, 'open');
    const r2v = await t.sale({ date: '2026-03-25' });
    const r2 = await t.call('POST', `/api/einvoices/${r1.id}/replace`, { voucherId: r2v.id, reason: 'Sai tiếp', issueDate: '2026-03-25' });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(await t.row(r1.id)).toMatchObject({ status: 'replaced', needs_reversal: false });
    const ok = await t.call('POST', `/api/einvoices/${a.id}/reverse-original`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await t.voucher(v.id)).toMatchObject({ state: 'reversed', rev_date: '2026-03-10' });
  });

  it('hủy: thay thế đã chốt trước khi kết quả hủy về (0 dòng cập nhật) → 409 EINVOICE_ORPHAN_CANCELLED, nhật ký orphan_cancelled', async () => {
    const t = await tenant(false);
    const v = await t.sale();
    const o = await t.issue(v.id);
    const racing = (r: ProviderRow): EInvoiceProvider => {
      const p = providerFor(r);
      return { ...p, cancel: async (c, ref, reason, date) => { await p.cancel!(c, ref, reason, date); await sql`UPDATE einvoice SET status = 'replaced' WHERE id = ${o.id}`.execute(t.admin); } };
    };
    await expect(cancelEInvoice(ctx.t.db, t.ectx, o.id, { reason: 'Lập nhầm', date: '2026-03-12' }, racing)).rejects.toMatchObject({ code: 'EINVOICE_ORPHAN_CANCELLED', status: 409 });
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: false });
    expect((await sql<{ action: string; ok: boolean }>`SELECT action, ok FROM einvoice_log WHERE einvoice_id = ${o.id} ORDER BY id`.execute(t.admin)).rows).toEqual([
      { action: 'create', ok: true }, { action: 'cancel', ok: true }, { action: 'orphan_cancelled', ok: false }]);
  });

  it('chế độ chặn tồn quỹ âm: đảo chứng từ bán thu tiền mặt làm quỹ âm → reverse-original 409 CASH_NEGATIVE, cờ giữ nguyên', async () => {
    const t = await tenant();
    expect((await t.call('PUT', '/api/settings', { cash_negative: 'block' })).statusCode).toBe(200);
    const v = await t.sale({ counter: '1111' });
    expect((await postVoucher(ctx, t.cookie, '2026-03-15', [{ accountCode: '6422', debit: '11000000' }, { accountCode: '1111', credit: '11000000' }])).statusCode).toBe(201);
    const o = await t.issue(v.id);
    const r2 = await t.sale({ date: '2026-03-20' });
    const rep = await t.call('POST', `/api/einvoices/${o.id}/replace`, { voucherId: r2.id, reason: 'Sai', issueDate: '2026-03-20' });
    expect(rep.statusCode, rep.body).toBe(201);
    expect(rep.json().warnings).toMatchObject([{ code: 'EINVOICE_REVERSAL_FAILED' }]);
    expect(rep.json().warnings[0].message).toContain('tồn quỹ tiền mặt');
    expect(err(await t.call('POST', `/api/einvoices/${o.id}/reverse-original`))).toEqual([409, 'CASH_NEGATIVE']);
    expect(await t.row(o.id)).toMatchObject({ status: 'replaced', needs_reversal: true });
    expect((await t.voucher(v.id)).state).toBe('posted');
  });

  it('điều chỉnh tăng trỏ hóa đơn gốc chưa ghi sổ → bị từ chối', async () => {
    const t = await tenant();
    const d = await t.sale({ draft: true });
    const r = await t.call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001', autoPost: true, items: ITEMS('100000'),
      invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '10', adjustsInvoiceId: d.invoices[0]!.id, invoiceNo: '77', formNo: '1', serial: 'C26TAA' } });
    expect(err(r)).toEqual([404, 'INVOICE_NOT_FOUND']);
  });
});
