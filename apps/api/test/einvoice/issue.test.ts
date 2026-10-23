import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { retryEInvoice } from '../../src/modules/einvoice/issue.js';
import { reconcilePending } from '../../src/modules/einvoice/reconcile.js';
import { providerFor, type EInvoiceProvider, type ProviderRow } from '../../src/modules/einvoice/providers/index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any; headers: Record<string, unknown> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];

// Công ty riêng, nhà cung cấp giả lập (chế độ đổi được), ký hiệu C26TAA.
async function tenant() {
  const { cookie, tenantId, userId } = await setupLedgerTenant(ctx, `EI${Date.now()}${n++}`);
  const admin = ctx.t.admin;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name) VALUES (${tenantId}::uuid, 'fake', 'Giả lập') RETURNING id::int`.execute(admin)).rows[0]!.id;
  const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${providerId}, '1', 'C26TAA', 2026) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const mode = (options: object) => sql`UPDATE einvoice_provider SET options = ${JSON.stringify(options)}::jsonb WHERE id = ${providerId}`.execute(admin);
  const sale = async (more: object = {}, items: object[] = [{ description: 'Dịch vụ', accountCode: '5113', amountCurrency: '10000000', taxCodes: ['V10'] }]) => {
    const r = await call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001', autoPost: true, items,
      invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '10', einvoiceSeriesId: seriesId }, idempotencyKey: `k${n++}`, ...more });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; state: string };
  };
  const issue = (voucherId: string, issueDate = '2026-03-10') => call('POST', '/api/einvoices', { voucherId, issueDate });
  const row = async (id: number) => (await sql<{ status: string; transaction_uuid: string; attempts: number; invoice_no: string | null; xml: string | null; discarded_at: string | null; cqt_status: string }>`
    SELECT status, transaction_uuid::text, attempts, invoice_no, xml, discarded_at::text, cqt_status FROM einvoice WHERE id = ${id}`.execute(admin)).rows[0]!;
  const store = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM einvoice_fake_store WHERE tenant_id = ${tenantId}::uuid`.execute(admin)).rows[0]!.n;
  return { cookie, tenantId, userId, admin, call, providerId, seriesId, mode, sale, issue, row, store };
}

// Bọc nhà cung cấp để đếm lời gọi.
function counting() {
  const calls = { create: 0, findByTransaction: 0 };
  const factory = (r: ProviderRow): EInvoiceProvider => {
    const p = providerFor(r);
    return { ...p, create: (c, d) => { calls.create++; return p.create(c, d); }, findByTransaction: (c, d) => { calls.findByTransaction++; return p.findByTransaction(c, d); } };
  };
  return { calls, factory };
}

