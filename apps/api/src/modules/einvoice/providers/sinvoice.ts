// Adapter Viettel SInvoice. Nguồn duy nhất: docs/dev/tich-hop/sinvoice.md (khảo cứu từ mã Odoo 18 và gói npm không chính thức; không có tài liệu chính thức của Viettel).
// CHƯA THỬ TRÊN MÔI TRƯỜNG THẬT: mọi tên trường, đường dẫn, mã lỗi dưới đây chỉ khớp tài liệu khảo cứu và máy chủ giả lập của kiểm thử.
// Mục "§" dưới đây là mục của tài liệu trên. Không dùng ctx.db (không giữ giao dịch DB khi gọi HTTP); mọi lời gọi qua httpJson với timeout cứng.
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { D } from '@kt/domain';
import { httpJson, redact } from '../../../lib/http.js';
import { ProviderError, PROVIDER_TIMEOUT_SEC, type EInvoiceDoc, type EInvoiceLine, type EInvoiceProvider, type IssueResult, type OriginalRef, type ProviderCtx } from './types.js';

export interface SInvoiceConfig { baseUrl: string; username: string; password: string; sellerTaxCode: string; timeoutMs?: number }

const API = '/services/einvoiceapplication/api/InvoiceAPI'; // §1
const SECRET_KEYS = ['password', 'access_token', 'refresh_token'];
const TOKEN_MARGIN_MS = 30_000; // §1: trừ biên an toàn khi tính hạn token
const tokens = new Map<string, { token: string; exp: number }>(); // cache theo (baseUrl, username, mật khẩu): cùng nhà cung cấp dùng chung giữa các lời gọi

const fail = (code: string, message: string, retriable = false) => new ProviderError(code, message, retriable);
const unsupported = (message: string) => fail('SINVOICE_UNSUPPORTED', message);

// §2: ngày là mili-giây epoch. Ngày 'YYYY-MM-DD' lấy 00:00 giờ Việt Nam (+07); nguồn không nói múi giờ (rủi ro đã ghi trong tài liệu).
const ms = (isoDate: string) => Date.parse(`${isoDate}T00:00:00+07:00`);
const vnDate = (epochMs: number) => new Date(epochMs + 7 * 3600_000).toISOString().slice(0, 10);

// Tiền là chuỗi thập phân; chỉ đổi sang số JSON ở biên tuần tự hóa vì JSON mẫu §3.8 dùng kiểu số. Quá 15 chữ số có nghĩa thì không biểu diễn chính xác được: từ chối.
const money = (s: string | null | undefined): number => {
  const d = D(s ?? 0);
  if (d.precision(true) > 15) throw fail('SINVOICE_AMOUNT_TOO_LARGE', `Số tiền ${d.toString()} vượt 15 chữ số có nghĩa, không gửi chính xác được sang SInvoice`);
  return d.toNumber();
};

// §6: -2 không chịu thuế (KCT), -1 không kê khai nộp thuế (KKKNT), còn lại phần trăm 0/5/8/10. Thứ tự -1/-2 theo chú thích Odoo, cần đối chiếu TT 78 (xem Quyết định).
function taxPct(rate: string): number {
  if (rate === 'KCT') return -2;
  if (rate === 'KKKNT') return -1;
  if (['0', '5', '8', '10'].includes(rate)) return Number(rate);
  throw fail('SINVOICE_UNSUPPORTED_TAX', `Thuế suất "${rate}" không có trong bảng ánh xạ SInvoice (0, 5, 8, 10, KCT, KKKNT)`);
}

const digits = (p: string | null | undefined) => (p ?? '').replace(/\+/g, '00').replace(/\D/g, ''); // §3.2

export class SInvoiceProvider implements EInvoiceProvider {
  readonly code = 'sinvoice' as const;
  readonly timeoutMs: number;
  constructor(private cfg: SInvoiceConfig) { this.timeoutMs = cfg.timeoutMs ?? PROVIDER_TIMEOUT_SEC * 1000; }

