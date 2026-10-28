import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, message, theme } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ColDef, EditableCallbackParams } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useHotkeys, useRememberedFilter, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import type { Series } from './einvoiceCommon.js';
import { groupFetcher, iso, PickDialog, taxFetcher, text, useInvoiceGroups, useTaxDefs } from './voucherCommon.js';

// Hợp đồng bán/mua (GĐ6 Task 13a): thông tin hợp đồng, đợt thanh toán, lập hóa đơn nháp (HDB/HDM) từ đợt, theo dõi đã/chưa lập hóa đơn.
// Task 13b: phụ lục điều chỉnh giá trị, thẻ Theo dõi (đã xuất hóa đơn, % thực hiện, công nợ, quá hạn).
type Kind = 'sale' | 'purchase';
interface Milestone { id: number; seq: number; description: string; dueDate: string | null; percent: string | null; amount: string; taxCode: string | null; status: 'planned' | 'cancelled' | 'invoiced'; note: string | null;
  voucherId: string | null; voucherType: string | null; voucherNo: string | null; voucherState: string | null }
interface ContractRow { id: number; code: string; name: string; kind: Kind; partyCode: string | null; partyName: string | null; signedDate: string | null; validFrom: string | null; validTo: string | null; value: string; currencyCode: string;
  status: string; note: string | null; accountCode: string | null; taxCode: string | null; milestoneTotal: string; milestoneCount: number; invoicedTotal: string; invoicedCount: number; milestones?: Milestone[]; amendments?: Amendment[] }
interface Amendment { id: number; seq: number; amendmentNo: string | null; signedDate: string; description: string; valueChange: string; note: string | null }
type AmendRow = { id: string; seq: string; amendmentNo: string; signedDate: string; description: string; valueChange: string; note: string };
const blankAmend = (): AmendRow => ({ id: '', seq: '', amendmentNo: '', signedDate: '', description: '', valueChange: '', note: '' });
export interface Track { adjustedValue: string; amendmentTotal: string; invoiced: string; invoicedVnd: string; remainingValue: string; performedPct: string | null; milestoneTotal: string; milestoneInvoiced: string;
  overdueMilestoneCount: number; overdueMilestoneAmount: string; nextDueDate: string | null; debtIncurred: string | null; settled: string | null; outstanding: string | null; overdueDebt: string | null; debtHidden: boolean }
type GridRow = { id: string; seq: string; description: string; dueDate: string; percent: string; amount: string; taxCode: string; status: string; invoice: string; invoiced: string };

const KIND_LABEL: Record<Kind, string> = { sale: 'Bán', purchase: 'Mua' };
const STATUS_LABEL: Record<string, string> = { draft: 'Nháp', active: 'Hiệu lực', completed: 'Hoàn thành', cancelled: 'Hủy', expired: 'Hết hạn', terminated: 'Chấm dứt' };
const STATUS_COLOR: Record<string, string> = { active: 'green', completed: 'blue', cancelled: 'red' };
const STATE_LABEL: Record<string, string> = { draft: 'Nháp', posted: 'Đã ghi sổ', reversed: 'Đã đảo', cancelled: 'Đã hủy' };
const CANCELLED = 'Hủy đợt'; const PLANNED = 'Kế hoạch';
const money = (s: string | null | undefined, dp = 0) => formatVnNumber(s ?? '0', dp);
const blankRow = (): GridRow => ({ id: '', seq: '', description: '', dueDate: '', percent: '', amount: '', taxCode: '', status: PLANNED, invoice: '', invoiced: '' });
const toGrid = (m: Milestone, dp: number): GridRow => ({ id: String(m.id), seq: String(m.seq), description: m.description, dueDate: m.dueDate ?? '', percent: m.percent ? D(m.percent).toString() : '',
  amount: D(m.amount).toFixed(dp), taxCode: m.taxCode ?? '', status: m.status === 'cancelled' ? CANCELLED : PLANNED,
  invoice: m.voucherId ? `${m.voucherType} ${m.voucherNo ?? '(chưa cấp số)'} - ${STATE_LABEL[m.voucherState ?? ''] ?? ''}` : '', invoiced: m.voucherId ? '1' : '' });
const numParser = (re: RegExp) => (p: { newValue: unknown; oldValue: unknown }) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && re.test(n) ? n : p.oldValue; };

