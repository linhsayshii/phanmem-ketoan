import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Button, DatePicker, Form, Input, Modal, Space, Table, Tag, message } from 'antd';
import dayjs from 'dayjs';
import type { ColDef } from 'ag-grid-community';
import { D, formatVnNumber, parseVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

type Kind = 'quote' | 'sale_order' | 'purchase_order';
const SLUG: Record<string, Kind> = { 'bao-gia': 'quote', 'don-ban': 'sale_order', 'don-mua': 'purchase_order' };
const TITLE: Record<Kind, string> = { quote: 'Báo giá', sale_order: 'Đơn đặt hàng bán', purchase_order: 'Đơn đặt hàng mua' };
const STATUS: Record<string, { label: string; color: string }> = { draft: { label: 'Nháp', color: 'default' }, confirmed: { label: 'Đã duyệt', color: 'blue' }, partial: { label: 'Chuyển một phần', color: 'orange' }, done: { label: 'Hoàn thành', color: 'green' }, cancelled: { label: 'Đã hủy', color: 'red' } };
interface Row { id: string; kind: Kind; docNo: string; docDate: string; status: string; partyCode: string; partyName: string; total: string }
interface Line { itemCode?: string; uomCode?: string; warehouseCode?: string | null; quantity?: string; unitPrice?: string; discountRate?: string; taxCode?: string | null; deliveredQty?: string; lineNo?: number }
interface Detail { id: string; kind: Kind; docNo: string; docDate: string; status: string; partyCode: string; contractCode: string | null; currencyCode: string; note: string | null; lines: Line[]; vouchers: { id: string; voucherType: string; voucherNo: string | null; state: string }[] }

const numCol = (colId: keyof Line, headerName: string, max?: number): ColDef<Line> => ({ colId, field: colId, headerName, width: 130, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
  valueFormatter: (p) => (p.value ? formatVnNumber(String(p.value), D(String(p.value)).decimalPlaces()) : ''),
  valueParser: (p) => { const s = parseVnNumber(String(p.newValue ?? '')); if (s === null || D(s).isNegative() || (max !== undefined && D(s).gt(max))) return p.oldValue; return D(s).toDecimalPlaces(4).toFixed(); } });

export default function OrdersPage() {
  const { can } = useAuth(); const qc = useQueryClient(); const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const kind = SLUG[slug] ?? 'quote';
  const list = useQuery({ queryKey: ['orders', kind], queryFn: () => api<Row[]>(`/api/orders?kind=${kind}`) });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [locked, setLocked] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState<{ col: 'itemCode' | 'uomCode' | 'warehouseCode'; row: number } | null>(null);
  const [conv, setConv] = useState<{ id: string; to: 'BH' | 'MH'; lines: Line[]; qty: Record<number, string>; warehouseCode?: string } | null>(null);
  const [form] = Form.useForm();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['orders'] });
  const fail = (e: unknown) => void message.error((e as Error).message);
  const open = async (id: string | 'new') => {
    setEditing(id);
    if (id === 'new') { form.resetFields(); form.setFieldsValue({ docDate: dayjs(), currencyCode: 'VND' }); setLines([{}]); setLocked(false); return; }
    const d = await api<Detail>(`/api/orders/${id}`);
    form.setFieldsValue({ ...d, docDate: dayjs(d.docDate) }); setLines(d.lines); setLocked(!['draft', 'confirmed'].includes(d.status) || d.vouchers.length > 0);
  };
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const json = { kind, docDate: (v['docDate'] as dayjs.Dayjs).format('YYYY-MM-DD'), partyCode: v['partyCode'], contractCode: v['contractCode'] || null, currencyCode: v['currencyCode'] || 'VND', note: v['note'] || null,
        lines: lines.filter((l) => l.itemCode && l.quantity).map((l) => ({ itemCode: l.itemCode, uomCode: l.uomCode || undefined, warehouseCode: l.warehouseCode || null, quantity: l.quantity, unitPrice: l.unitPrice || undefined, discountRate: l.discountRate || undefined, taxCode: l.taxCode || null })) };
      return editing === 'new' ? api('/api/orders', { method: 'POST', json }) : api(`/api/orders/${editing}`, { method: 'PUT', json });
    },
    onSuccess: () => { refresh(); setEditing(null); void message.success('Đã lưu đơn'); }, onError: fail });
  const act = useMutation({ mutationFn: (a: { id: string; what: 'confirm' | 'cancel' | 'delete' }) => (a.what === 'delete' ? api(`/api/orders/${a.id}`, { method: 'DELETE' }) : api(`/api/orders/${a.id}/${a.what}`, { method: 'POST' })), onSuccess: refresh, onError: fail });
  const toSale = useMutation({ mutationFn: (id: string) => api(`/api/orders/${id}/convert`, { method: 'POST', json: { to: 'SO' } }), onSuccess: () => { refresh(); void message.success('Đã chuyển báo giá thành đơn bán'); void navigate({ to: '/don-hang/$slug', params: { slug: 'don-ban' } }); }, onError: fail });
  const startConvert = async (id: string, to: 'BH' | 'MH') => {
    const d = await api<Detail>(`/api/orders/${id}`);
    const rem = d.lines.filter((l) => D(l.quantity!).gt(l.deliveredQty!));
    setConv({ id, to, lines: rem, qty: Object.fromEntries(rem.map((l) => [l.lineNo!, D(l.quantity!).minus(l.deliveredQty!).toFixed()])) });
  };
  const doConvert = useMutation({
    mutationFn: (c: NonNullable<typeof conv>) => api<{ voucher: { id: string; voucherType: string } }>(`/api/orders/${c.id}/convert`, { method: 'POST', json: { to: c.to, ...(c.warehouseCode && { warehouseCode: c.warehouseCode }),
      lines: c.lines.map((l) => ({ lineNo: l.lineNo, quantity: c.qty[l.lineNo!] })).filter((l) => D(l.quantity || '0').gt(0)) } }),
    onSuccess: (r) => { refresh(); setConv(null); void message.success('Đã lập chứng từ nháp'); void navigate({ to: '/chung-tu/$type/$id', params: { type: r.voucher.voucherType, id: r.voucher.id } }); }, onError: fail });
  const columns = useMemo<ColDef<Line>[]>(() => [
    { colId: 'itemCode', field: 'itemCode', headerName: 'Mã hàng (F4)', width: 160 }, { colId: 'uomCode', field: 'uomCode', headerName: 'ĐVT (F4)', width: 100 },
    { colId: 'warehouseCode', field: 'warehouseCode', headerName: 'Kho (F4)', width: 100 },
    numCol('quantity', 'Số lượng'), numCol('unitPrice', 'Đơn giá (trống: theo bảng giá)'), numCol('discountRate', 'CK (%)', 100),
    { colId: 'taxCode', field: 'taxCode', headerName: 'Mã thuế', width: 100 }, { colId: 'deliveredQty', field: 'deliveredQty', headerName: 'Đã chuyển', width: 110, editable: false, cellClass: 'ag-right-aligned-cell' }], []);
  useEffect(() => {
    if (editing === null) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => form.submit(), 50); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, form]);
  useHotkeys({ Insert: () => { if (can('order.create') && !editing && !conv) void open('new'); } });
  const toType = kind === 'purchase_order' ? 'MH' : 'BH';
  return (<>
    <Space style={{ marginBottom: 12 }} wrap>
      <h2 style={{ margin: 0 }}>{TITLE[kind]}</h2>
      {can('order.create') && <Button type="primary" onClick={() => void open('new')}>Thêm (Insert)</Button>}
    </Space>
    <Table<Row> size="small" rowKey="id" dataSource={list.data ?? []} pagination={false} columns={[
      { title: 'Số', dataIndex: 'docNo', width: 140 }, { title: 'Ngày', dataIndex: 'docDate', width: 110, render: (d: string) => dayjs(d).format('DD/MM/YYYY') },
      { title: 'Mã đối tượng', dataIndex: 'partyCode', width: 130 }, { title: 'Tên đối tượng', dataIndex: 'partyName' },
      { title: 'Giá trị', dataIndex: 'total', align: 'right', width: 140, render: (t: string) => formatVnNumber(t, 0) },
      { title: 'Trạng thái', dataIndex: 'status', width: 150, render: (s: string) => <Tag color={STATUS[s]?.color ?? 'default'}>{STATUS[s]?.label ?? s}</Tag> },
      { title: '', width: 420, render: (_v, r) => { const live = ['draft', 'confirmed', 'partial'].includes(r.status); return (<Space size={0} wrap>
        {can('order.view') && <Button type="link" size="small" onClick={() => void open(r.id)}>{can('order.update') && ['draft', 'confirmed'].includes(r.status) ? 'Sửa' : 'Xem'}</Button>}
        {can('order.update') && r.status === 'draft' && <Button type="link" size="small" onClick={() => act.mutate({ id: r.id, what: 'confirm' })}>Duyệt</Button>}
        {can('order.update') && kind === 'quote' && ['draft', 'confirmed'].includes(r.status) && <Button type="link" size="small" onClick={() => toSale.mutate(r.id)}>Thành đơn bán</Button>}
        {can('order.update') && can('voucher.create') && live && <Button type="link" size="small" onClick={() => void startConvert(r.id, toType)}>{toType === 'BH' ? 'Lập BH nháp' : 'Lập MH nháp'}</Button>}
        {can('order.update') && ['draft', 'confirmed'].includes(r.status) && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Hủy ${r.docNo}?`, okText: 'Hủy đơn', cancelText: 'Không', onOk: () => act.mutateAsync({ id: r.id, what: 'cancel' }) })}>Hủy</Button>}
        {can('order.delete') && r.status === 'draft' && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Xóa ${r.docNo}?`, okText: 'Xóa', cancelText: 'Hủy', onOk: () => act.mutateAsync({ id: r.id, what: 'delete' }) })}>Xóa</Button>}
      </Space>); } }]} />
    <Modal title={editing === 'new' ? `Thêm ${TITLE[kind].toLowerCase()}` : TITLE[kind]} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} okText="Lưu (Ctrl+S)" cancelText="Đóng" okButtonProps={{ disabled: locked || !can('order.update') && editing !== 'new' }} width={1000} destroyOnHidden forceRender>
      <Form form={form} layout="vertical" disabled={locked} onFinish={(v) => save.mutate(v)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', columnGap: 16 }}>
          <Form.Item name="docDate" label="Ngày" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="partyCode" label={kind === 'purchase_order' ? 'Nhà cung cấp' : 'Khách hàng'} rules={[{ required: true, message: 'Bắt buộc nhập' }]}><LookupSelect catalog="party" aria-label="Đối tượng" /></Form.Item>
          <Form.Item name="currencyCode" label="Loại tiền"><LookupSelect catalog="currency" aria-label="Loại tiền" /></Form.Item>
          <Form.Item name="contractCode" label="Mã hợp đồng"><Input aria-label="Mã hợp đồng" /></Form.Item>
        </div>
        <Form.Item name="note" label="Ghi chú"><Input /></Form.Item>
        <strong>Dòng hàng</strong>
        <KeyboardGrid<Line> rows={lines} columns={columns} onRowsChange={setLines} addRowTemplate={() => ({})} height={280} readOnly={locked}
          onLookup={(col, row) => { if (col === 'itemCode' || col === 'uomCode' || col === 'warehouseCode') setPick({ col, row }); }} />
      </Form>
    </Modal>
    <Modal title="Chọn" open={!!pick} footer={null} onCancel={() => setPick(null)} destroyOnHidden>
      {pick && <LookupSelect catalog={pick.col === 'itemCode' ? 'item' : pick.col === 'uomCode' ? 'uom' : 'warehouse'} autoFocus defaultOpen style={{ width: '100%' }} aria-label="Tra cứu" value={null}
        onChange={(code) => { if (code) { setLines((ls) => ls.map((l, i) => (i === pick.row ? { ...l, [pick.col]: code } : l))); setPick(null); } }} />}
    </Modal>
    <Modal title={conv?.to === 'BH' ? 'Lập chứng từ Bán hàng nháp' : 'Lập chứng từ Mua hàng nháp'} open={!!conv} onCancel={() => setConv(null)} onOk={() => conv && doConvert.mutate(conv)} okText="Lập chứng từ" cancelText="Hủy" destroyOnHidden>
      {conv && (<Space direction="vertical" style={{ width: '100%' }}>
        <span>Nhập số lượng chuyển cho từng dòng (mặc định toàn bộ số còn lại).</span>
        {conv.lines.map((l) => (<Space key={l.lineNo}><span style={{ width: 200, display: 'inline-block' }}>{l.itemCode} (còn {D(l.quantity!).minus(l.deliveredQty!).toFixed()})</span>
          <Input aria-label={`Số lượng dòng ${l.lineNo}`} value={conv.qty[l.lineNo!]} onChange={(e) => setConv({ ...conv, qty: { ...conv.qty, [l.lineNo!]: e.target.value } })} /></Space>))}
        <Form.Item label="Kho (cho dòng chưa có kho)" style={{ margin: 0 }}><LookupSelect catalog="warehouse" allowClear aria-label="Kho chuyển" value={conv.warehouseCode ?? null} onChange={(c) => setConv({ ...conv, ...(c ? { warehouseCode: c as string } : {}) })} /></Form.Item>
      </Space>)}
    </Modal>
  </>);
}
