import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, message } from 'antd';
import dayjs from 'dayjs';
import { PageHeader, Section, useHotkeys, FormModal } from '@kt/ui';
import { api } from '../api/client.js';
import type { SigningProfile } from '../signing/signXml.js';

// Cài đặt ký số: mỗi người dùng có hồ sơ ký riêng. Khóa riêng không bao giờ lên máy chủ: tiện ích ký trên máy người dùng, hoặc ký từ xa qua VNPT SmartCA.
const AGENT_URL = 'http://127.0.0.1:18765';
const KINDS = [
  { value: 'local_agent', label: 'Tiện ích ký số trên máy này (USB token / tệp chứng thư)' },
  { value: 'smartca', label: 'VNPT SmartCA (ký từ xa) - chưa thử trên môi trường thật' },
  ...(import.meta.env.PROD ? [] : [{ value: 'fake', label: 'Giả lập (chỉ để thử)' }]),
];
const kindLabel = (k: string) => ({ local_agent: 'Tiện ích cục bộ', smartca: 'VNPT SmartCA', fake: 'Giả lập' })[k] ?? k;
const required = [{ required: true, whitespace: true, message: 'Bắt buộc nhập' }];
interface AgentCert { serial: string; subject: string; notAfter: string; certB64: string }

export default function SigningSetupPage() {
  const qc = useQueryClient(); const [form] = Form.useForm();
  const [open, setOpen] = useState(false); const [kind, setKind] = useState('local_agent');
  const [certs, setCerts] = useState<AgentCert[]>([]); const [agentMsg, setAgentMsg] = useState('');
  const list = useQuery({ queryKey: ['signing-profiles'], queryFn: () => api<SigningProfile[]>('/api/signing/profiles') });
  const done = (text: string) => { void qc.invalidateQueries({ queryKey: ['signing-profiles'] }); void message.success(text); };
  const fail = (e: unknown) => void message.error((e as Error).message);
  const show = () => { form.resetFields(); form.setFieldsValue({ kind: 'local_agent', isDefault: false }); setKind('local_agent'); setCerts([]); setAgentMsg(''); setOpen(true); };
  const save = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/signing/profiles', { method: 'POST', json: { ...v, serial: v['serial'] || undefined, baseUrl: v['baseUrl'] || undefined } }), onSuccess: () => { setOpen(false); done('Đã lưu hồ sơ ký số'); }, onError: fail });
  const setDefault = useMutation({ mutationFn: (id: number) => api(`/api/signing/profiles/${id}/default`, { method: 'POST' }), onSuccess: () => done('Đã đặt làm hồ sơ mặc định'), onError: fail });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/signing/profiles/${id}`, { method: 'DELETE' }), onSuccess: () => done('Đã xóa hồ sơ'), onError: fail });
  useHotkeys({ Insert: () => document.querySelector<HTMLButtonElement>('[data-add-profile]')?.click() });

  const readAgent = async () => {
    setAgentMsg('Đang kết nối tiện ích...');
    try {
      const r = await fetch(`${AGENT_URL}/v1/certificates`);
      const c = (await r.json()) as AgentCert[];
      setCerts(c); setAgentMsg(c.length ? '' : 'Tiện ích không có chứng thư nào');
      if (c.length === 1) form.setFieldsValue({ certB64: c[0]!.certB64 });
    } catch { setAgentMsg('Không kết nối được tiện ích ký số. Chạy tiện ích trên máy này rồi thử lại (xem docs/dev/ky-so-cuc-bo.md).'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Cài đặt ký số"
        description="Quản lý hồ sơ chứng thư số cá nhân dùng để ký điện tử báo cáo và tờ khai thuế"
        extra={<Button type="primary" data-add-profile onClick={show}>Thêm hồ sơ (Insert)</Button>}
      />
      {list.error && <Alert type="error" showIcon message={(list.error as Error).message} />}
      <Section title="Hồ sơ ký số của tôi" bodyPadding={0}>
        <Table<SigningProfile> size="small" rowKey="id" pagination={false} loading={list.isLoading} dataSource={list.data ?? []} locale={{ emptyText: 'Chưa có hồ sơ ký số' }} columns={[
          { title: 'Tên hồ sơ', dataIndex: 'label' }, { title: 'Hình thức', dataIndex: 'kind', width: 150, render: kindLabel },
          { title: 'Chủ thể chứng thư', dataIndex: 'certSubject' }, { title: 'Số sê-ri', dataIndex: 'certSerial', width: 180, ellipsis: true },
          { title: 'Hạn chứng thư', dataIndex: 'certNotAfter', width: 130, render: (d: string, r) => (r.expired ? <Tag color="red">Đã hết hạn {dayjs(d).format('DD/MM/YYYY')}</Tag> : dayjs(d).format('DD/MM/YYYY')) },
          { title: 'Mặc định', dataIndex: 'isDefault', width: 100, render: (b: boolean) => (b ? <Tag color="green">Mặc định</Tag> : null) },
          { title: '', width: 190, render: (_v, r) => (<Space size={0}>
            {!r.isDefault && <Button type="link" size="small" onClick={() => setDefault.mutate(r.id)}>Đặt mặc định</Button>}
            <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Xóa hồ sơ ${r.label}?`, okText: 'Xóa', cancelText: 'Hủy', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button></Space>) }]} />
      </Section>
      <FormModal title="Thêm hồ sơ ký số" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} okText="Lưu (Ctrl+S)" cancelText="Hủy" confirmLoading={save.isPending} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} onValuesChange={(c: { kind?: string }) => { if (c.kind) setKind(c.kind); }}>
          <Form.Item name="kind" label="Hình thức ký"><Select aria-label="Hình thức ký" options={KINDS} /></Form.Item>
          <Form.Item name="label" label="Tên hồ sơ" rules={required}><Input /></Form.Item>
          {kind === 'local_agent' && (<>
            <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
              <Button onClick={() => void readAgent()}>Lấy chứng thư từ tiện ích</Button>
              {agentMsg && <Alert type="warning" showIcon message={agentMsg} />}
              {certs.length > 1 && <Select style={{ width: '100%' }} aria-label="Chọn chứng thư" placeholder="Chọn chứng thư" options={certs.map((c) => ({ value: c.certB64, label: c.subject }))} onChange={(v) => form.setFieldsValue({ certB64: v })} />}
            </Space>
            <Form.Item name="certB64" hidden rules={[{ required: true, message: 'Chưa lấy chứng thư từ tiện ích' }]}><Input /></Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.certB64 !== b.certB64}>{() => form.getFieldValue('certB64') ? <Alert type="success" showIcon style={{ marginBottom: 12 }} message="Đã nhận chứng thư từ tiện ích" /> : null}</Form.Item>
          </>)}
          {kind === 'smartca' && (<>
            <Form.Item name="baseUrl" label="Địa chỉ máy chủ" extra="Để trống: dùng môi trường thử của VNPT"><Input placeholder="https://..." /></Form.Item>
            <Form.Item name="spId" label="Mã dịch vụ (sp_id)" rules={required}><Input autoComplete="off" /></Form.Item>
            <Form.Item name="spPassword" label="Mật khẩu dịch vụ" rules={required} extra="Được mã hóa khi lưu, không hiển thị lại."><Input.Password autoComplete="new-password" /></Form.Item>
            <Form.Item name="userId" label="Định danh thuê bao (CCCD/MST)" rules={required}><Input autoComplete="off" /></Form.Item>
            <Form.Item name="serial" label="Số sê-ri chứng thư (nếu có nhiều)"><Input /></Form.Item>
          </>)}
          {kind === 'fake' && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Khóa thử công khai, chữ ký không có giá trị pháp lý. Không dùng ở môi trường chính thức." />}
          <Form.Item name="isDefault" label="Đặt làm mặc định" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </FormModal>
    </div>
  );
}
