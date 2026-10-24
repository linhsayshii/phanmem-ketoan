import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Upload, message } from 'antd';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useHotkeys, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import { PickDialog, groupFetcher, taxFetcher, useInvoiceGroups, useTaxDefs } from './voucherCommon.js';

// Hóa đơn đầu vào: tải XML/zip, xem chi tiết, lập chứng từ mua hàng (HDM/MH) với ánh xạ dòng được nhớ theo người bán.
interface Row {
  id: number; status: string; invoiceNo: string; serial: string; issueDate: string | null; sellerTaxCode: string | null; sellerName: string | null; currency: string | null; total: string | null;
  buyerMatches: boolean | null; blocked: boolean; voucherId: string | null; voucherType: string | null; signature: 'none' | 'valid' | 'invalid'; warningCount: number;
}
interface Warning { code: string; message: string }
interface Detail extends Omit<Row, 'warningCount' | 'signature'> {
  formNo: string; sellerAddress: string | null; buyerName: string | null; buyerTaxCode: string | null; totalBeforeTax: string | null; totalTax: string | null; warnings: Warning[];
  lines: { lineNo: number; kind: string; code: string | null; name: string; uom: string | null; quantity: string | null; unitPrice: string | null; amount: string | null; taxRate: string | null }[];
}
interface Proposal {
  partyCode: string | null; sellerName: string | null; sellerTaxCode: string | null; blocked: boolean; status: string; voucherType: 'HDM' | 'MH';
  lines: { lineNo: number; kind: string; name: string; amount: string | null; taxRate: string | null; itemCode: string | null; accountCode: string | null; taxCode: string | null; source: 'map' | 'guess' }[];
}
interface Result { file: string; status: 'new' | 'duplicate' | 'skipped' | 'error'; id?: number; error?: { code: string; message: string } }
interface GridLine { lineNo: number; name: string; amount: string | null; taxRate: string | null; accountCode: string; itemCode: string; taxCode: string; source: string; convert: boolean }
// Máy chủ chỉ lập dòng hàng, hoặc dòng khuyến mại có thành tiền > 0; dòng khác không cần tài khoản.
const converts = (l: Proposal['lines'][number]) => l.kind === 'goods' || (l.kind === 'promotion' && /[1-9]/.test(l.amount ?? ''));
const GRID_CATALOG: Record<string, string> = { accountCode: 'account', itemCode: 'item', taxCode: 'tax_code' };

const STATUS: Record<string, { label: string; color: string }> = {
  new: { label: 'Mới', color: 'blue' }, voucher_created: { label: 'Đã lập chứng từ', color: 'green' }, ignored: { label: 'Đã bỏ qua', color: 'default' }, duplicate: { label: 'Trùng', color: 'orange' },
};
const RESULT_LABEL: Record<Result['status'], { label: string; color: string }> = {
  new: { label: 'Mới', color: 'green' }, duplicate: { label: 'Trùng', color: 'orange' }, skipped: { label: 'Bỏ qua', color: 'default' }, error: { label: 'Lỗi', color: 'red' },
};
const SIG: Record<Row['signature'], { label: string; color: string; tip: string }> = {
  valid: { label: 'Hợp lệ', color: 'green', tip: 'Chữ ký hợp lệ (chưa kiểm CA): đã đối chiếu chữ ký với nội dung, chưa kiểm chuỗi chứng thư số' },
  invalid: { label: 'Không hợp lệ', color: 'red', tip: 'Chữ ký số không khớp nội dung hóa đơn' },
  none: { label: 'Không có', color: 'default', tip: 'Tệp XML không có chữ ký người bán' },
};
const money = (v: string | null) => (v === null ? '' : formatVnNumber(v));

