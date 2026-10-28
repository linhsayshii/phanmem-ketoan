import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Upload, message } from 'antd';
import dayjs from 'dayjs';
import type { ColDef } from 'ag-grid-community';
import { D, formatVnNumber, parseVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, Section, COLOR, useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Head { id: number; code: string; name: string; kind: 'sale' | 'purchase'; currencyCode: string; partyGroupCode: string | null; validFrom: string; validTo: string | null; priority: number; isActive: boolean; lineCount: number }
interface Line { itemCode?: string; uomCode?: string; minQty?: string; price?: string; discountRate?: string }
const KIND = [{ value: 'sale', label: 'Bảng giá bán' }, { value: 'purchase', label: 'Bảng giá mua' }];
const kindLabel = (k: string) => KIND.find((o) => o.value === k)?.label ?? k;

const numCol = (colId: keyof Line, headerName: string, max?: number): ColDef<Line> => ({ colId, field: colId, headerName, width: 150, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
  valueFormatter: (p) => (p.value ? formatVnNumber(String(p.value), D(String(p.value)).decimalPlaces()) : ''),
  valueParser: (p) => { const s = parseVnNumber(String(p.newValue ?? '')); if (s === null || D(s).isNegative() || (max !== undefined && D(s).gt(max))) return p.oldValue; return D(s).toDecimalPlaces(4).toFixed(); } });

export default function PriceListsPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const [kind, setKind] = useState<string>();
  const list = useQuery({ queryKey: ['price-lists', kind], queryFn: () => api<Head[]>(`/api/price-lists${kind ? `?kind=${kind}` : ''}`) });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState<{ col: 'itemCode' | 'uomCode'; row: number } | null>(null);
  const [form] = Form.useForm();
  const canEdit = can('price_list.update');
  const open = async (id: number | 'new') => {
    setEditing(id);
    if (id === 'new') { form.resetFields(); form.setFieldsValue({ kind: 'sale', currencyCode: 'VND', priority: 0, validFrom: dayjs() }); setLines([{ minQty: '0', discountRate: '0' }]); return; }
    const d = await api<Head & { lines: Line[] }>(`/api/price-lists/${id}`);
    form.setFieldsValue({ ...d, validFrom: dayjs(d.validFrom), validTo: d.validTo ? dayjs(d.validTo) : null }); setLines(d.lines);
  };
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const json = { code: v['code'], name: v['name'], kind: v['kind'], currencyCode: v['currencyCode'], partyGroupCode: v['partyGroupCode'] || null, priority: Number(v['priority'] ?? 0),
        validFrom: (v['validFrom'] as dayjs.Dayjs).format('YYYY-MM-DD'), validTo: v['validTo'] ? (v['validTo'] as dayjs.Dayjs).format('YYYY-MM-DD') : null,
        lines: lines.filter((l) => l.itemCode && l.uomCode && l.price).map((l) => ({ itemCode: l.itemCode, uomCode: l.uomCode, minQty: l.minQty || '0', price: l.price, discountRate: l.discountRate || '0' })) };
      return editing === 'new' ? api('/api/price-lists', { method: 'POST', json }) : api(`/api/price-lists/${editing as number}`, { method: 'PUT', json });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['price-lists'] }); setEditing(null); void message.success('Đã lưu bảng giá'); },
    onError: (e) => void message.error((e as Error).message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/price-lists/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['price-lists'] }); void message.success('Đã xóa bảng giá'); }, onError: (e) => void message.error((e as Error).message) });
  const importXlsx = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch(`/api/price-lists/${editing as number}/import-lines?mode=commit`, { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json() as { inserted?: number; error?: { message: string; details?: { row: number; message: string }[] } };
    if (!r.ok) void message.error(`${j.error?.message ?? 'Lỗi nhập'}${j.error?.details?.length ? `: dòng ${j.error.details[0]!.row}, ${j.error.details[0]!.message}` : ''}`);
    else { void message.success(`Đã nhập ${j.inserted} dòng giá`); await open(editing as number); void qc.invalidateQueries({ queryKey: ['price-lists'] }); }
  };
  const columns = useMemo<ColDef<Line>[]>(() => [
    { colId: 'itemCode', field: 'itemCode', headerName: 'Mã hàng (F4)', width: 180 }, { colId: 'uomCode', field: 'uomCode', headerName: 'ĐVT (F4)', width: 110 },
    numCol('minQty', 'Từ số lượng'), numCol('price', 'Đơn giá'), numCol('discountRate', 'Chiết khấu (%)', 100)], []);
  // Ctrl+S khi hộp thoại mở (useHotkeys bỏ qua phím trong hộp thoại): chốt ô đang sửa của lưới rồi lưu.
  useEffect(() => {
    if (editing === null) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => form.submit(), 50); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, form]);
  useHotkeys({ Insert: () => { if (can('price_list.create') && !editing) void open('new'); } });
  return (<>
    <PageHeader
      title="Bảng giá"
      extra={can('price_list.create') && <Button type="primary" onClick={() => void open('new')}>Thêm (Insert)</Button>}
    >
      <Toolbar>
        <Select allowClear placeholder="Loại bảng giá" value={kind} options={KIND} onChange={setKind} style={{ width: 180 }} aria-label="Loại bảng giá" />
        {list.data !== undefined && (
          <span style={{ marginLeft: 'auto', color: COLOR.textSecondary, fontSize: 13 }}>
            {formatVnNumber(String(list.data.length))} bảng giá
          </span>
        )}
      </Toolbar>
    </PageHeader>
    <Section bodyPadding={0}>
      <Table<Head> size="small" rowKey="id" dataSource={list.data ?? []} pagination={false} columns={[
        { title: 'Mã', dataIndex: 'code', width: 120 }, { title: 'Tên bảng giá', dataIndex: 'name' }, { title: 'Loại', dataIndex: 'kind', render: kindLabel, width: 130 },
        { title: 'Tiền', dataIndex: 'currencyCode', width: 70 }, { title: 'Nhóm đối tượng', dataIndex: 'partyGroupCode', width: 140 },
        { title: 'Hiệu lực', width: 200, render: (_v, r) => `${dayjs(r.validFrom).format('DD/MM/YYYY')} - ${r.validTo ? dayjs(r.validTo).format('DD/MM/YYYY') : 'không giới hạn'}` },
        { title: 'Ưu tiên', dataIndex: 'priority', align: 'right', width: 90, className: 'kt-num' }, { title: 'Số dòng giá', dataIndex: 'lineCount', align: 'right', width: 110, className: 'kt-num' },
        { title: '', width: 120, render: (_v, r) => (<Space size={0}>{canEdit && <Button type="link" size="small" onClick={() => void open(r.id)}>Sửa</Button>}
          {can('price_list.delete') && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Xóa bảng giá ${r.code}?`, okText: 'Xóa', cancelText: 'Hủy', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button>}</Space>) }]} />
    </Section>
    <Modal title={editing === 'new' ? 'Thêm bảng giá' : 'Sửa bảng giá'} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} okText="Lưu (Ctrl+S)" cancelText="Hủy" width={900} destroyOnHidden forceRender>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', columnGap: 16 }}>
          <Form.Item name="code" label="Mã bảng giá" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><Input /></Form.Item>
          <Form.Item name="name" label="Tên bảng giá" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><Input /></Form.Item>
          <Form.Item name="kind" label="Loại"><Select options={KIND} aria-label="Loại" /></Form.Item>
          <Form.Item name="currencyCode" label="Loại tiền" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><LookupSelect catalog="currency" aria-label="Loại tiền" /></Form.Item>
          <Form.Item name="partyGroupCode" label="Nhóm đối tượng (trống = áp dụng chung)"><LookupSelect catalog="party_group" allowClear aria-label="Nhóm đối tượng" /></Form.Item>
          <Form.Item name="priority" label="Ưu tiên"><InputNumber min={0} max={9999} precision={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="validFrom" label="Hiệu lực từ" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="validTo" label="Đến (trống = không giới hạn)"><DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} /></Form.Item>
        </div>
        <Space style={{ marginBottom: 8 }}>
          <strong>Dòng giá</strong>
          {editing !== 'new' && editing !== null && canEdit && <Upload accept=".xlsx" showUploadList={false} beforeUpload={(f) => { void importXlsx(f); return false; }}><Button size="small">Nhập Excel</Button></Upload>}
          <a href="/api/price-lists/lines-template.xlsx">Tải mẫu Excel</a>
        </Space>
        <KeyboardGrid<Line> rows={lines} columns={columns} onRowsChange={setLines} addRowTemplate={() => ({ minQty: '0', discountRate: '0' })} height={280} readOnly={!canEdit && editing !== 'new'}
          onLookup={(col, row) => { if (col === 'itemCode' || col === 'uomCode') setPick({ col, row }); }} />
      </Form>
    </Modal>
    <Modal title={pick?.col === 'itemCode' ? 'Chọn vật tư hàng hóa' : 'Chọn đơn vị tính'} open={!!pick} footer={null} onCancel={() => setPick(null)} destroyOnHidden>
      {pick && <LookupSelect catalog={pick.col === 'itemCode' ? 'item' : 'uom'} autoFocus defaultOpen style={{ width: '100%' }} aria-label="Tra cứu" value={null}
        onChange={(code) => { if (code) { setLines((ls) => ls.map((l, i) => (i === pick.row ? { ...l, [pick.col]: code } : l))); setPick(null); } }} />}
    </Modal>
  </>);
}