interface InvoiceValues { postingDate: dayjs.Dayjs; invoiceDate: dayjs.Dayjs; invoiceGroupCode: string; accountCode: string; serial?: string; invoiceNo?: string; einvoiceSeriesId?: number | null; fxRate?: string }
function InvoiceDialog({ contract, milestone, onClose, onDone }: { contract: ContractRow; milestone: Milestone | null; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const [form] = Form.useForm<InvoiceValues>(); const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; voucherType: string } | null>(null);
  const groups = useInvoiceGroups(); const groupsOf = useMemo(() => groupFetcher(groups.data ?? [], contract.kind), [groups.data, contract.kind]);
  const accounts = useMemo(() => accountFetcherFor(), []);
  const sale = contract.kind === 'sale'; const foreign = contract.currencyCode !== 'VND';
  const series = useQuery({ queryKey: ['einvoice-series'], enabled: sale && can('einvoice.view'), queryFn: () => api<Series[]>('/api/einvoice/series') });
  const seriesId = Form.useWatch('einvoiceSeriesId', form);
  useEffect(() => { if (milestone) { form.resetFields(); form.setFieldsValue({ postingDate: dayjs(todayVn()), invoiceDate: dayjs(todayVn()), accountCode: contract.accountCode ?? '' }); setErr(null); setResult(null); } }, [milestone?.id]);
  const run = useMutation({
    mutationFn: (v: InvoiceValues) => api<{ invoice: { id: string; voucherType: string } }>(`/api/contracts/${contract.id}/milestones/${milestone!.id}/invoice`, { method: 'POST', json: {
      postingDate: iso(v.postingDate), invoiceDate: iso(v.invoiceDate), invoiceGroupCode: v.invoiceGroupCode, ...(v.accountCode ? { accountCode: v.accountCode } : {}),
      ...(v.einvoiceSeriesId ? { einvoiceSeriesId: v.einvoiceSeriesId } : { invoiceNo: (v.invoiceNo ?? '').trim(), ...(text(v.serial) ? { serial: text(v.serial)! } : {}) }), ...(foreign && v.fxRate ? { fxRate: v.fxRate } : {}) } }),
    onError: (e) => setErr((e as Error).message), onSuccess: (r) => { setErr(null); setResult(r.invoice); onDone(); } });
  const submit = () => { void form.validateFields().then((v) => run.mutate(v), () => undefined); };
  return (
    <Modal open={!!milestone} title={milestone ? `Lập hóa đơn từ đợt ${milestone.seq}: ${milestone.description}` : ''} onCancel={onClose} destroyOnHidden forceRender
      footer={result ? <Button type="primary" onClick={onClose}>Đóng</Button> : [<Button key="c" onClick={onClose}>Bỏ qua</Button>, <Button key="s" type="primary" loading={run.isPending} onClick={submit}>Lập hóa đơn</Button>]}>
      {result ? <Alert type="success" showIcon data-testid="milestone-invoice-result" message={`Đã lập ${sale ? 'hóa đơn bán dịch vụ' : 'hóa đơn mua dịch vụ'} nháp`}
        description={<Link to="/chung-tu/$type/$id" params={{ type: result.voucherType, id: result.id }}>Mở hóa đơn để kiểm tra và ghi sổ</Link>} /> : milestone && (
        <Form form={form} layout="vertical" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLElement).closest('.ant-select')) { e.preventDefault(); submit(); } }}>
          <div style={{ marginBottom: 12 }}>Số tiền chưa thuế: <b>{money(milestone.amount, foreign ? 4 : 0)} {contract.currencyCode}</b> · Thuế GTGT: <b>{milestone.taxCode ?? contract.taxCode ?? 'không'}</b></div>
          <Space align="start" wrap>
            <Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
            <Form.Item label="Ngày hóa đơn" name="invoiceDate" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
            {foreign && <Form.Item label="Tỷ giá" name="fxRate" rules={[{ required: true, message: 'Nhập tỷ giá' }]}><VnNumberInput scale={4} aria-label="Tỷ giá" /></Form.Item>}
          </Space>
          <Space align="start" wrap>
            <Form.Item label="Nhóm kê khai (F4)" name="invoiceGroupCode" rules={[{ required: true, message: 'Chọn nhóm kê khai' }]}><LookupSelect catalog="invoice_group" fetcher={groupsOf} style={{ width: 200 }} aria-label="Nhóm kê khai" /></Form.Item>
            <Form.Item label={`TK ${sale ? 'doanh thu' : 'chi phí'} (F4)`} name="accountCode" rules={[{ required: true, message: 'Chọn tài khoản' }]}><LookupSelect catalog="account" fetcher={accounts} style={{ width: 170 }} aria-label="Tài khoản hạch toán" /></Form.Item>
          </Space>
          {sale && can('einvoice.view') && <Form.Item label="Ký hiệu HĐĐT" name="einvoiceSeriesId" extra="Để trống nếu dùng hóa đơn giấy hoặc nhập số tay.">
            <Select allowClear aria-label="Ký hiệu HĐĐT" style={{ maxWidth: 260 }} placeholder="Không dùng hóa đơn điện tử" options={(series.data ?? []).filter((x) => x.isActive).map((x) => ({ value: x.id, label: `${x.formNo}${x.serial}` }))} /></Form.Item>}
          {!seriesId && <Space align="start" wrap>
            <Form.Item label="Ký hiệu" name="serial"><Input maxLength={20} style={{ width: 120 }} /></Form.Item>
            <Form.Item label="Số hóa đơn" name="invoiceNo" rules={[{ required: true, whitespace: true, message: 'Nhập số hóa đơn' }]}><Input maxLength={30} style={{ width: 160 }} aria-label="Số hóa đơn" /></Form.Item>
          </Space>}
          {err && <Alert type="error" showIcon message={err} />}
        </Form>)}
    </Modal>);
}