function VoucherDialog({ id, onClose, onDone }: { id: number | null; onClose: () => void; onDone: (voucherId: string, type: string) => void }) {
  const { can } = useAuth();
  const [form] = Form.useForm();
  const [rows, setRows] = useState<GridLine[]>([]);
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const p = useQuery({ queryKey: ['inbound-proposal', id], enabled: id !== null, queryFn: () => api<Proposal>(`/api/inbound-invoices/${id}/proposal`) });
  const prop = p.data;
  const defs = useTaxDefs(); const groups = useInvoiceGroups();
  const accounts = useMemo(() => accountFetcherFor(), []);
  const taxes = useMemo(() => taxFetcher(defs.data ?? [], 'purchase'), [defs.data]);
  const groupsOf = useMemo(() => groupFetcher(groups.data ?? [], 'purchase'), [groups.data]);
  useEffect(() => { setRows((prop?.lines ?? []).map((l) => ({ lineNo: l.lineNo, name: l.name, amount: l.amount, taxRate: l.taxRate, accountCode: l.accountCode ?? '', itemCode: l.itemCode ?? '', taxCode: l.taxCode ?? '', source: l.source, convert: converts(l) }))); }, [prop]);
  const columns = useMemo<ColDef<GridLine>[]>(() => [
    { field: 'lineNo', headerName: 'Dòng', width: 70, editable: false },
    { field: 'name', headerName: 'Tên hàng hóa, dịch vụ', flex: 1, minWidth: 200, editable: false },
    { field: 'amount', headerName: 'Thành tiền', width: 120, editable: false, type: 'rightAligned', valueFormatter: (p) => money((p.value as string | null) ?? null) },
    { field: 'taxRate', headerName: 'TS', width: 70, editable: false, valueFormatter: (p) => (p.value ? `${p.value as string}%` : '') },
    { colId: 'accountCode', field: 'accountCode', headerName: 'Tài khoản (F4)', width: 140, editable: (p) => !!p.data?.convert },
    { colId: 'itemCode', field: 'itemCode', headerName: 'Mã hàng (F4)', width: 130, editable: (p) => !!p.data?.convert },
    { colId: 'taxCode', field: 'taxCode', headerName: 'Mã thuế (F4)', width: 120, editable: (p) => !!p.data?.convert },
    { field: 'source', headerName: '', width: 70, editable: false, valueFormatter: (p) => (p.value === 'map' ? 'Nhớ' : '') , headerTooltip: 'Nhớ: lấy từ lần nhập trước của cùng người bán' },
  ], []);
  const lookupFetcher = lookup?.col === 'accountCode' ? accounts : lookup?.col === 'taxCode' ? taxes : undefined;
  const run = useMutation({
    mutationFn: (v: { postingDate: dayjs.Dayjs; invoiceGroupCode: string; voucherType: string; partyCode?: string; createParty?: boolean; counterAccountCode?: string; description?: string }) => api<{ voucherId: string }>(`/api/inbound-invoices/${id}/voucher`, {
      method: 'POST', json: {
        voucherType: v.voucherType, postingDate: v.postingDate.format('YYYY-MM-DD'), invoiceGroupCode: v.invoiceGroupCode,
        ...(v.createParty ? { createParty: true } : v.partyCode ? { partyCode: v.partyCode } : {}), ...(v.counterAccountCode ? { counterAccountCode: v.counterAccountCode } : {}), ...(v.description ? { description: v.description } : {}),
        lines: rows.filter((e) => e.convert).map((e) => ({ lineNo: e.lineNo, ...(e.itemCode.trim() ? { itemCode: e.itemCode.trim() } : {}), ...(e.accountCode.trim() ? { accountCode: e.accountCode.trim() } : {}), ...(e.taxCode.trim() ? { taxCode: e.taxCode.trim() } : {}) })),
      } }),
    onSuccess: (r, v) => { message.success('Đã lập chứng từ mua hàng (nháp)'); onDone(r.voucherId, v.voucherType); },
    onError: (e: Error) => message.error(e.message),
  });
  const missing = !!prop && rows.some((l) => l.convert && !l.accountCode.trim());
  const submit = () => { if (prop && !prop.blocked && !missing && !run.isPending) form.submit(); };
  // useHotkeys bỏ qua phím khi tiêu điểm ở trong hộp thoại, nên Ctrl+S của hộp thoại này tự nghe ở cửa sổ.
  const go = useRef(submit); go.current = submit;
  useEffect(() => {
    if (id === null) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); go.current(); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [id]);
  return (
    <Modal title="Lập chứng từ mua hàng từ hóa đơn đầu vào" open={id !== null} onCancel={onClose} width={900} destroyOnHidden afterClose={() => form.resetFields()}
      footer={<Space><Button onClick={onClose}>Đóng</Button><Button type="primary" disabled={!prop || prop.blocked || missing} loading={run.isPending} onClick={submit}>Lập chứng từ (Ctrl+S)</Button></Space>}>
      <PickDialog open={!!lookup} catalog={lookup ? GRID_CATALOG[lookup.col]! : 'account'} {...(lookupFetcher ? { fetcher: lookupFetcher } : {})}
        onPick={(code) => { if (lookup) setRows((rs) => rs.map((r, i) => (i === lookup.row ? { ...r, [lookup.col]: code } : r))); }} onClose={() => setLookup(null)} />
      {prop?.blocked && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="Hóa đơn bị chặn, không lập được chứng từ" description="Số tiền trong tệp XML sai dạng hoặc vượt giới hạn: xem cảnh báo trong chi tiết hóa đơn." />}
      {prop && (
        <Form form={form} layout="vertical" onFinish={(v) => run.mutate(v)} initialValues={{ postingDate: dayjs(), invoiceGroupCode: '01', voucherType: prop.voucherType, partyCode: prop.partyCode ?? undefined, createParty: !prop.partyCode }}>
          <Space align="start" wrap>
            <Form.Item name="voucherType" label="Loại chứng từ"><Select style={{ width: 200 }} aria-label="Loại chứng từ" options={[{ value: 'HDM', label: 'Hóa đơn mua dịch vụ' }, { value: 'MH', label: 'Mua hàng' }]} /></Form.Item>
            <Form.Item name="postingDate" label="Ngày hạch toán" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" aria-label="Ngày hạch toán" /></Form.Item>
            <Form.Item name="invoiceGroupCode" label="Nhóm hóa đơn" rules={[{ required: true, message: 'Chọn nhóm' }]}><LookupSelect catalog="invoice_group" fetcher={groupsOf} aria-label="Nhóm hóa đơn" style={{ width: 160 }} /></Form.Item>
            <Form.Item name="partyCode" label={`Nhà cung cấp${prop.sellerName ? ` (${prop.sellerName})` : ''}`}><LookupSelect catalog="party" aria-label="Nhà cung cấp" style={{ width: 280 }} /></Form.Item>
            {can('catalog.create') && <Form.Item noStyle shouldUpdate={(a, b) => a.partyCode !== b.partyCode}>{() => !form.getFieldValue('partyCode') && (
              <Form.Item name="createParty" valuePropName="checked" label=" "><Checkbox>Tạo nhà cung cấp mới từ hóa đơn</Checkbox></Form.Item>)}</Form.Item>}
          </Space>
          <div style={{ marginBottom: 12 }}><KeyboardGrid<GridLine> rows={rows} columns={columns} onRowsChange={setRows} addRowTemplate={() => ({} as GridLine)} lockRows height={Math.min(320, 80 + 42 * rows.length)}
            onLookup={(col, row) => { if (col in GRID_CATALOG && rows[row]?.convert) setLookup({ col, row }); }} /></div>
          <Form.Item name="description" label="Diễn giải"><Input aria-label="Diễn giải" /></Form.Item>
        </Form>
      )}
    </Modal>
  );
}

