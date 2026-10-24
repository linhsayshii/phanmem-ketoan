import { useEffect, useState } from 'react';
import { Alert, Button, DatePicker, Input, Modal, Popconfirm, Radio, Select, Space, Switch, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NO_SALARY, PayrollErrorAlert } from './payrollUi.js';

// Mẫu tệp chi lương (Task 8): người dùng tự ánh xạ cột theo mẫu import của ngân hàng mình. Phần mềm chưa có mẫu nào của từng ngân hàng (chờ mẫu thật), chỉ có bố cục "Chung".
const F = '/api/payroll/payment-formats';
const FIELDS: { value: string; label: string }[] = [
  { value: 'seq', label: 'Số thứ tự' }, { value: 'employee_code', label: 'Mã nhân viên' }, { value: 'employee_name', label: 'Họ tên nhân viên' }, { value: 'account_no', label: 'Số tài khoản nhận' },
  { value: 'account_name', label: 'Tên người nhận (chủ tài khoản)' }, { value: 'bank_code', label: 'Mã ngân hàng nhận' }, { value: 'bank_name', label: 'Tên ngân hàng nhận' }, { value: 'amount', label: 'Số tiền' },
  { value: 'content', label: 'Nội dung chuyển khoản' }, { value: 'payer_account_no', label: 'Số tài khoản chi' }, { value: 'payer_account_name', label: 'Tên tài khoản chi' }, { value: 'constant', label: 'Giá trị cố định' },
];
const DELIMS = [{ value: ',', label: 'Dấu phẩy ( , )' }, { value: ';', label: 'Dấu chấm phẩy ( ; )' }, { value: '\t', label: 'Dấu Tab' }, { value: '|', label: 'Dấu gạch đứng ( | )' }];
interface Col { field: string; header: string; value?: string }
interface Fmt { id?: number; name: string; fileType: 'csv' | 'xlsx'; delimiter: string; utf8Bom: boolean; hasHeader: boolean; asciiOnly: boolean; contentTemplate: string; columns: Col[] }
interface RunRow { id: number; name: string; status: string }
interface Preview { sample: boolean; rows: string[][]; warnings: { message: string }[]; recipientCount: number }
const NEW: Fmt = { name: '', fileType: 'csv', delimiter: ',', utf8Bom: true, hasHeader: true, asciiOnly: false, contentTemplate: 'Lương tháng {month}/{year} {employee_name}',
  columns: [{ field: 'account_no', header: 'Số tài khoản' }, { field: 'account_name', header: 'Tên người nhận' }, { field: 'amount', header: 'Số tiền' }, { field: 'content', header: 'Nội dung' }] };
const body = (f: Fmt) => ({ name: f.name.trim(), fileType: f.fileType, delimiter: f.delimiter, utf8Bom: f.utf8Bom, hasHeader: f.hasHeader, asciiOnly: f.asciiOnly, contentTemplate: f.contentTemplate,
  columns: f.columns.map((c) => ({ field: c.field, header: c.header, ...(c.field === 'constant' ? { value: c.value ?? '' } : {}) })) });
const fieldLabel = (v: string) => FIELDS.find((x) => x.value === v)?.label ?? v;

