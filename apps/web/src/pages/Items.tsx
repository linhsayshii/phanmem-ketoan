import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Form, Input, Modal, Select, Space, Table, Tabs, message } from 'antd';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, useHotkeys, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { FieldFor, isIntKey, type Def } from './Catalog.js';

type Row = Record<string, unknown>;
interface Uom { id: string; uomCode: string; uomName: string; factor: string; isBase: boolean }
type Active = 'true' | 'false' | 'all';
const ACTIVE_OPTIONS = [{ value: 'true', label: 'Đang dùng' }, { value: 'false', label: 'Ngưng dùng' }, { value: 'all', label: 'Tất cả' }];
const TRACKING = ['tracking', 'shelf_life_days']; // tab "Lô, hạn dùng"

// Tab ĐVT quy đổi: chỉ mở khi hàng đã lưu (cần mã hàng để thêm dòng item_uom).
function UomTab({ itemId, itemCode, canEdit }: { itemId: string; itemCode: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const [uom, setUom] = useState<string>(); const [factor, setFactor] = useState<string>('');
  const list = useQuery({ queryKey: ['item-uoms', itemId], queryFn: () => api<Uom[]>(`/api/items/${itemId}/uoms`) });
  const done = () => { void qc.invalidateQueries({ queryKey: ['item-uoms', itemId] }); };
  const add = useMutation({ mutationFn: () => api('/api/catalogs/item_uom', { method: 'POST', json: { item_code: itemCode, uom_code: uom, factor } }),
    onSuccess: () => { setUom(undefined); setFactor(''); done(); }, onError: (e) => void message.error((e as Error).message) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/catalogs/item_uom/${id}`, { method: 'DELETE' }), onSuccess: done, onError: (e) => void message.error((e as Error).message) });
  return (<>
    <Table<Uom> size="small" rowKey="id" pagination={false} dataSource={list.data ?? []} columns={[
      { title: 'ĐVT', render: (_v, r) => `${r.uomCode} - ${r.uomName}` },
      { title: 'Hệ số quy đổi ra ĐVT cơ sở', dataIndex: 'factor', align: 'right', render: (v: string) => formatVnNumber(v, 6) },
      { title: '', width: 80, render: (_v, r) => (canEdit && !r.isBase ? <Button type="link" size="small" danger onClick={() => del.mutate(r.id)}>Xóa</Button> : r.isBase ? 'Cơ sở' : null) }]} />
    {canEdit && <Space style={{ marginTop: 12 }} align="end">
      <LookupSelect catalog="uom" value={uom} onChange={(v) => setUom(v ?? undefined)} placeholder="ĐVT (F4)" aria-label="Chọn ĐVT" style={{ width: 200 }} />
      <VnNumberInput scale={6} value={factor} onChange={(v) => setFactor(v ?? '')} aria-label="Hệ số quy đổi" />
      <Button type="primary" disabled={!uom || !factor} loading={add.isPending} onClick={() => add.mutate()}>Thêm ĐVT</Button>
    </Space>}
  </>);
}

export default function ItemsPage() {
  const { me, can } = useAuth(); const qc = useQueryClient();
  const defs = useQuery({ queryKey: ['catalog-defs'], queryFn: () => api<Def[]>('/api/catalogs') });
  const def = defs.data?.find((d) => d.name === 'item');
  const cols = def?.columns.filter((c) => !c.importOnly) ?? [];
  const [filter, setFilter] = useRememberedFilter<{ q: string; active: Active }>('items', { q: '', active: 'true' }, `${me?.tenantId ?? ''}:${me?.userId ?? ''}`);
  const [qText, setQText] = useState(filter.q);
  useEffect(() => setQText(filter.q), [filter.q]);
  const rows = useQuery({ queryKey: ['catalog', 'item', filter.q, filter.active], queryFn: () => api<{ rows: Row[] }>(`/api/catalogs/item?q=${encodeURIComponent(filter.q)}&active=${filter.active}&size=1000`), enabled: !!def });
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const json = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : isIntKey(k) && typeof x === 'string' ? Number(x) : x]));
      return editing === 'new' ? api('/api/catalogs/item', { method: 'POST', json }) : api(`/api/catalogs/item/${String((editing as Row)['id'])}`, { method: 'PUT', json });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['catalog', 'item'] }); setEditing(null); form.resetFields(); void message.success('Đã lưu'); },
    onError: (e) => void message.error((e as Error).message) });
  const toggle = useMutation({ mutationFn: (v: { id: string; active: boolean }) => api(`/api/catalogs/item/${v.id}/${v.active ? 'activate' : 'deactivate'}`, { method: 'POST', json: {} }),
    onSuccess: (_d, v) => { void qc.invalidateQueries({ queryKey: ['catalog', 'item'] }); void message.success(v.active ? 'Đã cho dùng lại' : 'Đã ngưng dùng'); }, onError: (e) => void message.error((e as Error).message) });
  const canEdit = can('item.update');
  const columns = useMemo<ColDef<Row>[]>(() => def ? [
    ...['code', 'name', 'item_group_code', 'base_uom_code', 'kind', 'tracking'].map((k) => cols.find((c) => c.key === k)!).map((c): ColDef<Row> => ({ field: c.key, headerName: c.label, editable: false, width: c.key === 'name' ? 280 : 160,
      valueFormatter: (p) => c.type === 'select' ? (c.options?.find((o) => o.value === p.value)?.label ?? '') : String(p.value ?? '') })),
    { headerName: '', width: 190, editable: false, pinned: 'right', cellRenderer: (p: ICellRendererParams<Row>) => p.data ? (
      <Space size={0}>{canEdit && <Button type="link" size="small" onClick={() => { setEditing(p.data!); form.setFieldsValue(p.data); }}>Sửa</Button>}
        {canEdit && <Button type="link" size="small" onClick={() => toggle.mutate({ id: String(p.data!['id']), active: p.data!['is_active'] === false })}>{p.data['is_active'] === false ? 'Dùng lại' : 'Ngưng dùng'}</Button>}</Space>) : null }] : [],
  [def, cols, canEdit, form, toggle.mutate]);
  const add = () => { setEditing('new'); form.resetFields(); };
  useHotkeys({ Insert: () => { if (def && can('item.create') && !editing) add(); } });
  if (!def) return null;
  const field = (c: (typeof cols)[number]) => <FieldFor key={c.key} c={c} catalog="item" canQuickAdd={can('catalog.create')} />;
  const isNew = editing === 'new';
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <h2 style={{ margin: 0 }}>Vật tư hàng hóa</h2>
        <Input.Search placeholder="Tìm mã, tên, mã vạch…" value={qText} onChange={(e) => setQText(e.target.value)} onSearch={(q) => setFilter({ ...filter, q })} style={{ width: 280 }} allowClear />
        <Select value={filter.active} options={ACTIVE_OPTIONS} onChange={(active: Active) => setFilter({ ...filter, active })} style={{ width: 140 }} aria-label="Trạng thái" />
        {can('item.create') && <Button type="primary" onClick={add}>Thêm (Insert)</Button>}
      </Space>
      <KeyboardGrid<Row> rows={rows.data?.rows ?? []} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height="calc(100vh - 200px)" />
      <Modal title={isNew ? 'Thêm vật tư hàng hóa' : 'Sửa vật tư hàng hóa'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} width={820} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Tabs items={[
            { key: 'general', label: 'Thông tin chung', forceRender: true, children: <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>{cols.filter((c) => !TRACKING.includes(c.key)).map(field)}</div> },
            { key: 'uom', label: 'ĐVT quy đổi', disabled: isNew, children: editing && !isNew ? <UomTab itemId={String((editing as Row)['id'])} itemCode={String((editing as Row)['code'])} canEdit={canEdit} /> : null },
            { key: 'lot', label: 'Lô, hạn dùng', forceRender: true, children: <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>{cols.filter((c) => TRACKING.includes(c.key)).map(field)}</div> },
          ]} />
        </Form>
      </Modal>
    </>
  );
}
