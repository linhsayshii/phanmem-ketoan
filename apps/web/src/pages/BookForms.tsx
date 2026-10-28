import { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Form, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';

type BookForm = 'NKC' | 'CTGS' | 'NKSC' | 'NKCT';
const FORMS: { value: BookForm; label: string }[] = [{ value: 'NKC', label: 'Nhật ký chung' }, { value: 'CTGS', label: 'Chứng từ ghi sổ' }, { value: 'NKSC', label: 'Nhật ký – Sổ Cái' }, { value: 'NKCT', label: 'Nhật ký – Chứng từ' }];
interface Side { debit: string; credit: string }
interface SetRow { id: number; setNo: number; setDate: string; description: string; vouchers: number; amount: string }
type Row = Record<string, unknown>;

const money = (v: unknown) => (typeof v === 'string' && v !== '0' ? formatVnNumber(v) : '');
const num = (headerName: string, get: (r: Row) => unknown, width = 130): ColDef<Row> => ({ headerName, width, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => (p.data ? get(p.data) : ''), valueFormatter: (p) => money(p.value) });
const txt = (headerName: string, field: string, width?: number): ColDef<Row> => (width ? { field, headerName, width } : { field, headerName, flex: 1, minWidth: 180 });
const dt = (headerName: string, field: string): ColDef<Row> => ({ field, headerName, width: 115, valueFormatter: (p) => formatVnDate(p.value as string) });
const Grid = ({ rows, columns }: { rows: Row[]; columns: ColDef<Row>[] }) =>
  <KeyboardGrid<Row> rows={rows} columns={columns.map((c) => ({ ...c, editable: false }))} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height="calc(100vh - 380px)" />;
const Sum = ({ items }: { items: [string, Side | string][] }) =>
  <Space size="large" wrap>{items.map(([l, s]) => <span key={l}>{l}: {typeof s === 'string' ? <b>{formatVnNumber(s)}</b> : <>Nợ <b>{formatVnNumber(s.debit)}</b> / Có <b>{formatVnNumber(s.credit)}</b></>}</span>)}</Space>;

export default function BookFormsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; regime: string; dateFrom: string; dateTo: string }[]>('/api/fiscal-years') });
  const [yearSel, setYear] = useState<number | undefined>();
  const [range, setRange] = useState<[string, string] | null>(null);
  const [ctgsTab, setCtgsTab] = useState('sets');
  const [accountCode, setAccountCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [addForm] = Form.useForm();
  const yearRow = years.data?.find((y) => y.fiscalYear === yearSel) ?? years.data?.at(-1);
  const year = yearRow?.fiscalYear;
  const from = range?.[0] ?? yearRow?.dateFrom ?? ''; const to = range?.[1] ?? yearRow?.dateTo ?? '';
  const fetcher = useMemo(() => accountFetcherFor(from || dayjs().format('YYYY-MM-DD'), true, true), [from]);
  const fail = (e: Error) => void message.error(e.message);

  const bf = useQuery({ queryKey: ['book-form', year], queryFn: () => api<{ bookForm: BookForm }>(`/api/fiscal-years/${year}/book-form`), enabled: !!year });
  const form = bf.data?.bookForm ?? 'NKC';
  const change = useMutation({ mutationFn: (bookForm: BookForm) => api(`/api/fiscal-years/${year}/book-form`, { method: 'PUT', json: { bookForm } }), onError: fail,
    onSuccess: () => { void message.success('Đã đổi hình thức sổ; số liệu sổ cái không thay đổi'); void qc.invalidateQueries({ queryKey: ['book-form', year] }); } });

  const q = `from=${from}&to=${to}`;
  const url = form === 'NKSC' ? `/api/reports/books/nksc?${q}`
    : form === 'NKCT' ? (accountCode ? `/api/reports/books/nkct?${q}&creditAccountCode=${accountCode}` : '')
    : form === 'CTGS' && ctgsTab === 'register' ? `/api/reports/books/ctgs-register?${q}`
    : form === 'CTGS' && ctgsTab === 'ledger' ? (accountCode ? `/api/reports/books/ctgs-ledger?${q}&accountCode=${accountCode}` : '') : '';
  const data = useQuery({ queryKey: ['book-form-data', url], queryFn: () => api<Record<string, unknown>>(url), enabled: !!url && !!from, retry: false });
  const sets = useQuery({ queryKey: ['voucher-sets', year], queryFn: () => api<{ rows: SetRow[]; total: string }>(`/api/voucher-sets?fiscalYear=${year}`), enabled: form === 'CTGS' && ctgsTab === 'sets' && !!year && can('voucher_set.view') });
  const create = useMutation({ mutationFn: (b: unknown) => api<{ setNo: number; vouchers: number }>('/api/voucher-sets', { method: 'POST', json: b }), onError: fail,
    onSuccess: (r) => { setAdding(false); addForm.resetFields(); void message.success(`Đã lập Chứng từ ghi sổ số ${r.setNo} (${r.vouchers} chứng từ gốc)`); void qc.invalidateQueries({ queryKey: ['voucher-sets'] }); } });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/voucher-sets/${id}`, { method: 'DELETE' }), onError: fail,
    onSuccess: () => { void message.success('Đã xóa Chứng từ ghi sổ; chứng từ gốc và sổ cái không đổi'); void qc.invalidateQueries({ queryKey: ['voucher-sets'] }); } });
  const open = (u: string, format: 'pdf' | 'xlsx') => { window.open(`${u}${u.includes('?') ? '&' : '?'}format=${format}`, '_blank'); };

  const needAccount = (form === 'NKCT' || (form === 'CTGS' && ctgsTab === 'ledger')) && !accountCode;
  const d = data.data;
  const body = () => {
    if (form === 'NKC') return <Alert type="info" showIcon message="Năm này dùng hình thức Nhật ký chung: xem ở trang Sổ sách kế toán." />;
    if (needAccount) return <Alert type="info" showIcon message={form === 'NKCT' ? 'Chọn tài khoản ghi Có để xem bảng kê' : 'Chọn tài khoản để xem Sổ Cái'} />;
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} />;
    if (form === 'CTGS' && ctgsTab === 'sets') return null;
    if (!d) return <Alert type="info" message="Đang tải…" />;
    if (form === 'NKSC') {
      const accounts = d['accounts'] as { accountCode: string; accountName: string; debit: string; credit: string }[];
      return <Space direction="vertical" style={{ width: '100%' }}><Sum items={[['Tổng phát sinh', { debit: d['totalDebit'] as string, credit: d['totalCredit'] as string }]]} />
        <Grid rows={d['rows'] as Row[]} columns={[dt('Ngày ghi sổ', 'postingDate'), txt('Số hiệu CT', 'voucherNo', 130), dt('Ngày CT', 'documentDate'), txt('Diễn giải', 'description'), txt('TK', 'accountCode', 90), num('Phát sinh Nợ', (r) => r['debit']), num('Phát sinh Có', (r) => r['credit'])]} />
        <Table size="small" bordered pagination={false} rowKey="accountCode" dataSource={accounts} title={() => <b>Cộng phát sinh theo tài khoản</b>}
          columns={[{ title: 'TK', dataIndex: 'accountCode', width: 90 }, { title: 'Tên tài khoản', dataIndex: 'accountName' }, { title: 'Nợ', dataIndex: 'debit', align: 'right', render: money }, { title: 'Có', dataIndex: 'credit', align: 'right', render: money }]} /></Space>;
    }
    if (form === 'NKCT') {
      const cols = d['debitAccounts'] as string[]; const totals = d['totals'] as Record<string, string>;
      return <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="info" showIcon message="Bảng kê chung theo bên Có: mỗi cột là tài khoản Nợ đối ứng; chưa chia cột theo mẫu S07–S10-DN từng tài khoản." />
        <Sum items={[[`Cộng Có TK ${accountCode}`, d['total'] as string]]} />
        <Grid rows={(d['rows'] as Row[]).map((r) => ({ ...r, ...(r['amounts'] as Row) }))} columns={[dt('Ngày ghi sổ', 'postingDate'), txt('Số hiệu CT', 'voucherNo', 130), txt('Diễn giải', 'description'), ...cols.map((c) => num(`Nợ TK ${c} (${formatVnNumber(totals[c] ?? '0')})`, (r) => r[c], 170)), num('Cộng Có', (r) => r['total'])]} /></Space>;
    }
    if (ctgsTab === 'register') {
      return <Space direction="vertical" style={{ width: '100%' }}><Sum items={[['Tổng số tiền', d['total'] as string]]} />
        <Grid rows={d['rows'] as Row[]} columns={[txt('Số hiệu', 'setNo', 100), dt('Ngày tháng', 'setDate'), txt('Diễn giải', 'description'), txt('Số CT gốc', 'vouchers', 110), num('Số tiền', (r) => r['amount'])]} /></Space>;
    }
    return <Space direction="vertical" style={{ width: '100%' }}>
      {(d['unassigned'] as number) > 0 && <Alert type="warning" showIcon message={`Còn ${d['unassigned'] as number} chứng từ trong kỳ chưa vào Chứng từ ghi sổ nào; Sổ Cái này chưa gồm các chứng từ đó.`} />}
      <Sum items={[['Dư đầu', d['opening'] as Side], ['Phát sinh', { debit: d['totalDebit'] as string, credit: d['totalCredit'] as string }], ['Dư cuối', d['closing'] as Side]]} />
      <Grid rows={d['rows'] as Row[]} columns={[dt('Ngày CTGS', 'setDate'), txt('Số hiệu CTGS', 'setNo', 120), txt('Diễn giải', 'description'), txt('TK đối ứng', 'counterAccountCode', 115), num('Nợ', (r) => r['debit']), num('Có', (r) => r['credit'])]} /></Space>;
  };

  const accountPick = <LookupSelect catalog="account" fetcher={fetcher} placeholder={form === 'NKCT' ? 'Tài khoản ghi Có' : 'Tài khoản'} style={{ width: 300 }} value={accountCode || null} onChange={(c) => setAccountCode(c ?? '')} />;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Hình thức sổ kế toán</h2>
        <Select style={{ width: 130 }} placeholder="Năm" value={year} onChange={(y) => { setYear(y); setRange(null); }} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }))} />
        <Radio.Group optionType="button" value={form} disabled={!can('period.update') || change.isPending} onChange={(e) => change.mutate(e.target.value as BookForm)} options={FORMS} />
        <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={from ? [dayjs(from), dayjs(to)] : null} onChange={(r) => r?.[0] && r[1] && setRange([r[0].format('YYYY-MM-DD'), r[1].format('YYYY-MM-DD')])} />
        {(form === 'NKCT' || (form === 'CTGS' && ctgsTab === 'ledger')) && accountPick}
        {can('report.print') && !!url && <><Button disabled={needAccount} onClick={() => open(url, 'pdf')}>In PDF</Button><Button disabled={needAccount} onClick={() => open(url, 'xlsx')}>Xuất Excel</Button></>}
      </Space>
      {!can('period.update') && <Alert type="info" showIcon message="Chỉ người có quyền sửa kỳ kế toán mới đổi được hình thức sổ của năm." />}
      {form === 'CTGS' && <Tabs activeKey={ctgsTab} onChange={setCtgsTab} items={[{ key: 'sets', label: 'Chứng từ ghi sổ' }, { key: 'register', label: 'Sổ đăng ký Chứng từ ghi sổ' }, { key: 'ledger', label: 'Sổ Cái' }]} />}
      {form === 'CTGS' && ctgsTab === 'sets' && <Space direction="vertical" style={{ width: '100%' }}>
        {can('voucher_set.create') && <Button type="primary" onClick={() => { addForm.setFieldsValue({ setDate: dayjs(to || undefined), range: [dayjs(from), dayjs(to)] }); setAdding(true); }}>Lập Chứng từ ghi sổ</Button>}
        <Table size="small" bordered pagination={false} rowKey="id" loading={sets.isFetching} dataSource={sets.data?.rows ?? []}
          columns={[{ title: 'Số hiệu', dataIndex: 'setNo', width: 90 }, { title: 'Ngày', dataIndex: 'setDate', width: 120, render: formatVnDate }, { title: 'Diễn giải', dataIndex: 'description' }, { title: 'Số CT gốc', dataIndex: 'vouchers', align: 'right', width: 110 }, { title: 'Số tiền', dataIndex: 'amount', align: 'right', render: money },
            { title: '', width: 220, render: (_: unknown, r: SetRow) => <Space>
              {can('report.print') && <Button size="small" onClick={() => open(`/api/voucher-sets/${r.id}`, 'pdf')}>In</Button>}
              {can('voucher_set.delete') && <Popconfirm title="Xóa Chứng từ ghi sổ này? Chứng từ gốc không đổi." okText="Xóa" cancelText="Không" onConfirm={() => remove.mutate(r.id)}><Button size="small" danger>Xóa</Button></Popconfirm>}</Space> }]} />
      </Space>}
      {body()}
      <Modal open={adding} title="Lập Chứng từ ghi sổ" okText="Lập" cancelText="Đóng" confirmLoading={create.isPending} onCancel={() => setAdding(false)} onOk={() => void addForm.validateFields().then((v: { setDate: dayjs.Dayjs; description: string; range: [dayjs.Dayjs, dayjs.Dayjs]; voucherType?: string }) =>
        create.mutate({ fiscalYear: year, setDate: v.setDate.format('YYYY-MM-DD'), description: v.description, dateFrom: v.range[0].format('YYYY-MM-DD'), dateTo: v.range[1].format('YYYY-MM-DD'), ...(v.voucherType ? { voucherType: v.voucherType.toUpperCase() } : {}) }))}>
        <Form form={addForm} layout="vertical">
          <Form.Item name="description" label="Diễn giải" rules={[{ required: true, message: 'Nhập diễn giải' }]}><Input autoFocus /></Form.Item>
          <Form.Item name="setDate" label="Ngày Chứng từ ghi sổ" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item>
          <Form.Item name="range" label="Gom chứng từ gốc đã ghi sổ trong khoảng ngày" rules={[{ required: true, message: 'Chọn khoảng ngày' }]}><DatePicker.RangePicker format="DD/MM/YYYY" /></Form.Item>
          <Form.Item name="voucherType" label="Loại chứng từ (để trống = mọi loại)"><Input style={{ width: 120 }} maxLength={10} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
