import { Button } from 'antd';
import { EmptyState } from './EmptyState.js';
import { Section } from './Section.js';

// Trạng thái "công ty chưa có năm tài chính" dùng chung cho các màn cần chọn năm: nói rõ vì sao trống và chỉ cách làm.
// Không có quyền tạo kỳ thì chỉ dặn liên hệ quản trị, không hiện nút.
export interface NoFiscalYearProps {
  /** Người dùng có quyền `period.create`. */
  canCreate: boolean;
  /** Bấm "Thêm năm tài chính": trang gọi điều hướng tới Kỳ kế toán, hoặc mở hộp thoại nếu đang ở Kỳ kế toán. */
  onCreate?: () => void;
  /** Việc không làm được khi chưa có năm, nối vào câu hướng dẫn, ví dụ "nhập số dư đầu kỳ". */
  purpose?: string;
  /** Bỏ khung Section khi đã nằm trong một khối. */
  bare?: boolean;
  testId?: string;
}

export function NoFiscalYear({ canCreate, onCreate, purpose, bare, testId = 'no-fiscal-year' }: NoFiscalYearProps) {
  const need = purpose ? `Cần có năm tài chính để ${purpose}. ` : '';
  const description = canCreate
    ? `${need}Vào Kỳ kế toán và bấm "Thêm năm tài chính" để tạo năm đầu tiên.`
    : `${need}Bạn chưa có quyền tạo kỳ kế toán: liên hệ quản trị viên để thêm năm tài chính.`;
  const empty = (
    <EmptyState
      title="Công ty chưa có năm tài chính"
      description={description}
      testId={testId}
      action={canCreate && onCreate ? <Button type="primary" onClick={onCreate}>Thêm năm tài chính</Button> : undefined}
    />
  );
  return bare ? empty : <Section>{empty}</Section>;
}
