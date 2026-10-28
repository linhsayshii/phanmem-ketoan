import { useEffect } from 'react';
import { Form, Select, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { HO_LABEL, unitOptions, useBranches, type BranchList } from './branchCommon.js';

type Unit = 'HO' | number;
export const unitValue = (u: Unit) => String(u);
export const unitLabel = (list: BranchList | undefined, u: Unit) => (u === 'HO' ? HO_LABEL : (list?.rows.find((r) => r.id === u)?.name ?? `Chi nhánh ${u}`));

// Ô "Chi nhánh" của chứng từ (GĐ7 gói 3). Công ty chưa khai báo chi nhánh thì không hiện.
// - Chứng từ mới: mặc định chi nhánh làm việc; `onPick` báo lựa chọn để form gắn sau khi lập (chỉ truyền khi khác chi nhánh làm việc).
// - Chứng từ nháp: đổi tại chỗ (PUT /api/vouchers/:id/branch), có nhật ký kiểm toán.
// - Chứng từ đã ghi sổ: chỉ xem (bỏ ghi sổ rồi mới đổi được).
export function VoucherBranchField({ voucherId, editable, onPick }: { voucherId: string | undefined; editable: boolean; onPick?(branch: Unit | undefined): void }) {
  const qc = useQueryClient(); const branches = useBranches();
  const working = useQuery({ queryKey: ['me-branch'], queryFn: () => api<{ working: Unit }>('/api/me/branch') });
  const current = useQuery({ queryKey: ['voucher-branch', voucherId], queryFn: () => api<{ branch: Unit }>(`/api/vouchers/${voucherId}/branch`), enabled: !!voucherId });
  const form = Form.useFormInstance();
  const change = useMutation({ mutationFn: (branch: Unit) => api(`/api/vouchers/${voucherId}/branch`, { method: 'PUT', json: { branch } }),
    onError: (e: Error) => { void message.error(e.message); void qc.invalidateQueries({ queryKey: ['voucher-branch', voucherId] }); },
    onSuccess: () => { void message.success('Đã đổi chi nhánh của chứng từ'); void qc.invalidateQueries({ queryKey: ['voucher-branch', voucherId] }); void qc.invalidateQueries({ queryKey: ['vouchers'] }); } });
  const value = voucherId ? current.data?.branch : working.data?.working;
  useEffect(() => { if (!voucherId && value !== undefined) form.setFieldValue('branchUnit', unitValue(value)); }, [voucherId, value, form]);
  if (!branches.data?.rows?.length) return null;
  const options = unitOptions(branches.data);
  if (voucherId && !editable) return <Form.Item label="Chi nhánh"><Tag data-testid="voucher-branch">{value === undefined ? '…' : unitLabel(branches.data, value)}</Tag></Form.Item>;
  return (
    <Form.Item label="Chi nhánh" name={voucherId ? undefined : 'branchUnit'}>
      <Select aria-label="Chi nhánh của chứng từ" options={options} loading={change.isPending} {...(voucherId ? { value: value === undefined ? undefined : unitValue(value) } : {})}
        onChange={(v: string) => {
          const unit: Unit = v === 'HO' ? 'HO' : Number(v);
          if (voucherId) change.mutate(unit);
          else onPick?.(unit === working.data?.working ? undefined : unit);
        }} />
    </Form.Item>
  );
}
