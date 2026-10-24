import { Alert } from 'antd';
import { Link } from '@tanstack/react-router';
import { formatVnDate } from '@kt/domain';
import { paramMissing } from './payrollCommon.js';

export const NO_SALARY = <Alert type="warning" showIcon message="Không có quyền xem lương" description="Màn hình này cần quyền xem lương của người quản trị." />;

// Lỗi từ API lương. Thiếu tham số pháp lý: nêu tham số, ngày hiệu lực và dẫn sang màn Tham số lương để nhập kèm nguồn văn bản.
export function PayrollErrorAlert({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  const miss = paramMissing(error);
  return (
    <Alert type="error" showIcon closable={!!onClose} {...(onClose ? { onClose } : {})} style={{ marginBottom: 12 }} message={(error as Error).message}
      description={miss && (<span>Thiếu tham số {miss.label ? <b>{miss.label}</b> : 'lương'}{miss.date ? ` hiệu lực ngày ${formatVnDate(miss.date)}` : ''}{miss.employeeCode ? ` (khi tính nhân viên ${miss.employeeCode})` : ''}.{' '}
        <Link to="/luong/tham-so">Mở màn Tham số lương để nhập</Link></span>)} />);
}
