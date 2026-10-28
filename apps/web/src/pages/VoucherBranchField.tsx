import { useEffect, useState } from 'react';
import { Form, Select, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { HO_LABEL, unitOptions, useBranches, type BranchList } from './branchCommon.js';

type Unit = 'HO' | number;
export const unitValue = (u: Unit) => String(u);
export const unitLabel = (list: BranchList | undefined, u: Unit) => (u === 'HO' ? HO_LABEL : (list?.rows.find((r) => r.id === u)?.name ?? `Chi nhánh ${u}`));

// Ô "Chi nhánh" của chứng từ (GĐ7 gói 3). Công ty chưa khai báo chi nhánh thì không hiện.
// - Chứng từ mới: mặc định chi nhánh làm việc. Chứng từ nháp: mặc định chi nhánh hiện tại của chứng từ.
// - Chọn khác chi nhánh gốc thì báo `onPick(chi nhánh)`, chọn lại chi nhánh gốc thì `onPick(undefined)`; form gắn chi nhánh khi lưu
//   (đổi chi nhánh làm tăng phiên bản chứng từ nên phải sau lần lưu nội dung, không tách riêng gây VERSION_CONFLICT hoặc mất phần đang nhập).
// - Chứng từ đã ghi sổ: chỉ xem (bỏ ghi sổ rồi mới đổi được).
export function VoucherBranchField({ voucherId, editable, onPick }: { voucherId: string | undefined; editable: boolean; onPick?(branch: Unit | undefined): void }) {
  const branches = useBranches();
  const working = useQuery({ queryKey: ['me-branch'], queryFn: () => api<{ working: Unit }>('/api/me/branch') });
  const current = useQuery({ queryKey: ['voucher-branch', voucherId], queryFn: () => api<{ branch: Unit }>(`/api/vouchers/${voucherId}/branch`), enabled: !!voucherId });
  const [local, setLocal] = useState<Unit | undefined>();
  const base = voucherId ? current.data?.branch : working.data?.working;
  useEffect(() => { setLocal(undefined); }, [base, voucherId]); // đã lưu và tải lại, hoặc chuyển sang chứng từ khác: bỏ lựa chọn tạm
  if (!branches.data?.rows?.length) return null;
  const shown = local ?? base;
  if (voucherId && !editable) return <Form.Item label="Chi nhánh"><Tag data-testid="voucher-branch">{shown === undefined ? '…' : unitLabel(branches.data, shown)}</Tag></Form.Item>;
  return (
    <Form.Item label="Chi nhánh">
      <Select aria-label="Chi nhánh của chứng từ" options={unitOptions(branches.data)} value={shown === undefined ? null : unitValue(shown)}
        onChange={(v: string) => { const unit: Unit = v === 'HO' ? 'HO' : Number(v); setLocal(unit); onPick?.(unit === base ? undefined : unit); }} />
    </Form.Item>
  );
}