describe('phát hành hóa đơn điện tử', () => {
  it('phát hành HDB đã ghi sổ qua fake: issued, invoice_no 1, voucher_invoice có số, einvoice_log 1 dòng ok', async () => {
    const t = await tenant();
    const v = await t.sale();
    const r = await t.issue(v.id);
    expect(r.statusCode, r.body).toBe(201);
    const e = r.json();
    expect(e).toMatchObject({ status: 'issued', invoiceNo: '0000001', issueDate: '2026-03-10', serial: 'C26TAA', formNo: '1', voucherId: v.id, buyerName: 'Khách 1', total: '11000000', attempts: 1 });
    expect(e.warnings).toBeUndefined();
    const vi_ = (await sql<{ invoice_no: string; einvoice_pending: boolean; invoice_date: string }>`SELECT invoice_no, einvoice_pending, invoice_date FROM voucher_invoice WHERE voucher_id = ${v.id}::uuid`.execute(t.admin)).rows;
    expect(vi_).toEqual([{ invoice_no: '0000001', einvoice_pending: false, invoice_date: '2026-03-10' }]);
    const logs = (await sql<{ action: string; ok: boolean }>`SELECT action, ok FROM einvoice_log WHERE einvoice_id = ${e.id}`.execute(t.admin)).rows;
    expect(logs).toEqual([{ action: 'create', ok: true }]);
    const payload = (await sql<{ p: { transactionUuid: string } }>`SELECT payload AS p FROM einvoice WHERE id = ${e.id}`.execute(t.admin)).rows[0]!.p;
    expect(payload.transactionUuid).toBe(e.transactionUuid);
    // chứng từ đã phát hành: khóa
    expect(err(await t.call('POST', `/api/vouchers/${v.id}/unpost`))).toEqual([409, 'EINVOICE_ISSUED']);
    // chi tiết kèm nhật ký, danh sách, hóa đơn của chứng từ
    const detail = await t.call('GET', `/api/einvoices/${e.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().logs).toMatchObject([{ action: 'create', ok: true }]);
    const list = await t.call('GET', '/api/einvoices?status=issued&from=2026-03-01&to=2026-03-31&q=0000001');
    expect(list.json().map((x: { id: number }) => x.id)).toEqual([e.id]);
    expect((await t.call('GET', '/api/einvoices?q=khong-co')).json()).toEqual([]);
    expect((await t.call('GET', `/api/vouchers/${v.id}/einvoice`)).json().einvoice).toMatchObject({ id: e.id, status: 'issued' });
    // ngày hóa đơn khác tháng hạch toán: phát hành được, có cảnh báo
    const w = await t.issue((await t.sale()).id, '2026-04-02');
    expect(w.statusCode, w.body).toBe(201);
    expect(w.json()).toMatchObject({ status: 'issued', invoiceNo: '0000002', issueDate: '2026-04-02', warnings: [{ code: 'ISSUE_DATE_DIFFERS_PERIOD' }] });
  });

  it('chứng từ nháp → 409 VOUCHER_NOT_POSTED; HDM → 400; đã issued → 409 EINVOICE_EXISTS; dòng thiếu mã thuế → 400 LINE_MISSING_TAX_CODE, không gọi nhà cung cấp', async () => {
    const t = await tenant();
    const draft = await t.sale({ autoPost: false });
    expect(err(await t.issue(draft.id))).toEqual([409, 'VOUCHER_NOT_POSTED']);
    const hdm = await t.call('POST', '/api/invoices', { voucherType: 'HDM', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'NCC001', autoPost: true,
      items: [{ description: 'Mua', accountCode: '6422', amountCurrency: '1000000', taxCodes: ['V10'] }], invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '01', formNo: '1', serial: 'C26TBB', invoiceNo: '123' } });
    expect(hdm.statusCode, hdm.body).toBe(201);
    expect(err(await t.issue(hdm.json().id))).toEqual([400, 'EINVOICE_VOUCHER_TYPE']);
    const v = await t.sale();
    expect((await t.issue(v.id)).statusCode).toBe(201);
    expect(err(await t.issue(v.id))).toEqual([409, 'EINVOICE_EXISTS']);
    expect(err(await t.issue((await t.sale()).id, '2027-01-05'))).toEqual([400, 'SERIES_YEAR_MISMATCH']);

    const noTax = await t.sale({}, [{ description: 'Không mã thuế', accountCode: '5113', amountCurrency: '500000', taxCodes: [] }]);
    const r = await t.issue(noTax.id);
    expect(err(r)).toEqual([400, 'LINE_MISSING_TAX_CODE']);
    expect(r.json().error.message).toContain('Dòng 1 chưa có mã thuế GTGT');
    expect((await sql`SELECT 1 FROM einvoice WHERE voucher_id = ${noTax.id}::uuid`.execute(t.admin)).rows).toHaveLength(0);
    expect(await t.store()).toBe(1);
  });

  it('timeout_after_create: trạng thái sending; retry → findByTransaction trả số cũ, create không gọi lại (đếm lời gọi), issued', async () => {
    const t = await tenant();
    const v = await t.sale();
    await t.mode({ mode: 'timeout_after_create' });
    const r = await t.issue(v.id);
    expect(r.statusCode, r.body).toBe(201);
    const e = r.json();
    expect(e).toMatchObject({ status: 'sending', invoiceNo: null, attempts: 1, errorCode: 'PENDING' });
    expect(err(await t.call('POST', `/api/vouchers/${v.id}/unpost`))).toEqual([409, 'EINVOICE_ISSUED']); // đang gửi cũng khóa
    expect(err(await t.issue(v.id))).toEqual([409, 'EINVOICE_EXISTS']);
    await t.mode({});
    const { calls, factory } = counting();
    const done = await retryEInvoice(ctx.t.db, { tenantId: t.tenantId, userId: t.userId }, e.id, factory);
    expect(calls).toEqual({ create: 0, findByTransaction: 1 });
    expect(done).toMatchObject({ status: 'issued', invoiceNo: '0000001', transactionUuid: e.transactionUuid, attempts: 2, errorCode: null });
    expect(await t.store()).toBe(1);
    expect(err(await t.call('POST', `/api/einvoices/${e.id}/retry`))).toEqual([409, 'EINVOICE_NOT_SENDING']);
  });

  it('timeout_before: retry không thấy theo uuid thì create lại cùng uuid, cùng payload đã lưu', async () => {
    const t = await tenant();
    const v = await t.sale();
    await t.mode({ mode: 'timeout_before' });
    const e = (await t.issue(v.id)).json();
    expect(e.status).toBe('sending');
    expect(await t.store()).toBe(0);
    await sql`UPDATE einvoice SET payload = jsonb_set(payload, '{issueDate}', '"2026-03-11"') WHERE id = ${e.id}`.execute(t.admin); // payload lưu là thứ được gửi lại
    await t.mode({});
    const { calls, factory } = counting();
    const done = await retryEInvoice(ctx.t.db, { tenantId: t.tenantId, userId: t.userId }, e.id, factory);
    expect(calls).toEqual({ create: 1, findByTransaction: 1 });
    expect(done).toMatchObject({ status: 'issued', issueDate: '2026-03-11', transactionUuid: e.transactionUuid });
  });

  it('hai yêu cầu phát hành đồng thời cùng chứng từ: một issued, một 409; fake ghi đúng một hóa đơn', async () => {
    const t = await tenant();
    const v = await t.sale();
    const rs = await Promise.all([t.issue(v.id), t.issue(v.id)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().error.code).toBe('EINVOICE_EXISTS');
    expect(rs.find((r) => r.statusCode === 201)!.json().status).toBe('issued');
    expect(await t.store()).toBe(1);
  });

  it('phát hành song song với bỏ ghi sổ: chứng từ không bao giờ vừa bỏ ghi sổ vừa có hóa đơn', async () => {
    const t = await tenant();
    const v = await t.sale();
    const [i, u] = await Promise.all([t.issue(v.id), t.call('POST', `/api/vouchers/${v.id}/unpost`)]);
    const state = (await sql<{ state: string }>`SELECT state FROM voucher WHERE id = ${v.id}::uuid`.execute(t.admin)).rows[0]!.state;
    if (i.statusCode === 201) { expect(u.statusCode).toBe(409); expect(state).toBe('posted'); }
    else { expect(err(i)).toEqual([409, 'VOUCHER_NOT_POSTED']); expect(u.statusCode).toBe(200); expect(state).toBe('draft'); }
  });

  it('reject → failed, chứng từ bỏ ghi sổ được sau discard; phát hành lại dùng transaction_uuid mới', async () => {
    const t = await tenant();
    const v = await t.sale();
    await t.mode({ mode: 'reject' });
    const a = (await t.issue(v.id)).json();
    expect(a).toMatchObject({ status: 'failed', errorCode: 'FAKE_REJECT', errorMessage: 'Nhà cung cấp giả lập từ chối hóa đơn' });
    expect(err(await t.call('POST', `/api/einvoices/${a.id}/retry`))).toEqual([409, 'EINVOICE_NOT_SENDING']);
    // phát hành lại khi chưa bỏ: dùng lại hàng lỗi với uuid mới
    const b = (await t.issue(v.id)).json();
    expect(b).toMatchObject({ id: a.id, status: 'failed' });
    expect(b.transactionUuid).not.toBe(a.transactionUuid);
    const d = await t.call('POST', `/api/einvoices/${a.id}/discard`);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().discardedAt).not.toBeNull();
    expect(err(await t.call('POST', `/api/einvoices/${a.id}/discard`))).toEqual([409, 'EINVOICE_NOT_FAILED']);
    expect((await t.call('GET', `/api/vouchers/${v.id}/einvoice`)).json().einvoice).toBeNull();
    expect((await t.call('GET', '/api/einvoices?status=failed')).json()).toEqual([]);
    const un = await t.call('POST', `/api/vouchers/${v.id}/unpost`);
    expect(un.statusCode, un.body).toBe(200);
    const post = await t.call('POST', `/api/vouchers/${v.id}/post`);
    expect(post.statusCode, post.body).toBe(200);
    await t.mode({});
    const c = (await t.issue(v.id)).json();
    expect(c).toMatchObject({ status: 'issued', invoiceNo: '0000001' });
    expect(c.id).not.toBe(a.id);
    expect([a.transactionUuid, b.transactionUuid]).not.toContain(c.transactionUuid);
    expect((await t.row(a.id)).status).toBe('failed'); // hàng đã bỏ vẫn giữ làm lịch sử
    expect(err(await t.call('POST', `/api/einvoices/${c.id}/discard`))).toEqual([409, 'EINVOICE_NOT_FAILED']);
  });

  it('reconcilePending với hai công ty: chỉ đụng hàng sending cũ hơn 120 giây, mỗi công ty dưới RLS của nó', async () => {
    const a = await tenant(); const b = await tenant();
    await a.mode({ mode: 'timeout_after_create' }); await b.mode({ mode: 'timeout_after_create' });
    const aOld = (await a.issue((await a.sale()).id)).json(); const aNew = (await a.issue((await a.sale()).id)).json(); const bOld = (await b.issue((await b.sale()).id)).json();
    expect([aOld.status, aNew.status, bOld.status]).toEqual(['sending', 'sending', 'sending']);
    await a.mode({}); await b.mode({});
    await sql`UPDATE einvoice SET last_attempt_at = now() - interval '5 minutes' WHERE id IN (${aOld.id}, ${bOld.id})`.execute(ctx.t.admin);
    const r = await reconcilePending(ctx.t.db, providerFor, { olderThanSec: 120, limit: 1000 });
    expect(r.issued).toBeGreaterThanOrEqual(2);
    expect(await a.row(aOld.id)).toMatchObject({ status: 'issued', invoice_no: '0000001', attempts: 2 });
    expect(await a.row(aNew.id)).toMatchObject({ status: 'sending', invoice_no: null, attempts: 1 });
    expect(await b.row(bOld.id)).toMatchObject({ status: 'issued', invoice_no: '0000001', attempts: 2 });
    // tra theo uuid trong kho của chính công ty: không cấp thêm số
    expect([await a.store(), await b.store()]).toEqual([2, 1]);
  });

  it('ký hiệu C: cqt_status waiting rồi refresh → accepted có cqt_code', async () => {
    const t = await tenant();
    const e = (await t.issue((await t.sale()).id)).json();
    expect(e).toMatchObject({ status: 'issued', cqtStatus: 'waiting', cqtCode: null });
    const r = await t.call('POST', `/api/einvoices/${e.id}/refresh`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cqtStatus).toBe('accepted');
    expect(r.json().cqtCode).toMatch(/^[0-9A-F]{34}$/);
    // nhà cung cấp cấp mã ngay (withCode): accepted luôn
    await t.mode({ withCode: true });
    expect((await t.issue((await t.sale()).id)).json()).toMatchObject({ cqtStatus: 'accepted', cqtCode: expect.stringMatching(/^[0-9A-F]{34}$/) });
  });

  it('GET file xml lưu einvoice.xml; người chỉ có einvoice.view tải được, không có quyền → 403', async () => {
    const t = await tenant();
    const e = (await t.issue((await t.sale()).id)).json();
    const userWith = async (roleCode: string) => {
      const username = `ei_${roleCode}_${Date.now()}${n++}`;
      const u = await t.call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode });
      expect(u.statusCode, u.body).toBe(201);
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
      return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    };
    const viewer = await userWith('xem');
    const x = await t.call('GET', `/api/einvoices/${e.id}/file?kind=xml`, undefined, viewer);
    expect(x.statusCode, x.body).toBe(200);
    expect(x.headers['content-type']).toContain('application/xml');
    expect(x.body).toContain('<SHDon>1</SHDon>');
    expect((await t.row(e.id)).xml).toBe(x.body);
    // lần sau đọc từ DB: nhà cung cấp mất hóa đơn vẫn tải được
    await sql`DELETE FROM einvoice_fake_store WHERE tenant_id = ${t.tenantId}::uuid`.execute(t.admin);
    expect((await t.call('GET', `/api/einvoices/${e.id}/file?kind=xml`, undefined, viewer)).body).toBe(x.body);
    expect(err(await t.call('POST', `/api/einvoices/${e.id}/refresh`, undefined, viewer))).toEqual([403, 'FORBIDDEN']);

    await sql`INSERT INTO role (tenant_id, code, name) VALUES (${t.tenantId}::uuid, 'khac', 'Không xem hóa đơn')`.execute(t.admin);
    const none = await userWith('khac');
    expect(err(await t.call('GET', `/api/einvoices/${e.id}/file?kind=xml`, undefined, none))).toEqual([403, 'FORBIDDEN']);
    expect(err(await t.call('GET', '/api/einvoices', undefined, none))).toEqual([403, 'FORBIDDEN']);
    expect(err(await t.call('POST', '/api/einvoices', { voucherId: e.voucherId }, none))).toEqual([403, 'FORBIDDEN']);
  });

  it('GET file pdf: nhà cung cấp giả lập trả HTML; hóa đơn chưa phát hành → 409', async () => {
    const t = await tenant();
    const e = (await t.issue((await t.sale()).id)).json();
    const p = await t.call('GET', `/api/einvoices/${e.id}/file?kind=pdf`);
    expect(p.statusCode, p.body).toBe(200);
    expect(p.body).toContain('Hóa đơn giả lập C26TAA/0000001');
    await t.mode({ mode: 'reject' });
    const f = (await t.issue((await t.sale()).id)).json();
    expect(err(await t.call('GET', `/api/einvoices/${f.id}/file?kind=pdf`))).toEqual([409, 'EINVOICE_NOT_ISSUED']);
    expect(err(await t.call('GET', '/api/einvoices/999999'))).toEqual([404, 'EINVOICE_NOT_FOUND']);
  });
});
