import { useState } from 'react';
import { useHotkeys } from '@kt/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, DatePicker, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Khóa API cho phần mềm bán hàng (POS) gọi /api/ext/v1. Khóa đầy đủ chỉ hiện một lần lúc tạo; máy chủ chỉ giữ dấu vết băm.
interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; username: string; defaultWarehouseCode: string | null; postSales: boolean;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt: string; status: 'active' | 'revoked' | 'expired';
}
const SCOPE_LABEL: Record<string, string> = {
  'items.read': 'Đọc danh mục hàng hóa', 'stock.read': 'Đọc tồn kho', 'sales.write': 'Lập bán hàng và thu tiền', 'inbound_invoice.write': 'Gửi hóa đơn đầu vào (XML)',
};
const STATUS: Record<ApiKey['status'], { label: string; color: string }> = { active: { label: 'Hoạt động', color: 'green' }, revoked: { label: 'Đã thu hồi', color: 'red' }, expired: { label: 'Hết hạn', color: 'default' } };
const fmtTime = (t: string | null) => (t ? new Date(t).toLocaleString('vi-VN') : null);

function Copy({ label, value }: { label: string; value: string }) {
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input readOnly value={value} aria-label={label} />
      <Button onClick={() => { void navigator.clipboard?.writeText(value).then(() => message.success(`Đã chép ${label.toLowerCase()}`), () => message.error('Không chép được, hãy chọn và chép tay')); }}>Chép</Button>
    </Space.Compact>
  );
}

export default function ApiKeysPage() {
  const qc = useQueryClient(); const { can } = useAuth();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKey[]>('/api/api-keys') });
  const warehouses = useQuery({ queryKey: ['api-keys-warehouses'], queryFn: () => api<{ rows: { code: string; name: string }[] }>('/api/catalogs/warehouse?limit=200'), enabled: can('api_key.manage') });
  const [adding, setAdding] = useState(false); const [created, setCreated] = useState<{ key: string; prefix: string } | null>(null);
  const [form] = Form.useForm();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['api-keys'] });
  const fail = (e: Error) => void message.error(e.message);

  const create = useMutation({ mutationFn: (b: unknown) => api<{ id: string; key: string; prefix: string }>('/api/api-keys', { method: 'POST', json: b }), onError: fail,
    onSuccess: (r) => { setAdding(false); form.resetFields(); setCreated(r); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/api-keys/${id}/revoke`, { method: 'POST', json: {} }), onError: fail, onSuccess: () => { void message.success('Đã thu hồi khóa API'); refresh(); } });

  const submit = (v: { name: string; scopes: string[]; defaultWarehouseCode?: string; postSales?: boolean; expiresAt?: { endOf: (u: string) => { toISOString: () => string } } }) =>
    create.mutate({ name: v.name, scopes: v.scopes, postSales: !!v.postSales, ...(v.defaultWarehouseCode && { defaultWarehouseCode: v.defaultWarehouseCode }), ...(v.expiresAt && { expiresAt: v.expiresAt.endOf('day').toISOString() }) });

  const openAdd = () => { form.setFieldsValue({ scopes: ['items.read', 'stock.read'], postSales: false }); setAdding(true); };
  useHotkeys({ Insert: () => { if (can('api_key.manage') && !adding && !created) openAdd(); } });
  if (!can('api_key.manage')) return <Alert type="warning" showIcon message="Bạn không có quyền quản lý khóa API" />;
  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Khóa API</h2>
        <Button type="primary" onClick={openAdd}>Tạo khóa API (Insert)</Button>
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Khóa API cho phép phần mềm bán hàng gọi /api/ext/v1 với quyền của người tạo, thu hẹp theo phạm vi đã chọn. Khóa đầy đủ chỉ hiện một lần; mất khóa thì thu hồi và tạo khóa mới." />
      <Table<ApiKey> rowKey="id" size="small" loading={keys.isLoading} dataSource={keys.data ?? []} pagination={false} locale={{ emptyText: 'Chưa có khóa API nào' }}
        columns={[
          { title: 'Tên', dataIndex: 'name' },
          { title: 'Tiền tố', dataIndex: 'prefix', width: 130, render: (p: string) => <code>kt_{p}</code> },
          { title: 'Phạm vi', dataIndex: 'scopes', render: (s: string[]) => <Space size={[4, 4]} wrap>{s.map((x) => <Tag key={x}>{SCOPE_LABEL[x] ?? x}</Tag>)}</Space> },
          { title: 'Người dùng', dataIndex: 'username', width: 110 },
          { title: 'Kho mặc định', dataIndex: 'defaultWarehouseCode', width: 110, render: (w: string | null) => w ?? '–' },
          { title: 'Dùng gần nhất', dataIndex: 'lastUsedAt', width: 160, render: (t: string | null) => fmtTime(t) ?? <Tag>Chưa dùng</Tag> },
          { title: 'Hết hạn', dataIndex: 'expiresAt', width: 160, render: (t: string | null) => fmtTime(t) ?? '–' },
          { title: 'Trạng thái', dataIndex: 'status', width: 110, render: (s: ApiKey['status']) => <Tag color={STATUS[s].color}>{STATUS[s].label}</Tag> },
          { title: '', width: 100, render: (_, r) => r.status !== 'revoked' && (
            <Popconfirm title="Thu hồi khóa này?" description="Phần mềm đang dùng khóa sẽ bị từ chối ngay." okText="Thu hồi" cancelText="Không" onConfirm={() => revoke.mutate(r.id)}>
              <Button size="small" danger aria-label={`Thu hồi ${r.name}`}>Thu hồi</Button>
            </Popconfirm>) },
        ]} />

      <Modal title="Tạo khóa API" open={adding} okText="Tạo khóa" cancelText="Hủy" confirmLoading={create.isPending} destroyOnHidden onCancel={() => setAdding(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={submit} onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); form.submit(); } }}>
          <Form.Item label="Tên khóa" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên khóa' }]}><Input maxLength={100} placeholder="Ví dụ: POS quầy 1" /></Form.Item>
          <Form.Item label="Phạm vi" name="scopes" rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một phạm vi' }]}>
            <Checkbox.Group style={{ display: 'grid', gap: 4 }} options={Object.entries(SCOPE_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item label="Kho mặc định (cho bán hàng)" name="defaultWarehouseCode">
            <Select allowClear showSearch optionFilterProp="label" options={(warehouses.data?.rows ?? []).map((w) => ({ value: w.code, label: `${w.code} – ${w.name}` }))} />
          </Form.Item>
          <Form.Item label="Tự ghi sổ chứng từ bán hàng" name="postSales" valuePropName="checked" extra="Tắt thì chứng từ lập ở trạng thái nháp, kế toán duyệt sau."><Switch /></Form.Item>
          <Form.Item label="Ngày hết hạn (không bắt buộc)" name="expiresAt"><DatePicker format="DD/MM/YYYY" disabledDate={(d) => d.endOf('day').valueOf() < Date.now()} style={{ width: 180 }} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="Khóa API mới" open={!!created} footer={<Button type="primary" onClick={() => setCreated(null)}>Đã lưu, đóng</Button>} onCancel={() => setCreated(null)} destroyOnHidden width={640}>
        {created && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="warning" showIcon message="Khóa chỉ hiện một lần. Hãy chép và lưu vào cấu hình phần mềm bán hàng ngay." />
            <Descriptions column={1} size="small" layout="vertical">
              <Descriptions.Item label="Khóa API"><Copy label="Khóa API" value={created.key} /></Descriptions.Item>
            </Descriptions>
          </Space>)}
      </Modal>
    </div>
  );
}
