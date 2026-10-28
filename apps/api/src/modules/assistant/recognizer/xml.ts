import { parseInvoiceXml, stripBom } from '../../inbound/parseXml.js';
import { f, finalize, type FileKind, type InvoiceRecognizer, type RecognizedInvoice } from './types.js';

// Bộ nhận diện XML hóa đơn điện tử theo QĐ 1233: tái dùng bộ phân tích GĐ5 (chặn DOCTYPE/ENTITY, 2 MB, độ sâu, ký tự điều khiển, đánh tráo nội dung). Cục bộ, không gửi đi đâu.
// Độ tin cậy 1 cho trường đọc được từ XML; số liệu hỏng (blocked) hạ về 0,3 để buộc soát.
export const xmlRecognizer: InvoiceRecognizer = {
  id: 'xml', external: false,
  supports: (k: FileKind) => k === 'xml',
  async recognize({ buffer }) {
    const p = parseInvoiceXml(stripBom(buffer.toString('utf8')));
    const c = p.blocked ? 0.3 : 1;
    const out: RecognizedInvoice = {
      provider: 'xml', source: 'xml',
      formNo: f(p.formNo), serial: f(p.serial), invoiceNo: f(p.invoiceNo), issueDate: f(p.issueDate), currency: f(p.currency),
      seller: { name: f(p.seller.name), taxCode: f(p.seller.taxCode), address: f(p.seller.address) },
      buyer: { name: f(p.buyer.name), taxCode: f(p.buyer.taxCode), address: f(p.buyer.address) },
      lines: p.lines.filter((l) => l.kind !== 'note').map((l) => ({ name: f(l.name), uom: f(l.uom), quantity: f(l.quantity), unitPrice: f(l.unitPrice), amount: f(l.amount, c), taxRate: f(l.taxRate) })),
      totals: { beforeTax: f(p.totals.beforeTax, c), tax: f(p.totals.tax, c), total: f(p.totals.total, c) },
      warnings: p.warnings.map((w) => ({ code: w.code, message: w.message })), needsReview: false,
    };
    if (p.blocked) out.warnings.push({ code: 'BLOCKED', message: 'Hóa đơn có số liệu hỏng (xem cảnh báo): không dùng được cho đến khi soát' });
    for (const [who, s] of [['người bán', p.signatures.seller], ['cơ quan thuế', p.signatures.cqt]] as const) {
      if (s && !s.valid) out.warnings.push({ code: 'SIGNATURE_INVALID', message: `Chữ ký ${who} không hợp lệ${s.reason ? `: ${s.reason}` : ''}` });
    }
    return finalize(out);
  },
};
