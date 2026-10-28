import { z } from 'zod';
import { D } from '@kt/domain';

// Kết quả nhận diện hóa đơn: mỗi trường có giá trị (hoặc null) và độ tin cậy 0..1. Là dữ liệu nháp để người dùng soát; không tự tạo chứng từ.
export interface Field { value: string | null; confidence: number }
export interface RecognizedLine { name: Field; uom: Field; quantity: Field; unitPrice: Field; amount: Field; taxRate: Field }
export interface Party { name: Field; taxCode: Field; address: Field }
export interface RecognizedInvoice {
  provider: string; source: 'xml' | 'ocr' | 'mock';
  formNo: Field; serial: Field; invoiceNo: Field; issueDate: Field; currency: Field; seller: Party; buyer: Party; lines: RecognizedLine[];
  totals: { beforeTax: Field; tax: Field; total: Field };
  warnings: { code: string; message: string }[];
  // Còn trường thiếu hoặc độ tin cậy dưới ngưỡng, hoặc số liệu không khớp: người dùng phải soát trước khi dùng.
  needsReview: boolean;
}
export interface RecognizeInput { buffer: Buffer; fileName: string; kind: FileKind }
export type FileKind = 'xml' | 'pdf' | 'png' | 'jpeg';
// Giao diện bộ nhận diện: bộ XML (cục bộ), bộ giả lập (kiểm thử), bộ nhà cung cấp OCR/LLM (ngoài). external = true khi nội dung tệp rời máy chủ.
export interface InvoiceRecognizer {
  id: string; external: boolean;
  supports(kind: FileKind): boolean;
  recognize(input: RecognizeInput): Promise<RecognizedInvoice>;
}

export const REVIEW_THRESHOLD = 0.8;
export const MONEY_RE = /^-?\d{1,16}(\.\d{1,4})?$/;
const QTY_RE = /^-?\d{1,16}(\.\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAX_RE = /^\d{10}(-\d{3})?$/;
// eslint-disable-next-line no-control-regex -- loại ký tự điều khiển khỏi văn bản của nhà cung cấp ngoài
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const f = (value: string | null | undefined, confidence = 1): Field => (value === null || value === undefined || value === '' ? { value: null, confidence: 0 } : { value, confidence });

// Câu giống lệnh nằm trong hóa đơn là dữ liệu; chỉ cảnh báo để người soát chú ý, không bao giờ làm theo.
const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|the)\b|system\s*prompt|bỏ qua\s+(mọi\s+|các\s+)?(chỉ dẫn|hướng dẫn|lệnh)|<\s*\/?\s*(system|assistant|tool)\b|\bBEGIN\s+(SYSTEM|INSTRUCTIONS)/i;

const rawField = z.object({ value: z.union([z.string(), z.number()]).nullable().optional(), confidence: z.number().min(0).max(1).optional() }).strict();
const rawParty = z.object({ name: rawField.optional(), taxCode: rawField.optional(), address: rawField.optional() }).strict();
export const rawInvoice = z.object({
  formNo: rawField.optional(), serial: rawField.optional(), invoiceNo: rawField.optional(), issueDate: rawField.optional(), currency: rawField.optional(),
  seller: rawParty.optional(), buyer: rawParty.optional(),
  lines: z.array(z.object({ name: rawField.optional(), uom: rawField.optional(), quantity: rawField.optional(), unitPrice: rawField.optional(), amount: rawField.optional(), taxRate: rawField.optional() }).strict()).max(500).optional(),
  totals: z.object({ beforeTax: rawField.optional(), tax: rawField.optional(), total: rawField.optional() }).strict().optional(),
}).strict();

