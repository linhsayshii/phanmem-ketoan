import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Switch, Table, Tag, message } from 'antd';
import { parseInvoiceSymbol } from '@kt/domain';
import { useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import type { Series } from './einvoiceCommon.js';

// Cấu hình hóa đơn điện tử: nhà cung cấp (mật khẩu chỉ ghi) và dải ký hiệu mẫu số/ký hiệu (TT 91/2026 Phụ lục I).
interface Provider { id: number; code: 'fake' | 'sinvoice'; name: string; baseUrl: string; username: string; hasSecret: boolean; sellerTaxCode: string; isActive: boolean }
const CODES = [{ value: 'fake', label: 'Giả lập (kiểm thử)' }, { value: 'sinvoice', label: 'SInvoice (Viettel)' }];
const required = [{ required: true, whitespace: true, message: 'Bắt buộc nhập' }];

function ProviderCard({ providers, canEdit }: { providers: Provider[]; canEdit: boolean }) {
  const qc = useQueryClient(); const [form] = Form.useForm();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [tested, setTested] = useState<Record<number, { ok: boolean; message: string }>>({});
  const open = (p: Provider | 'new') => { setEditing(p); form.resetFields(); form.setFieldsValue(p === 'new' ? { code: 'sinvoice', isActive: true } : { ...p, password: '' }); };
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => { const json = { ...v, password: v['password'] || undefined }; return editing === 'new' ? api('/api/einvoice/providers', { method: 'POST', json }) : api(`/api/einvoice/providers/${(editing as Provider).id}`, { method: 'PUT', json }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-providers'] }); setEditing(null); void message.success('Đã lưu nhà cung cấp'); }, onError: (e) => void message.error((e as Error).message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/einvoice/providers/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-providers'] }); void message.success('Đã xóa nhà cung cấp'); }, onError: (e) => void message.error((e as Error).message) });
  const test = useMutation({ mutationFn: (id: number) => api<{ ok: boolean; message: string }>(`/api/einvoice/providers/${id}/test`, { method: 'POST' }), onSuccess: (r, id) => setTested((t) => ({ ...t, [id]: r })), onError: (e) => void message.error((e as Error).message) });
  return (
    <Card size="small" title="Nhà cung cấp hóa đơn điện tử" extra={canEdit && <Button type="primary" onClick={() => open('new')}>Thêm nhà cung cấp</Button>}>
      <Table<Provider> size="small" rowKey="id" pagination={false} dataSource={providers} locale={{ emptyText: 'Chưa có nhà cung cấp' }} columns={[
        { title: 'Loại', dataIndex: 'code', width: 160, render: (c: string) => CODES.find((x) => x.value === c)?.label ?? c }, { title: 'Tên', dataIndex: 'name' }, { title: 'Địa chỉ máy chủ', dataIndex: 'baseUrl' },
        { title: 'Tên đăng nhập', dataIndex: 'username', width: 150 }, { title: 'Mật khẩu', dataIndex: 'hasSecret', width: 100, render: (b: boolean) => (b ? 'Đã đặt' : 'Chưa đặt') }, { title: 'MST người bán', dataIndex: 'sellerTaxCode', width: 140 },
        { title: 'Đang dùng', dataIndex: 'isActive', width: 100, render: (b: boolean) => (b ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng</Tag>) },
        { title: '', width: 330, render: (_v, r) => (<Space size={4} wrap>
          {canEdit && <Button size="small" loading={test.isPending && test.variables === r.id} onClick={() => test.mutate(r.id)}>Kiểm tra kết nối</Button>}
          {tested[r.id] && <Tag color={tested[r.id]!.ok ? 'green' : 'red'}>{tested[r.id]!.message}</Tag>}
          {canEdit && <Button type="link" size="small" onClick={() => open(r)}>Sửa</Button>}
          {canEdit && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Xóa nhà cung cấp ${r.name}?`, okText: 'Xóa', cancelText: 'Hủy', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button>}</Space>) }]} />
      <Modal title={editing === 'new' ? 'Thêm nhà cung cấp' : 'Sửa nhà cung cấp'} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} okText="Lưu (Ctrl+S)" cancelText="Hủy" confirmLoading={save.isPending} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="code" label="Loại nhà cung cấp"><Select options={CODES} aria-label="Loại nhà cung cấp" /></Form.Item>
          <Form.Item name="name" label="Tên" rules={required}><Input /></Form.Item>
          <Form.Item name="baseUrl" label="Địa chỉ máy chủ (URL)"><Input placeholder="https://..." /></Form.Item>
          <Form.Item name="username" label="Tên đăng nhập"><Input autoComplete="off" /></Form.Item>
          <Form.Item name="password" label="Mật khẩu" extra={editing !== 'new' && editing?.hasSecret ? 'Để trống: giữ mật khẩu cũ. Mật khẩu chỉ ghi, không hiển thị lại.' : 'Mật khẩu được mã hóa khi lưu, không hiển thị lại.'}><Input.Password autoComplete="new-password" /></Form.Item>
          <Form.Item name="sellerTaxCode" label="Mã số thuế người bán"><Input maxLength={20} /></Form.Item>
          <Form.Item name="isActive" label="Đang dùng" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function SeriesCard({ providers, series, canEdit }: { providers: Provider[]; series: Series[]; canEdit: boolean }) {
  const qc = useQueryClient(); const [form] = Form.useForm();
  const [editing, setEditing] = useState<Series | 'new' | null>(null);
  const [typed, setTyped] = useState<{ formNo: string; serial: string }>({ formNo: '', serial: '' });
  const parsed = typed.formNo || typed.serial ? parseInvoiceSymbol(typed.formNo, typed.serial.toUpperCase()) : null;
  const open = (s: Series | 'new') => { setEditing(s); form.resetFields(); const v = s === 'new' ? { kind: 'standard', isActive: true, providerId: providers[0]?.id } : s; form.setFieldsValue(v); setTyped(s === 'new' ? { formNo: '', serial: '' } : { formNo: s.formNo, serial: s.serial }); };
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => { const json = { ...v, serial: String(v['serial']).toUpperCase(), providerTemplate: v['providerTemplate'] || null, note: v['note'] || null }; return editing === 'new' ? api('/api/einvoice/series', { method: 'POST', json }) : api(`/api/einvoice/series/${(editing as Series).id}`, { method: 'PUT', json }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-series'] }); setEditing(null); void message.success('Đã lưu ký hiệu hóa đơn'); }, onError: (e) => void message.error((e as Error).message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/einvoice/series/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-series'] }); void message.success('Đã xóa ký hiệu'); }, onError: (e) => void message.error((e as Error).message) });
  return (
    <Card size="small" title="Ký hiệu hóa đơn" extra={canEdit && <Button type="primary" data-add-series disabled={!providers.length} onClick={() => open('new')}>Thêm ký hiệu (Insert)</Button>}>
      <Table<Series> size="small" rowKey="id" pagination={false} dataSource={series} locale={{ emptyText: providers.length ? 'Chưa có ký hiệu hóa đơn' : 'Thêm nhà cung cấp trước' }} columns={[
        { title: 'Ký hiệu mẫu số', dataIndex: 'formNo', width: 130 }, { title: 'Ký hiệu', dataIndex: 'serial', width: 120 }, { title: 'Năm', dataIndex: 'year', width: 80 },
        { title: 'Loại', dataIndex: 'kind', width: 190, render: (k: string) => (k === 'cash_register' ? 'Máy tính tiền' : 'Thông thường') }, { title: 'Nhà cung cấp', dataIndex: 'providerId', render: (id: number) => providers.find((p) => p.id === id)?.name ?? id },
        { title: 'Mã mẫu của nhà cung cấp', dataIndex: 'providerTemplate', width: 190 }, { title: 'Đang dùng', dataIndex: 'isActive', width: 100, render: (b: boolean) => (b ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng</Tag>) }, { title: 'Ghi chú', dataIndex: 'note' },
        { title: '', width: 110, render: (_v, r) => canEdit && (<Space size={0}><Button type="link" size="small" onClick={() => open(r)}>Sửa</Button>
          <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Xóa ký hiệu ${r.formNo}${r.serial}?`, okText: 'Xóa', cancelText: 'Hủy', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button></Space>) }]} />
      <Modal title={editing === 'new' ? 'Thêm ký hiệu hóa đơn' : 'Sửa ký hiệu hóa đơn'} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} okText="Lưu (Ctrl+S)" cancelText="Hủy" confirmLoading={save.isPending} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} onValuesChange={(_c, all: { formNo?: string; serial?: string }) => setTyped({ formNo: all.formNo ?? '', serial: all.serial ?? '' })}>
          <Form.Item name="providerId" label="Nhà cung cấp" rules={[{ required: true, message: 'Chọn nhà cung cấp' }]}><Select aria-label="Nhà cung cấp" options={providers.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>
          <Space align="start">
            <Form.Item name="formNo" label="Ký hiệu mẫu số (1-9)" rules={required}><Input maxLength={1} style={{ width: 160 }} /></Form.Item>
            <Form.Item name="serial" label="Ký hiệu (vd. C26TAA)" rules={required}><Input maxLength={6} style={{ width: 200, textTransform: 'uppercase' }} /></Form.Item>
          </Space>
          {parsed && (parsed.ok ? <Alert type="success" showIcon style={{ marginBottom: 12 }} message={`Hợp lệ: ${parsed.withCode ? 'có mã của cơ quan thuế' : 'không có mã của cơ quan thuế'}, năm ${parsed.year}, chữ loại hóa đơn ${parsed.typeLetter}`} />
            : <Alert type="error" showIcon style={{ marginBottom: 12 }} message={parsed.message} />)}
          <Form.Item name="kind" label="Loại"><Select aria-label="Loại" options={[{ value: 'standard', label: 'Thông thường' }, { value: 'cash_register', label: 'Khởi tạo từ máy tính tiền (chữ thứ tư M)' }]} /></Form.Item>
          <Form.Item name="providerTemplate" label="Mã mẫu hóa đơn của nhà cung cấp"><Input /></Form.Item>
          <Form.Item name="note" label="Ghi chú"><Input /></Form.Item>
          <Form.Item name="isActive" label="Đang dùng" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

export default function EInvoiceConfigPage() {
  const { can } = useAuth();
  const providers = useQuery({ queryKey: ['einvoice-providers'], queryFn: () => api<Provider[]>('/api/einvoice/providers') });
  const series = useQuery({ queryKey: ['einvoice-series'], queryFn: () => api<Series[]>('/api/einvoice/series') });
  const canEdit = can('einvoice.config');
  useHotkeys({ Insert: () => { /* mở hộp thoại thêm ký hiệu: nút "Thêm ký hiệu" */ document.querySelector<HTMLButtonElement>('[data-add-series]')?.click(); } });
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <h2 style={{ margin: 0 }}>Cấu hình hóa đơn điện tử</h2>
      {(providers.error || series.error) && <Alert type="error" showIcon message={((providers.error ?? series.error) as Error).message} />}
      <ProviderCard providers={providers.data ?? []} canEdit={canEdit} />
      <SeriesCard providers={providers.data ?? []} series={series.data ?? []} canEdit={canEdit} />
    </Space>
  );
}
