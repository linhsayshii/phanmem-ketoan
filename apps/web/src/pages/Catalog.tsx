import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, DatePicker, Form, Input, Modal, Select, Space, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface ColumnDef { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select'; required?: boolean; options?: { value: string; label: string }[]; lookup?: { catalog: string } }
interface Def { name: string; label: string; columns: ColumnDef[] }
type Row = Record<string, unknown>;

// Khóa của currency là chính mã (không có cột id); các danh mục khác dùng id.
const idOf = (r: Row) => String(r['id'] ?? r['code']);
// Cột số nguyên của API nhận số JSON chứ không phải chuỗi (cùng quy tắc với nhập Excel).
const isIntKey = (key: string) => key.endsWith('_days') || key === 'minor_unit';
// Số lẻ theo cột DB: tỷ giá numeric(20,10), thuế suất numeric(5,2), còn lại số nguyên.
const scaleOf = (catalog: string, key: string) => (key === 'rate' ? (catalog === 'exchange_rate' ? 10 : catalog === 'tax_code' || catalog === 'invoice_group' ? 2 : 0) : 0);
const QUICK_ADD = [{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }];

export function FieldFor({ c, catalog, canQuickAdd }: { c: ColumnDef; catalog: string; canQuickAdd: boolean }) {
  const rules = c.required ? [{ required: true, message: `Nhập ${c.label.toLowerCase()}` }] : [];
  if (c.lookup) return <Form.Item name={c.key} label={c.label} rules={rules}><LookupSelect catalog={c.lookup.catalog} quickAddFields={canQuickAdd ? QUICK_ADD : undefined} /></Form.Item>;
  if (c.type === 'boolean') return <Form.Item name={c.key} label={c.label} valuePropName="checked"><Checkbox /></Form.Item>;
  if (c.type === 'number') return <Form.Item name={c.key} label={c.label} rules={rules}><VnNumberInput scale={scaleOf(catalog, c.key)} /></Form.Item>;
  if (c.type === 'date') return <Form.Item name={c.key} label={c.label} rules={rules} getValueProps={(v) => ({ value: v ? dayjs(v as string) : undefined })} normalize={(v) => (v ? (v as dayjs.Dayjs).format('YYYY-MM-DD') : null)}><DatePicker format="DD/MM/YYYY" /></Form.Item>;
  if (c.type === 'select') return <Form.Item name={c.key} label={c.label} rules={rules}><Select options={c.options ?? []} /></Form.Item>;
  return <Form.Item name={c.key} label={c.label} rules={rules}><Input /></Form.Item>;
}

export default function CatalogPage() {
  const { name } = useParams({ strict: false }) as { name: string };
  const { me, can } = useAuth(); const qc = useQueryClient();
  const defs = useQuery({ queryKey: ['catalog-defs'], queryFn: () => api<Def[]>('/api/catalogs') });
  const def = defs.data?.find((d) => d.name === name);
  const [filter, setFilter] = useRememberedFilter(`catalog:${name}`, { q: '' }, `${me?.tenantId ?? ''}:${me?.userId ?? ''}`);
  const [qText, setQText] = useState(filter.q);
  useEffect(() => setQText(filter.q), [filter.q]); // bộ lọc nhớ nạp muộn từ máy chủ hoặc đổi danh mục thì ô tìm kiếm theo kịp
  const rows = useQuery({ queryKey: ['catalog', name, filter.q], queryFn: () => api<{ rows: Row[]; total: number }>(`/api/catalogs/${name}?q=${encodeURIComponent(filter.q)}&size=1000`), enabled: !!def });
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      // '' (ô văn bản đã xóa) → null để xóa được giá trị; cột số nguyên → số
      const json = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : isIntKey(k) && typeof x === 'string' ? Number(x) : x]));
      return editing === 'new' ? api(`/api/catalogs/${name}`, { method: 'POST', json }) : api(`/api/catalogs/${name}/${idOf(editing as Row)}`, { method: 'PUT', json });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['catalog', name] }); setEditing(null); form.resetFields(); void message.success('Đã lưu'); },
    onError: (e) => void message.error((e as Error).message) });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/catalogs/${name}/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['catalog', name] }); void message.success('Đã xóa'); }, onError: (e) => void message.error((e as Error).message) });
  const columns = useMemo<ColDef<Row>[]>(() => def ? [...def.columns.map((c): ColDef<Row> => ({
    field: c.key, headerName: c.label, editable: false, width: c.type === 'boolean' ? 110 : 180,
    valueFormatter: (p) => c.type === 'number' ? formatVnNumber(p.value as string | null, scaleOf(def.name, c.key)) : c.type === 'date' && p.value ? formatVnDate(p.value as string) : c.type === 'boolean' ? (p.value ? '✓' : '') : c.type === 'select' ? (c.options?.find((o) => o.value === p.value)?.label ?? '') : String(p.value ?? ''),
  })), { headerName: '', width: 140, editable: false, cellRenderer: (p: ICellRendererParams<Row>) => p.data ? (
    <Space>{can('catalog.update') && <a onClick={() => { setEditing(p.data!); form.setFieldsValue(p.data); }}>Sửa</a>}
      {can('catalog.delete') && <a onClick={() => Modal.confirm({ title: `Xóa ${def.label.toLowerCase()} này?`, onOk: () => remove.mutate(idOf(p.data!)) })}>Xóa</a>}</Space>) : null }] : [],
  [def, can, form, remove.mutate]);
  if (!def) return null;
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{def.label}</h2>
        <Input.Search placeholder="Tìm mã, tên…" value={qText} onChange={(e) => setQText(e.target.value)} onSearch={(q) => setFilter({ q })} style={{ width: 280 }} allowClear />
        {can('catalog.create') && <Button type="primary" onClick={() => { setEditing('new'); form.resetFields(); }}>Thêm (Insert)</Button>}
      </Space>
      <KeyboardGrid<Row> rows={rows.data?.rows ?? []} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height="calc(100vh - 200px)" />
      <Modal title={editing === 'new' ? `Thêm ${def.label.toLowerCase()}` : `Sửa ${def.label.toLowerCase()}`} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} width={720} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>
          {def.columns.map((c) => <FieldFor key={c.key} c={c} catalog={name} canQuickAdd={can('catalog.create')} />)}
        </Form>
      </Modal>
    </>
  );
}
