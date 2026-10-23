import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DatePicker, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate } from '@kt/domain';
import { KeyboardGrid, useHotkeys } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { symbolOf, type EInvoice } from './einvoiceCommon.js';

// Thông báo hóa đơn điện tử có sai sót, mẫu 04/SS-HĐĐT (TT 91/2026). Cột (8) Thông báo/Giải trình suy ra từ loại thông báo.
interface NoticeLine { einvoiceId: number | null; cqtCode: string | null; formNo: string; serial: string; invoiceNo: string; issueDate: string; invoiceType: string; action?: string; reason: string }
interface Notice { id: number; noticeKind: 'self' | 'tax_notice'; taxNoticeNo: string | null; taxNoticeDate: string | null; noticeDate: string; place: string; providerId: number | null; status: 'draft' | 'sent'; providerRef: string | null; lines: NoticeLine[] }
interface Provider { id: number; name: string; isActive: boolean }
const KIND_LABEL = { self: 'Người bán tự thông báo', tax_notice: 'Theo thông báo của CQT (01/TB-RSĐT)' } as const;
const emptyLine = (): NoticeLine => ({ einvoiceId: null, cqtCode: null, formNo: '', serial: '', invoiceNo: '', issueDate: '', invoiceType: '', reason: '' });
const fromInvoice = (e: EInvoice): Partial<NoticeLine> => ({ einvoiceId: e.id, cqtCode: e.cqtCode, formNo: e.formNo, serial: e.serial, invoiceNo: e.invoiceNo ?? '', issueDate: e.issueDate ?? '' });

