import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export interface Branch { id: number; code: string; name: string; taxCode: string | null; parentCode: string | null; isActive: boolean; inScope: boolean }
export interface BranchList { headOffice: { inScope: boolean }; rows: Branch[] }
export const HO_LABEL = 'Trụ sở chính';

export function useBranches() {
  const { can } = useAuth();
  return useQuery({ queryKey: ['branches'], queryFn: () => api<BranchList>('/api/branches'), enabled: can('catalog.view') });
}
// Đơn vị trong phạm vi người dùng: 'HO' và id chi nhánh (chuỗi, để dùng thẳng làm tham số truy vấn `branch`).
export const unitOptions = (b: BranchList | undefined) => [
  ...(b?.headOffice.inScope ? [{ value: 'HO', label: HO_LABEL }] : []),
  ...(b?.rows ?? []).filter((r) => r.inScope).map((r) => ({ value: String(r.id), label: `${r.code} – ${r.name}` })),
];

// Bộ lọc chi nhánh của sổ sách/báo cáo: rỗng = mọi đơn vị trong phạm vi. Công ty chưa khai báo chi nhánh thì không hiện.
export function BranchFilter({ value, onChange }: { value: string; onChange(v: string): void }) {
  const b = useBranches();
  if (!b.data?.rows.length) return null;
  return <Select aria-label="Chi nhánh" style={{ width: 220 }} value={value} onChange={onChange}
    options={[{ value: '', label: 'Tất cả chi nhánh' }, ...unitOptions(b.data)]} />;
}
