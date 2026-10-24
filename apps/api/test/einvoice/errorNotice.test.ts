import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { sealSecret } from '../../src/lib/secretBox.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];

async function tenant(code: 'fake' | 'sinvoice' = 'fake') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `EN${Date.now()}${n++}`);
  const admin = ctx.t.admin;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name, base_url, secret, options) VALUES (${tenantId}::uuid, ${code}, 'NCC', 'https://api.example.test', ${code === 'sinvoice' ? sealSecret('x') : null}, ${JSON.stringify({ withCode: true })}::jsonb) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const seriesId = (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${providerId}, '1', 'C26TAA', 2026) RETURNING id::int`.execute(admin)).rows[0]!.id;
  // Hóa đơn đã phát hành (fake) hoặc hàng issued chèn tay (sinvoice).
  const issued = async () => {
    const s = await call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'KH001', autoPost: true,
      items: [{ description: 'Dịch vụ', accountCode: '5113', amountCurrency: '10000000', taxCodes: ['V10'] }], invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: '10', einvoiceSeriesId: seriesId }, idempotencyKey: `k${n++}` });
    expect(s.statusCode, s.body).toBe(201);
    if (code === 'sinvoice') {
      return (await sql<{ id: number }>`INSERT INTO einvoice (tenant_id, voucher_id, series_id, provider_id, status, transaction_uuid, invoice_no, issue_date, cqt_code)
        VALUES (${tenantId}::uuid, ${s.json().id}::uuid, ${seriesId}, ${providerId}, 'issued', gen_random_uuid(), '0000007', '2026-03-10', 'MCQT123') RETURNING id::int`.execute(admin)).rows[0]!.id;
    }
    const r = await call('POST', '/api/einvoices', { voucherId: s.json().id, issueDate: '2026-03-10' });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as number;
  };
  return { call, tenantId, admin, providerId, issued };
}
const body = (extra: object = {}) => ({ noticeKind: 'self', noticeDate: '2026-04-05', place: 'Hà Nội', ...extra });

describe('thông báo hóa đơn điện tử đã lập sai 04/SS-HĐĐT', () => {
  it('lập 04/SS cho hóa đơn issued: dòng lấy ký hiệu mẫu, ký hiệu, số, ngày, mã CQT từ einvoice; loại hóa đơn theo ký tự đầu ký hiệu mẫu', async () => {
    const t = await tenant();
    const id = await t.issued();
    const r = await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ einvoiceId: id, action: 'notice', reason: 'Sai địa chỉ người mua' }] }));
    expect(r.statusCode, r.body).toBe(201);
    const l = r.json().lines[0];
    expect(l).toMatchObject({ lineNo: 1, einvoiceId: id, formNo: '1', serial: 'C26TAA', invoiceNo: '0000001', issueDate: '2026-03-10', invoiceType: 'Hóa đơn giá trị gia tăng', action: 'notice', reason: 'Sai địa chỉ người mua' });
    expect(l.cqtCode).toMatch(/^[0-9A-F]{34}$/);
    // dòng nhập tay thiếu ngày → 400; tax_notice thiếu số thông báo → 400
    expect(err(await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ formNo: '1', serial: 'C26TAA', invoiceNo: '9', action: 'notice', reason: 'x' }] })))).toEqual([400, 'VALIDATION']);
    expect(err(await t.call('POST', '/api/einvoice/error-notices', body({ noticeKind: 'tax_notice', lines: [{ einvoiceId: id, action: 'explain', reason: 'x' }] })))[0]).toBe(400);
    const ok = await t.call('POST', '/api/einvoice/error-notices', body({ noticeKind: 'tax_notice', taxNoticeNo: '01/TB-RSĐT', taxNoticeDate: '2026-04-01', lines: [{ formNo: '2', serial: 'K26TYY', invoiceNo: '5', issueDate: '2026-02-01', action: 'explain', reason: 'Đã rà soát' }] }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().lines[0]).toMatchObject({ einvoiceId: null, invoiceType: 'Hóa đơn bán hàng', cqtCode: null });
    // giải trình chỉ cho thông báo của CQT, thông báo chỉ cho tự lập
    expect(err(await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ einvoiceId: id, action: 'explain', reason: 'x' }] })))).toEqual([400, 'VALIDATION']);
  });

  it('in HTML có tiêu đề và dòng Mẫu số đúng TT 91/2026; cột (1)-(9) theo mẫu; PDF', async () => {
    const t = await tenant();
    const id = await t.issued();
    const c = await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ einvoiceId: id, action: 'notice', reason: 'Sai tên' }] }));
    const h = await t.call('GET', `/api/einvoice/error-notices/${c.json().id}/print?format=html`);
    expect(h.statusCode, h.body).toBe(200);
    for (const s of ['Mẫu số: 04/SS-HĐĐT', '(Kèm theo Thông tư số 91/2026/TT-BTC ngày 30 tháng 6 năm 2026 của Bộ trưởng Bộ Tài chính)', 'THÔNG BÁO HÓA ĐƠN ĐIỆN TỬ ĐÃ LẬP SAI', 'Kính gửi: (Cơ quan thuế)',
      'Người nộp thuế thông báo về việc hóa đơn điện tử đã lập sai như sau:', 'Mã CQT cấp', 'Ký hiệu mẫu hóa đơn', 'Ký hiệu hóa đơn', 'Số hóa đơn điện tử', 'Ngày lập hóa đơn', 'Loại hóa đơn điện tử', 'Thông báo/Giải trình', 'Lý do/Thông báo của CQT',
      '(9)', 'NGƯỜI MUA', 'NGƯỜI NỘP THUẾ hoặc', 'Hà Nội, ngày 05 tháng 04 năm 2026', 'C26TAA', 'Sai tên']) expect(h.body, s).toContain(s);
    const p = await t.call('GET', `/api/einvoice/error-notices/${c.json().id}/print?format=pdf`);
    expect(p.statusCode).toBe(200);
  });

  it('send với fake → sent; sửa/xóa/gửi lại thông báo đã gửi → 409', async () => {
    const t = await tenant();
    const id = await t.issued();
    const c = (await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ einvoiceId: id, action: 'notice', reason: 'Sai tên' }] }))).json();
    expect(c.status).toBe('draft');
    const put = await t.call('PUT', `/api/einvoice/error-notices/${c.id}`, body({ place: 'Đà Nẵng', lines: [{ einvoiceId: id, action: 'notice', reason: 'Sai tên hàng' }] }));
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().place).toBe('Đà Nẵng');
    const s = await t.call('POST', `/api/einvoice/error-notices/${c.id}/send`);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ status: 'sent' });
    expect(s.json().providerRef).toBeTruthy();
    expect(err(await t.call('PUT', `/api/einvoice/error-notices/${c.id}`, body({ lines: [{ einvoiceId: id, action: 'notice', reason: 'x' }] })))).toEqual([409, 'ERROR_NOTICE_NOT_DRAFT']);
    expect(err(await t.call('DELETE', `/api/einvoice/error-notices/${c.id}`))).toEqual([409, 'ERROR_NOTICE_NOT_DRAFT']);
    expect(err(await t.call('POST', `/api/einvoice/error-notices/${c.id}/send`))).toEqual([409, 'ERROR_NOTICE_NOT_DRAFT']);
    expect((await t.call('GET', '/api/einvoice/error-notices')).json()).toHaveLength(1);
  });

  it('sinvoice không hỗ trợ sendErrorNotice → 409 PROVIDER_UNSUPPORTED; mark-sent tay; xóa bản nháp', async () => {
    const t = await tenant('sinvoice');
    const id = await t.issued();
    const c = (await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ einvoiceId: id, action: 'notice', reason: 'Sai tên' }] }))).json();
    expect(err(await t.call('POST', `/api/einvoice/error-notices/${c.id}/send`))).toEqual([409, 'PROVIDER_UNSUPPORTED']);
    const m = await t.call('POST', `/api/einvoice/error-notices/${c.id}/mark-sent`, { providerRef: 'Cổng CQT 123' });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json()).toMatchObject({ status: 'sent', providerRef: 'Cổng CQT 123' });
    expect(err(await t.call('POST', `/api/einvoice/error-notices/${c.id}/mark-sent`))).toEqual([409, 'ERROR_NOTICE_NOT_DRAFT']);
    const d = (await t.call('POST', '/api/einvoice/error-notices', body({ lines: [{ einvoiceId: id, action: 'notice', reason: 'x' }] }))).json();
    expect((await t.call('DELETE', `/api/einvoice/error-notices/${d.id}`)).statusCode).toBe(204);
    expect((await t.call('GET', `/api/einvoice/error-notices/${d.id}`)).statusCode).toBe(404);
  });
});
