import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DatePicker, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { COLOR, EmptyState, PageHeader, Section, Toolbar, useRememberedFilter } from '@kt/ui';
import { api, apiBlob } from '../api/client.js';
import { useAuth } from '../auth.js';
import { ORPHAN_ACTIONS, RELATION_LABEL, STATUS_LABEL, StatusTags, canCancel, cqtPending, reportEInvoiceError, showWarnings, symbolOf, type EInvoice, type EInvoiceLog } from './einvoiceCommon.js';

// Danh sách hóa đơn điện tử: tra cứu, phát hành lại, tra mã cơ quan thuế, điều chỉnh, thay thế, hủy (TT 78/2021, NĐ 123/2020, TT 91/2026).
interface Detail extends EInvoice { logs: EInvoiceLog[] }
interface VoucherRow { id: string; voucherType: string; voucherNo: string | null; postingDate: string; partyName: string | null }
const ISSUE_TYPES = ['HDB', 'BH', 'GGB', 'TLB'] as const;
const reason = [{ required: true, whitespace: true, message: 'Nhập lý do' }];

type Dlg = { kind: 'adjust' | 'replace' | 'cancel'; e: EInvoice } | null;

function ActionDialog({ dlg, onClose, onDone }: { dlg: Dlg; onClose: () => void; onDone: (r: EInvoice) => void }) {
  const [form] = Form.useForm();
  const e = dlg?.e;
  const cands = useQuery({
    queryKey: ['einvoice-candidates', e?.id, dlg?.kind], enabled: !!e && dlg?.kind !== 'cancel',
    queryFn: async () => {
      const doc = await api<{ partyCode: string | null }>(`/api/invoices/${e!.voucherId}`);
      const types = dlg!.kind === 'replace' ? ['HDB', 'BH'] : [...ISSUE_TYPES];
      const lists = await Promise.all(types.map((t) => api<{ rows: VoucherRow[] }>(`/api/vouchers?type=${t}&state=posted&partyCode=${encodeURIComponent(doc.partyCode ?? '')}&size=200`)));
      return lists.flatMap((l) => l.rows).filter((r) => r.id !== e!.voucherId);
    } });
  const run = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const base = { reason: v['reason'], agreementNo: v['agreementNo'] || undefined, agreementDate: v['agreementDate'] ? (v['agreementDate'] as dayjs.Dayjs).format('YYYY-MM-DD') : undefined };
      if (dlg!.kind === 'cancel') return api<EInvoice>(`/api/einvoices/${e!.id}/cancel`, { method: 'POST', json: { reason: v['reason'], date: (v['date'] as dayjs.Dayjs).format('YYYY-MM-DD') } });
      const vt = cands.data?.find((c) => c.id === v['voucherId'])?.voucherType;
      const extra = dlg!.kind === 'adjust' ? { adjust: vt === 'GGB' || vt === 'TLB' ? 'decrease' : 'increase' } : {};
      return api<EInvoice>(`/api/einvoices/${e!.id}/${dlg!.kind}`, { method: 'POST', json: { voucherId: v['voucherId'], ...extra, ...base } });
    },
    onSuccess: (r) => { showWarnings(r); onDone(r); }, onError: reportEInvoiceError });
  const title = dlg?.kind === 'adjust' ? 'Lập hóa đơn điều chỉnh' : dlg?.kind === 'replace' ? 'Lập hóa đơn thay thế' : 'Hủy hóa đơn';
  return (
    <Modal title={`${title}${e ? ` - ${symbolOf(e)} ${e.invoiceNo ?? ''}` : ''}`} open={!!dlg} onCancel={onClose} onOk={() => form.submit()} okText="Thực hiện" cancelText="Đóng" confirmLoading={run.isPending} destroyOnHidden afterClose={() => form.resetFields()}>
      <Form form={form} layout="vertical" onFinish={(v) => run.mutate(v)} initialValues={{ date: dayjs() }}>
        {dlg?.kind !== 'cancel' && (<Form.Item name="voucherId" label={dlg?.kind === 'adjust' ? 'Chứng từ điều chỉnh đã ghi sổ (cùng khách hàng)' : 'Hóa đơn bán đã ghi sổ thay thế (cùng khách hàng)'} rules={[{ required: true, message: 'Chọn chứng từ' }]}>
          <Select showSearch aria-label="Chứng từ" loading={cands.isLoading} optionFilterProp="label" notFoundContent="Không có chứng từ đã ghi sổ của cùng khách hàng"
            options={(cands.data ?? []).map((c) => ({ value: c.id, label: `${c.voucherType} ${c.voucherNo ?? ''} - ${formatVnDate(c.postingDate)}${c.partyName ? ` - ${c.partyName}` : ''}` }))} /></Form.Item>)}
        {dlg?.kind === 'cancel' && <Form.Item name="date" label="Ngày hủy" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item>}
        <Form.Item name="reason" label="Lý do" rules={reason}><Input.TextArea rows={2} /></Form.Item>
        {dlg?.kind !== 'cancel' && (<Space align="start"><Form.Item name="agreementNo" label="Số văn bản thỏa thuận"><Input /></Form.Item><Form.Item name="agreementDate" label="Ngày văn bản"><DatePicker format="DD/MM/YYYY" /></Form.Item></Space>)}
      </Form>
    </Modal>
  );
}

