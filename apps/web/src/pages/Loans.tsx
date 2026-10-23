import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useHotkeys, useRememberedFilter, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor, bankAccountFetcher } from '../lookups.js';
import { evenSchedule, type InstallmentRow } from './loanCalc.js';
import { iso, text } from './voucherCommon.js';

interface RateRow { validFrom: string; annualRate: string }
interface LoanRow { id: number; code: string; name: string; partyCode: string | null; partyName: string | null; currencyCode: string; value: string; signedDate: string | null; validTo: string | null; status: string; note: string | null;
  principalAccountCode: string; interestExpenseAccountCode: string; interestPayableAccountCode: string; dayBasis: number; purpose: string | null; outstanding: string; interestPayable: string; drawn: string;
  rates?: { validFrom: string; annualRate: string }[]; installments?: { dueDate: string; principal: string; note: string | null }[] }
interface VoucherRef { id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; description: string | null }
interface ReportRow { id: number; code: string; name: string; currency: string; openingCur: string; openingVnd: string; drawnCur: string; drawnVnd: string; repaidCur: string; repaidVnd: string; closingCur: string; closingVnd: string;
  interestOpening: string; interestEstimated: string; interestOther: string; interestPaid: string; interestClosing: string; nextDueDate: string | null; nextDuePrincipal: string | null }
interface Report { rows: ReportRow[]; totals: Record<string, string> }
const money = (s: string | null | undefined) => formatVnNumber(s ?? '0', 0);
const STATUS_LABEL: Record<string, string> = { draft: 'Nháp', active: 'Đang hiệu lực', terminated: 'Đã tất toán' };
const STATE_LABEL: Record<string, string> = { draft: 'Nháp', posted: 'Đã ghi sổ', reversed: 'Đã đảo', cancelled: 'Đã hủy' };
const RATE_RE = /^\d{1,3}(\.\d{1,6})?$/;

interface TermValues { code: string; name: string; partyCode: string | null; currencyCode: string; value: string | null; signedDate: dayjs.Dayjs | null; validTo: dayjs.Dayjs | null; status: 'draft' | 'active';
  principalAccountCode: string; interestExpenseAccountCode: string; interestPayableAccountCode: string; dayBasis: 360 | 365; purpose: string; note: string }

// Ô ngày dd/mm/yyyy của lưới: lưu dạng yyyy-mm-dd, chữ sai giữ giá trị cũ.
const dateCol = (field: string, headerName: string): ColDef<Record<string, string>> => ({ field, headerName, width: 150, cellEditorParams: { useFormatter: true },
  valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : ''), valueParser: (p) => { const t = String(p.newValue ?? '').trim(); return t === '' ? '' : parseVnDate(t) ?? p.oldValue; } });

