import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, Button, DatePicker, Form, Input, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export interface Delegation {
  id: number; delegatorId: string; delegator: string; delegateId: string; delegate: string; dateFrom: string; dateTo: string; reason: string | null;
  status: 'active' | 'upcoming' | 'expired' | 'revoked';
}
export const DELEGATION_STATUS: Record<Delegation['status'], { label: string; color: string }> = {
  active: { label: 'Đang hiệu lực', color: 'green' }, upcoming: { label: 'Chưa tới ngày', color: 'blue' }, expired: { label: 'Hết hạn', color: 'default' }, revoked: { label: 'Đã thu hồi', color: 'red' },
};
const fmt = (d: string) => dayjs(d).format('DD/MM/YYYY');
const fail = (e: Error) => void message.error(e.message);

// Ủy quyền duyệt khi vắng mặt (GĐ7): người duyệt giao các bước của mình cho người khác trong khoảng ngày; người được ủy quyền duyệt "thay" và nhật ký ghi cả hai.
export default function ApprovalDelegationsPage() {
  const { can, me } = useAuth(); const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [form] = Form.useForm<{ delegateId: string; range: [dayjs.Dayjs, dayjs.Dayjs]; reason?: string }>();
  const list = useQuery({ queryKey: ['approval-delegations', all], queryFn: () => api<Delegation[]>(`/api/approval-delegations?scope=${all ? 'all' : 'mine'}`), enabled: can('approval_request.approve') });
  const candidates = useQuery({ queryKey: ['approval-delegations', 'candidates'], queryFn: () => api<{ id: string; username: string; fullName: string }[]>('/api/approval-delegations/candidates'), enabled: can('approval_request.approve') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['approval-delegations'] });
  const create = useMutation({
    mutationFn: (v: { delegateId: string; range: [dayjs.Dayjs, dayjs.Dayjs]; reason?: string | undefined }) =>
      api('/api/approval-delegations', { method: 'POST', json: { delegateId: v.delegateId, dateFrom: v.range[0].format('YYYY-MM-DD'), dateTo: v.range[1].format('YYYY-MM-DD'), ...(v.reason?.trim() ? { reason: v.reason.trim() } : {}) } }),
    onError: fail, onSuccess: () => { void message.success('Đã lập ủy quyền'); form.resetFields(); refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: number) => api(`/api/approval-delegations/${id}/revoke`, { method: 'POST', json: {} }), onError: fail, onSuccess: () => { void message.success('Đã thu hồi ủy quyền'); refresh(); } });
  if (!can('approval_request.approve')) return <Alert type="warning" showIcon message="Cần quyền duyệt đề nghị để lập ủy quyền duyệt" />;
  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        <h2 style={{ margin: 0 }}>Ủy quyền duyệt</h2>
        {can('setting.update') && <Space>Xem mọi ủy quyền của công ty <Switch aria-label="Xem mọi ủy quyền" checked={all} onChange={setAll} /></Space>}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Khi vắng mặt, ủy quyền cho người khác duyệt thay các bước của bạn trong khoảng ngày."
        description="Người được ủy quyền vẫn phải có quyền duyệt và quyền xem số liệu của chính họ. Không duyệt thay đề nghị do bạn lập, không duyệt hai bước của cùng một đề nghị, không ủy quyền vòng. Nhật ký ghi cả người duyệt thay và người ủy quyền." />
      <Form form={form} layout="inline" onFinish={(v) => create.mutate(v)} style={{ marginBottom: 16, rowGap: 8 }}>
        <Form.Item name="delegateId" label="Người được ủy quyền" rules={[{ required: true, message: 'Chọn người được ủy quyền' }]}>
          <Select aria-label="Người được ủy quyền" style={{ width: 260 }} showSearch optionFilterProp="label" loading={candidates.isLoading} placeholder="Chọn người"
            options={(candidates.data ?? []).map((u) => ({ value: u.id, label: `${u.fullName || u.username} (${u.username})` }))} />
        </Form.Item>
        <Form.Item name="reason" label="Lý do"><Input aria-label="Lý do ủy quyền" maxLength={500} style={{ width: 220 }} placeholder="Đi công tác, nghỉ phép…" /></Form.Item>
        <Form.Item name="range" label="Từ ngày – đến ngày" rules={[{ required: true, message: 'Chọn khoảng ngày' }]}>
          <DatePicker.RangePicker aria-label="Khoảng ngày ủy quyền" format="DD/MM/YYYY" disabledDate={(d) => d.isBefore(dayjs(), 'day')} />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit" loading={create.isPending}>Ủy quyền</Button></Form.Item>
      </Form>
      <Table<Delegation> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa có ủy quyền nào' }}
        columns={[
          { title: 'Người ủy quyền', dataIndex: 'delegator', width: 150 },
          { title: 'Người được ủy quyền', dataIndex: 'delegate', width: 170 },
          { title: 'Từ ngày', dataIndex: 'dateFrom', width: 110, render: fmt },
          { title: 'Đến ngày', dataIndex: 'dateTo', width: 110, render: fmt },
          { title: 'Lý do', dataIndex: 'reason', ellipsis: true },
          { title: 'Trạng thái', dataIndex: 'status', width: 140, render: (s: Delegation['status']) => <Tag color={DELEGATION_STATUS[s].color}>{DELEGATION_STATUS[s].label}</Tag> },
          { title: '', width: 110, render: (_, d) => (d.status === 'active' || d.status === 'upcoming') && (d.delegatorId === me?.userId || can('setting.update')) && (
            <Popconfirm title="Thu hồi ủy quyền này?" okText="Thu hồi" cancelText="Không" onConfirm={() => revoke.mutate(d.id)}>
              <Button size="small" danger aria-label={`Thu hồi ủy quyền cho ${d.delegate}`}>Thu hồi</Button>
            </Popconfirm>) },
        ]} />
    </div>
  );
}