function FormatDialog({ target, onClose }: { target: Fmt | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Fmt>(NEW); const [err, setErr] = useState<unknown>(null);
  const [period, setPeriod] = useState(dayjs()); const [runId, setRunId] = useState<number | undefined>(undefined); const [pv, setPv] = useState<Preview | null>(null);
  useEffect(() => { if (target) { setF(target); setErr(null); setPv(null); setRunId(undefined); } }, [target]);
  const runs = useQuery({ queryKey: ['payroll-runs', period.year(), period.month() + 1], enabled: !!target, queryFn: () => api<RunRow[]>(`/api/payroll/runs?year=${period.year()}&month=${period.month() + 1}`) });
  const patchCol = (i: number, p: Partial<Col>) => setF({ ...f, columns: f.columns.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const move = (i: number, d: number) => { const cols = [...f.columns]; const [c] = cols.splice(i, 1); cols.splice(i + d, 0, c!); setF({ ...f, columns: cols }); };
  const save = useMutation({
    mutationFn: () => api(f.id ? `${F}/${f.id}` : F, { method: f.id ? 'PUT' : 'POST', json: body(f) }),
    onError: setErr, onSuccess: () => { void message.success('Đã lưu mẫu tệp chi lương'); void qc.invalidateQueries({ queryKey: ['payroll-payment-formats'] }); onClose(); },
  });
  const preview = useMutation({ mutationFn: () => api<Preview>(`${F}/preview`, { method: 'POST', json: { format: body(f), ...(runId ? { runId } : {}) } }), onError: setErr, onSuccess: (r) => { setErr(null); setPv(r); } });
  return (
    <Modal open={!!target} title={f.id ? 'Sửa mẫu tệp chi lương' : 'Thêm mẫu tệp chi lương'} onCancel={onClose} onOk={() => { setErr(null); save.mutate(); }} okText="Lưu (Ctrl+S)" cancelText="Bỏ qua" confirmLoading={save.isPending} destroyOnHidden width={900}>
      <div onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); setErr(null); save.mutate(); } }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space wrap align="end">
            <label>Tên mẫu<br /><Input aria-label="Tên mẫu" value={f.name} maxLength={100} style={{ width: 240 }} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label>Loại tệp<br /><Radio.Group aria-label="Loại tệp" value={f.fileType} onChange={(e) => setF({ ...f, fileType: e.target.value })} options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel (.xlsx)' }]} /></label>
            {f.fileType === 'csv' && <label>Dấu phân cách<br /><Select aria-label="Dấu phân cách" value={f.delimiter} style={{ width: 190 }} options={DELIMS} onChange={(delimiter) => setF({ ...f, delimiter })} /></label>}
            {f.fileType === 'csv' && <label>BOM UTF-8 <Switch aria-label="BOM UTF-8" checked={f.utf8Bom} onChange={(utf8Bom) => setF({ ...f, utf8Bom })} /></label>}
            <label>Dòng tiêu đề <Switch aria-label="Dòng tiêu đề" checked={f.hasHeader} onChange={(hasHeader) => setF({ ...f, hasHeader })} /></label>
            <label>Bỏ dấu tiếng Việt <Switch aria-label="Bỏ dấu tiếng Việt" checked={f.asciiOnly} onChange={(asciiOnly) => setF({ ...f, asciiOnly })} /></label>
          </Space>
          <label>Nội dung chuyển khoản (dùng {'{month}'}, {'{year}'}, {'{employee_name}'}, {'{employee_code}'}, {'{run_name}'})<br />
            <Input aria-label="Nội dung chuyển khoản" value={f.contentTemplate} maxLength={200} onChange={(e) => setF({ ...f, contentTemplate: e.target.value })} /></label>
          <Table<Col & { i: number }> size="small" rowKey="i" pagination={false} dataSource={f.columns.map((c, i) => ({ ...c, i }))} data-testid="format-columns"
            columns={[
              { title: 'Cột', width: 50, render: (_, c) => c.i + 1 },
              { title: 'Lấy từ', width: 260, render: (_, c) => <Select aria-label={`Cột ${c.i + 1} lấy từ`} value={c.field} style={{ width: 240 }} options={FIELDS} onChange={(field) => patchCol(c.i, { field })} /> },
              { title: 'Tiêu đề cột trong tệp', render: (_, c) => <Input aria-label={`Cột ${c.i + 1} tiêu đề`} value={c.header} maxLength={100} placeholder={fieldLabel(c.field)} onChange={(e) => patchCol(c.i, { header: e.target.value })} /> },
              { title: 'Giá trị cố định', width: 170, render: (_, c) => c.field === 'constant' && <Input aria-label={`Cột ${c.i + 1} giá trị`} value={c.value ?? ''} maxLength={200} onChange={(e) => patchCol(c.i, { value: e.target.value })} /> },
              { title: '', width: 150, render: (_, c) => (<Space size={8}>
                <a aria-label={`Đưa cột ${c.i + 1} lên`} onClick={() => c.i > 0 && move(c.i, -1)}>Lên</a><a aria-label={`Đưa cột ${c.i + 1} xuống`} onClick={() => c.i < f.columns.length - 1 && move(c.i, 1)}>Xuống</a>
                {f.columns.length > 1 && <a onClick={() => setF({ ...f, columns: f.columns.filter((_x, j) => j !== c.i) })}>Xóa</a>}</Space>) },
            ]} />
          <Button onClick={() => setF({ ...f, columns: [...f.columns, { field: 'employee_name', header: '' }] })}>Thêm cột</Button>
          <Space wrap align="end">
            <label>Xem thử với bảng lương tháng<br /><DatePicker picker="month" format="MM/YYYY" allowClear={false} aria-label="Tháng xem thử" value={period} onChange={(v) => { if (v) { setPeriod(v); setRunId(undefined); } }} /></label>
            <Select aria-label="Bảng lương xem thử" allowClear placeholder="Để trống = dòng minh họa" style={{ width: 280 }} value={runId} onChange={(v) => setRunId(v ?? undefined)} options={(runs.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
            <Button loading={preview.isPending} onClick={() => preview.mutate()}>Xem thử 5 dòng</Button>
          </Space>
          {pv && (
            <div data-testid="format-preview">
              {pv.sample && <Tag color="orange">Dữ liệu minh họa, không phải nhân viên thật</Tag>}
              {pv.warnings.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`${pv.warnings.length} nhân viên không vào tệp`} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{pv.warnings.map((w) => <li key={w.message}>{w.message}</li>)}</ul>} />}
              <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', minWidth: '100%' }}><tbody>
                {pv.rows.map((r, i) => (<tr key={i}>{r.map((c, j) => <td key={j} style={{ border: '1px solid #ddd', padding: '2px 8px', fontWeight: f.hasHeader && i === 0 ? 600 : 400, whiteSpace: 'nowrap' }}>{c}</td>)}</tr>))}
              </tbody></table></div>
              <div>Tệp có {pv.recipientCount} người; hiển thị tối đa 5 dòng đầu.</div>
            </div>)}
          <PayrollErrorAlert error={err} />
        </Space>
      </div>
    </Modal>);
}