type Action = 'disburse' | 'repay';
function ActionDialog({ loan, action, onClose, onDone }: { loan: LoanRow; action: Action | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm<{ date: dayjs.Dayjs; amount: string; principal: string; interest: string; bankAccountNo: string; fxRate: string; description: string }>();
  const [err, setErr] = useState<string | null>(null); const [result, setResult] = useState<{ id: string; voucherNo: string | null; voucherType: string } | null>(null);
  const foreign = loan.currencyCode !== 'VND';
  useEffect(() => { if (action) { form.resetFields(); form.setFieldsValue({ date: dayjs(todayVn()) }); setErr(null); setResult(null); } }, [action]);
  const run = useMutation({
    mutationFn: (v: NonNullable<ReturnType<typeof form.getFieldsValue>>) => api<{ id: string; voucherNo: string | null; voucherType: string }>(`/api/loans/${loan.id}/${action}`, { method: 'POST', json: {
      date: iso(v.date), bankAccountNo: v.bankAccountNo, ...(foreign && v.fxRate ? { fxRate: v.fxRate } : {}), ...(text(v.description) ? { description: text(v.description) } : {}),
      ...(action === 'disburse' ? { amount: v.amount } : { principal: v.principal || '0', interest: v.interest || '0' }) } }),
    onError: (e) => setErr((e as Error).message), onSuccess: (r) => { setErr(null); setResult(r); onDone(); } });
  const title = action === 'disburse' ? 'Giải ngân' : 'Trả nợ';
  const cur = foreign ? ` (${loan.currencyCode})` : '';
  return (
    <Modal open={action !== null} title={`${title} khế ước ${loan.code}`} onCancel={onClose} destroyOnHidden forceRender
      footer={result ? <Button type="primary" onClick={onClose}>Đóng</Button> : [<Button key="c" onClick={onClose}>Bỏ qua</Button>, <Button key="s" type="primary" loading={run.isPending} onClick={() => { void form.validateFields().then((v) => run.mutate(v), () => undefined); }}>{title}</Button>]}>
      {result ? <Alert type="success" showIcon data-testid="loan-action-result" message={`Đã lập ${result.voucherType} ${result.voucherNo ?? ''} và ghi sổ`} description={<Link to="/chung-tu/$type/$id" params={{ type: result.voucherType, id: result.id }}>Xem chứng từ</Link>} /> : (
        <Form form={form} layout="vertical" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLElement).closest('.ant-select')) { e.preventDefault(); void form.validateFields().then((v) => run.mutate(v), () => undefined); } }}>
          <Form.Item label="Ngày" name="date" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          {action === 'disburse'
            ? <Form.Item label={`Số tiền giải ngân${cur}`} name="amount" rules={[{ required: true, message: 'Nhập số tiền giải ngân' }]}><VnNumberInput scale={foreign ? 4 : 0} aria-label="Số tiền giải ngân" /></Form.Item>
            : <Space align="start" wrap>
              <Form.Item label={`Trả gốc${cur}`} name="principal"><VnNumberInput scale={foreign ? 4 : 0} aria-label="Trả gốc" /></Form.Item>
              <Form.Item label={`Trả lãi${cur}`} name="interest"><VnNumberInput scale={foreign ? 4 : 0} aria-label="Trả lãi" /></Form.Item></Space>}
          <Form.Item label="Tài khoản ngân hàng (F4)" name="bankAccountNo" rules={[{ required: true, message: 'Chọn tài khoản ngân hàng' }]}><LookupSelect catalog="bank_account" fetcher={bankAccountFetcher} /></Form.Item>
          {foreign && <Form.Item label="Tỷ giá" name="fxRate" rules={[{ required: true, message: 'Nhập tỷ giá' }]}><VnNumberInput scale={4} aria-label="Tỷ giá" /></Form.Item>}
          <Form.Item label="Diễn giải" name="description"><Input maxLength={500} /></Form.Item>
          {err && <Alert type="error" showIcon message={err} />}
        </Form>)}
    </Modal>);
}

