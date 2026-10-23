/* eslint-disable @typescript-eslint/no-explicit-any -- JSON tự do của máy chủ giả lập */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import JSZip from 'jszip';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { SInvoiceProvider } from '../../src/modules/einvoice/providers/sinvoice.js';
import { providerFor, withProviderCtx, PROVIDER_TIMEOUT_SEC, ProviderError, type EInvoiceDoc, type EInvoiceLine, type OriginalRef, type ProviderCtx } from '../../src/modules/einvoice/providers/index.js';
import { sealSecret } from '../../src/lib/secretBox.js';
import { NetworkError } from '../../src/lib/http.js';
import { startSInvoiceMock } from './sinvoiceMock.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let app: TestApp; let mock: Awaited<ReturnType<typeof startSInvoiceMock>>;
beforeAll(async () => { app = await createTestApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { mock = await startSInvoiceMock(); });
afterEach(async () => { vi.useRealTimers(); await mock.close(); });

const NOW = new Date('2026-03-10T03:00:00Z'); // 10:00 +07
const ISSUE_MS = NOW.getTime();
const uuid = () => crypto.randomUUID();
const make = (over: Partial<ConstructorParameters<typeof SInvoiceProvider>[0]> = {}) => new SInvoiceProvider({ baseUrl: mock.baseUrl, username: mock.username, password: mock.password, sellerTaxCode: '0100109106', ...over });
const logs: Array<{ action: string; request: any; response: any; ok: boolean; error?: string }> = [];
const ctx: ProviderCtx = { db: new Proxy({}, { get() { throw new Error('adapter thật không được dùng ctx.db'); } }) as never, async log(e) { logs.push(e as never); } };
beforeEach(() => { logs.length = 0; });

const line = (over: Partial<EInvoiceLine> = {}): EInvoiceLine => ({ lineNo: 1, kind: 'goods', code: 'SP01', name: 'Sản phẩm', uom: 'Cái', quantity: '2', unitPrice: '500000', amount: '1000000', discountRate: null, discountAmount: '0',
  taxRate: '10', taxAmount: '100000', total: '1100000', ...over });
const doc = (over: Partial<EInvoiceDoc> = {}): EInvoiceDoc => ({ transactionUuid: uuid(), formNo: '1', serial: 'K24TUT', providerTemplate: '1/001', issueDate: '2026-03-10', currency: 'VND', fxRate: '1', paymentMethod: 'TM/CK',
  seller: { name: 'Công ty ABC', taxCode: '0100109106', address: '1 Láng Hạ', email: 'a@abc.vn', phone: '+84 24 3999 8888' },
  buyer: { name: 'Công ty XYZ', taxCode: '0312345678', address: '2 Lê Lợi', buyerName: 'Nguyễn Văn A', email: 'x@xyz.vn', phone: '0901234567' },
  lines: [line()], taxGroups: [{ taxRate: '10', base: '1000000', tax: '100000' }],
  totals: { beforeTax: '1000000', tax: '100000', discount: '0', total: '1100000', totalInWords: 'Một triệu một trăm nghìn đồng chẵn' }, relation: { kind: 'original' }, ...over });
const orig = (providerRef: Record<string, unknown> = {}): OriginalRef => ({ formNo: '1', serial: 'K24TUT', invoiceNo: '01', issueDate: '2026-03-01', providerRef: { invoiceNo: 'K24TUT01', templateCode: '1/001', issueMs: 1772296800000, ...providerRef } });

describe('SInvoice adapter (máy chủ giả lập theo tài liệu)', () => {
  it('create: đăng nhập một lần, gửi JSON đúng các trường của tài liệu, tách ký hiệu khỏi invoiceNo', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const p = make(); const d = doc();
    const r = await p.create(ctx, d);
    await p.create(ctx, doc());
    expect(mock.s.logins).toBe(1);
    const sent = mock.calls('/createInvoice/0100109106')[0]!;
    expect(sent.auth).toBe('Bearer tok-1');
    expect(sent.cookie).toBe('access_token=tok-1');
    expect(sent.body).toEqual({
      generalInvoiceInfo: { transactionUuid: d.transactionUuid, invoiceType: '1', templateCode: '1/001', invoiceSeries: 'K24TUT', invoiceIssuedDate: ISSUE_MS, currencyCode: 'VND', adjustmentType: '1', paymentStatus: false, cusGetInvoiceRight: true, validation: 1 },
      buyerInfo: { buyerName: 'Nguyễn Văn A', buyerLegalName: 'Công ty XYZ', buyerTaxCode: '0312345678', buyerAddressLine: '2 Lê Lợi', buyerPhoneNumber: '0901234567', buyerEmail: 'x@xyz.vn', buyerCityName: '', buyerCountryCode: 'VN', buyerNotGetInvoice: 0 },
      sellerInfo: { sellerLegalName: 'Công ty ABC', sellerTaxCode: '0100109106', sellerAddressLine: '1 Láng Hạ', sellerPhoneNumber: '00842439998888', sellerEmail: 'a@abc.vn', sellerCountryCode: 'VN' },
      payments: [{ paymentMethodName: 'TM/CK' }],
      itemInfo: [{ selection: 1, itemCode: 'SP01', itemName: 'Sản phẩm', unitName: 'Cái', unitPrice: 500000, quantity: 2, itemTotalAmountWithoutTax: 1000000, taxPercentage: 10, taxAmount: 100000, discount: 0, itemTotalAmountAfterDiscount: 1000000, itemTotalAmountWithTax: 1100000 }],
      taxBreakdowns: [{ taxPercentage: 10, taxableAmount: 1000000, taxAmount: 100000, taxableAmountPos: true, taxAmountPos: true }],
      summarizeInfo: { sumOfTotalLineAmountWithoutTax: 1000000, totalAmountWithoutTax: 1000000, totalTaxAmount: 100000, totalAmountWithTax: 1100000, totalAmountWithTaxInWords: 'Một triệu một trăm nghìn đồng chẵn' },
    });
    expect(r).toMatchObject({ invoiceNo: '01', issueDate: '2026-03-10', cqtCode: null, cqtStatus: 'none' });
    expect(r.providerRef).toMatchObject({ invoiceNo: 'K24TUT01', templateCode: '1/001', reservationCode: 'RC1', issueMs: ISSUE_MS, transactionUuid: d.transactionUuid });
  });

  it('token hết hạn (401) → đăng nhập lại một lần rồi gửi lại', async () => {
    const p = make();
    await p.create(ctx, doc());
    mock.s.valid.clear();
    const r = await p.create(ctx, doc());
    expect(r.invoiceNo).toBe('02');
    expect(mock.s.logins).toBe(2);
    expect(mock.calls('/createInvoice/0100109106')).toHaveLength(3);
  });

  it('sai mật khẩu → ProviderError SINVOICE_AUTH không thử lại', async () => {
    const e = await make({ password: 'sai' }).create(ctx, doc()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ code: 'SINVOICE_AUTH', retriable: false });
  });

  it('timeout mặc định là PROVIDER_TIMEOUT_SEC; hết giờ → NetworkError, findByTransaction trả hóa đơn đã tạo', async () => {
    expect(make().timeoutMs).toBe(PROVIDER_TIMEOUT_SEC * 1000);
    mock.s.hangCreateMs = 600;
    const p = make({ timeoutMs: 200 }); const d = doc();
    await expect(p.create(ctx, d)).rejects.toBeInstanceOf(NetworkError);
    const f = await p.findByTransaction(ctx, d);
    expect(f).toMatchObject({ invoiceNo: '01', providerRef: { invoiceNo: 'K24TUT01', templateCode: '1/001' } });
    expect(await p.findByTransaction(ctx, doc())).toBeNull();
    const form = mock.calls('/searchInvoiceByTransactionUuid')[0]!;
    expect(form.query).toEqual({ supplierTaxCode: '0100109106', transactionUuid: d.transactionUuid });
  });

  it('create trùng transactionUuid mà SInvoice báo lỗi trùng → trả hóa đơn đã có, không tạo thứ hai', async () => {
    const p = make(); const d = doc();
    const a = await p.create(ctx, d);
    const b = await p.create(ctx, d);
    expect(b.invoiceNo).toBe(a.invoiceNo);
    expect(mock.s.invoices.size).toBe(1);
    // lỗi nghiệp vụ khác (không có hóa đơn theo uuid) vẫn ném, không retriable
    mock.s.failNext = { status: 200, body: { errorCode: 'INVALID_DATA', description: 'Sai mã số thuế người mua', result: null } };
    const e = await p.create(ctx, doc()).catch((x) => x);
    expect(e).toMatchObject({ code: 'INVALID_DATA', retriable: false });
  });

  it('lỗi 5xx và body không phải JSON → ProviderError retriable', async () => {
    const p = make();
    mock.s.failNext = { status: 503, body: { x: 1 } };
    expect(await p.create(ctx, doc()).catch((x) => x)).toMatchObject({ retriable: true });
    mock.s.failNext = { status: 200, body: 'not json' };
    expect(await p.create(ctx, doc()).catch((x) => x)).toMatchObject({ code: 'SINVOICE_BAD_RESPONSE', retriable: true });
  });

  it('điều chỉnh giảm: adjustmentType 5, tham chiếu hóa đơn gốc, dòng isIncreaseItem=false, unitPrice âm', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const d = doc({ relation: { kind: 'adjustment', adjust: 'decrease', original: orig(), reason: 'Giảm giá hàng bán', agreementNo: 'BB-01', agreementDate: '2026-03-05' } });
    await make().create(ctx, d);
    const b = mock.calls('/createInvoice/0100109106')[0]!.body;
    expect(b.generalInvoiceInfo).toMatchObject({ adjustmentType: '5', adjustmentInvoiceType: '1', originalInvoiceId: 'K24TUT01', originalInvoiceIssueDate: 1772296800000, originalTemplateCode: '1/001',
      additionalReferenceDesc: 'BB-01', additionalReferenceDate: Date.parse('2026-03-05T00:00:00+07:00'), invoiceNote: 'Giảm giá hàng bán' });
    expect(b.itemInfo[0]).toMatchObject({ unitPrice: -500000, itemTotalAmountWithoutTax: 1000000, taxAmount: 100000, adjustmentTaxAmount: 100000, isIncreaseItem: false });
    expect(b.taxBreakdowns[0]).toMatchObject({ taxableAmountPos: false, taxAmountPos: false });
    // không có văn bản thỏa thuận → 'NA' và ngày gọi
    await make().create(ctx, doc({ relation: { kind: 'adjustment', adjust: 'decrease', original: orig(), reason: 'r' } }));
    expect(mock.calls('/createInvoice/0100109106')[1]!.body.generalInvoiceInfo).toMatchObject({ additionalReferenceDesc: 'NA', additionalReferenceDate: ISSUE_MS });
  });

  it('điều chỉnh tăng: isIncreaseItem=true (suy từ tên trường); điều chỉnh thông tin: từ chối vì nguồn không mô tả', async () => {
    await make().create(ctx, doc({ relation: { kind: 'adjustment', adjust: 'increase', original: orig(), reason: 'r' } }));
    const b = mock.calls('/createInvoice/0100109106')[0]!.body;
    expect(b.itemInfo[0]).toMatchObject({ unitPrice: 500000, isIncreaseItem: true, adjustmentTaxAmount: 100000 });
    expect(b.taxBreakdowns[0]).toMatchObject({ taxableAmountPos: true, taxAmountPos: true });
    const e = await make().create(ctx, doc({ relation: { kind: 'adjustment', adjust: 'info', original: orig(), reason: 'r' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'SINVOICE_UNSUPPORTED', retriable: false });
    expect(mock.calls('/createInvoice/0100109106')).toHaveLength(1);
  });

  it('thay thế: adjustmentType 3, dòng dương không có isIncreaseItem', async () => {
    await make().create(ctx, doc({ relation: { kind: 'replacement', original: orig(), reason: 'Sai đơn giá' } }));
    const b = mock.calls('/createInvoice/0100109106')[0]!.body;
    expect(b.generalInvoiceInfo).toMatchObject({ adjustmentType: '3', originalInvoiceId: 'K24TUT01', originalTemplateCode: '1/001', additionalReferenceDesc: 'NA' });
    expect(b.itemInfo[0].unitPrice).toBe(500000);
    expect(b.itemInfo[0]).not.toHaveProperty('isIncreaseItem');
    expect(b.itemInfo[0]).not.toHaveProperty('adjustmentTaxAmount');
    expect(b.taxBreakdowns[0].taxableAmountPos).toBe(true);
  });

  it('thuế suất: 8% là 8, KCT là -2, KKKNT là -1, mã KHAC bị từ chối trước khi gọi', async () => {
    const p = make();
    const d = doc({ lines: [line({ taxRate: '8', taxAmount: '80000', total: '1080000' }), line({ lineNo: 2, taxRate: 'KCT', taxAmount: '0', total: '1000000' }), line({ lineNo: 3, taxRate: 'KKKNT', taxAmount: '0', total: '1000000' })],
      taxGroups: [{ taxRate: '8', base: '1000000', tax: '80000' }, { taxRate: 'KCT', base: '1000000', tax: '0' }, { taxRate: 'KKKNT', base: '1000000', tax: '0' }] });
    await p.create(ctx, d);
    const b = mock.calls('/createInvoice/0100109106')[0]!.body;
    expect(b.itemInfo.map((i: any) => i.taxPercentage)).toEqual([8, -2, -1]);
    expect(b.taxBreakdowns.map((i: any) => i.taxPercentage)).toEqual([8, -2, -1]);
    const e = await p.create(ctx, doc({ lines: [line({ taxRate: 'KHAC' })] })).catch((x) => x);
    expect(e).toMatchObject({ code: 'SINVOICE_UNSUPPORTED_TAX', retriable: false });
    expect(mock.calls('/createInvoice/0100109106')).toHaveLength(1);
  });

  it('ngoại tệ: currencyCode, exchangeRate 2 chữ số, số tiền nguyên tệ theo tổng của hóa đơn trung lập', async () => {
    const d = doc({ currency: 'USD', fxRate: '24500.1234', lines: [line({ quantity: '3', unitPrice: '10.01', amount: '30.03', taxAmount: '3.00', total: '33.03' })],
      taxGroups: [{ taxRate: '10', base: '30.03', tax: '3.00' }], totals: { beforeTax: '30.03', tax: '3.00', discount: '0', total: '33.03', totalInWords: 'x' } });
    await make().create(ctx, d);
    const b = mock.calls('/createInvoice/0100109106')[0]!.body;
    expect(b.generalInvoiceInfo).toMatchObject({ currencyCode: 'USD', exchangeRate: '24500.12' });
    expect(b.itemInfo[0]).toMatchObject({ unitPrice: 10.01, itemTotalAmountWithoutTax: 30.03, taxAmount: 3, itemTotalAmountWithTax: 33.03 });
    expect(b.taxBreakdowns[0]).toMatchObject({ taxableAmount: 30.03, taxAmount: 3 });
    expect(b.summarizeInfo).toMatchObject({ totalAmountWithoutTax: 30.03, totalTaxAmount: 3, totalAmountWithTax: 33.03 });
    // VND không gửi exchangeRate
    await make().create(ctx, doc());
    expect(mock.calls('/createInvoice/0100109106')[1]!.body.generalInvoiceInfo).not.toHaveProperty('exchangeRate');
  });

  it('số tiền quá 15 chữ số có nghĩa bị từ chối (không mất chính xác khi đổi sang số JSON)', async () => {
    const big = line({ amount: '9999999999999999', total: '9999999999999999', taxAmount: '0', taxRate: '0' });
    const e = await make().create(ctx, doc({ lines: [big] })).catch((x) => x);
    expect(e).toMatchObject({ code: 'SINVOICE_AMOUNT_TOO_LARGE', retriable: false });
  });

  it('getFile: pdf giải base64; xml giải ZIP lồng ZIP; tệp chưa sẵn sàng → retriable', async () => {
    const p = make(); const r = await p.create(ctx, doc());
    const ref = orig({ ...r.providerRef });
    expect((await p.getFile(ctx, ref, 'pdf')).subarray(0, 4).toString()).toBe('%PDF');
    expect((await p.getFile(ctx, ref, 'xml')).toString()).toBe('<HDon>mock</HDon>');
    const sent = mock.calls('/getInvoiceRepresentationFile');
    expect(sent[0]!.body).toEqual({ supplierTaxCode: '0100109106', templateCode: '1/001', invoiceNo: 'K24TUT01', fileType: 'PDF' });
    expect(sent[1]!.body.fileType).toBe('ZIP');
    mock.s.pdfEmptyOnce = true;
    expect(await p.getFile(ctx, ref, 'pdf').catch((x) => x)).toMatchObject({ code: 'SINVOICE_FILE_NOT_READY', retriable: true });
  });

  it('cancel và setPaid dùng đúng endpoint, tham số của tài liệu', async () => {
    const p = make(); const r = await p.create(ctx, doc());
    const ref = orig({ ...r.providerRef });
    await p.setPaid!(ctx, ref, true);
    expect(mock.s.invoices.get(r.providerRef.transactionUuid as string)!.paid).toBe(true);
    expect(mock.calls('/updatePaymentStatus')[0]!.query).toEqual({ supplierTaxCode: '0100109106', invoiceNo: 'K24TUT01', strIssueDate: String(r.providerRef.issueMs), templateCode: '1/001' });
    await p.setPaid!(ctx, ref, true); // đã khớp: không gọi lại
    expect(mock.calls('/updatePaymentStatus')).toHaveLength(1);
    await p.setPaid!(ctx, ref, false);
    expect(mock.calls('/cancelPaymentStatus')[0]!.query).toEqual({ supplierTaxCode: '0100109106', invoiceNo: 'K24TUT01', strIssueDate: String(r.providerRef.issueMs) });
    await p.cancel!(ctx, ref, 'Lập sai', '2026-03-12');
    expect(mock.calls('/cancelTransactionInvoice')[0]!.query).toEqual({ supplierTaxCode: '0100109106', templateCode: '1/001', invoiceNo: 'K24TUT01', strIssueDate: String(r.providerRef.issueMs),
      additionalReferenceDesc: 'NA', additionalReferenceDate: String(Date.parse('2026-03-12T00:00:00+07:00')), reasonDelete: 'Lập sai' });
    expect([...mock.s.invoices.values()][0]!.cancelled).toBe(true);
    expect('sendErrorNotice' in p).toBe(false);
  });

  it('refreshStatus: ký hiệu K không có mã; ký hiệu C tra exchangeStatus', async () => {
    const p = make(); const d = doc(); const r = await p.create(ctx, d);
    expect(await p.refreshStatus(ctx, orig({ ...r.providerRef }))).toEqual({ cqtCode: null, cqtStatus: 'none' });
    expect(await p.refreshStatus(ctx, { ...orig({ ...r.providerRef }), serial: 'C24TUT' })).toMatchObject({ cqtStatus: 'accepted' });
  });

  it('ping đăng nhập; sai mật khẩu báo lỗi', async () => {
    await make().ping(ctx);
    expect(mock.s.logins).toBe(1);
    await expect(make({ password: 'sai' }).ping(ctx)).rejects.toMatchObject({ code: 'SINVOICE_AUTH' });
  });

  it('ctx.log ghi từng lời gọi và che password, access_token, refresh_token', async () => {
    await make().create(ctx, doc());
    expect(logs.map((l) => l.action)).toEqual(['login', 'create']);
    const all = JSON.stringify(logs);
    expect(all).not.toContain('p@ss-secret');
    expect(all).not.toContain('tok-1');
    expect(all).not.toContain('rt-secret');
    expect(logs[0]!.request.password).toBe('***');
  });
});

