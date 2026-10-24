import { Alert } from 'antd';
import { Link } from '@tanstack/react-router';
import { formatVnDate } from '@kt/domain';
import { ApiError } from '../api/client.js';
import { paramMissing } from './payrollCommon.js';

const PAY_KIND_LABEL: Record<string, string> = { pay: 'Chi lương', insurance: 'Nộp bảo hiểm', pit: 'Nộp thuế TNCN' };
// Chứng từ chi đã ghi sổ chặn hủy hạch toán, chạy lại hạch toán bảng lương (409 PAYROLL_PAYMENT_POSTED, details.vouchers).
function postedPayments(e: unknown): { kind: string; voucherNo: string | null }[] | null {
  if (!(e instanceof ApiError) || e.code !== 'PAYROLL_PAYMENT_POSTED') return null;
  return ((e.details as { vouchers?: { kind: string; voucherNo: string | null }[] } | undefined)?.vouchers) ?? [];
}

export const NO_SALARY = <Alert type="warning" showIcon message="Không có quyền xem lương" description="Màn hình này cần quyền xem lương của người quản trị." />;

// Lỗi từ API lương. Thiếu tham số pháp lý: nêu tham số, ngày hiệu lực và dẫn sang màn Tham số lương để nhập kèm nguồn văn bản.
export function PayrollErrorAlert({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  const miss = paramMissing(error); const posted = postedPayments(error);
  return (
    <Alert type="error" showIcon closable={!!onClose} {...(onClose ? { onClose } : {})} style={{ marginBottom: 12 }} message={(error as Error).message}
      description={posted ? (<ul style={{ margin: 0, paddingLeft: 18 }} data-testid="posted-payments">{posted.map((v) => <li key={`${v.kind}-${v.voucherNo}`}>{PAY_KIND_LABEL[v.kind] ?? v.kind} {v.voucherNo ?? '(chưa có số)'}: bỏ ghi sổ hoặc đảo chứng từ này ở màn Chứng từ rồi làm lại</li>)}</ul>) : miss && (<span>Thiếu tham số {miss.label ? <b>{miss.label}</b> : 'lương'}{miss.date ? ` hiệu lực ngày ${formatVnDate(miss.date)}` : ''}{miss.employeeCode ? ` (khi tính nhân viên ${miss.employeeCode})` : ''}.{' '}
        <Link to="/luong/tham-so">Mở màn Tham số lương để nhập</Link></span>)} />);
}