function LoanDrawer({ loan, onClose }: { loan: LoanRow | 'new'; onClose: () => void }) {
  const qc = useQueryClient(); const { can } = useAuth();
  const isNew = loan === 'new';
  const [form] = Form.useForm<TermValues>();
  const [id, setId] = useState<number | null>(isNew ? null : loan.id);
  const [tab, setTab] = useState('terms'); const [err, setErr] = useState<string | null>(null); const [action, setAction] = useState<Action | null>(null);
  const [rates, setRates] = useState<RateRow[]>([{ validFrom: '', annualRate: '' }]);
  const [inst, setInst] = useState<InstallmentRow[]>([{ dueDate: '', principal: '', note: '' }]);
  const [gen, setGen] = useState<{ count: number; months: number; first: dayjs.Dayjs; total: string } | null>(null);
  const detail = useQuery({ queryKey: ['loan', id], enabled: id !== null, queryFn: () => api<LoanRow>(`/api/loans/${id}`) });
  const vouchers = useQuery({ queryKey: ['loan-vouchers', id], enabled: id !== null, queryFn: () => api<VoucherRef[]>(`/api/loans/${id}/vouchers`) });
  const l = detail.data;
  const canEdit = (isNew && id === null ? can('loan.create') : can('loan.update')) && l?.status !== 'terminated';
  const refresh = () => { for (const k of ['loan', 'loans', 'loan-vouchers', 'loan-report']) void qc.invalidateQueries({ queryKey: [k] }); };
  const fetcher = useMemo(() => accountFetcherFor(), []);
  const gridsRef = useRef({ rates, inst }); gridsRef.current = { rates, inst };

  useEffect(() => {
    if (!l) { if (isNew) form.setFieldsValue({ currencyCode: 'VND', status: 'active', dayBasis: 365, principalAccountCode: '3411', interestExpenseAccountCode: '635', interestPayableAccountCode: '335', value: '0' }); return; }
    form.setFieldsValue({ code: l.code, name: l.name, partyCode: l.partyCode, currencyCode: l.currencyCode, value: D(l.value).toFixed(0), signedDate: l.signedDate ? dayjs(l.signedDate) : null, validTo: l.validTo ? dayjs(l.validTo) : null,
      status: l.status === 'draft' ? 'draft' : 'active', principalAccountCode: l.principalAccountCode, interestExpenseAccountCode: l.interestExpenseAccountCode, interestPayableAccountCode: l.interestPayableAccountCode,
      dayBasis: l.dayBasis as 360 | 365, purpose: l.purpose ?? '', note: l.note ?? '' });
    setRates(l.rates?.length ? l.rates.map((r) => ({ validFrom: r.validFrom, annualRate: D(r.annualRate).toString() })) : [{ validFrom: '', annualRate: '' }]);
    setInst(l.installments?.length ? l.installments.map((r) => ({ dueDate: r.dueDate, principal: D(r.principal).toFixed(0), note: r.note ?? '' })) : [{ dueDate: '', principal: '', note: '' }]);
  }, [l?.id, detail.dataUpdatedAt]);

  const save = useMutation({
    mutationFn: (v: TermValues) => {
      const rs = gridsRef.current.rates.filter((r) => r.validFrom || r.annualRate); const is = gridsRef.current.inst.filter((r) => r.dueDate || r.principal);
      rs.forEach((r, i) => { if (!r.validFrom || !RATE_RE.test(r.annualRate)) throw new Error(`Lãi suất dòng ${i + 1}: nhập ngày hiệu lực và lãi suất (% năm)`); });
      is.forEach((r, i) => { if (!r.dueDate || !/^\d{1,16}$/.test(r.principal)) throw new Error(`Lịch trả gốc dòng ${i + 1}: nhập ngày đến hạn và số gốc là số nguyên đồng`); });
      const body = { code: v.code.trim(), name: v.name.trim(), partyCode: v.partyCode || null, currencyCode: v.currencyCode.trim().toUpperCase(), value: v.value || '0', signedDate: v.signedDate ? iso(v.signedDate) : null,
        validTo: v.validTo ? iso(v.validTo) : null, status: v.status, principalAccountCode: v.principalAccountCode, interestExpenseAccountCode: v.interestExpenseAccountCode, interestPayableAccountCode: v.interestPayableAccountCode,
        dayBasis: v.dayBasis, purpose: text(v.purpose), note: text(v.note), rates: rs.map((r) => ({ validFrom: r.validFrom, annualRate: r.annualRate })), installments: is.map((r) => ({ dueDate: r.dueDate, principal: r.principal, note: text(r.note) })) };
      return id === null ? api<LoanRow>('/api/loans', { method: 'POST', json: body }) : api<LoanRow>(`/api/loans/${id}`, { method: 'PUT', json: body });
    },
    onError: (e) => setErr((e as Error).message), onSuccess: (r) => { setErr(null); setId(r.id); void message.success('Đã lưu khế ước'); refresh(); } });
  const submit = () => { void form.validateFields().then((v) => save.mutate(v), () => setTab('terms')); };
  const settle = useMutation({ mutationFn: () => api(`/api/loans/${id}/settle`, { method: 'POST' }), onError: (e) => void message.error((e as Error).message), onSuccess: () => { void message.success('Đã tất toán khế ước'); refresh(); } });
  const remove = useMutation({ mutationFn: () => api(`/api/loans/${id}`, { method: 'DELETE' }), onError: (e) => void message.error((e as Error).message), onSuccess: () => { void message.success('Đã xóa khế ước'); refresh(); onClose(); } });

  const onKey = (e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !(e.target as HTMLElement).closest('.ant-modal')) { e.preventDefault(); if (canEdit) submit(); } };
  const currency = Form.useWatch('currencyCode', form) as string | undefined;
  const terms = (
    <Form form={form} layout="vertical" disabled={!canEdit}>
      <Space align="start" wrap>
        <Form.Item label="Số khế ước" name="code" rules={[{ required: true, whitespace: true, message: 'Nhập số khế ước' }]}><Input maxLength={50} autoFocus /></Form.Item>
        <Form.Item label="Tên" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên' }]}><Input maxLength={255} style={{ width: 300 }} /></Form.Item>
        <Form.Item label="Bên cho vay (F4)" name="partyCode"><LookupSelect catalog="party" allowClear style={{ width: 240 }} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Loại tiền" name="currencyCode" rules={[{ required: true, len: 3, message: 'Mã loại tiền 3 chữ cái' }]}><Input maxLength={3} style={{ width: 90 }} disabled={!!l && l.status !== 'draft' && D(l.drawn).gt(0)} /></Form.Item>
        <Form.Item label={`Hạn mức${currency && currency !== 'VND' ? ` (${currency})` : ''} (0 = không giới hạn)`} name="value"><VnNumberInput scale={0} aria-label="Hạn mức" /></Form.Item>
        <Form.Item label="Ngày ký" name="signedDate"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Ngày đáo hạn" name="validTo"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Trạng thái" name="status"><Select style={{ width: 150 }} options={[{ value: 'active', label: 'Đang hiệu lực' }, { value: 'draft', label: 'Nháp' }]} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="TK gốc vay (F4)" name="principalAccountCode" rules={[{ required: true }]}><LookupSelect catalog="account" fetcher={fetcher} style={{ width: 170 }} /></Form.Item>
        <Form.Item label="TK chi phí lãi vay (F4)" name="interestExpenseAccountCode" rules={[{ required: true }]}><LookupSelect catalog="account" fetcher={fetcher} style={{ width: 170 }} /></Form.Item>
        <Form.Item label="TK lãi vay phải trả (F4)" name="interestPayableAccountCode" rules={[{ required: true }]}><LookupSelect catalog="account" fetcher={fetcher} style={{ width: 170 }} /></Form.Item>
        <Form.Item label="Cơ sở ngày" name="dayBasis"><Select style={{ width: 110 }} options={[{ value: 365, label: '365 ngày' }, { value: 360, label: '360 ngày' }]} /></Form.Item>
      </Space>
      <Form.Item label="Mục đích vay" name="purpose"><Input maxLength={500} /></Form.Item>
      <Form.Item label="Ghi chú" name="note"><Input.TextArea rows={2} maxLength={1000} /></Form.Item>
    </Form>);

  const rateCols = useMemo<ColDef<Record<string, string>>[]>(() => [dateCol('validFrom', 'Hiệu lực từ ngày'),
    { field: 'annualRate', headerName: 'Lãi suất (%/năm)', width: 160, cellClass: 'ag-right-aligned-cell',
      valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && RATE_RE.test(n) ? n : p.oldValue; } }], []);
  const instCols = useMemo<ColDef<Record<string, string>>[]>(() => [dateCol('dueDate', 'Ngày đến hạn'),
    { field: 'principal', headerName: 'Gốc phải trả', width: 170, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => (p.value ? formatVnNumber(p.value as string, 0) : ''),
      valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && /^\d{1,16}$/.test(n) ? n : p.oldValue; } },
    { field: 'note', headerName: 'Ghi chú', flex: 1, minWidth: 140 }], []);
  const total = inst.reduce((s, r) => s.plus(/^\d{1,16}$/.test(r.principal) ? r.principal : 0), D(0));
  const needCard = <Alert type="info" showIcon message="Lưu điều khoản trước khi giải ngân, trả nợ" />;
  const ratesTab = (<>
    <KeyboardGrid<Record<string, string>> rows={rates as unknown as Record<string, string>[]} columns={rateCols} onRowsChange={(r) => setRates(r as unknown as RateRow[])} addRowTemplate={() => ({ validFrom: '', annualRate: '' })} readOnly={!canEdit} height={240} />
    <div style={{ marginTop: 4 }}>Lãi suất áp dụng từ ngày hiệu lực đến khi có mức mới; lãi tính theo số dư nợ gốc từng ngày.</div></>);
  const scheduleTab = (<>
    {canEdit && <Button style={{ marginBottom: 8 }} onClick={() => setGen({ count: 12, months: 3, first: dayjs(todayVn()).add(3, 'month'), total: l ? D(l.outstanding).toFixed(0) : '0' })}>Sinh lịch đều</Button>}
    <KeyboardGrid<Record<string, string>> rows={inst as unknown as Record<string, string>[]} columns={instCols} onRowsChange={(r) => setInst(r as unknown as InstallmentRow[])} addRowTemplate={() => ({ dueDate: '', principal: '', note: '' })} readOnly={!canEdit} height={280} />
    <div style={{ marginTop: 4 }}>Tổng gốc theo lịch: <Tag data-testid="schedule-total">{money(total.toString())}</Tag></div></>);
  const docsTab = id === null ? needCard : (<>
    {l && (can('loan.update') && can('voucher.create') && can('voucher.post')) && l.status === 'active' && <Space wrap style={{ marginBottom: 8 }}>
      <Button onClick={() => setAction('disburse')}>Giải ngân</Button><Button onClick={() => setAction('repay')}>Trả nợ</Button>
      <Popconfirm title="Tất toán khế ước này?" okText="Tất toán" cancelText="Không" onConfirm={() => settle.mutate()}><Button>Tất toán</Button></Popconfirm></Space>}
    {l && <div style={{ marginBottom: 8 }}>Dư nợ gốc: <b data-testid="loan-outstanding">{money(l.outstanding)}</b> · Đã rút: <b>{money(l.drawn)}</b> · Lãi phải trả (VND): <b>{money(l.interestPayable)}</b></div>}
    <Table<VoucherRef> size="small" rowKey="id" loading={vouchers.isLoading} dataSource={vouchers.data ?? []} pagination={false} data-testid="loan-vouchers" locale={{ emptyText: 'Chưa có chứng từ' }}
      columns={[{ title: 'Ngày', dataIndex: 'postingDate', render: formatVnDate }, { title: 'Loại', dataIndex: 'voucherType' },
        { title: 'Số', render: (_, r) => <Link to="/chung-tu/$type/$id" params={{ type: r.voucherType, id: r.id }}>{r.voucherNo ?? 'Xem'}</Link> }, { title: 'Diễn giải', dataIndex: 'description' },
        { title: 'Trạng thái', dataIndex: 'state', render: (s: string) => STATE_LABEL[s] ?? s }]} />
  </>);
  const dialogLoan: LoanRow | null = l ?? null;
  return (
    <Drawer open width={820} title={id === null ? 'Thêm khế ước vay' : `Khế ước vay ${l?.code ?? ''}`} onClose={onClose} destroyOnHidden
      extra={<Space>{id !== null && can('loan.delete') && l?.status !== 'terminated' && <Popconfirm title="Xóa khế ước này?" okText="Xóa" cancelText="Không" onConfirm={() => remove.mutate()}><Button danger>Xóa</Button></Popconfirm>}
        {canEdit && <Button type="primary" onClick={submit} loading={save.isPending}>Lưu (Ctrl+S)</Button>}</Space>}>
      <div onKeyDown={onKey}>
        {l && <div style={{ marginBottom: 8 }}>Trạng thái: <Tag>{STATUS_LABEL[l.status] ?? l.status}</Tag></div>}
        {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
        <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'terms', label: 'Điều khoản', children: terms }, { key: 'rates', label: 'Lãi suất', children: ratesTab },
          { key: 'schedule', label: 'Lịch trả gốc', children: scheduleTab }, { key: 'docs', label: 'Chứng từ', children: docsTab }]} />
      </div>
      {dialogLoan && <ActionDialog loan={dialogLoan} action={action} onClose={() => setAction(null)} onDone={refresh} />}
      <Modal open={!!gen} title="Sinh lịch trả gốc đều" okText="Sinh lịch" cancelText="Bỏ qua" onCancel={() => setGen(null)} destroyOnHidden
        onOk={() => { if (!gen) return; const rows = evenSchedule(iso(gen.first), gen.count, gen.months, D(gen.total || '0').toFixed(0)); if (!rows.length) { void message.error('Nhập số kỳ, chu kỳ, ngày đầu tiên và tổng gốc hợp lệ'); return; } setInst(rows); setGen(null); }}>
        {gen && <Space direction="vertical">
          <label>Số kỳ <InputNumber min={1} max={600} precision={0} value={gen.count} onChange={(v) => setGen({ ...gen, count: v ?? 1 })} aria-label="Số kỳ" /></label>
          <label>Chu kỳ (tháng) <InputNumber min={1} max={60} precision={0} value={gen.months} onChange={(v) => setGen({ ...gen, months: v ?? 1 })} aria-label="Chu kỳ tháng" /></label>
          <label>Ngày trả đầu tiên <DatePicker format="DD/MM/YYYY" allowClear={false} value={gen.first} onChange={(d) => d && setGen({ ...gen, first: d })} /></label>
          <label>Tổng gốc <VnNumberInput scale={0} value={gen.total} onChange={(v) => setGen({ ...gen, total: v ?? '0' })} aria-label="Tổng gốc" /></label></Space>}
      </Modal>
    </Drawer>);
}

