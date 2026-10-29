import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DatePicker, Form, Input, Modal, Radio, Space, Table, message } from 'antd';
import dayjs from 'dayjs';
import type { ColDef } from 'ag-grid-community';
import { D, formatVnNumber, parseVnNumber } from '@kt/domain';
import { COLOR, KeyboardGrid, LookupSelect, PageHeader, Section, Toolbar, useHotkeys, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { costObjectPick } from '../lookups.js';

// Định mức nguyên vật liệu (GĐ6): lượng NVL cho MỘT đơn vị sản phẩm, hao hụt % cộng thêm; theo sản phẩm hoặc đối tượng tập hợp chi phí, có khoảng hiệu lực.
interface Head { id: number; itemCode: string | null; itemName: string | null; costObjectCode: string | null; costObjectName: string | null; validFrom: string; validTo: string | null; note: string | null; lineCount: number }
interface Line { itemCode?: string; itemName?: string; uomCode?: string | null; quantity?: string; lossPercent?: string; grossQuantity?: string; note?: string | null }
type Target = 'item' | 'object';
const vnDate = (d: string) => dayjs(d).format('DD/MM/YYYY');

// Ô số: số không âm, tối đa `scale` chữ số thập phân; sai thì giữ giá trị cũ.
const numCol = (field: 'quantity' | 'lossPercent', headerName: string, scale: number): ColDef<Line> => ({ colId: field, field, headerName, width: 150, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
  valueFormatter: (p) => (p.value ? formatVnNumber(String(p.value), Math.min(scale, D(String(p.value)).decimalPlaces())) : ''),
  valueParser: (p) => { const s = parseVnNumber(String(p.newValue ?? '')); if (s === null || D(s).isNegative() || D(s).decimalPlaces() > scale) return p.oldValue; return D(s).toFixed(); } });

export default function CostNormsPage() {
  const { me, can } = useAuth(); const qc = useQueryClient();
  const [filter, setFilter] = useRememberedFilter<{ q: string }>('cost-norms', { q: '' }, `${me?.tenantId ?? ''}:${me?.userId ?? ''}`);
  const list = useQuery({ queryKey: ['cost-norms', filter.q], queryFn: () => api<Head[]>(`/api/costing/norms?q=${encodeURIComponent(filter.q)}`) });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState<number | null>(null); // dòng đang tra F4 vật tư
  const [form] = Form.useForm();
  const target = Form.useWatch('target', form) as Target | undefined;
  const canEdit = editing === 'new' ? can('costing_obj.create') : can('costing_obj.update');
  const open = async (id: number | 'new') => {
    setEditing(id);
    if (id === 'new') { form.resetFields(); form.setFieldsValue({ target: 'item', validFrom: dayjs().startOf('month') }); setLines([{ lossPercent: '0' }]); return; }
    const d = await api<Head & { lines: Line[] }>(`/api/costing/norms/${id}`);
    form.setFieldsValue({ ...d, target: d.itemCode ? 'item' : 'object', validFrom: dayjs(d.validFrom), validTo: d.validTo ? dayjs(d.validTo) : null }); setLines(d.lines);
  };
  const onError = (e: unknown) => void message.error((e as Error).message);
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const json = { ...(v['target'] === 'item' ? { itemCode: v['itemCode'] } : { costObjectCode: v['costObjectCode'] }), note: (v['note'] as string | undefined) || null,
        validFrom: (v['validFrom'] as dayjs.Dayjs).format('YYYY-MM-DD'), validTo: v['validTo'] ? (v['validTo'] as dayjs.Dayjs).format('YYYY-MM-DD') : null,
        lines: lines.filter((l) => l.itemCode && l.quantity).map((l) => ({ itemCode: l.itemCode, quantity: l.quantity, lossPercent: l.lossPercent || '0', note: l.note || null })) };
      return editing === 'new' ? api('/api/costing/norms', { method: 'POST', json }) : api(`/api/costing/norms/${editing as number}`, { method: 'PUT', json });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cost-norms'] }); setEditing(null); void message.success('Đã lưu định mức'); }, onError });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/costing/norms/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cost-norms'] }); void message.success('Đã xóa định mức'); }, onError });
  const columns = useMemo<ColDef<Line>[]>(() => [
    { colId: 'itemCode', field: 'itemCode', headerName: 'Mã NVL (F4)', width: 140 }, { colId: 'itemName', field: 'itemName', headerName: 'Tên nguyên vật liệu', flex: 1, editable: false },
    { colId: 'uomCode', field: 'uomCode', headerName: 'ĐVT', width: 80, editable: false },
    numCol('quantity', 'Số lượng / 1 sản phẩm', 6), numCol('lossPercent', 'Hao hụt (%)', 4),
    { colId: 'grossQuantity', headerName: 'Định mức gồm hao hụt', width: 170, editable: false, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
      valueGetter: (p) => (p.data?.quantity ? formatVnNumber(D(p.data.quantity).mul(D(p.data.lossPercent || '0').div(100).add(1)).toDecimalPlaces(6).toFixed(), 6) : '') },
    { colId: 'note', field: 'note', headerName: 'Ghi chú', width: 160 }], []);
  // Ctrl+S khi hộp thoại mở (useHotkeys bỏ qua phím trong hộp thoại): chốt ô đang sửa của lưới rồi lưu.
  useEffect(() => {
    if (editing === null) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => form.submit(), 50); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, form]);
  useHotkeys({ Insert: () => { if (can('costing_obj.create') && !editing) void open('new'); } });
  const count = list.data?.length;
  return (<>
    <PageHeader
      title="Định mức nguyên vật liệu"
      description="Lượng nguyên vật liệu cho một đơn vị sản phẩm và tỷ lệ hao hụt theo khoảng thời gian hiệu lực"
      extra={can('costing_obj.create') && <Button type="primary" onClick={() => void open('new')}>Thêm (Insert)</Button>}
    >
      <Toolbar>
        <Input.Search placeholder="Tìm sản phẩm, đối tượng…" defaultValue={filter.q} onSearch={(q) => setFilter({ q })} style={{ width: 280 }} allowClear aria-label="Tìm định mức" />
        {count !== undefined && (
          <span style={{ marginLeft: 'auto', color: COLOR.textSecondary, fontSize: 13 }}>
            {formatVnNumber(String(count))} định mức
          </span>
        )}
      </Toolbar>
    </PageHeader>
    <Section bodyPadding={0}>
      <Table<Head> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="cost-norms" columns={[
        { title: 'Áp dụng cho', render: (_v, r) => (r.itemCode ? `Sản phẩm ${r.itemCode} - ${r.itemName}` : `Đối tượng ${r.costObjectCode} - ${r.costObjectName}`) },
        { title: 'Hiệu lực', width: 220, render: (_v, r) => `${vnDate(r.validFrom)} - ${r.validTo ? vnDate(r.validTo) : 'không giới hạn'}` },
        { title: 'Số dòng NVL', dataIndex: 'lineCount', align: 'right', width: 110 }, { title: 'Ghi chú', dataIndex: 'note' },
        { title: '', width: 120, render: (_v, r) => (<Space size={0}>{can('costing_obj.update') && <Button type="link" size="small" onClick={() => void open(r.id)}>Sửa</Button>}
          {can('costing_obj.delete') && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: 'Xóa định mức này?', okText: 'Xóa', cancelText: 'Không', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button>}</Space>) }]} />
    </Section>
    <Modal title={editing === 'new' ? 'Thêm định mức nguyên vật liệu' : 'Sửa định mức nguyên vật liệu'} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()}
      okText="Lưu (Ctrl+S)" cancelText="Bỏ qua" okButtonProps={{ disabled: !canEdit }} confirmLoading={save.isPending} width={960} destroyOnHidden forceRender>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', columnGap: 16 }}>
          <Form.Item name="target" label="Định mức theo"><Radio.Group options={[{ value: 'item', label: 'Sản phẩm' }, { value: 'object', label: 'Đối tượng THCP' }]} optionType="button" /></Form.Item>
          {target === 'object'
            ? <Form.Item name="costObjectCode" label="Đối tượng tập hợp chi phí (F4)" rules={[{ required: true, message: 'Chọn đối tượng' }]}><LookupSelect catalog="cost_object" fetcher={costObjectPick} aria-label="Đối tượng tập hợp chi phí" /></Form.Item>
            : <Form.Item name="itemCode" label="Sản phẩm (F4)" rules={[{ required: true, message: 'Chọn sản phẩm' }]}><LookupSelect catalog="item" aria-label="Sản phẩm" /></Form.Item>}
          <Form.Item name="validFrom" label="Hiệu lực từ" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} aria-label="Hiệu lực từ" /></Form.Item>
          <Form.Item name="validTo" label="Đến (trống = không giới hạn)"><DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} aria-label="Hiệu lực đến" /></Form.Item>
        </div>
        <Form.Item name="note" label="Ghi chú"><Input maxLength={500} /></Form.Item>
        <strong style={{ display: 'block', marginBottom: 8 }}>Nguyên vật liệu cho một đơn vị sản phẩm</strong>
        <KeyboardGrid<Line> rows={lines} columns={columns} onRowsChange={setLines} addRowTemplate={() => ({ lossPercent: '0' })} height={280} readOnly={!canEdit}
          onLookup={(col, row) => { if (col === 'itemCode') setPick(row); }} />
      </Form>
    </Modal>
    <Modal title="Chọn nguyên vật liệu" open={pick !== null} footer={null} onCancel={() => setPick(null)} destroyOnHidden>
      {pick !== null && <LookupSelect catalog="item" autoFocus defaultOpen style={{ width: '100%' }} aria-label="Tra cứu vật tư" value={null}
        onChange={(code, row) => { if (code) { setLines((ls) => ls.map((l, i) => (i === pick ? { ...l, itemCode: code, itemName: row?.name ?? '' } : l))); setPick(null); } }} />}
    </Modal>
  </>);
}