function Formats() {
  const { can } = useAuth(); const qc = useQueryClient();
  const [dlg, setDlg] = useState<Fmt | null>(null);
  const list = useQuery({ queryKey: ['payroll-payment-formats'], queryFn: () => api<(Fmt & { id: number })[]>(F) });
  const del = useMutation({
    mutationFn: (id: number) => api(`${F}/${id}`, { method: 'DELETE' }),
    onError: (e) => void message.error((e as Error).message), onSuccess: () => { void message.success('Đã xóa mẫu tệp'); void qc.invalidateQueries({ queryKey: ['payroll-payment-formats'] }); },
  });
  return (
    <div>
      <Space wrap align="center" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Mẫu tệp chi lương</h2>
        {can('payroll.export') && <Button type="primary" onClick={() => setDlg(NEW)}>Thêm mẫu</Button>}
      </Space>
      <Alert style={{ marginBottom: 12 }} type="info" showIcon data-testid="formats-banner" message="Chưa có mẫu tệp theo từng ngân hàng."
        description="Mỗi ngân hàng có mẫu nhập chi hộ riêng. Khai cột theo đúng thứ tự và tiêu đề trong mẫu ngân hàng cấp cho công ty, xem thử rồi lưu. Mẫu Chung chỉ là bố cục tham khảo, không thuộc ngân hàng nào." />
      <PayrollErrorAlert error={list.error} />
      <Table<Fmt & { id: number }> size="small" rowKey="id" pagination={false} dataSource={list.data ?? []} loading={list.isLoading} data-testid="format-list"
        columns={[
          { title: 'Tên mẫu', dataIndex: 'name' }, { title: 'Loại tệp', dataIndex: 'fileType', width: 100, render: (t: string) => (t === 'xlsx' ? 'Excel' : 'CSV') },
          { title: 'Các cột', render: (_, r) => r.columns.map((c) => c.header || fieldLabel(c.field)).join(' | ') },
          ...(can('payroll.export') ? [{ title: '', width: 120, render: (_: unknown, r: Fmt & { id: number }) => (<Space><a onClick={() => setDlg(r)}>Sửa</a>
            <Popconfirm title="Xóa mẫu tệp này?" description="Mẫu đã dùng để xuất tệp thì không xóa được." okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><a>Xóa</a></Popconfirm></Space>) }] : []),
        ]} />
      <FormatDialog target={dlg} onClose={() => setDlg(null)} />
    </div>);
}

export default function PayrollPaymentFormatsPage() {
  const { me } = useAuth();
  return me?.sensitive.includes('view_salary') ? <Formats /> : NO_SALARY;
}