// Chuẩn hóa đầu ra của nhà cung cấp ngoài (không tin cậy): chỉ nhận đúng lược đồ, cắt độ dài, bỏ ký tự điều khiển, số tiền sai dạng thành null với độ tin cậy 0.
export function normalizeRaw(raw: unknown, provider: string, source: RecognizedInvoice['source']): RecognizedInvoice {
  const r = rawInvoice.parse(raw); const warnings: RecognizedInvoice['warnings'] = [];
  const clean = (x: z.infer<typeof rawField> | undefined, kind: 'text' | 'money' | 'qty' | 'date' | 'tax' | 'rate', max = 300): Field => {
    if (!x || x.value === null || x.value === undefined) return f(null);
    const s = String(x.value).replace(CTRL, '').trim().slice(0, max);
    if (!s) return f(null);
    if (INJECTION.test(s) && !warnings.some((w) => w.code === 'POSSIBLE_PROMPT_INJECTION')) warnings.push({ code: 'POSSIBLE_PROMPT_INJECTION', message: 'Văn bản trong tệp có câu giống chỉ dẫn cho máy: đã coi là dữ liệu, không làm theo; hãy soát kỹ' });
    const ok = kind === 'money' ? MONEY_RE.test(s) : kind === 'qty' ? QTY_RE.test(s) : kind === 'date' ? DATE_RE.test(s) : kind === 'tax' ? TAX_RE.test(s) : kind === 'rate' ? /^(\d{1,3}(\.\d{1,4})?|KCT|KKKNT|KHAC)$/i.test(s) : true;
    if (!ok) { warnings.push({ code: 'FIELD_FORMAT', message: `Giá trị "${s.slice(0, 40)}" sai dạng cho trường ${kind}: bỏ` }); return f(null); }
    return { value: s, confidence: Math.max(0, Math.min(1, x.confidence ?? 0.5)) };
  };
  const party = (p: z.infer<typeof rawParty> | undefined): Party => ({ name: clean(p?.name, 'text', 300), taxCode: clean(p?.taxCode, 'tax', 14), address: clean(p?.address, 'text', 500) });
  const out: RecognizedInvoice = {
    provider, source, formNo: clean(r.formNo, 'text', 20), serial: clean(r.serial, 'text', 20), invoiceNo: clean(r.invoiceNo, 'text', 20), issueDate: clean(r.issueDate, 'date'),
    currency: clean(r.currency, 'text', 3), seller: party(r.seller), buyer: party(r.buyer),
    lines: (r.lines ?? []).map((l) => ({ name: clean(l.name, 'text', 500), uom: clean(l.uom, 'text', 50), quantity: clean(l.quantity, 'qty'), unitPrice: clean(l.unitPrice, 'qty'), amount: clean(l.amount, 'money'), taxRate: clean(l.taxRate, 'rate', 10) })),
    totals: { beforeTax: clean(r.totals?.beforeTax, 'money'), tax: clean(r.totals?.tax, 'money'), total: clean(r.totals?.total, 'money') }, warnings, needsReview: false,
  };
  return finalize(out);
}

// Đối chiếu số học và đặt cờ soát: tổng thành tiền các dòng so với tổng trước thuế; trước thuế + thuế so với tổng; trường bắt buộc thiếu; độ tin cậy thấp.
export function finalize(inv: RecognizedInvoice): RecognizedInvoice {
  const lineSum = inv.lines.length && inv.lines.every((l) => l.amount.value !== null) ? inv.lines.reduce((a, l) => a.plus(D(l.amount.value!)), D(0)) : null;
  if (lineSum && inv.totals.beforeTax.value !== null && !lineSum.eq(inv.totals.beforeTax.value)) {
    inv.warnings.push({ code: 'TOTAL_MISMATCH', message: `Tổng thành tiền các dòng (${lineSum.toFixed()}) khác tổng tiền trước thuế (${inv.totals.beforeTax.value})` });
    inv.totals.beforeTax.confidence = Math.min(inv.totals.beforeTax.confidence, 0.3);
  }
  const { beforeTax, tax, total } = inv.totals;
  if (beforeTax.value !== null && tax.value !== null && total.value !== null && !D(beforeTax.value).plus(tax.value).eq(total.value)) {
    inv.warnings.push({ code: 'TOTAL_MISMATCH', message: 'Tiền trước thuế cộng tiền thuế khác tổng thanh toán' });
    total.confidence = Math.min(total.confidence, 0.3);
  }
  const required = [inv.serial, inv.invoiceNo, inv.issueDate, inv.seller.name, inv.seller.taxCode];
  const all = [inv.formNo, inv.serial, inv.invoiceNo, inv.issueDate, inv.currency, inv.seller.name, inv.seller.taxCode, inv.seller.address, inv.buyer.name, inv.buyer.taxCode, inv.totals.beforeTax, inv.totals.tax, inv.totals.total,
    ...inv.lines.flatMap((l) => [l.name, l.amount])];
  if (required.some((x) => x.value === null)) inv.warnings.push({ code: 'REQUIRED_MISSING', message: 'Thiếu ký hiệu, số, ngày hóa đơn hoặc thông tin người bán' });
  if (inv.lines.length === 0) inv.warnings.push({ code: 'NO_LINES', message: 'Không nhận được dòng hàng' });
  inv.needsReview = inv.warnings.length > 0 || required.some((x) => x.value === null) || all.some((x) => x.value !== null && x.confidence < REVIEW_THRESHOLD);
  return inv;
}