function DetailDrawer({ id, onClose, onVoucher, onIgnore, mayEdit }: { id: number | null; onClose: () => void; onVoucher: (id: number) => void; onIgnore: (id: number) => void; mayEdit: boolean }) {
  const d = useQuery({ queryKey: ['inbound-invoice', id], enabled: id !== null, queryFn: () => api<Detail>(`/api/inbound-invoices/${id}`) });
  const x = d.data;
  const open = x && ['new', 'duplicate'].includes(x.status);
  return (
    <Drawer title={x ? `Hóa đơn ${x.formNo}${x.serial} số ${x.invoiceNo}` : 'Hóa đơn đầu vào'} open={id !== null} onClose={onClose} width={720} destroyOnHidden
      extra={x && mayEdit && open && (<Space>
        <Button onClick={() => onIgnore(x.id)}>Bỏ qua</Button>
        <Button type="primary" disabled={x.blocked || x.status !== 'new'} onClick={() => onVoucher(x.id)}>Lập chứng từ</Button></Space>)}>
      {x && (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        {x.blocked && <Alert type="error" showIcon message="Hóa đơn bị chặn: số tiền trong tệp XML sai dạng hoặc vượt giới hạn, không thể lập chứng từ" />}
        {x.warnings.map((w, i) => <Alert key={i} type="warning" showIcon message={w.message} description={w.code} />)}
        <Tag color={STATUS[x.status]?.color ?? 'default'}>{STATUS[x.status]?.label ?? x.status}</Tag>
        <Descriptions size="small" column={2} bordered items={[
          { key: 's', label: 'Người bán', children: x.sellerName ?? '' }, { key: 'm', label: 'MST người bán', children: x.sellerTaxCode ?? '' },
          { key: 'a', label: 'Địa chỉ', span: 2, children: x.sellerAddress ?? '' }, { key: 'b', label: 'Người mua', children: x.buyerName ?? '' }, { key: 'bm', label: 'MST người mua', children: x.buyerTaxCode ?? '' },
          { key: 'd', label: 'Ngày hóa đơn', children: x.issueDate ? formatVnDate(x.issueDate) : '' }, { key: 'c', label: 'Loại tiền', children: x.currency ?? '' },
          { key: 'bt', label: 'Cộng tiền hàng', children: money(x.totalBeforeTax) }, { key: 'tx', label: 'Tiền thuế', children: money(x.totalTax) }, { key: 't', label: 'Tổng thanh toán', span: 2, children: money(x.total) },
        ]} />
        <Table size="small" pagination={false} rowKey="lineNo" dataSource={x.lines} columns={[
          { title: 'STT', dataIndex: 'lineNo', width: 52 }, { title: 'Tên hàng hóa, dịch vụ', dataIndex: 'name', ellipsis: true },
          { title: 'ĐVT', dataIndex: 'uom', width: 60 }, { title: 'SL', dataIndex: 'quantity', width: 70, align: 'right', render: (v: string | null) => (v === null ? '' : formatVnNumber(v, 2)) },
          { title: 'Đơn giá', dataIndex: 'unitPrice', width: 100, align: 'right', render: money }, { title: 'Thành tiền', dataIndex: 'amount', width: 110, align: 'right', render: money },
          { title: 'TS', dataIndex: 'taxRate', width: 56, render: (v: string | null) => (v ? `${v}%` : '') },
        ]} />
      </Space>)}
    </Drawer>
  );
}