  private get tokenKey() { return `${this.cfg.baseUrl}|${this.cfg.username}|${createHash('sha256').update(this.cfg.password).digest('hex')}`; }

  // Một lời gọi HTTP có nhật ký. Nhật ký che password/token; tệp base64 chỉ ghi kích thước.
  private async send<T>(ctx: ProviderCtx, action: string, url: string, init: { headers?: Record<string, string>; body?: unknown }, logRequest: unknown) {
    const t0 = Date.now();
    const brief = (b: unknown) => (b && typeof b === 'object' && 'fileToBytes' in b ? { ...b, fileToBytes: `[${String((b as { fileToBytes: unknown }).fileToBytes ?? '').length} ký tự base64]` } : b);
    let r;
    try { r = await httpJson<T>(url, { method: 'POST', ...init, timeoutMs: this.timeoutMs }); } catch (e) {
      // Ghi nhật ký lỗi không được che lỗi HTTP gốc.
      await ctx.log({ action, request: redact(logRequest, SECRET_KEYS), response: null, httpStatus: null, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }).catch(() => undefined);
      throw e;
    }
    const err = this.errorOf(r.status, r.body);
    await ctx.log({ action, request: redact(logRequest, SECRET_KEYS), response: redact(brief(r.body ?? r.raw.slice(0, 500)), SECRET_KEYS), httpStatus: r.status, ok: !err, ...(err && { error: err.message }), ms: Date.now() - t0 });
    return { ...r, err };
  }

  // §1 "Phát hiện lỗi": HTTP không 2xx, `code`/`error` ở gốc (lỗi nền tảng), `errorCode` khác null/0 (lỗi nghiệp vụ; giá trị thành công chính xác không có trong nguồn). 5xx/429/body không phải JSON: tạm thời, thử lại.
  private errorOf(status: number, body: unknown): ProviderError | null {
    if (status === 401 || status === 403) return fail('SINVOICE_AUTH', 'SInvoice từ chối xác thực (sai tài khoản, mật khẩu hoặc token hết hạn)');
    if (status >= 500 || status === 429) return fail(`SINVOICE_HTTP_${status}`, `SInvoice tạm thời lỗi (HTTP ${status})`, true);
    if (body === null || typeof body !== 'object') return fail('SINVOICE_BAD_RESPONSE', `SInvoice trả nội dung không phải JSON (HTTP ${status})`, true);
    const b = body as Record<string, unknown>;
    if (b.code !== undefined || b.error !== undefined) return fail(String(b.code ?? b.error), String(b.data ?? b.error ?? b.description ?? 'Lỗi SInvoice'));
    if (status >= 400) return fail(`SINVOICE_HTTP_${status}`, `SInvoice từ chối yêu cầu (HTTP ${status})`);
    if (b.errorCode !== undefined && b.errorCode !== null && b.errorCode !== '' && b.errorCode !== 0 && b.errorCode !== '0') return fail(String(b.errorCode), String(b.description ?? b.errorCode));
    return null;
  }

  private async login(ctx: ProviderCtx): Promise<string> {
    const req = { username: this.cfg.username, password: this.cfg.password };
    const r = await this.send<{ access_token?: string; expires_in?: number }>(ctx, 'login', `${this.cfg.baseUrl}/auth/login`, { body: req }, req);
    if (r.err) throw r.err.retriable ? r.err : fail('SINVOICE_AUTH', r.err.message);
    const token = r.body?.access_token;
    if (!token) throw fail('SINVOICE_AUTH', 'SInvoice không trả access_token khi đăng nhập');
    tokens.set(this.tokenKey, { token, exp: Date.now() + Math.max(0, (r.body.expires_in ?? 300) * 1000 - TOKEN_MARGIN_MS) });
    return token;
  }

  private async token(ctx: ProviderCtx, force = false): Promise<string> {
    const c = tokens.get(this.tokenKey);
    return !force && c && c.exp > Date.now() ? c.token : this.login(ctx);
  }