function DetailDrawer({ id, onClose, act }: { id: number | null; onClose: () => void; act: (e: EInvoice) => React.ReactNode }) {
  const d = useQuery({ queryKey: ['einvoice', id], enabled: id !== null, queryFn: () => api<Detail>(`/api/einvoices/${id}`) });
  const e = d.data;
  const rel = useQuery({ queryKey: ['einvoices-related', id], enabled: id !== null, queryFn: () => api<EInvoice[]>(`/api/einvoices?relatedTo=${id}`) });
  const linked = rel.data ?? [];
  const orphans = (e?.logs ?? []).filter((l) => ORPHAN_ACTIONS.includes(l.action));
  return (
    <Drawer title={e ? `Hóa đơn ${symbolOf(e)} ${e.invoiceNo ?? '(chưa có số)'}` : 'Hóa đơn điện tử'} open={id !== null} onClose={onClose} width={640} destroyOnHidden>
      {e && (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        {orphans.map((l) => (<Alert key={l.id} type="warning" showIcon message={l.action === 'orphan_issued' ? 'Nhà cung cấp đã phát hành hóa đơn nhưng phần mềm không ghi nhận được' : 'Nhà cung cấp đã hủy hóa đơn nhưng phần mềm không ghi nhận được'} description={l.error ?? undefined} />))}
        {e.errorMessage && <Alert type="error" showIcon message={e.errorMessage} description={e.errorCode ?? undefined} />}
        <div><StatusTags e={e} /></div>
        <Descriptions size="small" column={2} bordered items={[
          { key: 'v', label: 'Chứng từ', children: `${e.voucherType} ${e.voucherNo ?? ''}` }, { key: 'r', label: 'Loại', children: RELATION_LABEL[e.relation] },
          { key: 'b', label: 'Khách hàng', children: e.buyerName ?? '' }, { key: 't', label: 'Tổng tiền', children: e.total ? `${formatVnNumber(e.total)} ${e.currency ?? ''}` : '' },
          { key: 'd', label: 'Ngày hóa đơn', children: e.issueDate ? formatVnDate(e.issueDate) : '' }, { key: 'c', label: 'Mã của cơ quan thuế', children: e.cqtCode ?? '' },
          { key: 'a', label: 'Số lần gửi', children: e.attempts }, { key: 'p', label: 'Thanh toán', children: e.paid ? 'Đã thanh toán' : 'Chưa thanh toán' }]} />
        {linked.length > 0 && (<div><b>Hóa đơn liên quan</b>{linked.map((l) => <div key={l.id}>{RELATION_LABEL[l.relation]}: {symbolOf(l)} {l.invoiceNo ?? ''} <StatusTags e={l} /></div>)}</div>)}
        <Space wrap>{act(e)}</Space>
        <Table<EInvoiceLog> size="small" rowKey="id" pagination={false} dataSource={e.logs} locale={{ emptyText: 'Chưa có nhật ký' }} title={() => <b>Nhật ký gửi và nhận</b>} columns={[
          { title: 'Thời gian', dataIndex: 'createdAt', width: 150, render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm:ss') },
          { title: 'Thao tác', dataIndex: 'action', width: 130, render: (a: string) => (ORPHAN_ACTIONS.includes(a) ? <Tag color="orange">{a}</Tag> : a) },
          { title: 'Kết quả', dataIndex: 'ok', width: 80, render: (ok: boolean, l) => (ok ? <Tag color="green">Tốt</Tag> : <Tag color="red">{l.httpStatus ?? 'Lỗi'}</Tag>) },
          { title: 'Lỗi', dataIndex: 'error' }]} />
      </Space>)}
    </Drawer>
  );
}

export default function EInvoicesPage() {
  const { me, can } = useAuth(); const nav = useNavigate(); const qc = useQueryClient();
  const [f, setF] = useRememberedFilter('einvoices', { status: '', from: '', to: '', q: '', needsReversal: false }, `${me?.tenantId}:${me?.userId}`);
  const [openId, setOpenId] = useState<number | null>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const qs = new URLSearchParams(); for (const k of ['status', 'from', 'to', 'q'] as const) if (f[k]) qs.set(k, f[k]);
  if (f.needsReversal) qs.set('needsReversal', 'true');
  const list = useQuery({ queryKey: ['einvoices', f.status, f.from, f.to, f.q, f.needsReversal], queryFn: () => api<EInvoice[]>(`/api/einvoices?${qs}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['einvoices'] }); void qc.invalidateQueries({ queryKey: ['einvoice'] }); void qc.invalidateQueries({ queryKey: ['einvoices-related'] }); void qc.invalidateQueries({ queryKey: ['voucher-einvoice'] }); };
  const post = useMutation({
    mutationFn: ({ id, path, json }: { id: number; path: string; json?: unknown; ok: string }) => api<EInvoice>(`/api/einvoices/${id}/${path}`, { method: 'POST', ...(json !== undefined ? { json } : {}) }),
    onSuccess: (r, v) => { showWarnings(r); void message.success(v.ok); refresh(); }, onError: reportEInvoiceError });
  const call = (e: EInvoice, path: string, ok: string, json?: unknown) => post.mutate({ id: e.id, path, ok, ...(json !== undefined ? { json } : {}) });
  const openFile = async (e: EInvoice, kind: 'pdf' | 'xml') => {
    try { const b = await apiBlob(`/api/einvoices/${e.id}/file?kind=${kind}`); const url = URL.createObjectURL(b);
      if (kind === 'pdf') window.open(url, '_blank'); else { const a = document.createElement('a'); a.href = url; a.download = `${symbolOf(e)}-${e.invoiceNo ?? e.id}.xml`; a.click(); } } catch (err) { reportEInvoiceError(err); }
  };
  const actions = (e: EInvoice) => {
    const issue = can('einvoice.issue'); const post_ = issue && can('voucher.post');
    const out: React.ReactNode[] = [];
    if (e.status === 'issued' || e.status === 'replaced' || e.status === 'cancelled') out.push(<Button key="pdf" size="small" onClick={() => void openFile(e, 'pdf')}>Xem PDF</Button>, <Button key="xml" size="small" onClick={() => void openFile(e, 'xml')}>Tải XML</Button>);
    if (issue && e.status === 'sending') out.push(<Button key="retry" size="small" type="primary" onClick={() => call(e, 'retry', 'Đã gửi lại')}>Thử lại</Button>);
    if (issue && e.status === 'failed') out.push(<Button key="discard" size="small" danger onClick={() => Modal.confirm({ title: 'Bỏ hóa đơn lỗi này?', content: 'Chứng từ gốc được mở khóa để phát hành lại.', okText: 'Bỏ hóa đơn', cancelText: 'Đóng', onOk: () => call(e, 'discard', 'Đã bỏ hóa đơn lỗi') })}>Bỏ hóa đơn lỗi</Button>);
    if (e.status === 'issued' && cqtPending(e)) out.push(<Button key="refresh" size="small" onClick={() => call(e, 'refresh', 'Đã tra cứu mã của cơ quan thuế')}>Tra mã CQT</Button>);
    if (issue && e.status === 'issued' && e.relation === 'original' && !e.adjusted) out.push(<Button key="adj" size="small" onClick={() => setDlg({ kind: 'adjust', e })}>Lập điều chỉnh</Button>);
    if (post_ && e.status === 'issued' && !e.adjusted && e.relation !== 'adjustment') out.push(<Button key="rep" size="small" onClick={() => setDlg({ kind: 'replace', e })}>Lập thay thế</Button>);
    if (post_ && canCancel(e)) out.push(<Button key="cancel" size="small" danger onClick={() => setDlg({ kind: 'cancel', e })}>Hủy</Button>);
    if (post_ && e.needsReversal) out.push(<Button key="rev" size="small" type="primary" danger onClick={() => call(e, 'reverse-original', 'Đã đảo chứng từ gốc')}>Đảo chứng từ gốc</Button>);
    if (issue && e.status === 'issued') out.push(<Button key="paid" size="small" onClick={() => call(e, 'paid', e.paid ? 'Đã bỏ đánh dấu thanh toán' : 'Đã đánh dấu thanh toán', { paid: !e.paid })}>{e.paid ? 'Bỏ đánh dấu đã thanh toán' : 'Đánh dấu đã thanh toán'}</Button>);
    if (can('einvoice.view') && ['issued', 'replaced', 'cancelled'].includes(e.status)) out.push(<Button key="ss" size="small" onClick={() => void nav({ to: '/hoa-don-dien-tu/thong-bao-sai-sot', search: { einvoice: e.id } as never })}>Lập 04/SS</Button>);
    return out;
  };
  return (
    <>
      <PageHeader
        title="Hóa đơn điện tử"
        description="Tra cứu, phát hành lại, tra mã cơ quan thuế, điều chỉnh, thay thế và hủy hóa đơn điện tử"
        extra={<Button onClick={refresh}>Làm mới</Button>}
      >
        <Toolbar>
          <Select aria-label="Trạng thái" style={{ width: 170 }} value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: '', label: 'Mọi trạng thái' }, ...Object.entries(STATUS_LABEL).filter(([k]) => k !== 'draft').map(([value, label]) => ({ value, label }))]} />
          <DatePicker.RangePicker aria-label="Khoảng ngày" format="DD/MM/YYYY" value={f.from && f.to ? [dayjs(f.from), dayjs(f.to)] : null} onChange={(v) => setF({ ...f, from: v?.[0]?.format('YYYY-MM-DD') ?? '', to: v?.[1]?.format('YYYY-MM-DD') ?? '' })} />
          <Input.Search aria-label="Tìm số hóa đơn hoặc khách hàng" allowClear placeholder="Số hóa đơn, khách hàng" style={{ width: 240 }} defaultValue={f.q} onSearch={(v) => setF({ ...f, q: v.trim() })} />
          <Select aria-label="Cần đảo" style={{ width: 230 }} value={f.needsReversal ? 'yes' : 'all'} onChange={(v) => setF({ ...f, needsReversal: v === 'yes' })} options={[{ value: 'all', label: 'Tất cả hóa đơn' }, { value: 'yes', label: 'Chỉ hóa đơn cần đảo chứng từ gốc' }]} />
          {list.data && <span style={{ color: COLOR.textSecondary, marginLeft: 'auto' }}>{formatVnNumber(String(list.data.length))} hóa đơn</span>}
        </Toolbar>
      </PageHeader>
      {list.error && <Alert type="error" showIcon message={(list.error as Error).message} style={{ marginBottom: 12 }} />}
      <Section bodyPadding={0}>
        <Table<EInvoice> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 50, showSizeChanger: false }}
          locale={{ emptyText: <EmptyState title="Chưa có hóa đơn điện tử" /> }}
          onRow={(r) => ({ onDoubleClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })} columns={[
            { title: 'Ký hiệu', width: 120, render: (_v, r) => symbolOf(r) }, { title: 'Số', dataIndex: 'invoiceNo', width: 110, render: (v: string | null) => v ?? <i>Chưa có</i> },
            { title: 'Ngày', dataIndex: 'issueDate', width: 105, render: (v: string | null) => (v ? formatVnDate(v) : '') }, { title: 'Khách hàng', dataIndex: 'buyerName', ellipsis: true },
            { title: 'Loại', dataIndex: 'relation', width: 130, render: (v: string) => RELATION_LABEL[v] },
            { title: 'MST', dataIndex: 'buyerTaxCode', width: 120 },
            { title: 'Tiền trước thuế', dataIndex: 'beforeTax', width: 130, align: 'right', render: (v: string | null) => (v ? formatVnNumber(v) : '') },
            { title: 'Thuế', dataIndex: 'tax', width: 110, align: 'right', render: (v: string | null) => (v ? formatVnNumber(v) : '') },
            { title: 'Tổng', dataIndex: 'total', width: 130, align: 'right', render: (v: string | null) => (v ? formatVnNumber(v) : '') },
            { title: 'Trạng thái', width: 260, render: (_v, r) => <StatusTags e={r} /> }, { title: 'Mã CQT', dataIndex: 'cqtCode', width: 160, ellipsis: true },
            { title: '', width: 80, render: (_v, r) => <Button type="link" size="small" onClick={() => setOpenId(r.id)}>Chi tiết</Button> }]} />
      </Section>
      <DetailDrawer id={openId} onClose={() => setOpenId(null)} act={actions} />
      <ActionDialog dlg={dlg} onClose={() => setDlg(null)} onDone={(r) => { setDlg(null); void message.success(dlg?.kind === 'cancel' ? 'Đã hủy hóa đơn' : `Đã lập hóa đơn ${r.invoiceNo ?? ''}`); refresh(); }} />
    </>
  );
}