function LoanReportTab() {
  const { me, can } = useAuth();
  const [f, setF] = useRememberedFilter('loan-report', { from: `${todayVn().slice(0, 4)}-01-01`, to: todayVn() }, `${me?.tenantId}:${me?.userId}`);
  const url = `/api/loans/report?from=${f.from}&to=${f.to}`;
  const q = useQuery({ queryKey: ['loan-report', f.from, f.to], queryFn: () => api<Report>(url) });
  const t = q.data?.totals;
  return (<>
    <Space wrap style={{ marginBottom: 12 }}>
      <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />
      {can('report.print') && <><Button onClick={() => window.open(`${url}&format=pdf`, '_blank')}>In PDF</Button><Button onClick={() => window.open(`${url}&format=xlsx`, '_blank')}>Xuất Excel</Button></>}
    </Space>
    {q.error && <Alert type="error" showIcon message={(q.error as Error).message} style={{ marginBottom: 8 }} />}
    <Table<ReportRow> size="small" rowKey="id" loading={q.isLoading} dataSource={q.data?.rows ?? []} pagination={false} scroll={{ x: 2300 }} data-testid="loan-report" locale={{ emptyText: 'Chưa có khế ước' }}
      columns={[{ title: 'Khế ước', dataIndex: 'code', fixed: 'left', width: 110 }, { title: 'Tên', dataIndex: 'name', width: 160 }, { title: 'Loại tiền', dataIndex: 'currency', width: 70 },
        { title: 'Dư nợ đầu kỳ', dataIndex: 'openingVnd', align: 'right', render: money }, { title: 'Giải ngân', dataIndex: 'drawnVnd', align: 'right', render: money }, { title: 'Trả gốc', dataIndex: 'repaidVnd', align: 'right', render: money },
        ...(['openingCur', 'drawnCur', 'repaidCur', 'closingCur'] as const).map((k) => ({ title: `${{ openingCur: 'Dư nợ đầu kỳ', drawnCur: 'Giải ngân', repaidCur: 'Trả gốc', closingCur: 'Dư nợ cuối kỳ' }[k]} (nguyên tệ)`, dataIndex: k, align: 'right' as const, render: (v: string, r: ReportRow) => (r.currency === 'VND' ? '' : formatVnNumber(v, 4)) })),
        { title: 'Dư nợ cuối kỳ (VND)', dataIndex: 'closingVnd', align: 'right', render: money },
        { title: 'Lãi phải trả đầu kỳ', dataIndex: 'interestOpening', align: 'right', render: money }, { title: 'Lãi dự tính (LV)', dataIndex: 'interestEstimated', align: 'right', render: money },
        { title: 'Lãi trích khác', dataIndex: 'interestOther', align: 'right', render: money }, { title: 'Lãi đã trả', dataIndex: 'interestPaid', align: 'right', render: money },
        { title: 'Lãi phải trả cuối kỳ', dataIndex: 'interestClosing', align: 'right', render: money },
        { title: 'Kỳ trả gốc kế tiếp', render: (_, r) => (r.nextDueDate ? `${formatVnDate(r.nextDueDate)}: ${money(r.nextDuePrincipal)}` : '') }]}
      summary={() => t && (<Table.Summary.Row><Table.Summary.Cell index={0} colSpan={3}><b>Cộng</b></Table.Summary.Cell>
        {(['openingVnd', 'drawnVnd', 'repaidVnd'] as const).map((k, i) => <Table.Summary.Cell key={k} index={3 + i} align="right"><b>{money(t[k])}</b></Table.Summary.Cell>)}
        <Table.Summary.Cell index={6} colSpan={4} /><Table.Summary.Cell index={10} align="right"><b data-testid="report-total-closing">{money(t['closingVnd'])}</b></Table.Summary.Cell>
        {(['interestOpening', 'interestEstimated', 'interestOther', 'interestPaid', 'interestClosing'] as const).map((k, i) => <Table.Summary.Cell key={k} index={11 + i} align="right"><b>{money(t[k])}</b></Table.Summary.Cell>)}
        <Table.Summary.Cell index={16} /></Table.Summary.Row>)} />
  </>);
}