  // Gọi nghiệp vụ. `json`: thân JSON; `query`: tham số form-urlencoded đặt ở query (cách Odoo, §2 ghi chú) với Content-Type form và thân rỗng.
  // Token gửi cả Bearer (NPM) lẫn cookie (Odoo) vì §1 chưa rõ endpoint nào nhận cách nào. 401: đăng nhập lại đúng một lần rồi gửi lại.
  private async call<T extends object>(ctx: ProviderCtx, action: string, path: string, req: { json?: unknown; query?: Record<string, string | number> }, lenient = false): Promise<T> {
    const qs = req.query ? `?${new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)]))}` : '';
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(ctx, attempt > 0);
      const r = await this.send<T>(ctx, action, `${this.cfg.baseUrl}${API}/${path}${qs}`, {
        headers: { authorization: `Bearer ${token}`, cookie: `access_token=${token}`, ...(req.query && { 'content-type': 'application/x-www-form-urlencoded' }) },
        ...(req.json !== undefined && { body: req.json }) }, req.json ?? req.query ?? null);
      if (r.status === 401 && attempt === 0) { tokens.delete(this.tokenKey); continue; }
      // tra cứu theo uuid: không có `result` nghĩa là chưa tạo (§4.2), không phải lỗi, kể cả khi errorCode có giá trị; lỗi nền tảng (code/error), 4xx, 5xx vẫn ném
      const platform = r.body && typeof r.body === 'object' && ('code' in r.body || 'error' in r.body);
      if (r.err && !(lenient && r.status < 400 && r.body && typeof r.body === 'object' && !platform)) throw r.err;
      return r.body;
    }
  }

  async ping(ctx: ProviderCtx) { await this.login(ctx); }

  private body(doc: EInvoiceDoc): Record<string, unknown> {
    const rel = doc.relation;
    const foreign = doc.currency !== 'VND';
    const decrease = rel.kind === 'adjustment' && rel.adjust === 'decrease';
    const increase = rel.kind === 'adjustment' && rel.adjust === 'increase';
    if (rel.kind === 'adjustment' && rel.adjust === 'info') throw unsupported('Điều chỉnh thông tin (adjustmentInvoiceType=2) chưa hỗ trợ: tài liệu SInvoice công khai không mô tả cách điền dòng hàng');
    const now = Date.now();
    const general: Record<string, unknown> = {
      transactionUuid: doc.transactionUuid, invoiceType: doc.formNo.split('/')[0]!, templateCode: doc.providerTemplate ?? doc.formNo, invoiceSeries: doc.serial,
      invoiceIssuedDate: now, // §3.1: thời điểm gọi, không phải ngày chứng từ (phải khớp thứ tự thời gian dãy số)
      currencyCode: doc.currency, ...(foreign && { exchangeRate: D(doc.fxRate).toFixed(2) }), // §3.1: tối đa 2 chữ số thập phân
      adjustmentType: rel.kind === 'original' ? '1' : rel.kind === 'replacement' ? '3' : '5',
      paymentStatus: false, cusGetInvoiceRight: true, validation: 1,
    };
    if (rel.kind !== 'original') {
      // §5.6, §5.7. Lý do không có trường riêng trong nguồn: đặt vào invoiceNote (xem Quyết định).
      Object.assign(general, { adjustmentInvoiceType: '1', originalInvoiceId: this.fullNo(rel.original), originalInvoiceIssueDate: this.issueMs(rel.original), originalTemplateCode: this.templateOf(rel.original),
        additionalReferenceDesc: rel.agreementNo ?? 'NA', additionalReferenceDate: rel.agreementDate ? ms(rel.agreementDate) : now, invoiceNote: rel.reason });
    }
    const item = (l: EInvoiceLine) => {
      if (l.kind === 'promotion') throw unsupported('Dòng khuyến mại chưa hỗ trợ: tài liệu SInvoice chỉ mô tả dòng hàng hóa (1), ghi chú (2), chiết khấu (3)');
      if (l.kind === 'note') return { selection: 2, itemName: l.name };
      const sign = decrease ? -1 : 1;
      const abs = (s: string | null) => D(s ?? 0).abs().toString();
      const qty = l.quantity ?? '1'; const price = l.unitPrice ?? l.amount;
      const afterDiscount = D(l.amount).minus(l.discountAmount).toString();
      return {
        selection: l.kind === 'discount' ? 3 : 1, itemCode: l.code ?? '', itemName: l.name.replace(/\r?\n/g, ' ').replace(/^(.{500}).+$/s, '$1...'), unitName: l.uom ?? 'Đơn vị', // §3.5
        unitPrice: l.kind === 'discount' ? money(abs(price)) : money(D(price).times(sign).toString()), quantity: l.kind === 'discount' ? money(abs(qty)) : money(qty),
        itemTotalAmountWithoutTax: money(abs(l.amount)), taxPercentage: taxPct(l.taxRate), taxAmount: money(abs(l.taxAmount)), discount: money(l.discountRate ?? '0'),
        itemTotalAmountAfterDiscount: money(abs(afterDiscount)), itemTotalAmountWithTax: money(abs(l.total)),
        // Dòng chiết khấu và mọi dòng điều chỉnh giảm: isIncreaseItem=false (§3.5, §5.6). Điều chỉnh tăng: true là SUY RA từ tên trường, KHÔNG có trong nguồn (§5.6, §8): cần kiểm khi có tài khoản thử.
        ...((l.kind === 'discount' || decrease) && { isIncreaseItem: false }), ...(increase && { isIncreaseItem: l.increase ?? true }),
        ...((decrease || increase) && { adjustmentTaxAmount: money(abs(l.taxAmount)) }),
      };
    };
    const t = doc.totals;
    return {
      generalInvoiceInfo: general,
      buyerInfo: { buyerName: doc.buyer.buyerName || doc.buyer.name, buyerLegalName: doc.buyer.name, buyerTaxCode: doc.buyer.taxCode ?? '', buyerAddressLine: doc.buyer.address ?? '', buyerPhoneNumber: digits(doc.buyer.phone),
        buyerEmail: doc.buyer.email ?? '', buyerCityName: '', buyerCountryCode: 'VN', buyerNotGetInvoice: 0, // buyerCityName: EInvoiceParty không có tỉnh/thành (Quyết định)
        ...(doc.buyer.bankAccount && { buyerBankAccount: doc.buyer.bankAccount, buyerBankName: doc.buyer.bankName ?? '' }) },
      sellerInfo: { sellerLegalName: doc.seller.name, sellerTaxCode: doc.seller.taxCode ?? this.cfg.sellerTaxCode, sellerAddressLine: doc.seller.address ?? '', sellerPhoneNumber: digits(doc.seller.phone),
        sellerEmail: doc.seller.email ?? '', sellerCountryCode: 'VN', ...(doc.seller.bankAccount && { sellerBankAccount: doc.seller.bankAccount, sellerBankName: doc.seller.bankName ?? '' }) },
      payments: [{ paymentMethodName: doc.paymentMethod }],
      itemInfo: doc.lines.map(item),
      taxBreakdowns: doc.taxGroups.map((g) => ({ taxPercentage: taxPct(g.taxRate), taxableAmount: money(D(g.base).abs().toString()), taxAmount: money(D(g.tax).abs().toString()), taxableAmountPos: !decrease, taxAmountPos: !decrease })),
      // Tổng lấy nguyên từ doc.totals để SInvoice không tự cộng lệch sổ cái (Odoo để SInvoice tự tính, §3: chọn khác có chủ đích, xem Quyết định).
      summarizeInfo: { sumOfTotalLineAmountWithoutTax: money(doc.lines.reduce((s, l) => s.plus(D(l.amount).abs()), D(0)).toString()), totalAmountWithoutTax: money(t.beforeTax), totalTaxAmount: money(t.tax),
        totalAmountWithTax: money(t.total), totalAmountWithTaxInWords: t.totalInWords },
    };
  }

  // providerRef do create/findByTransaction ghi; thiếu thì suy từ ký hiệu + số (invoiceNo của SInvoice gồm 6 ký tự ký hiệu, §4.1).
  private fullNo = (ref: OriginalRef) => String(ref.providerRef.invoiceNo ?? `${ref.serial}${ref.invoiceNo}`);
  private templateOf = (ref: OriginalRef) => String(ref.providerRef.templateCode ?? ref.formNo);
  private issueMs = (ref: OriginalRef) => Number(ref.providerRef.issueMs ?? ms(ref.issueDate));

  private result(doc: Pick<EInvoiceDoc, 'transactionUuid' | 'serial' | 'providerTemplate' | 'formNo'>, r: { invoiceNo: string; reservationCode?: string; codeOfTax?: string | null; issueMs: number; templateCode?: string }): IssueResult {
    const cqtCode = r.codeOfTax || null;
    return { invoiceNo: r.invoiceNo.startsWith(doc.serial) ? r.invoiceNo.slice(doc.serial.length) : r.invoiceNo, issueDate: vnDate(r.issueMs), cqtCode, cqtStatus: doc.serial.startsWith('C') ? (cqtCode ? 'accepted' : 'waiting') : 'none',
      providerRef: { invoiceNo: r.invoiceNo, templateCode: r.templateCode ?? doc.providerTemplate ?? doc.formNo, supplierTaxCode: this.cfg.sellerTaxCode, transactionUuid: doc.transactionUuid, reservationCode: r.reservationCode ?? null, issueMs: r.issueMs } };
  }

  async create(ctx: ProviderCtx, doc: EInvoiceDoc): Promise<IssueResult> {
    const body = this.body(doc);
    const issueMs = (body.generalInvoiceInfo as { invoiceIssuedDate: number }).invoiceIssuedDate;
    let r;
    try { r = await this.call<{ result?: { invoiceNo?: string; reservationCode?: string; codeOfTax?: string | null } }>(ctx, 'create', `InvoiceWS/createInvoice/${this.cfg.sellerTaxCode}`, { json: body }); } catch (e) {
      // §5.1 mục 5: SInvoice có thể từ chối transactionUuid trùng nhưng nguồn không nêu mã lỗi. Lỗi nghiệp vụ không thử lại: tra theo uuid một lần, đã có hóa đơn thì trả hóa đơn đó (không tạo thứ hai).
      if (e instanceof ProviderError && !e.retriable && e.code !== 'SINVOICE_AUTH') { const found = await this.findByTransaction(ctx, doc).catch(() => null); if (found) return found; }
      throw e;
    }
    if (!r.result?.invoiceNo) throw fail('SINVOICE_BAD_RESPONSE', 'SInvoice không trả số hóa đơn', true);
    return this.result(doc, { ...r.result, invoiceNo: r.result.invoiceNo, issueMs });
  }

  async findByTransaction(ctx: ProviderCtx, doc: Pick<EInvoiceDoc, 'transactionUuid' | 'seller' | 'serial' | 'providerTemplate' | 'formNo'>): Promise<IssueResult | null> {
    const r = await this.call<{ result?: Array<{ invoiceNo: string; reservationCode?: string; issueDate: number; templateCode?: string; codeOfTax?: string | null }> }>(ctx, 'find',
      'InvoiceWS/searchInvoiceByTransactionUuid', { query: { supplierTaxCode: this.cfg.sellerTaxCode, transactionUuid: doc.transactionUuid } }, true);
    const x = r.result?.[0];
    return x ? this.result(doc, { ...x, issueMs: x.issueDate }) : null; // §4.2: không có `result` = chưa tạo
  }

  async getFile(ctx: ProviderCtx, ref: OriginalRef, kind: 'pdf' | 'xml'): Promise<Buffer> {
    const r = await this.call<{ fileToBytes?: string }>(ctx, `file_${kind}`, 'InvoiceUtilsWS/getInvoiceRepresentationFile',
      { json: { supplierTaxCode: this.cfg.sellerTaxCode, templateCode: this.templateOf(ref), invoiceNo: this.fullNo(ref), fileType: kind === 'pdf' ? 'PDF' : 'ZIP' } });
    if (!r.fileToBytes) throw fail('SINVOICE_FILE_NOT_READY', 'SInvoice chưa tạo xong tệp hóa đơn, thử lại sau', true); // §4.3
    const bytes = Buffer.from(r.fileToBytes, 'base64');
    if (kind === 'pdf') return bytes;
    const xml = await findXml(await JSZip.loadAsync(bytes));
    if (!xml) throw fail('SINVOICE_NO_XML', 'Gói ZIP của SInvoice không chứa tệp XML');
    return xml;
  }

  // Nguồn không có API cấp mã CQT riêng: dùng exchangeStatus của tra cứu theo uuid (§4.2). Ký hiệu K không có mã.
  async refreshStatus(ctx: ProviderCtx, ref: OriginalRef) {
    if (!ref.serial.startsWith('C')) return { cqtCode: null, cqtStatus: 'none' as const };
    const uuid = ref.providerRef.transactionUuid as string | undefined;
    const r = uuid ? await this.call<{ result?: Array<{ exchangeStatus?: unknown; codeOfTax?: string | null }> }>(ctx, 'status', 'InvoiceWS/searchInvoiceByTransactionUuid', { query: { supplierTaxCode: this.cfg.sellerTaxCode, transactionUuid: uuid } }, true) : {};
    const x = (r as { result?: Array<{ exchangeStatus?: unknown; codeOfTax?: string | null }> }).result?.[0];
    return x?.exchangeStatus === 'INVOICE_HAS_CODE_APPROVED' ? { cqtCode: x.codeOfTax || null, cqtStatus: 'accepted' as const } : { cqtCode: null, cqtStatus: 'waiting' as const };
  }

  // §5.5. additionalReferenceDesc 'NA' (mặc định của Odoo); additionalReferenceDate = ngày hủy người dùng nhập.
  async cancel(ctx: ProviderCtx, ref: OriginalRef, reason: string, date: string) {
    await this.call(ctx, 'cancel', 'InvoiceWS/cancelTransactionInvoice', { query: { supplierTaxCode: this.cfg.sellerTaxCode, templateCode: this.templateOf(ref), invoiceNo: this.fullNo(ref),
      strIssueDate: this.issueMs(ref), additionalReferenceDesc: 'NA', additionalReferenceDate: ms(date), reasonDelete: reason } });
  }

  // §5.4: tra trạng thái trước (NOT_FOUND_DATA không phân biệt "đã khớp" với "không thấy"); chỉ gọi khi khác.
  async setPaid(ctx: ProviderCtx, ref: OriginalRef, paid: boolean) {
    const uuid = ref.providerRef.transactionUuid as string | undefined;
    if (uuid) {
      const r = await this.call<{ result?: Array<{ status?: string }> }>(ctx, 'find', 'InvoiceWS/searchInvoiceByTransactionUuid', { query: { supplierTaxCode: this.cfg.sellerTaxCode, transactionUuid: uuid } }, true);
      const cur = r.result?.[0]?.status;
      if (cur !== undefined && (cur !== 'Chưa thanh toán') === paid) return;
    }
    const base = { supplierTaxCode: this.cfg.sellerTaxCode, invoiceNo: this.fullNo(ref), strIssueDate: this.issueMs(ref) };
    await this.call(ctx, paid ? 'set_paid' : 'unset_paid', `InvoiceWS/${paid ? 'updatePaymentStatus' : 'cancelPaymentStatus'}`,
      { query: paid ? { ...base, templateCode: this.templateOf(ref) } : base });
  }
}

// §4.3: duyệt gói ngoài tìm *.xml, không có thì mở từng *.zip bên trong.
async function findXml(zip: JSZip): Promise<Buffer | null> {
  const files = Object.values(zip.files).filter((f) => !f.dir);
  const xml = files.find((f) => /\.xml$/i.test(f.name));
  if (xml) return xml.async('nodebuffer');
  for (const f of files.filter((x) => /\.zip$/i.test(x.name))) { const r = await findXml(await JSZip.loadAsync(await f.async('nodebuffer'))); if (r) return r; }
  return null;
}
