import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import { LookupSelect, useHotkeys, useRememberedFilter, type LookupRow } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Danh mục đối tượng tập hợp chi phí (GĐ6): sản phẩm, vụ việc/công trình, đơn hàng bán, hợp đồng. API /api/costing/objects (quyền costing_obj.*).
export interface CostObject { id: number; code: string; name: string; kind: Kind; itemCode: string | null; projectCode: string | null; orderNo: string | null; contractCode: string | null; method: string | null; unit: string | null; isActive: boolean }
type Kind = 'product' | 'project' | 'order' | 'contract';
export const KIND_LABEL: Record<Kind, string> = { product: 'Sản phẩm', project: 'Vụ việc, công trình', order: 'Đơn hàng', contract: 'Hợp đồng' };
const REF: Record<Kind, { key: 'itemCode' | 'projectCode' | 'orderNo' | 'contractCode'; label: string }> = {
  product: { key: 'itemCode', label: 'Sản phẩm (vật tư hàng hóa)' }, project: { key: 'projectCode', label: 'Vụ việc, công trình' },
  order: { key: 'orderNo', label: 'Số đơn đặt hàng bán' }, contract: { key: 'contractCode', label: 'Hợp đồng' },
};
const METHOD_LABEL: Record<string, string> = { simple: 'Giản đơn', coefficient: 'Hệ số', ratio: 'Tỷ lệ', project: 'Vụ việc, công trình', order: 'Đơn hàng' };
const contractFetcher = async (q: string, signal: AbortSignal): Promise<LookupRow[]> => {
  const r = await fetch(`/api/lookups/contracts?q=${encodeURIComponent(q)}&size=50`, { credentials: 'include', signal });
  return r.ok ? ((await r.json()) as LookupRow[]).map(({ id, code, name }) => ({ id, code, name })) : [];
};
type FormValues = Omit<CostObject, 'id'>;

export default function CostObjectsPage() {
  const { me, can } = useAuth(); const qc = useQueryClient();
  const [filter, setFilter] = useRememberedFilter<{ q: string; kind: Kind | '' }>('cost-objects', { q: '', kind: '' }, `${me?.tenantId ?? ''}:${me?.userId ?? ''}`);
  const list = useQuery({ queryKey: ['cost-objects', filter], queryFn: () => api<{ rows: CostObject[] }>(`/api/costing/objects?${new URLSearchParams({ q: filter.q, size: '1000', ...(filter.kind ? { kind: filter.kind } : {}) })}`) });
  const [editing, setEditing] = useState<CostObject | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const kind = Form.useWatch('kind', form) as Kind | undefined;
  const onError = (e: unknown) => void message.error((e as Error).message);
  const done = (msg: string) => { void qc.invalidateQueries({ queryKey: ['cost-objects'] }); void message.success(msg); };
  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const k = v.kind; const json = { code: v.code, name: v.name, kind: k, [REF[k].key]: v[REF[k].key], method: v.method ?? null, unit: v.unit || null, isActive: v.isActive ?? true };
      return editing === 'new' ? api('/api/costing/objects', { method: 'POST', json }) : api(`/api/costing/objects/${(editing as CostObject).id}`, { method: 'PUT', json });
    },
    onSuccess: () => { setEditing(null); done('Đã lưu đối tượng tập hợp chi phí'); }, onError });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/costing/objects/${id}`, { method: 'DELETE' }), onSuccess: () => done('Đã xóa'), onError });
  const add = () => { form.resetFields(); form.setFieldsValue({ kind: 'product', isActive: true }); setEditing('new'); };
  useHotkeys({ Insert: () => { if (can('costing_obj.create') && !editing) add(); } });
  const canEdit = can('costing_obj.update');
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <h2 style={{ margin: 0 }}>Đối tượng tập hợp chi phí</h2>
        <Input.Search placeholder="Tìm mã, tên…" defaultValue={filter.q} onSearch={(q) => setFilter({ ...filter, q })} style={{ width: 260 }} allowClear aria-label="Tìm đối tượng" />
        <Select value={filter.kind} onChange={(k: Kind | '') => setFilter({ ...filter, kind: k })} style={{ width: 190 }} aria-label="Loại đối tượng"
          options={[{ value: '', label: 'Mọi loại' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]} />
        {can('costing_obj.create') && <Button type="primary" onClick={add}>Thêm (Insert)</Button>}
      </Space>
      <Table<CostObject> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data?.rows ?? []} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="cost-objects"
        columns={[
          { title: 'Mã', dataIndex: 'code', width: 130 }, { title: 'Tên đối tượng', dataIndex: 'name' },
          { title: 'Loại', dataIndex: 'kind', width: 170, render: (k: Kind) => KIND_LABEL[k] },
          { title: 'Tham chiếu', width: 160, render: (_v, r) => r[REF[r.kind].key] },
          { title: 'Phương pháp giá thành', dataIndex: 'method', width: 170, render: (m: string | null) => (m ? METHOD_LABEL[m] : '') },
          { title: 'ĐVT', dataIndex: 'unit', width: 80 },
          { title: 'Trạng thái', dataIndex: 'isActive', width: 110, render: (a: boolean) => (a ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngưng dùng</Tag>) },
          { title: '', width: 120, render: (_v, r) => <Space size={0}>
            {canEdit && <Button type="link" size="small" onClick={() => { form.resetFields(); form.setFieldsValue(r); setEditing(r); }}>Sửa</Button>}
            {can('costing_obj.delete') && <Popconfirm title={`Xóa đối tượng ${r.code}?`} okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><Button type="link" size="small" danger>Xóa</Button></Popconfirm>}
          </Space> },
        ]} />
      <Modal title={editing === 'new' ? 'Thêm đối tượng tập hợp chi phí' : 'Sửa đối tượng tập hợp chi phí'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}
        okText="Lưu (Ctrl+S)" cancelText="Bỏ qua" confirmLoading={save.isPending} destroyOnHidden forceRender width={620}>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}
          onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); form.submit(); } }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', columnGap: 16 }}>
            <Form.Item label="Mã" name="code" rules={[{ required: true, message: 'Nhập mã' }]}><Input autoFocus maxLength={30} /></Form.Item>
            <Form.Item label="Tên đối tượng" name="name" rules={[{ required: true, message: 'Nhập tên' }]}><Input maxLength={200} /></Form.Item>
            <Form.Item label="Loại đối tượng" name="kind" rules={[{ required: true }]}>
              <Select options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} onChange={() => form.setFieldsValue({ itemCode: null, projectCode: null, orderNo: null, contractCode: null })} />
            </Form.Item>
            {kind && <Form.Item label={REF[kind].label} name={REF[kind].key} rules={[{ required: true, message: 'Bắt buộc theo loại đối tượng' }]}>
              {kind === 'product' ? <LookupSelect catalog="item" aria-label="Sản phẩm" />
                : kind === 'project' ? <LookupSelect catalog="project" aria-label="Vụ việc" />
                  : kind === 'contract' ? <LookupSelect catalog="contract" fetcher={contractFetcher} aria-label="Hợp đồng" />
                    : <Input maxLength={50} />}
            </Form.Item>}
            <Form.Item label="Phương pháp giá thành" name="method"><Select allowClear options={Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item label="Đơn vị tính sản lượng" name="unit"><Input maxLength={30} style={{ width: 160 }} /></Form.Item>
            <Form.Item label="Đang dùng" name="isActive" valuePropName="checked"><Switch /></Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}