interface TermValues { code: string; name: string; kind: Kind; partyCode: string | null; currencyCode: string; value: string | null; signedDate: dayjs.Dayjs | null; validFrom: dayjs.Dayjs | null; validTo: dayjs.Dayjs | null;
  status: string; accountCode: string | null; taxCode: string | null; note: string }
const dateOrNull = (d: dayjs.Dayjs | null | undefined) => (d ? iso(d) : null);

function ContractDrawer({ initial, onClose }: { initial: ContractRow | 'new'; onClose: () => void }) {
  const qc = useQueryClient(); const { can } = useAuth(); const { token } = theme.useToken();
  const [form] = Form.useForm<TermValues>();
  const [id, setId] = useState<number | null>(initial === 'new' ? null : initial.id);
  const [tab, setTab] = useState('terms'); const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<GridRow[]>([blankRow()]); const rowsRef = useRef(rows); rowsRef.current = rows;
  const [amends, setAmends] = useState<AmendRow[]>([blankAmend()]); const amendsRef = useRef(amends); amendsRef.current = amends;
  const [asOf, setAsOf] = useState(todayVn());
  const [pick, setPick] = useState<number | null>(null); const [invoicing, setInvoicing] = useState<Milestone | null>(null);
  const detail = useQuery({ queryKey: ['contract', id], enabled: id !== null, queryFn: () => api<ContractRow>(`/api/contracts/${id}`) });
  const c = detail.data;
  const canEdit = id === null ? can('order.create') : can('order.update');
  const kind = (Form.useWatch('kind', form) as Kind | undefined) ?? c?.kind ?? 'sale';
  const currency = (Form.useWatch('currencyCode', form) as string | undefined) ?? 'VND'; const dp = currency === 'VND' ? 0 : 4;
  const taxDefs = useTaxDefs(); const taxes = useMemo(() => taxFetcher(taxDefs.data ?? [], kind, true), [taxDefs.data, kind]);
  const accounts = useMemo(() => accountFetcherFor(), []);
  const refresh = () => { for (const k of ['contract', 'contracts', 'contract-track']) void qc.invalidateQueries({ queryKey: [k] }); };
  const canTrack = can('contract_track.view');
  const track = useQuery({ queryKey: ['contract-track', id, asOf], enabled: id !== null && canTrack && tab === 'track', retry: false,
    queryFn: () => api<Track & { milestones: (Milestone & { overdue: boolean })[] }>(`/api/contracts/${id}/track?asOf=${asOf}`) });

  useEffect(() => {
    if (!c) { if (initial === 'new') form.setFieldsValue({ kind: 'sale', currencyCode: 'VND', status: 'active', value: '0' }); return; }
    form.setFieldsValue({ code: c.code, name: c.name, kind: c.kind, partyCode: c.partyCode, currencyCode: c.currencyCode, value: D(c.value).toFixed(0), signedDate: c.signedDate ? dayjs(c.signedDate) : null,
      validFrom: c.validFrom ? dayjs(c.validFrom) : null, validTo: c.validTo ? dayjs(c.validTo) : null, status: c.status, accountCode: c.accountCode, taxCode: c.taxCode, note: c.note ?? '' });
    setRows([...(c.milestones ?? []).map((m) => toGrid(m, c.currencyCode === 'VND' ? 0 : 4)), ...(canEdit ? [blankRow()] : [])]);
    setAmends([...(c.amendments ?? []).map((a) => ({ id: String(a.id), seq: String(a.seq), amendmentNo: a.amendmentNo ?? '', signedDate: a.signedDate, description: a.description, valueChange: a.valueChange, note: a.note ?? '' })),
      ...(canEdit ? [blankAmend()] : [])]);
  }, [c?.id, detail.dataUpdatedAt]);

  const save = useMutation({
    mutationFn: async (v: TermValues) => {
      const body = { code: v.code.trim(), name: v.name.trim(), kind: v.kind, partyCode: v.partyCode || null, currencyCode: (v.currencyCode || 'VND').toUpperCase(), value: v.value || '0',
        signedDate: dateOrNull(v.signedDate), validFrom: dateOrNull(v.validFrom), validTo: dateOrNull(v.validTo), status: v.status, accountCode: v.accountCode || null, taxCode: v.taxCode || null, note: text(v.note) };
      const saved = await (id === null ? api<ContractRow>('/api/contracts', { method: 'POST', json: body }) : api<ContractRow>(`/api/contracts/${id}`, { method: 'PUT', json: body }));
      const ms = rowsRef.current.filter((r) => r.id || r.description.trim() || r.amount || r.percent);
      ms.forEach((r, i) => { if (!r.description.trim()) throw new Error(`Đợt dòng ${i + 1}: nhập nội dung đợt`); if (!r.amount && !r.percent) throw new Error(`Đợt dòng ${i + 1}: nhập tỷ lệ hoặc số tiền`); });
      await api(`/api/contracts/${saved.id}/milestones`, { method: 'PUT', json: { milestones: ms.map((r, i) => ({ ...(r.id ? { id: Number(r.id) } : {}), seq: Number(r.seq) || i + 1, description: r.description.trim(),
        dueDate: r.dueDate || null, percent: r.percent || null, amount: r.amount || null, taxCode: r.taxCode.trim() || null, status: r.status === CANCELLED ? 'cancelled' : 'planned' })) } });
      const am = amendsRef.current.filter((r) => r.id || r.description.trim() || r.valueChange || r.signedDate);
      am.forEach((r, i) => { if (!r.description.trim() || !r.signedDate) throw new Error(`Phụ lục dòng ${i + 1}: nhập ngày ký và nội dung`); });
      await api(`/api/contracts/${saved.id}/amendments`, { method: 'PUT', json: { amendments: am.map((r, i) => ({ ...(r.id ? { id: Number(r.id) } : {}), seq: Number(r.seq) || i + 1,
        amendmentNo: r.amendmentNo.trim() || null, signedDate: r.signedDate, description: r.description.trim(), valueChange: r.valueChange || '0', note: r.note.trim() || null })) } });
      return saved;
    },
    onError: (e) => setErr((e as Error).message), onSuccess: (r) => { setErr(null); setId(r.id); void message.success('Đã lưu hợp đồng'); refresh(); } });
  const submit = () => { void form.validateFields().then((v) => save.mutate(v), () => setTab('terms')); };
  const remove = useMutation({ mutationFn: () => api(`/api/contracts/${id}`, { method: 'DELETE' }), onError: (e) => void message.error((e as Error).message), onSuccess: () => { void message.success('Đã xóa hợp đồng'); refresh(); onClose(); } });
  const onKey = (e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !(e.target as HTMLElement).closest('.ant-modal')) { e.preventDefault(); if (canEdit) submit(); } };

  const terms = (
    <Form form={form} layout="vertical" disabled={!canEdit}>
      <Space align="start" wrap>
        <Form.Item label="Số hợp đồng" name="code" rules={[{ required: true, whitespace: true, message: 'Nhập số hợp đồng' }]}><Input maxLength={50} autoFocus aria-label="Số hợp đồng" /></Form.Item>
        <Form.Item label="Tên hợp đồng" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên hợp đồng' }]}><Input maxLength={255} style={{ width: 320 }} aria-label="Tên hợp đồng" /></Form.Item>
        <Form.Item label="Loại" name="kind"><Select style={{ width: 110 }} aria-label="Loại hợp đồng" options={[{ value: 'sale', label: 'Bán' }, { value: 'purchase', label: 'Mua' }]} /></Form.Item>
        <Form.Item label={kind === 'sale' ? 'Khách hàng (F4)' : 'Nhà cung cấp (F4)'} name="partyCode"><LookupSelect catalog="party" allowClear style={{ width: 240 }} aria-label="Đối tác" /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Loại tiền (F4)" name="currencyCode" rules={[{ required: true }]}><LookupSelect catalog="currency" style={{ width: 100 }} /></Form.Item>
        <Form.Item label={`Giá trị hợp đồng${currency !== 'VND' ? ` (${currency})` : ''}`} name="value"><VnNumberInput scale={0} aria-label="Giá trị hợp đồng" /></Form.Item>
        <Form.Item label="Ngày ký" name="signedDate"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Hiệu lực từ" name="validFrom"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Hiệu lực đến" name="validTo"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Trạng thái" name="status"><Select style={{ width: 140 }} aria-label="Trạng thái" options={['draft', 'active', 'completed', 'cancelled'].map((s) => ({ value: s, label: STATUS_LABEL[s] }))} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label={`TK ${kind === 'sale' ? 'doanh thu' : 'chi phí'} mặc định (F4)`} name="accountCode" tooltip="Dùng khi lập hóa đơn từ đợt"><LookupSelect catalog="account" fetcher={accounts} allowClear style={{ width: 180 }} aria-label="TK mặc định" /></Form.Item>
        <Form.Item label="Thuế GTGT mặc định (F4)" name="taxCode" tooltip="Đợt không ghi thuế thì lấy thuế này"><LookupSelect catalog="tax_code" fetcher={taxes} allowClear style={{ width: 180 }} aria-label="Thuế GTGT mặc định" /></Form.Item>
      </Space>
      <Form.Item label="Ghi chú" name="note"><Input.TextArea rows={2} maxLength={1000} /></Form.Item>
    </Form>);

  // Hủy/khôi phục đợt chưa lập hóa đơn: đổi trạng thái dòng trong lưới rồi lưu cả hợp đồng như Ctrl+S.
  const toggleCancel = (mid: number) => {
    const next = rowsRef.current.map((r) => (r.id === String(mid) ? { ...r, status: r.status === CANCELLED ? PLANNED : CANCELLED } : r));
    rowsRef.current = next; setRows(next); submit();
  };
  const editableIfOpen = (p: EditableCallbackParams<GridRow>) => !p.data?.invoiced;
  const cols = useMemo<ColDef<GridRow>[]>(() => [
    { field: 'seq', headerName: 'STT', width: 70, valueParser: numParser(/^\d{1,4}$/) },
    { field: 'description', headerName: 'Nội dung đợt', flex: 1, minWidth: 200 },
    { field: 'dueDate', headerName: 'Ngày dự kiến', width: 130, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : ''),
      valueParser: (p) => { const t = String(p.newValue ?? '').trim(); return t === '' ? '' : parseVnDate(t) ?? p.oldValue; } },
    { field: 'percent', headerName: 'Tỷ lệ (%)', width: 100, cellClass: 'ag-right-aligned-cell', editable: editableIfOpen,
      valueSetter: (p) => { const v = numParser(/^\d{1,3}(\.\d{1,4})?$/)({ newValue: p.newValue, oldValue: p.oldValue }) as string; if (v === p.oldValue) return false; p.data.percent = v; if (v) p.data.amount = ''; return true; } },
    { field: 'amount', headerName: `Số tiền chưa thuế${currency !== 'VND' ? ` (${currency})` : ''}`, width: 180, cellClass: 'ag-right-aligned-cell', editable: editableIfOpen,
      headerTooltip: 'Bỏ trống: tính theo tỷ lệ × giá trị hợp đồng khi lưu', valueFormatter: (p) => (p.value ? formatVnNumber(p.value as string, dp) : ''), valueParser: numParser(dp ? /^\d{1,16}(\.\d{1,4})?$/ : /^\d{1,16}$/) },
    { field: 'taxCode', headerName: 'Thuế GTGT (F4)', width: 130, editable: editableIfOpen },
    { field: 'status', headerName: 'Trạng thái', width: 110, editable: false, headerTooltip: 'Hủy đợt hoặc khôi phục bằng nút ở bảng theo dõi bên dưới' },
    { field: 'invoice', headerName: 'Hóa đơn', width: 220, editable: false },
  ], [currency, dp]);
  const ms = c?.milestones ?? [];
  const remaining = c ? D(c.value).minus(c.milestoneTotal) : D(0);
  const mayInvoice = can('order.update') && can('voucher.create') && c?.status === 'active';
  const milestonesTab = (<>
    <KeyboardGrid<GridRow> rows={rows} columns={cols} onRowsChange={setRows} addRowTemplate={blankRow} readOnly={!canEdit} height={260}
      onLookup={(col, row) => { if (col === 'taxCode' && !rowsRef.current[row]?.invoiced) setPick(row); }} />
    <div style={{ margin: '6px 0 12px' }}>Enter/Tab sang ô kế, Insert thêm dòng, F4 chọn thuế. Lưu (Ctrl+S) lưu cả hợp đồng và danh sách đợt; đợt đã lập hóa đơn chỉ sửa được nội dung, ngày, STT.</div>
    {c && <div style={{ marginBottom: 8 }} data-testid="contract-summary">Giá trị: <b>{money(c.value)}</b> · Tổng các đợt: <b>{money(c.milestoneTotal, dp)}</b> · Đã lập hóa đơn: <b>{money(c.invoicedTotal, dp)}</b> ({c.invoicedCount}/{c.milestoneCount} đợt)
      {D(c.value).gt(0) && !remaining.isZero() && <Tag color="orange" style={{ marginLeft: 8 }}>{remaining.gt(0) ? `Chưa chia đợt ${money(remaining.toString(), dp)}` : `Các đợt vượt giá trị ${money(remaining.abs().toString(), dp)}`}</Tag>}</div>}
    {c && c.status !== 'active' && ms.some((m) => m.status === 'planned') && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Chỉ lập hóa đơn từ đợt khi hợp đồng ở trạng thái Hiệu lực" />}
    <Table<Milestone> size="small" rowKey="id" dataSource={ms} pagination={false} data-testid="milestone-table" locale={{ emptyText: id === null ? 'Lưu hợp đồng để nhập đợt thanh toán' : 'Chưa có đợt thanh toán' }}
      columns={[{ title: 'STT', dataIndex: 'seq', width: 60 }, { title: 'Nội dung', dataIndex: 'description' }, { title: 'Ngày dự kiến', dataIndex: 'dueDate', width: 110, render: (d: string | null) => (d ? formatVnDate(d) : '') },
        { title: 'Số tiền chưa thuế', dataIndex: 'amount', align: 'right', width: 150, render: (s: string) => money(s, dp) },
        { title: 'Tình trạng', width: 130, render: (_, m) => (m.status === 'invoiced' ? <Tag color="green">Đã lập hóa đơn</Tag> : m.status === 'cancelled' ? <Tag>Hủy đợt</Tag> : <Tag color="orange">Chưa lập hóa đơn</Tag>) },
        { title: 'Hóa đơn', width: 230, render: (_, m) => (m.voucherId ? <Link to="/chung-tu/$type/$id" params={{ type: m.voucherType!, id: m.voucherId }}>{`${m.voucherType} ${m.voucherNo ?? '(chưa cấp số)'} - ${STATE_LABEL[m.voucherState ?? ''] ?? ''}`}</Link>
          : <Space size={4}>{m.status === 'planned' && mayInvoice && <Button size="small" onClick={() => setInvoicing(m)}>Lập hóa đơn từ đợt</Button>}
            {canEdit && <Button size="small" type="link" onClick={() => toggleCancel(m.id)}>{m.status === 'cancelled' ? 'Khôi phục đợt' : 'Hủy đợt'}</Button>}</Space>) }]} />
  </>);
  const amendCols = useMemo<ColDef<AmendRow>[]>(() => [
    { field: 'seq', headerName: 'STT', width: 70, valueParser: numParser(/^\d{1,4}$/) },
    { field: 'amendmentNo', headerName: 'Số phụ lục', width: 120 },
    { field: 'signedDate', headerName: 'Ngày ký', width: 120, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : ''),
      valueParser: (p) => { const t = String(p.newValue ?? '').trim(); return t === '' ? '' : parseVnDate(t) ?? p.oldValue; } },
    { field: 'description', headerName: 'Nội dung', flex: 1, minWidth: 200 },
    { field: 'valueChange', headerName: `Tăng (+) / giảm (−) giá trị${currency !== 'VND' ? ` (${currency})` : ''}`, width: 200, cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p) => (p.value ? formatVnNumber(p.value as string) : ''), valueParser: numParser(/^-?\d{1,16}$/) },
    { field: 'note', headerName: 'Ghi chú', width: 160 },
  ], [currency]);
  const adjusted = (c?.amendments ?? []).reduce((x, a) => x.plus(a.valueChange), D(c?.value ?? 0));
  const amendmentsTab = (<>
    <KeyboardGrid<AmendRow> rows={amends} columns={amendCols} onRowsChange={setAmends} addRowTemplate={blankAmend} readOnly={!canEdit} height={220} />
    <div style={{ margin: '6px 0' }}>Phụ lục ghi phần giá trị tăng (số dương) hoặc giảm (số âm); phụ lục chỉ gia hạn để 0. Lưu (Ctrl+S) lưu cùng hợp đồng.</div>
    {c && <div data-testid="amendment-summary">Giá trị ký: <b>{money(c.value)}</b> · Giá trị sau phụ lục: <b>{money(adjusted.toString())}</b></div>}
  </>);
  const t = track.data;
  const stat = (label: string, v: string | null | undefined, d = 0) => <span key={label}>{label}: <b>{v === null || v === undefined ? '—' : money(v, d)}</b></span>;
  const trackTab = (<Space direction="vertical" style={{ width: '100%' }} data-testid="contract-track">
    <Space wrap><span>Tại ngày</span><DatePicker format="DD/MM/YYYY" allowClear={false} aria-label="Theo dõi tại ngày" value={dayjs(asOf)} onChange={(d) => d && setAsOf(d.format('YYYY-MM-DD'))} /></Space>
    {track.error && <Alert type="error" showIcon message={(track.error as Error).message} />}
    {t && <>
      <Space size="large" wrap>{stat('Giá trị (gồm phụ lục)', t.adjustedValue)}{stat(c?.kind === 'purchase' ? 'Đã nhận hóa đơn' : 'Đã xuất hóa đơn', t.invoiced, dp)}{stat('Còn lại', t.remainingValue, dp)}
        <span>Thực hiện: <b data-testid="track-pct">{t.performedPct === null ? '—' : `${formatVnNumber(t.performedPct, 2)}%`}</b></span></Space>
      {t.debtHidden ? <Alert type="info" showIcon message="Không có quyền xem công nợ của hợp đồng này" />
        : <Space size="large" wrap>{stat('Phát sinh công nợ', t.debtIncurred)}{stat(c?.kind === 'purchase' ? 'Đã trả' : 'Đã thu', t.settled)}
          {stat(c?.kind === 'purchase' ? 'Còn phải trả' : 'Còn phải thu', t.outstanding)}<span>Quá hạn: <b data-testid="track-overdue" style={D(t.overdueDebt ?? 0).gt(0) ? { color: token.colorError } : undefined}>{money(t.overdueDebt)}</b></span></Space>}
      {t.overdueMilestoneCount > 0 && <Alert type="warning" showIcon message={`${t.overdueMilestoneCount} đợt đã quá ngày dự kiến mà chưa có hóa đơn ghi sổ (${money(t.overdueMilestoneAmount, dp)} ${c?.currencyCode ?? ''})`} />}
      <Table<Milestone & { overdue: boolean }> size="small" rowKey="id" dataSource={t.milestones} pagination={false}
        columns={[{ title: 'STT', dataIndex: 'seq', width: 60 }, { title: 'Nội dung', dataIndex: 'description' }, { title: 'Ngày dự kiến', dataIndex: 'dueDate', width: 110, render: (d: string | null) => (d ? formatVnDate(d) : '') },
          { title: 'Số tiền chưa thuế', dataIndex: 'amount', align: 'right', width: 150, render: (x: string) => money(x, dp) },
          { title: 'Tình trạng', width: 160, render: (_, m) => (m.status === 'invoiced' ? <Tag color="green">Đã lập hóa đơn</Tag> : m.status === 'cancelled' ? <Tag>Hủy đợt</Tag> : m.overdue ? <Tag color="red">Quá hạn lập hóa đơn</Tag> : <Tag color="orange">Chưa đến hạn</Tag>) }]} />
    </>}
  </Space>);
  return (
    <Drawer open width={1000} title={id === null ? 'Thêm hợp đồng' : `Hợp đồng ${c?.code ?? ''}`} onClose={onClose} destroyOnHidden
      extra={<Space>{id !== null && can('order.delete') && <Popconfirm title="Xóa hợp đồng này?" okText="Xóa" cancelText="Không" onConfirm={() => remove.mutate()}><Button danger>Xóa</Button></Popconfirm>}
        {canEdit && <Button type="primary" onClick={submit} loading={save.isPending}>Lưu (Ctrl+S)</Button>}</Space>}>
      <div onKeyDown={onKey}>
        {c && <div style={{ marginBottom: 8 }}>{KIND_LABEL[c.kind]} · <Tag color={STATUS_COLOR[c.status] ?? 'default'}>{STATUS_LABEL[c.status] ?? c.status}</Tag></div>}
        {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
        <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'terms', label: 'Thông tin hợp đồng', children: terms }, { key: 'milestones', label: 'Đợt thanh toán', forceRender: true, children: milestonesTab },
          { key: 'amendments', label: 'Phụ lục', forceRender: true, children: amendmentsTab }, ...(id !== null && canTrack ? [{ key: 'track', label: 'Theo dõi', children: trackTab }] : [])]} />
      </div>
      <PickDialog open={pick !== null} catalog="tax_code" fetcher={taxes} onClose={() => setPick(null)}
        onPick={(code) => setRows((rs) => rs.map((r, i) => (i === pick ? { ...r, taxCode: code } : r)))} />
      {c && <InvoiceDialog contract={c} milestone={invoicing} onClose={() => setInvoicing(null)} onDone={refresh} />}
    </Drawer>);
}

