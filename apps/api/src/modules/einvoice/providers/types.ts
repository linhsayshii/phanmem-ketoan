import type { Kysely } from 'kysely';
import type { Database } from '@kt/db';

// Mô hình hóa đơn trung lập: dữ liệu nhà cung cấp cần. Adapter chỉ ánh xạ EInvoiceDoc <-> API của mình.
// Tiền là chuỗi thập phân (VND nguyên, nguyên tệ tối đa 4 chữ số lẻ). `amount` của dòng là thành tiền trước chiết khấu, chưa thuế;
// `total` = amount - discountAmount + taxAmount. buildEInvoiceDoc hiện chỉ sinh dòng 'goods'.
export interface EInvoiceParty { name: string; taxCode: string | null; address: string | null; buyerName?: string | null; email?: string | null; phone?: string | null; bankAccount?: string | null; bankName?: string | null; idNo?: string | null }
export interface EInvoiceLine {
  lineNo: number; kind: 'goods' | 'promotion' | 'discount' | 'note'; code: string | null; name: string; uom: string | null; quantity: string | null; unitPrice: string | null;
  amount: string; discountRate: string | null; discountAmount: string;
  taxRate: string; // '0' | '5' | '8' | '10' | 'KCT' | 'KKKNT' | 'KHAC' (mã thuế không ánh xạ được: adapter báo lỗi)
  taxAmount: string; total: string; increase?: boolean;
}
export interface EInvoiceTaxGroup { taxRate: string; base: string; tax: string }
export interface OriginalRef { formNo: string; serial: string; invoiceNo: string; issueDate: string; providerRef: Record<string, unknown> }
export interface EInvoiceDoc {
  transactionUuid: string; formNo: string; serial: string; providerTemplate: string | null; issueDate: string; currency: string; fxRate: string; paymentMethod: string;
  seller: EInvoiceParty; buyer: EInvoiceParty; lines: EInvoiceLine[]; taxGroups: EInvoiceTaxGroup[];
  totals: { beforeTax: string; tax: string; discount: string; total: string; totalInWords: string };
  relation: { kind: 'original' }
    | { kind: 'adjustment'; adjust: 'increase' | 'decrease' | 'info'; original: OriginalRef; agreementNo?: string; agreementDate?: string; reason: string }
    | { kind: 'replacement'; original: OriginalRef; agreementNo?: string; agreementDate?: string; reason: string };
}
export interface IssueResult { invoiceNo: string; issueDate: string; cqtCode: string | null; cqtStatus: 'none' | 'waiting' | 'accepted' | 'rejected'; providerRef: Record<string, unknown> }
// Thông báo hóa đơn điện tử có sai sót (Task 8 bổ sung trường nếu nhà cung cấp cần).
export interface ErrorNoticeDoc { original: OriginalRef; kind: 'cancel' | 'adjust' | 'replace' | 'explain'; reason: string; noticeDate: string }

// Thời gian chờ tối đa một lời gọi nhà cung cấp (SInvoice 60 giây theo tài liệu): adapter thật đặt timeout bằng hằng này.
export const PROVIDER_TIMEOUT_SEC = 60;
// Một lần thử lại gồm tối đa hai lời gọi (findByTransaction + create) và hai giao dịch ngắn: trong khoảng này kể từ lần gửi trước,
// thử lại bị chặn (EINVOICE_BUSY) và worker không nhặt hàng, để hai lần gửi không chồng nhau.
export const RETRY_GUARD_SEC = 2 * PROVIDER_TIMEOUT_SEC + 30;

export class ProviderError extends Error {
  constructor(public code: string, message: string, public retriable: boolean) { super(message); }
}

export interface ProviderCtx {
  // Bộ thực thi dưới RLS của công ty. Chỉ nhà cung cấp `fake` dùng (kho giả lập einvoice_fake_store); adapter thật bỏ qua.
  db: Kysely<Database>;
  log(entry: { action: string; request: unknown; response: unknown; httpStatus: number | null; ok: boolean; error?: string; ms: number }): Promise<void>;
}

export interface EInvoiceProvider {
  readonly code: 'fake' | 'sinvoice';
  ping(ctx: ProviderCtx): Promise<void>;
  create(ctx: ProviderCtx, doc: EInvoiceDoc): Promise<IssueResult>;
  findByTransaction(ctx: ProviderCtx, doc: Pick<EInvoiceDoc, 'transactionUuid' | 'seller'>): Promise<IssueResult | null>;
  getFile(ctx: ProviderCtx, ref: OriginalRef, kind: 'pdf' | 'xml'): Promise<Buffer>;
  refreshStatus(ctx: ProviderCtx, ref: OriginalRef): Promise<Pick<IssueResult, 'cqtCode' | 'cqtStatus'>>;
  cancel?(ctx: ProviderCtx, ref: OriginalRef, reason: string, date: string): Promise<void>;
  setPaid?(ctx: ProviderCtx, ref: OriginalRef, paid: boolean): Promise<void>;
  sendErrorNotice?(ctx: ProviderCtx, notice: ErrorNoticeDoc): Promise<{ ref: string }>;
}

// Dòng nhà cung cấp truyền cho providerFor. Đăng nhập chỉ qua username/secret; `options` được GET trả nguyên văn nên không chứa bí mật.
export interface ProviderRow { code: string; base_url: string; username: string; secret: Buffer | null; seller_tax_code: string; options: unknown }