export default function LoansPage() {
  const { me, can } = useAuth();
  const [f, setF] = useRememberedFilter('loans', { q: '', status: '' as string }, `${me?.tenantId}:${me?.userId}`);
  const [open, setOpen] = useState<LoanRow | 'new' | null>(null); const [tab, setTab] = useState('list');
  const list = useQuery({ queryKey: ['loans'], queryFn: () => api<LoanRow[]>('/api/loans') });
  const k = f.q.trim().toLowerCase();
  const rows = (list.data ?? []).filter((r) => (!f.status || r.status === f.status) && (!k || r.code.toLowerCase().includes(k) || r.name.toLowerCase().includes(k)));
  useHotkeys({ Insert: () => { if (can('loan.create') && !open && tab === 'list') setOpen('new'); } });
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Khế ước vay</h2>
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'list', label: 'Danh sách khế ước', children: (<>
          <Space wrap style={{ marginBottom: 12 }}>
            <Input.Search placeholder="Tìm theo số, tên" allowClear defaultValue={f.q} onSearch={(q) => setF({ ...f, q })} style={{ width: 220 }} />
            <select aria-label="Trạng thái" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Mọi trạng thái</option><option value="draft">Nháp</option><option value="active">Đang hiệu lực</option><option value="terminated">Đã tất toán</option></select>
            {can('loan.create') && <Button type="primary" onClick={() => setOpen('new')}>Thêm (Insert)</Button>}
          </Space>
          <Table<LoanRow> size="small" rowKey="id" loading={list.isLoading} dataSource={rows} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="loans-table" locale={{ emptyText: 'Chưa có khế ước' }}
            onRow={(r) => ({ onClick: () => setOpen(r), tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter') setOpen(r); }, style: { cursor: 'pointer' } })}
            columns={[{ title: 'Số khế ước', dataIndex: 'code' }, { title: 'Tên', dataIndex: 'name' }, { title: 'Bên cho vay', dataIndex: 'partyName' }, { title: 'Loại tiền', dataIndex: 'currencyCode' },
              { title: 'Hạn mức', dataIndex: 'value', align: 'right', render: money }, { title: 'Dư nợ gốc', dataIndex: 'outstanding', align: 'right', render: money }, { title: 'Lãi phải trả (VND)', dataIndex: 'interestPayable', align: 'right', render: money },
              { title: 'Đáo hạn', dataIndex: 'validTo', render: (d: string | null) => (d ? formatVnDate(d) : '') }, { title: 'Trạng thái', dataIndex: 'status', render: (s: string) => STATUS_LABEL[s] ?? s }]} />
        </>) },
        ...(can('report.view') ? [{ key: 'report', label: 'Sổ theo dõi khế ước vay', children: <LoanReportTab /> }] : []),
      ]} />
      {open && <LoanDrawer loan={open} onClose={() => setOpen(null)} />}
    </div>);
}