describe('SInvoice qua providerFor + withProviderCtx (DB thật)', () => {
  it('providerFor mở bí mật đã mã hóa; einvoice_log che bí mật và vẫn commit khi nhà cung cấp ném lỗi; không giữ giao dịch DB', async () => {
    const b = await bootstrapTenant(app, { code: `SI${Date.now()}` });
    const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name) VALUES (${b.tenantId}::uuid, 'sinvoice', 'SInvoice') RETURNING id::int`.execute(app.t.admin)).rows[0]!.id;
    const row = { code: 'sinvoice', base_url: mock.baseUrl, username: mock.username, secret: sealSecret(mock.password), seller_tax_code: '0100109106', options: {} };
    const p = providerFor(row);
    expect(p.code).toBe('sinvoice');
    const run = <T>(fn: (c: ProviderCtx) => Promise<T>) => withProviderCtx(app.t.db, { tenantId: b.tenantId, userId: b.userId, providerId, einvoiceId: null }, fn);
    await run((c) => p.create(c, doc()));
    // giao dịch DB không mở trong lúc gọi HTTP: kiểm bằng cách đếm kết nối đang `idle in transaction` của app_user
    mock.s.hangCreateMs = 400;
    const during = run((c) => p.create(c, doc()));
    await new Promise((r) => setTimeout(r, 200));
    const open = (await sql<{ n: string }>`SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND usename = 'app_user'`.execute(app.t.admin)).rows[0]!.n;
    expect(Number(open)).toBe(0);
    await during;
    mock.s.hangCreateMs = 0;
    mock.s.failNext = { status: 200, body: { errorCode: 'INVALID_DATA', description: 'Sai dữ liệu', result: null } };
    await expect(run((c) => p.create(c, doc()))).rejects.toMatchObject({ code: 'INVALID_DATA' });
    const rows = (await sql<{ action: string; ok: boolean; request: unknown; response: unknown }>`SELECT action, ok, request, response FROM einvoice_log WHERE tenant_id = ${b.tenantId}::uuid ORDER BY id`.execute(app.t.admin)).rows;
    expect(rows.map((r) => `${r.action}:${r.ok}`)).toEqual(['login:true', 'create:true', 'create:true', 'create:false', 'find:true']);
    const all = JSON.stringify(rows);
    for (const secret of ['p@ss-secret', 'tok-1', 'rt-secret']) expect(all).not.toContain(secret);
  });

  it('providerFor sinvoice thiếu bí mật → lỗi cấu hình rõ ràng', () => {
    expect(() => providerFor({ code: 'sinvoice', base_url: 'http://x', username: 'u', secret: null, seller_tax_code: '1', options: {} })).toThrow(/mật khẩu/);
  });

  it('gói JSZip dùng được ở adapter', async () => { expect(typeof JSZip).toBe('function'); });
});
