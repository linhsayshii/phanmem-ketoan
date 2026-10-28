import { useEffect, useState } from 'react';
import { Alert, Button, Input, Space, Switch, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { useBranches } from './branchCommon.js';

interface Setting { perBranch: boolean; hqCode: string }

// Bật/tắt đánh số chứng từ theo chi nhánh (GĐ7 gói 3). Tắt (mặc định): một dãy số cho cả công ty. Bật: mỗi chi nhánh một dãy riêng, mã chi nhánh đứng trong số.
export function NumberingBranchPanel() {
  const { can } = useAuth(); const qc = useQueryClient(); const branches = useBranches();
  const q = useQuery({ queryKey: ['voucher-numbering'], queryFn: () => api<Setting>('/api/voucher-numbering/settings') });
  const [perBranch, setPerBranch] = useState(false); const [hqCode, setHqCode] = useState('TSC');
  useEffect(() => { if (q.data) { setPerBranch(!!q.data.perBranch); setHqCode(q.data.hqCode ?? 'TSC'); } }, [q.data]);
  const save = useMutation({ mutationFn: () => api('/api/voucher-numbering/settings', { method: 'PUT', json: { perBranch, hqCode: hqCode.trim() } }),
    onError: (e: Error) => void message.error(e.message),
    onSuccess: () => { void message.success('Đã lưu cách đánh số theo chi nhánh'); void qc.invalidateQueries({ queryKey: ['voucher-numbering'] }); void qc.invalidateQueries({ queryKey: ['next-no'] }); } });
  if (!branches.data?.rows?.length) return null; // công ty chưa khai báo chi nhánh: không có gì để tách
  const changed = !!q.data && (perBranch !== !!q.data.perBranch || (perBranch && hqCode.trim() !== (q.data.hqCode ?? 'TSC')));
  return (
    <Alert type="info" style={{ marginBottom: 12 }} message="Đánh số theo chi nhánh"
      description={<Space direction="vertical" size={8}>
        <span>Tắt: một dãy số chung cho cả công ty. Bật: mỗi chi nhánh một dãy số riêng bắt đầu từ 1 mỗi năm, số chứng từ có mã chi nhánh (đặt {'{BR}'} trong tiền tố để chọn vị trí, không đặt thì mã đứng đầu, vd. HN-PKT26-00001). Số đã cấp không đổi; muốn đồng bộ số cũ, dùng Đánh lại số theo ngày.</span>
        <Space wrap>
          <Switch aria-label="Đánh số theo chi nhánh" checked={perBranch} disabled={!can('setting.update')} onChange={setPerBranch} />
          <span>Bật đánh số theo chi nhánh</span>
          {perBranch && <><label htmlFor="hq-code">Mã trụ sở chính</label><Input id="hq-code" style={{ width: 120 }} maxLength={20} value={hqCode} disabled={!can('setting.update')} onChange={(e) => setHqCode(e.target.value)} /></>}
          {can('setting.update') && <Button type="primary" disabled={!changed} loading={save.isPending} onClick={() => save.mutate()}>Lưu cách đánh số</Button>}
        </Space>
      </Space>} />
  );
}
