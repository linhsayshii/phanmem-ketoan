import { normalizeRaw, type FileKind, type InvoiceRecognizer, type RecognizedInvoice } from './types.js';

// Bộ giả lập cho kiểm thử: trả kết quả dựng sẵn (đi qua cùng bước chuẩn hóa như bộ nhà cung cấp ngoài) và đếm số lần gọi.
// external có thể đặt true để kiểm đường gửi ra ngoài (cổng bật cài đặt, nhật ký) mà không gọi mạng.
export function mockRecognizer(raw: unknown, opts: { external?: boolean; kinds?: FileKind[] } = {}): InvoiceRecognizer & { calls: number } {
  const r = {
    id: 'mock', external: opts.external ?? false, calls: 0,
    supports: (k: FileKind) => (opts.kinds ?? ['pdf', 'png', 'jpeg']).includes(k),
    async recognize(): Promise<RecognizedInvoice> { r.calls++; return normalizeRaw(raw, 'mock', 'mock'); },
  };
  return r;
}