export default function ContractsPage() {
  const { me, can } = useAuth();
  const [f, setF] = useRememberedFilter('contracts', { q: '', kind: '' as string, status: '' as string }, `${me?.tenantId}:${me?.userId}`);
  const [open, setOpen] = useState<ContractRow | 'new' | null>(null);
  const list = useQuery({ queryKey: ['contracts'], queryFn: () => api<ContractRow[]>('/api/contracts') });
  const k = f.q.trim().toLowerCase();
  const rows = (list.data ?? []).filter((r) => (!f.kind || r.kind === f.kind) && (!f.status || r.status === f.status) && (!k || r.code.toLowerCase().includes(k) || r.name.toLowerCase().includes(k) || (r.partyName ?? '').toLowerCase().includes(k)));
  useHotkeys({ Insert: () => { if (can('order.create') && !open) setOpen('new'); } });
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Hợp đồng</h2>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search placeholder="Tìm theo số, tên, đối tác" allowClear defaultValue={f.q} onSearch={(q) => setF({ ...f, q })} style={{ width: 260 }} />
        <Select style={{ width: 130 }} value={f.kind} onChange={(kind) => setF({ ...f, kind })} aria-label="Lọc loại" options={[{ value: '', label: 'Bán và mua' }, { value: 'sale', label: 'Hợp đồng bán' }, { value: 'purchase', label: 'Hợp đồng mua' }]} />
        <Select style={{ width: 150 }} value={f.status} onChange={(status) => setF({ ...f, status })} aria-label="Lọc trạng thái" options={[{ value: '', label: 'Mọi trạng thái' }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />
        {can('order.create') && <Button type="primary" onClick={() => setOpen('new')}>Thêm (Insert)</Button>}
      </Space>
      {list.error && <Alert type="error" showIcon message={(list.error as Error).message} style={{ marginBottom: 8 }} />}
      <Table<ContractRow> size="small" rowKey="id" loading={list.isLoading} dataSource={rows} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="contracts-table" locale={{ emptyText: 'Chưa có hợp đồng' }}
        onRow={(r) => ({ onClick: () => setOpen(r), tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter') setOpen(r); }, style: { cursor: 'pointer' } })}
        columns={[{ title: 'Số hợp đồng', dataIndex: 'code', width: 130 }, { title: 'Tên', dataIndex: 'name' }, { title: 'Loại', dataIndex: 'kind', width: 70, render: (s: Kind) => KIND_LABEL[s] },
          { title: 'Đối tác', dataIndex: 'partyName' }, { title: 'Tiền', dataIndex: 'currencyCode', width: 60 }, { title: 'Giá trị', dataIndex: 'value', align: 'right', render: (s: string) => money(s) },
          { title: 'Đã lập hóa đơn', dataIndex: 'invoicedTotal', align: 'right', render: (s: string, r) => money(s, r.currencyCode === 'VND' ? 0 : 4) },
          { title: 'Chưa lập hóa đơn', align: 'right', render: (_, r) => money(D(r.milestoneTotal).minus(r.invoicedTotal).toString(), r.currencyCode === 'VND' ? 0 : 4) },
          { title: 'Đợt', width: 80, render: (_, r) => `${r.invoicedCount}/${r.milestoneCount}` },
          { title: 'Hiệu lực đến', dataIndex: 'validTo', width: 110, render: (d: string | null) => (d ? formatVnDate(d) : '') },
          { title: 'Trạng thái', dataIndex: 'status', width: 110, render: (s: string) => <Tag color={STATUS_COLOR[s] ?? 'default'}>{STATUS_LABEL[s] ?? s}</Tag> }]} />
      {open && <ContractDrawer initial={open} onClose={() => setOpen(null)} />}
    </div>);
}
