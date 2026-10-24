import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import { formatVnDate } from '@kt/domain';
import { useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { useBankAccounts } from './BankTransactions.js';

// Kết nối ngân hàng (webhook SePay / Casso) và mẫu cột sao kê Excel. Khóa/bí mật chỉ hiện một lần lúc tạo hoặc đổi mã.
interface Feed { id: number; bankAccountId: number; provider: 'sepay' | 'casso'; authKind: 'hmac' | 'apikey'; hasSecret: boolean; hasApiKey: boolean; isActive: boolean; lastReceivedAt: string | null; createdAt: string }
interface FeedSecret extends Feed { webhookUrl: string; apiKey?: string; secret?: string }
interface Format {
  id: number; name: string; bankCode: string | null; headerRow: number; sheetIndex: number; dateCol: string; dateFormat: string; descriptionCol: string;
  amountInCol: string | null; amountOutCol: string | null; signedAmountCol: string | null; referenceCol: string | null; balanceCol: string | null;
}
const PROVIDER = { sepay: 'SePay', casso: 'Casso' } as const;
const AUTH = { hmac: 'Chữ ký HMAC', apikey: 'Khóa API' } as const;
const DATE_FORMATS = ['dd/MM/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'excel'];
const COLS: [keyof Format, string][] = [['dateCol', 'Cột ngày'], ['descriptionCol', 'Cột diễn giải'], ['amountInCol', 'Cột ghi có'], ['amountOutCol', 'Cột ghi nợ'], ['signedAmountCol', 'Cột số tiền có dấu'], ['referenceCol', 'Cột tham chiếu'], ['balanceCol', 'Cột số dư']];

function Copy({ label, value }: { label: string; value: string }) {
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input readOnly value={value} aria-label={label} />
      <Button onClick={() => { void navigator.clipboard?.writeText(value).then(() => message.success(`Đã chép ${label.toLowerCase()}`), () => message.error('Không chép được, hãy chọn và chép tay')); }}>Chép</Button>
    </Space.Compact>
  );
}

export default function BankFeedsPage() {
  const qc = useQueryClient(); const { can } = useAuth();
  const accounts = useBankAccounts();
  const accLabel = (id: number) => { const a = accounts.data?.find((x) => x.id === id); return a ? `${a.account_no}${a.account_name ? ` – ${a.account_name}` : ''}` : String(id); };
  const feeds = useQuery({ queryKey: ['bank-feeds'], queryFn: () => api<Feed[]>('/api/bank-feeds') });
  const formats = useQuery({ queryKey: ['bank-formats'], queryFn: () => api<Format[]>('/api/bank-statement-formats') });
  const [secret, setSecret] = useState<FeedSecret | null>(null);
  const [adding, setAdding] = useState(false); const [fmt, setFmt] = useState<Partial<Format> | null>(null);
  const [form] = Form.useForm(); const [fmtForm] = Form.useForm();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['bank-feeds'] }); void qc.invalidateQueries({ queryKey: ['bank-formats'] }); };
  const fail = (e: Error) => void message.error(e.message);

  const create = useMutation({ mutationFn: (b: unknown) => api<FeedSecret>('/api/bank-feeds', { method: 'POST', json: b }), onError: fail,
    onSuccess: (r) => { setAdding(false); form.resetFields(); setSecret(r); refresh(); } });
  const rotate = useMutation({ mutationFn: (id: number) => api<FeedSecret>(`/api/bank-feeds/${id}/rotate`, { method: 'POST', json: {} }), onError: fail, onSuccess: (r) => { setSecret(r); refresh(); } });
  const toggle = useMutation({ mutationFn: (p: { id: number; isActive: boolean }) => api(`/api/bank-feeds/${p.id}`, { method: 'PUT', json: { isActive: p.isActive } }), onError: fail, onSuccess: refresh });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/bank-feeds/${id}`, { method: 'DELETE' }), onError: fail, onSuccess: () => { void message.success('Đã xóa kết nối'); refresh(); } });
  const saveFmt = useMutation({ mutationFn: (b: Record<string, unknown>) => api(fmt?.id ? `/api/bank-statement-formats/${fmt.id}` : '/api/bank-statement-formats', { method: fmt?.id ? 'PUT' : 'POST', json: b }), onError: fail,
    onSuccess: () => { setFmt(null); void message.success('Đã lưu mẫu cột sao kê'); refresh(); } });
  const delFmt = useMutation({ mutationFn: (id: number) => api(`/api/bank-statement-formats/${id}`, { method: 'DELETE' }), onError: fail, onSuccess: refresh });

  const canUpdate = can('bank_feed.update');
  const openAdd = () => { form.setFieldsValue({ provider: 'sepay', authKind: 'hmac' }); setAdding(true); };
  useHotkeys({ Insert: () => { if (can('bank_feed.create') && !adding && !fmt && !secret) openAdd(); } });
  const openFmt = (f: Partial<Format>) => { fmtForm.resetFields(); fmtForm.setFieldsValue({ headerRow: 1, sheetIndex: 0, dateFormat: 'dd/MM/yyyy', ...f }); setFmt(f); };
  const submitFmt = (v: Record<string, unknown>) => saveFmt.mutate(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x])));

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Kết nối ngân hàng</h2>
        {can('bank_feed.create') && <Button type="primary" onClick={openAdd}>Thêm kết nối (Insert)</Button>}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Dán địa chỉ webhook và khóa vào trang cấu hình SePay hoặc Casso. Khóa chỉ hiện một lần khi tạo hoặc đổi mã; mất khóa thì đổi mã mới." />
      <Table<Feed> rowKey="id" size="small" loading={feeds.isLoading} dataSource={feeds.data ?? []} pagination={false} locale={{ emptyText: 'Chưa có kết nối nào' }}
        columns={[
          { title: 'Tài khoản ngân hàng', dataIndex: 'bankAccountId', render: (id: number) => accLabel(id) },
          { title: 'Nhà cung cấp', dataIndex: 'provider', width: 120, render: (p: Feed['provider']) => PROVIDER[p] },
          { title: 'Xác thực', dataIndex: 'authKind', width: 130, render: (a: Feed['authKind']) => AUTH[a] },
          { title: 'Nhận gần nhất', dataIndex: 'lastReceivedAt', width: 150, render: (t: string | null) => (t ? formatVnDate(t.slice(0, 10)) : <Tag>Chưa nhận</Tag>) },
          { title: 'Hoạt động', dataIndex: 'isActive', width: 100, render: (a: boolean, r) => <Switch checked={a} disabled={!canUpdate} aria-label={`Hoạt động kết nối ${r.id}`} onChange={(isActive) => toggle.mutate({ id: r.id, isActive })} /> },
          { title: '', width: 220, render: (_, r) => (
            <Space>
              {canUpdate && <Popconfirm title="Đổi mã mới?" description="Mã cũ ngừng dùng được ngay; phải cập nhật lại bên SePay/Casso." okText="Đổi mã" cancelText="Không" onConfirm={() => rotate.mutate(r.id)}><Button size="small">Đổi mã</Button></Popconfirm>}
              {can('bank_feed.delete') && <Popconfirm title="Xóa kết nối này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><Button size="small" danger>Xóa</Button></Popconfirm>}
            </Space>) },
        ]} />

      <Space style={{ width: '100%', justifyContent: 'space-between', margin: '24px 0 12px' }}>
        <h3 style={{ margin: 0 }}>Mẫu cột sao kê</h3>
        {canUpdate && <Button onClick={() => openFmt({})}>Thêm mẫu</Button>}
      </Space>
      <Table<Format> rowKey="id" size="small" loading={formats.isLoading} dataSource={formats.data ?? []} pagination={false} locale={{ emptyText: 'Chưa có mẫu cột sao kê' }}
        columns={[
          { title: 'Tên mẫu', dataIndex: 'name' }, { title: 'Ngân hàng', dataIndex: 'bankCode', width: 110 },
          { title: 'Dòng tiêu đề', dataIndex: 'headerRow', width: 110, align: 'right' }, { title: 'Ngày', dataIndex: 'dateCol', width: 70 },
          { title: 'Diễn giải', dataIndex: 'descriptionCol', width: 90 },
          { title: 'Ghi có / Ghi nợ / Có dấu', width: 170, render: (_, r) => [r.amountInCol, r.amountOutCol, r.signedAmountCol].map((c) => c ?? '–').join(' / ') },
          { title: '', width: 150, render: (_, r) => canUpdate && (
            <Space><Button size="small" onClick={() => openFmt(r)}>Sửa</Button>
              <Popconfirm title="Xóa mẫu này?" okText="Xóa" cancelText="Không" onConfirm={() => delFmt.mutate(r.id)}><Button size="small" danger>Xóa</Button></Popconfirm></Space>) },
        ]} />

      <Modal title="Thêm kết nối ngân hàng" open={adding} okText="Tạo kết nối" cancelText="Hủy" confirmLoading={create.isPending} destroyOnHidden onCancel={() => setAdding(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); form.submit(); } }} onFinish={(v: Record<string, unknown>) => create.mutate(Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== undefined)))}>
          <Form.Item label="Tài khoản ngân hàng" name="bankAccountId" rules={[{ required: true, message: 'Chọn tài khoản ngân hàng' }]}>
            <Select showSearch optionFilterProp="label" options={(accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.account_no}${a.account_name ? ` – ${a.account_name}` : ''}` }))} />
          </Form.Item>
          <Form.Item label="Nhà cung cấp" name="provider" rules={[{ required: true }]}><Select options={[{ value: 'sepay', label: 'SePay' }, { value: 'casso', label: 'Casso' }]} /></Form.Item>
          <Form.Item label="Cách xác thực" name="authKind" rules={[{ required: true }]}><Select options={[{ value: 'hmac', label: 'Chữ ký HMAC' }, { value: 'apikey', label: 'Khóa API' }]} /></Form.Item>
          <Form.Item label="Khóa bí mật (để trống thì hệ thống tự sinh)" name="secret"><Input.Password autoComplete="off" /></Form.Item>
        </Form>
      </Modal>

      <Modal title="Địa chỉ webhook và khóa" open={!!secret} footer={<Button type="primary" onClick={() => setSecret(null)}>Đã lưu, đóng</Button>} onCancel={() => setSecret(null)} destroyOnHidden width={640}>
        {secret && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="warning" showIcon message="Khóa chỉ hiện một lần. Hãy chép và dán sang SePay/Casso ngay." />
            <Descriptions column={1} size="small" layout="vertical">
              <Descriptions.Item label="Địa chỉ webhook"><Copy label="Địa chỉ webhook" value={secret.webhookUrl} /></Descriptions.Item>
              {secret.secret && <Descriptions.Item label="Khóa bí mật (HMAC)"><Copy label="Khóa bí mật" value={secret.secret} /></Descriptions.Item>}
              {secret.apiKey && <Descriptions.Item label="Khóa API"><Copy label="Khóa API" value={secret.apiKey} /></Descriptions.Item>}
            </Descriptions>
          </Space>)}
      </Modal>

      <Modal title={fmt?.id ? 'Sửa mẫu cột sao kê' : 'Thêm mẫu cột sao kê'} open={!!fmt} okText="Lưu" cancelText="Hủy" confirmLoading={saveFmt.isPending} destroyOnHidden onCancel={() => setFmt(null)} onOk={() => fmtForm.submit()}>
        <Form form={fmtForm} layout="vertical" onFinish={submitFmt} onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fmtForm.submit(); } }}>
          <Form.Item label="Tên mẫu" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên mẫu' }]}><Input maxLength={100} /></Form.Item>
          <Space align="start" wrap>
            <Form.Item label="Mã ngân hàng" name="bankCode"><Input maxLength={20} style={{ width: 120 }} /></Form.Item>
            <Form.Item label="Dòng tiêu đề" name="headerRow"><InputNumber min={0} max={1000} /></Form.Item>
            <Form.Item label="Trang tính" name="sheetIndex"><InputNumber min={0} max={50} /></Form.Item>
            <Form.Item label="Định dạng ngày" name="dateFormat"><Select style={{ width: 150 }} options={DATE_FORMATS.map((d) => ({ value: d, label: d === 'excel' ? 'Ngày của Excel' : d }))} /></Form.Item>
          </Space>
          <Space wrap>
            {COLS.map(([k, label]) => (
              <Form.Item key={k} label={label} name={k} rules={[{ pattern: /^[A-Z]{1,3}$/, message: 'Viết hoa, ví dụ A, B, AA' }, ...(k === 'dateCol' || k === 'descriptionCol' ? [{ required: true, message: 'Bắt buộc' }] : [])]}><Input maxLength={3} style={{ width: 120 }} /></Form.Item>))}
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
