import { Modal, Tag, message } from 'antd';
import { ApiError } from '../api/client.js';

// Dùng chung cho màn hình hóa đơn điện tử và biểu mẫu hóa đơn: kiểu dữ liệu, thẻ trạng thái, hiển thị lỗi và cảnh báo của API.
export interface EInvoice {
  id: number; voucherId: string; voucherNo: string | null; voucherType: string; postingDate: string; seriesId: number; formNo: string; serial: string; relation: 'original' | 'adjustment' | 'replacement';
  originalId: number | null; status: 'draft' | 'sending' | 'issued' | 'failed' | 'replaced' | 'cancelled'; invoiceNo: string | null; issueDate: string | null; cqtCode: string | null; cqtStatus: string;
  errorCode: string | null; errorMessage: string | null; attempts: number; adjusted: boolean; needsReversal: boolean; paid: boolean; buyerName: string | null; total: string | null; currency: string | null; createdAt: string;
  warnings?: { code: string; message: string }[];
}
export interface EInvoiceLog { id: number; action: string; request: unknown; response: unknown; httpStatus: number | null; ok: boolean; error: string | null; ms: number; createdAt: string }
export interface Series { id: number; providerId: number; formNo: string; serial: string; year: number; kind: 'standard' | 'cash_register'; providerTemplate: string | null; isActive: boolean; note: string | null }

export const STATUS_LABEL: Record<string, string> = { draft: 'Nháp', sending: 'Đang gửi', issued: 'Đã phát hành', failed: 'Lỗi', replaced: 'Bị thay thế', cancelled: 'Đã hủy' };
const STATUS_COLOR: Record<string, string> = { draft: 'default', sending: 'processing', issued: 'green', failed: 'red', replaced: 'orange', cancelled: 'default' };
export const RELATION_LABEL: Record<string, string> = { original: 'Hóa đơn gốc', adjustment: 'Hóa đơn điều chỉnh', replacement: 'Hóa đơn thay thế' };
export const symbolOf = (e: Pick<EInvoice, 'formNo' | 'serial'>) => `${e.formNo}${e.serial}`;

// Hủy chỉ khi API cho phép (lifecycle.ts): hóa đơn gốc đang hiệu lực chưa bị điều chỉnh, ký hiệu K, hoặc ký hiệu C chưa được cấp mã.
export const canCancel = (e: EInvoice) => e.status === 'issued' && e.relation === 'original' && !e.adjusted && (e.serial.startsWith('K') || (e.serial.startsWith('C') && e.cqtStatus !== 'accepted'));
// Ký hiệu C chưa có mã của cơ quan thuế: điều chỉnh, thay thế phải tra mã trước.
export const cqtPending = (e: EInvoice) => e.serial.startsWith('C') && e.cqtStatus !== 'accepted';
// Hóa đơn còn hiệu lực pháp lý hoặc đang chờ xử lý: khóa "Bỏ ghi sổ" chứng từ.
export const isLive = (e: Pick<EInvoice, 'status' | 'needsReversal'> | null | undefined) => !!e && (['sending', 'issued', 'replaced', 'cancelled'].includes(e.status) || e.needsReversal);

export function StatusTags({ e }: { e: Pick<EInvoice, 'status' | 'cqtStatus' | 'serial' | 'needsReversal'> }) {
  const waiting = e.status === 'issued' && e.serial.startsWith('C') && e.cqtStatus !== 'accepted';
  return <>
    <Tag color={STATUS_COLOR[e.status] ?? 'default'} style={{ marginRight: 4 }}>{STATUS_LABEL[e.status] ?? e.status}</Tag>
    {waiting && <Tag color="gold" style={{ marginRight: 4 }}>Chờ mã CQT</Tag>}
    {e.needsReversal && <Tag color="red" style={{ marginRight: 0 }}>Cần đảo chứng từ gốc</Tag>}
  </>;
}

// Lỗi mồ côi (nhà cung cấp đã cấp số/hủy nhưng phần mềm đã ở trạng thái khác) phải đọc kỹ: hộp thoại, không phải thông báo tự tắt.
export function reportEInvoiceError(e: unknown) {
  if (e instanceof ApiError && e.code.startsWith('EINVOICE_ORPHAN')) { Modal.error({ title: 'Hóa đơn điện tử mồ côi: cần xử lý tay', content: e.message, width: 560 }); return; }
  void message.error({ content: e instanceof Error ? e.message : String(e), duration: 8 });
}
// Cảnh báo kèm kết quả thành công: ISSUE_DATE_DIFFERS_PERIOD, EINVOICE_REVERSAL_PENDING, EINVOICE_REVERSAL_FAILED.
export function showWarnings(r: { warnings?: { code: string; message: string }[] } | undefined) {
  for (const w of r?.warnings ?? []) void message.warning({ content: w.message, duration: 12 });
}
export const ORPHAN_ACTIONS = ['orphan_issued', 'orphan_cancelled'];