export default function InboundInvoicesPage() {
  const nav = useNavigate(); const qc = useQueryClient(); const { me, can } = useAuth();
  const [f, setF] = useRememberedFilter('inbound-invoices', { status: '', from: '', to: '', q: '' }, `${me?.tenantId}:${me?.userId}`);
  const [detail, setDetail] = useState<number | null>(null);
  const [convert, setConvert] = useState<number | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ['inbound-invoices', qs], queryFn: () => api<Row[]>(`/api/inbound-invoices?${qs}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['inbound-invoices'] }); void qc.invalidateQueries({ queryKey: ['inbound-invoice'] }); };
  const upload = useMutation({
    mutationFn: async (files: File[]) => { const fd = new FormData(); for (const x of files) fd.append('file', x, x.name); return api<{ results: Result[] }>('/api/inbound-invoices', { method: 'POST', body: fd }); },
    onSuccess: (r) => { setResults(r.results); refresh(); }, onError: (e: Error) => message.error(e.message),
  });
  const ignore = useMutation({ mutationFn: (id: number) => api(`/api/inbound-invoices/${id}/ignore`, { method: 'POST' }), onSuccess: () => { setDetail(null); refresh(); }, onError: (e: Error) => message.error(e.message) });
  const mayEdit = can('inbound_invoice.update') && can('voucher.create');
  useHotkeys({ Insert: () => { document.querySelector<HTMLInputElement>('.inbound-drop input[type=file]')?.click(); } });
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <h2 style={{ margin: 0 }}>Hóa đơn đầu vào</h2>
      {can('inbound_invoice.create') && (
        <div className="inbound-drop">
          <Upload.Dragger multiple accept=".xml,.zip" showUploadList={false} disabled={upload.isPending}
            beforeUpload={(file, all) => { if (file === all[0]) upload.mutate(all as unknown as File[]); return false; }}>
            <p style={{ margin: 0 }}>Kéo thả hoặc bấm để chọn nhiều tệp hóa đơn XML hoặc zip (phím Insert)</p>
          </Upload.Dragger>
        </div>)}
      {results.length > 0 && (
        <Table size="small" pagination={false} rowKey="file" dataSource={results} title={() => 'Kết quả tải lên'} columns={[
          { title: 'Tệp', dataIndex: 'file', ellipsis: true },
          { title: 'Kết quả', dataIndex: 'status', width: 100, render: (s: Result['status']) => <Tag color={RESULT_LABEL[s].color}>{RESULT_LABEL[s].label}</Tag> },
          { title: 'Ghi chú', width: 360, render: (_: unknown, r: Result) => r.error?.message ?? (r.status === 'duplicate' ? 'Hóa đơn đã có trong hệ thống' : '') },
          { title: '', width: 70, render: (_: unknown, r: Result) => (r.id ? <Button type="link" size="small" onClick={() => setDetail(r.id!)}>Xem</Button> : null) },
        ]} />)}
      <Space wrap>
        <Select aria-label="Trạng thái" allowClear placeholder="Trạng thái" style={{ width: 170 }} value={f.status || undefined} onChange={(v) => setF({ ...f, status: v ?? '' })}
          options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))} />
        <DatePicker.RangePicker format="DD/MM/YYYY" value={f.from && f.to ? [dayjs(f.from), dayjs(f.to)] : null} onChange={(r) => setF({ ...f, from: r?.[0]?.format('YYYY-MM-DD') ?? '', to: r?.[1]?.format('YYYY-MM-DD') ?? '' })} />
        <Input.Search aria-label="Tìm hóa đơn" allowClear placeholder="Người bán, MST, số hóa đơn" style={{ width: 280 }} defaultValue={f.q} onSearch={(q) => setF({ ...f, q })} />
      </Space>
      <Table size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 50, hideOnSinglePage: true }} onRow={(r) => ({ onDoubleClick: () => setDetail(r.id) })} columns={[
        { title: 'Ngày HĐ', dataIndex: 'issueDate', width: 100, render: (v: string | null) => (v ? formatVnDate(v) : '') },
        { title: 'Ký hiệu', dataIndex: 'serial', width: 90 }, { title: 'Số HĐ', dataIndex: 'invoiceNo', width: 100 },
        { title: 'Người bán', dataIndex: 'sellerName', ellipsis: true, render: (v: string | null, r) => (<span>{v}{r.sellerTaxCode ? <span style={{ color: 'var(--ant-color-text-secondary)' }}> ({r.sellerTaxCode})</span> : null}</span>) },
        { title: 'Tổng tiền', dataIndex: 'total', width: 120, align: 'right', render: (v: string | null, r) => (v === null ? '' : `${formatVnNumber(v)}${r.currency && r.currency !== 'VND' ? ` ${r.currency}` : ''}`) },
        { title: 'Chữ ký', dataIndex: 'signature', width: 110, render: (s: Row['signature']) => <Tooltip title={SIG[s].tip}><Tag color={SIG[s].color}>{SIG[s].label}</Tag></Tooltip> },
        { title: 'Trạng thái', dataIndex: 'status', width: 150, render: (s: string, r) => (<Space size={4}><Tag color={STATUS[s]?.color ?? 'default'}>{STATUS[s]?.label ?? s}</Tag>{r.blocked && <Tag color="red">Bị chặn</Tag>}{r.warningCount > 0 && <Tooltip title="Có cảnh báo: mở chi tiết để xem"><Tag color="gold">{r.warningCount}</Tag></Tooltip>}</Space>) },
        { title: '', width: 150, render: (_: unknown, r) => (<Space size={0}><Button type="link" size="small" onClick={() => setDetail(r.id)}>Chi tiết</Button>
          {r.voucherId && <Button type="link" size="small" onClick={() => void nav({ to: '/chung-tu/$type/$id', params: { type: r.voucherType ?? 'HDM', id: r.voucherId! } })}>Chứng từ</Button>}</Space>) },
      ]} />
      <DetailDrawer id={detail} mayEdit={mayEdit} onClose={() => setDetail(null)} onVoucher={(id) => setConvert(id)} onIgnore={(id) => ignore.mutate(id)} />
      <VoucherDialog id={convert} onClose={() => setConvert(null)} onDone={(vid, type) => { setConvert(null); setDetail(null); refresh(); void nav({ to: '/chung-tu/$type/$id', params: { type, id: vid } }); }} />
    </Space>
  );
}
