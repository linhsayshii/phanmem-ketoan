import { useNavigate } from '@tanstack/react-router';
import { NoFiscalYear } from '@kt/ui';
import { useAuth } from '../auth.js';

// Gắn NoFiscalYear với quyền `period.create` và điều hướng tới Kỳ kế toán; `onCreate` thay cho điều hướng khi trang đã là Kỳ kế toán.
export function NoFiscalYearNotice({ purpose, onCreate, bare }: { purpose?: string; onCreate?: () => void; bare?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  return <NoFiscalYear canCreate={can('period.create')} purpose={purpose} bare={bare}
    onCreate={onCreate ?? (() => void navigate({ to: '/so-cai/ky-ke-toan' }))} />;
}