export default function EInvoiceErrorNoticePage() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const [editing, setEditing] = useState<Notice | 'new' | null>(null);
  const [lines, setLines] = useState<NoticeLine[]>([emptyLine()]);
  const [pickRow, setPickRow] = useState<number | null>(null);
  const [kind, setKind] = useState<'self' | 'tax_notice'>('self');
  const list = useQuery({ queryKey: ['einvoice-notices'], queryFn: () => api<Notice[]>('/api/einvoice/error-notices') });
  const providers = useQuery({ queryKey: ['einvoice-providers'], queryFn: () => api<Provider[]>('/api/einvoice/providers') });
  const issued = useQuery({ queryKey: ['einvoices', 'issued-pick'], enabled: pickRow !== null || editing !== null, queryFn: () => api<EInvoice[]>('/api/einvoices?status=issued') });
  const draft = editing === 'new' || editing?.status === 'draft';
  const canEdit = can('einvoice.issue');

  const open = (n: Notice | 'new', firstLine?: Partial<NoticeLine>) => {
    setEditing(n); form.resetFields();
    if (n === 'new') { setKind('self'); form.setFieldsValue({ noticeKind: 'self', noticeDate: dayjs(), place: '', providerId: providers.data?.find((p) => p.isActive)?.id }); setLines([{ ...emptyLine(), ...firstLine }]); }
    else { setKind(n.noticeKind); form.setFieldsValue({ ...n, taxNoticeDate: n.taxNoticeDate ? dayjs(n.taxNoticeDate) : null, noticeDate: dayjs(n.noticeDate) }); setLines(n.lines.map((l) => ({ ...l, cqtCode: l.cqtCode ?? null }))); }
  };
  // Từ màn hình hóa đơn bấm "Lập 04/SS": /hoa-don-dien-tu/thong-bao-sai-sot?einvoice=<id>
  const preId = useMemo(() => Number(new URLSearchParams(window.location.search).get('einvoice')) || null, []);
  useEffect(() => {
    if (!preId || !providers.isSuccess) return;
    void api<EInvoice>(`/api/einvoices/${preId}`).then((e) => { open('new', fromInvoice(e)); window.history.replaceState(null, '', window.location.pathname); }).catch(() => undefined);
  }, [preId, providers.isSuccess]);

  const used = (l: NoticeLine) => !!l.einvoiceId || !!l.invoiceNo;
  const body = (v: Record<string, unknown>) => ({
    noticeKind: kind, ...(kind === 'tax_notice' ? { taxNoticeNo: v['taxNoticeNo'], taxNoticeDate: (v['taxNoticeDate'] as dayjs.Dayjs | null)?.format('YYYY-MM-DD') } : {}),
    noticeDate: (v['noticeDate'] as dayjs.Dayjs).format('YYYY-MM-DD'), place: v['place'] ?? '', ...(v['providerId'] ? { providerId: v['providerId'] } : {}),
    lines: lines.filter(used).map((l) => ({ ...(l.einvoiceId ? { einvoiceId: l.einvoiceId } : { formNo: l.formNo, serial: l.serial, invoiceNo: l.invoiceNo, issueDate: l.issueDate, cqtCode: l.cqtCode || null, invoiceType: l.invoiceType || undefined }),
      action: kind === 'self' ? 'notice' : 'explain', reason: l.reason })) });
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => (editing === 'new' ? api<Notice>('/api/einvoice/error-notices', { method: 'POST', json: body(v) }) : api<Notice>(`/api/einvoice/error-notices/${(editing as Notice).id}`, { method: 'PUT', json: body(v) })),
    onSuccess: (n) => { void qc.invalidateQueries({ queryKey: ['einvoice-notices'] }); setEditing(n); void message.success('Đã lưu thông báo'); }, onError: (e) => void message.error((e as Error).message) });
  const sendM = useMutation({
    mutationFn: (id: number) => api<Notice>(`/api/einvoice/error-notices/${id}/send`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-notices'] }); setEditing(null); void message.success('Đã gửi thông báo'); },
    onError: (e, id) => {
      if (e instanceof ApiError && e.code === 'PROVIDER_UNSUPPORTED') Modal.confirm({ title: 'Nhà cung cấp chưa hỗ trợ gửi thông báo', content: 'Nộp thông báo trên cổng thuế rồi đánh dấu đã gửi.', okText: 'Đánh dấu đã gửi', cancelText: 'Đóng', onOk: () => markM.mutateAsync(id) });
      else void message.error((e as Error).message); } });
  const markM = useMutation({
    mutationFn: (id: number) => api<Notice>(`/api/einvoice/error-notices/${id}/mark-sent`, { method: 'POST', json: {} }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-notices'] }); setEditing(null); void message.success('Đã đánh dấu đã gửi'); }, onError: (e) => void message.error((e as Error).message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/einvoice/error-notices/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einvoice-notices'] }); void message.success('Đã xóa thông báo'); }, onError: (e) => void message.error((e as Error).message) });
  const print = (id: number, format: 'pdf' | 'html') => window.open(`/api/einvoice/error-notices/${id}/print?format=${format}`, '_blank');

  const columns = useMemo<ColDef<NoticeLine>[]>(() => [
    { headerName: '(1) STT', width: 70, editable: false, valueGetter: (p) => (p.node?.rowIndex ?? 0) + 1 },
    { colId: 'invoiceNo', field: 'invoiceNo', headerName: '(3-5) Số hóa đơn (F4 chọn)', width: 190, editable: (p) => !p.data?.einvoiceId },
    { field: 'cqtCode', headerName: '(2) Mã của CQT', width: 220, editable: (p) => !p.data?.einvoiceId, valueGetter: (p) => p.data?.cqtCode ?? '', valueSetter: (p) => { p.data.cqtCode = p.newValue || null; return true; } },
    { field: 'formNo', headerName: 'Mẫu số', width: 80, editable: (p) => !p.data?.einvoiceId }, { field: 'serial', headerName: 'Ký hiệu', width: 100, editable: (p) => !p.data?.einvoiceId },
    { field: 'issueDate', headerName: '(6) Ngày lập', width: 120, editable: (p) => !p.data?.einvoiceId, valueFormatter: (p) => (p.value && /^\d{4}-/.test(p.value as string) ? formatVnDate(p.value as string) : (p.value as string)) },
    { field: 'invoiceType', headerName: '(7) Loại áp dụng', width: 150, editable: (p) => !p.data?.einvoiceId },
    { headerName: '(8) Thông báo/Giải trình', width: 170, editable: false, valueGetter: () => (kind === 'self' ? 'Thông báo' : 'Giải trình') },
    { field: 'reason', headerName: '(9) Lý do', flex: 1, minWidth: 220 }], [kind]);

  useHotkeys({ Insert: () => { if (editing === null && canEdit) open('new'); } });
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}><h2 style={{ margin: 0 }}>Thông báo hóa đơn điện tử có sai sót (04/SS-HĐĐT)</h2>
        {canEdit && <Button type="primary" onClick={() => open('new')}>Lập thông báo (Insert)</Button>}</Space>
      {list.error && <Alert type="error" showIcon message={(list.error as Error).message} />}
      <Table<Notice> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={false} locale={{ emptyText: 'Chưa có thông báo sai sót' }} columns={[
        { title: 'Ngày thông báo', dataIndex: 'noticeDate', width: 130, render: (v: string) => formatVnDate(v) }, { title: 'Loại', dataIndex: 'noticeKind', width: 280, render: (k: 'self' | 'tax_notice') => KIND_LABEL[k] },
        { title: 'Số hóa đơn', render: (_v, r) => r.lines.map((l) => `${l.formNo}${l.serial} ${l.invoiceNo}`).join('; ') },
        { title: 'Trạng thái', dataIndex: 'status', width: 120, render: (s: string) => (s === 'sent' ? <Tag color="green">Đã gửi</Tag> : <Tag>Nháp</Tag>) },
        { title: '', width: 160, render: (_v, r) => <Space size={0}><Button type="link" size="small" onClick={() => open(r)}>Mở</Button>{canEdit && r.status === 'draft' && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: 'Xóa thông báo nháp?', okText: 'Xóa', cancelText: 'Hủy', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button>}</Space> }]} />
      <Modal title={editing === 'new' ? 'Lập thông báo sai sót' : 'Thông báo sai sót'} open={editing !== null} onCancel={() => setEditing(null)} width={1100} destroyOnHidden forceRender
        footer={<Space>
          {editing && editing !== 'new' && <><Button onClick={() => print(editing.id, 'html')}>In (HTML)</Button><Button onClick={() => print(editing.id, 'pdf')}>In (PDF)</Button></>}
          {canEdit && editing && editing !== 'new' && editing.status === 'draft' && <><Button loading={sendM.isPending} onClick={() => sendM.mutate(editing.id)}>Gửi</Button><Button loading={markM.isPending} onClick={() => markM.mutate(editing.id)}>Đánh dấu đã gửi</Button></>}
          <Button onClick={() => setEditing(null)}>Đóng</Button>
          {canEdit && draft && <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Lưu</Button>}</Space>}>
        <Form form={form} layout="vertical" disabled={!draft || !canEdit} onFinish={(v) => { if (!lines.some(used)) { void message.error('Chọn ít nhất một hóa đơn'); return; } if (lines.filter(used).some((l) => !l.reason.trim())) { void message.error('Nhập lý do (9) cho mọi dòng'); return; } save.mutate(v); }}>
          <Space wrap align="start">
            <Form.Item name="noticeKind" label="Loại thông báo"><Select aria-label="Loại thông báo" style={{ width: 300 }} onChange={setKind} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
            {kind === 'tax_notice' && <><Form.Item name="taxNoticeNo" label="Số thông báo của CQT" rules={[{ required: true, whitespace: true, message: 'Nhập số thông báo' }]}><Input /></Form.Item>
              <Form.Item name="taxNoticeDate" label="Ngày thông báo của CQT" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></>}
            <Form.Item name="noticeDate" label="Ngày lập thông báo" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item>
            <Form.Item name="place" label="Địa danh"><Input /></Form.Item>
            <Form.Item name="providerId" label="Nhà cung cấp gửi"><Select allowClear aria-label="Nhà cung cấp gửi" style={{ width: 200 }} options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>
          </Space>
        </Form>
        <KeyboardGrid<NoticeLine> rows={lines} columns={columns} onRowsChange={setLines} addRowTemplate={emptyLine} height={260} readOnly={!draft || !canEdit} onLookup={(col, row) => { if (col === 'invoiceNo') setPickRow(row); }} />
      </Modal>
      <Modal title="Chọn hóa đơn đã phát hành" open={pickRow !== null} footer={null} onCancel={() => setPickRow(null)} destroyOnHidden>
        <Select showSearch autoFocus defaultOpen style={{ width: '100%' }} aria-label="Hóa đơn đã phát hành" optionFilterProp="label" loading={issued.isLoading}
          options={(issued.data ?? []).map((e) => ({ value: e.id, label: `${symbolOf(e)} ${e.invoiceNo ?? ''} - ${e.issueDate ? formatVnDate(e.issueDate) : ''} - ${e.buyerName ?? ''}` }))}
          onChange={(id: number) => { const e = issued.data?.find((x) => x.id === id); if (e && pickRow !== null) setLines(lines.map((l, i) => (i === pickRow ? { ...l, ...fromInvoice(e) } : l))); setPickRow(null); }} />
      </Modal>
    </Space>
  );
}
