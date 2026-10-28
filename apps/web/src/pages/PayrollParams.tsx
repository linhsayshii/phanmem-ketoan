import { useEffect, useState } from 'react';
import { Alert, Button, DatePicker, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { formatVnDate } from '@kt/domain';
import { VnNumberInput } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { PayrollErrorAlert } from './payrollUi.js';
import { PARAM_DEFS, emptyForm, formToValue, isIllustrative, paramDef, summarizeParam, valueToForm, type BracketRow, type ParamField, type ParamForm } from './payrollCommon.js';

const P = '/api/payroll/params';
interface ParamRow { id: number; code: string; validFrom: string; validTo: string | null; value: unknown; source: string }
interface Effective { value: unknown; source: 'legal_param' | 'payroll_param'; warning?: string }
const iso = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');
const coversDate = (r: ParamRow, date: string) => r.validFrom <= date && (r.validTo === null || r.validTo >= date);

function FieldInput({ f, value, onChange }: { f: ParamField; value: string | null; onChange: (v: string | null) => void }) {
  if (f.type === 'vnd') return <VnNumberInput scale={0} value={value} aria-label={f.label} style={{ width: 200 }} onChange={onChange} />;
  if (f.type === 'bool') return <Select aria-label={f.label} value={value ?? undefined} allowClear style={{ width: 200 }} placeholder="Chọn" onChange={(v) => onChange(v ?? null)} options={[{ value: 'true', label: 'Có' }, { value: 'false', label: 'Không' }]} />;
  if (f.type === 'enum') return <Select aria-label={f.label} value={value ?? undefined} allowClear style={{ width: 200 }} placeholder="Chọn" onChange={(v) => onChange(v ?? null)} options={f.options ?? []} />;
  return <Input aria-label={f.label} value={value ?? ''} inputMode="decimal" style={{ width: 200, textAlign: 'right' }} onChange={(e) => onChange(e.target.value)} />;
}

function Brackets({ rows, onChange }: { rows: BracketRow[]; onChange: (r: BracketRow[]) => void }) {
  const patch = (i: number, p: Partial<BracketRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div>
      <Table<BracketRow & { i: number }> size="small" rowKey="i" pagination={false} dataSource={rows.map((r, i) => ({ ...r, i }))} data-testid="brackets"
        columns={[
          { title: 'Bậc', width: 60, render: (_, r) => r.i + 1 },
          { title: 'Thu nhập tính thuế đến (đồng)', render: (_, r) => (r.i === rows.length - 1 ? <span>Không giới hạn</span>
            : <VnNumberInput scale={0} value={r.upTo} aria-label={`Bậc ${r.i + 1} đến mức`} style={{ width: 200 }} onChange={(v) => patch(r.i, { upTo: v })} />) },
          { title: 'Thuế suất (%)', width: 150, render: (_, r) => <Input aria-label={`Bậc ${r.i + 1} thuế suất`} value={r.rate ?? ''} inputMode="decimal" style={{ width: 110, textAlign: 'right' }} onChange={(e) => patch(r.i, { rate: e.target.value })} /> },
          { title: '', width: 60, render: (_, r) => rows.length > 1 && <a onClick={() => onChange(rows.filter((_x, j) => j !== r.i))}>Xóa</a> },
        ]} />
      <Button style={{ marginTop: 8 }} onClick={() => onChange([...rows.slice(0, -1), { upTo: null, rate: null }, rows[rows.length - 1]!])}>Thêm bậc</Button>
    </div>);
}

function ParamDialog({ target, onClose }: { target: { row?: ParamRow; code?: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const edit = target?.row; const [code, setCode] = useState<string | null>(null);
  const [validFrom, setValidFrom] = useState<dayjs.Dayjs | null>(null); const [validTo, setValidTo] = useState<dayjs.Dayjs | null>(null);
  const [source, setSource] = useState(''); const [form, setForm] = useState<ParamForm>(emptyForm('')); const [err, setErr] = useState<unknown>(null);
  // Mở hộp thoại: sửa thì nạp dòng đã nhập; thêm thì để TRỐNG mọi giá trị (phần mềm không điền sẵn tham số pháp lý nào).
  useEffect(() => {
    if (!target) return;
    setErr(null);
    if (target.row) { setCode(target.row.code); setValidFrom(dayjs(target.row.validFrom)); setValidTo(target.row.validTo ? dayjs(target.row.validTo) : null); setSource(target.row.source); setForm(valueToForm(target.row.code, target.row.value)); }
    else { setCode(target.code ?? null); setValidFrom(null); setValidTo(null); setSource(''); setForm(emptyForm(target.code ?? '')); }
  }, [target]);
  const def = code ? paramDef(code) : undefined;
  // Kiểm đầu vào trước khi gọi API (không qua mutation, nên nút Lưu không nhấp nháy trạng thái đang lưu khi chỉ là lỗi nhập).
  const build = () => {
    if (!code || !def) throw new Error('Chọn tham số');
    if (!validFrom) throw new Error('Nhập ngày bắt đầu hiệu lực');
    if (!source.trim()) throw new Error('Phải ghi nguồn văn bản (số hiệu, điều, khoản)');
    const v = formToValue(code, form);
    if (!v.ok) throw new Error(v.error);
    return { code, validFrom: iso(validFrom), validTo: validTo ? iso(validTo) : null, value: v.value, source: source.trim() };
  };
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof build>) => api(P, { method: 'PUT', json: body }),
    onError: setErr,
    onSuccess: () => { void message.success('Đã lưu tham số'); void qc.invalidateQueries({ queryKey: ['payroll-params'] }); void qc.invalidateQueries({ queryKey: ['payroll-param-effective'] }); onClose(); },
  });
  return (
    <Modal open={!!target} title={edit ? 'Sửa tham số lương' : 'Thêm tham số lương'} onCancel={onClose} onOk={() => { try { setErr(null); save.mutate(build()); } catch (e) { setErr(e); } }} okText="Lưu" cancelText="Bỏ qua" confirmLoading={save.isPending} destroyOnHidden width={680}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space wrap align="end">
          <label>Tham số<br /><Select aria-label="Tham số" value={code ?? undefined} disabled={!!edit} placeholder="Chọn tham số" style={{ width: 380 }} showSearch optionFilterProp="label"
            options={PARAM_DEFS.map((d) => ({ value: d.code, label: d.label }))} onChange={(c: string | undefined) => { setCode(c ?? null); setForm(emptyForm(c ?? '')); }} /></label>
          <label>Hiệu lực từ ngày<br /><DatePicker aria-label="Hiệu lực từ ngày" format="DD/MM/YYYY" value={validFrom} disabled={!!edit} onChange={setValidFrom} /></label>
          <label>Đến ngày (trống = không giới hạn)<br /><DatePicker aria-label="Hiệu lực đến ngày" format="DD/MM/YYYY" value={validTo} onChange={setValidTo} /></label>
        </Space>
        {def && <div style={{ color: '#666' }}>{def.hint}</div>}
        {def?.brackets && <Brackets rows={form.brackets} onChange={(brackets) => setForm({ ...form, brackets })} />}
        {def && !def.brackets && (
          <Space wrap align="start" size="large">
            {def.fields.map((f) => (<label key={f.path}>{f.label}{f.optional ? ' (không bắt buộc)' : ''}<br />
              <FieldInput f={f} value={form.fields[f.path] ?? null} onChange={(v) => setForm({ ...form, fields: { ...form.fields, [f.path]: v } })} /></label>))}
          </Space>)}
        <label>Nguồn văn bản (bắt buộc: số hiệu, điều, khoản)<br />
          <Input.TextArea aria-label="Nguồn văn bản" rows={2} maxLength={500} value={source} onChange={(e) => setSource(e.target.value)} /></label>
        {isIllustrative(source) && <Alert type="warning" showIcon message="Dòng này ghi là dữ liệu minh họa, không phải văn bản pháp lý: chỉ dùng để thử, không dùng để tính lương thật." />}
        <PayrollErrorAlert error={err} />
      </Space>
    </Modal>);
}

export default function PayrollParamsPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const canEdit = can('payroll.param');
  const [date, setDate] = useState(dayjs()); const [dialog, setDialog] = useState<{ row?: ParamRow; code?: string } | null>(null); const [filter, setFilter] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['payroll-params'], queryFn: () => api<ParamRow[]>(P) });
  const rows = list.data ?? [];
  const eff = useQueries({ queries: PARAM_DEFS.map((d) => ({
    queryKey: ['payroll-param-effective', d.code, iso(date)],
    // 409 PAYROLL_PARAM_MISSING = chưa có tham số tại ngày này: không phải lỗi hiển thị, chỉ là dòng "Chưa có".
    queryFn: async (): Promise<Effective | null> => { try { return await api<Effective>(`${P}/effective?code=${d.code}&date=${iso(date)}`); } catch (e) { if (e instanceof ApiError && e.code === 'PAYROLL_PARAM_MISSING') return null; throw e; } },
  })) });
  const del = useMutation({
    mutationFn: (id: number) => api(`${P}/${id}`, { method: 'DELETE' }),
    onError: (e) => void message.error((e as Error).message), onSuccess: () => { void message.success('Đã xóa tham số'); void qc.invalidateQueries({ queryKey: ['payroll-params'] }); void qc.invalidateQueries({ queryKey: ['payroll-param-effective'] }); },
  });
  const sourceOn = (code: string, d: string) => rows.find((r) => r.code === code && coversDate(r, d))?.source ?? null;
  const effRows = PARAM_DEFS.map((d, i) => ({ def: d, eff: eff[i]!.data ?? null, loading: eff[i]!.isLoading, error: eff[i]!.error }));
  const illustrative = effRows.some((r) => r.eff && r.eff.source === 'payroll_param' && isIllustrative(sourceOn(r.def.code, iso(date))));
  const label = (code: string) => paramDef(code)?.label ?? code;
  const sourceCell = (r: ParamRow | string | null) => {
    const text = typeof r === 'string' || r === null ? r : r.source;
    return text ? <span>{isIllustrative(text) && <Tag color="orange">Dữ liệu minh họa</Tag>}{text}</span> : null;
  };

  const effective = (
    <>
      <Space style={{ marginBottom: 8 }} wrap>Hiệu lực tại ngày <DatePicker aria-label="Ngày xem hiệu lực" format="DD/MM/YYYY" allowClear={false} value={date} onChange={(v) => v && setDate(v)} /></Space>
      {illustrative && <Alert style={{ marginBottom: 8 }} type="warning" showIcon data-testid="illustrative-warning" message="Có tham số đang áp dụng ghi nguồn là dữ liệu minh họa, không phải văn bản pháp lý: không dùng để tính lương thật." />}
      <Table size="small" rowKey={(r) => r.def.code} pagination={false} dataSource={effRows} loading={eff.some((q) => q.isLoading)} data-testid="effective-params"
        columns={[
          { title: 'Tham số', render: (_, r) => <div>{r.def.label}<div style={{ color: '#999', fontSize: 12 }}>{r.def.code}</div></div> },
          { title: 'Trạng thái', width: 120, render: (_, r) => (r.error ? <Tag color="red">Lỗi</Tag> : r.eff ? <Tag color="green">Có hiệu lực</Tag> : <Tag color="red">Chưa có</Tag>) },
          { title: 'Giá trị áp dụng', render: (_, r) => (r.eff ? summarizeParam(r.def.code, r.eff.value) : <span style={{ color: '#999' }}>Chưa nhập</span>) },
          { title: 'Nguồn', render: (_, r) => (!r.eff ? null : r.eff.source === 'legal_param' ? <Tag color="blue">Tham số pháp lý đã kiểm của hệ thống</Tag> : sourceCell(sourceOn(r.def.code, iso(date)))) },
          { title: 'Cảnh báo', render: (_, r) => r.eff?.warning && <Tag color="gold" style={{ whiteSpace: 'normal' }}>{r.eff.warning}</Tag> },
          ...(canEdit ? [{ title: '', width: 80, render: (_: unknown, r: { def: { code: string }; eff: Effective | null }) => <a onClick={() => setDialog({ code: r.def.code })}>{r.eff ? 'Thêm kỳ mới' : 'Nhập'}</a> }] : []),
        ]} />
    </>);

  const history = (
    <>
      <Space style={{ marginBottom: 8 }} wrap>
        <Select aria-label="Lọc theo tham số" allowClear placeholder="Tất cả tham số" style={{ width: 380 }} value={filter ?? undefined} onChange={(v) => setFilter(v ?? null)} options={PARAM_DEFS.map((d) => ({ value: d.code, label: d.label }))} />
        {canEdit && <Button type="primary" onClick={() => setDialog(filter ? { code: filter } : {})}>Thêm tham số</Button>}
      </Space>
      <Table<ParamRow> size="small" rowKey="id" pagination={{ pageSize: 20, hideOnSinglePage: true }} dataSource={rows.filter((r) => !filter || r.code === filter)} loading={list.isLoading} data-testid="param-list"
        locale={{ emptyText: 'Chưa nhập tham số nào: nhập từ văn bản pháp luật hiện hành kèm nguồn' }}
        columns={[
          { title: 'Tham số', dataIndex: 'code', render: label }, { title: 'Từ ngày', dataIndex: 'validFrom', width: 110, render: formatVnDate },
          { title: 'Đến ngày', dataIndex: 'validTo', width: 110, render: (v: string | null) => (v ? formatVnDate(v) : 'Không giới hạn') },
          { title: 'Giá trị', render: (_, r) => summarizeParam(r.code, r.value) }, { title: 'Nguồn', render: (_, r) => sourceCell(r) },
          ...(canEdit ? [{ title: '', width: 110, render: (_: unknown, r: ParamRow) => (<Space><a onClick={() => setDialog({ row: r })}>Sửa</a>
            <Popconfirm title="Xóa dòng tham số này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><a>Xóa</a></Popconfirm></Space>) }] : []),
        ]} />
    </>);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Tham số lương</h2>
      <Alert style={{ marginBottom: 12 }} type="info" showIcon data-testid="params-banner" message="Giá trị do người dùng nhập từ văn bản gốc; phần mềm không có mặc định."
        description="Thuế suất, giảm trừ gia cảnh, tỷ lệ và mức trần bảo hiểm, lương tối thiểu vùng, hệ số làm thêm giờ đều phải nhập kèm nguồn văn bản (số hiệu, điều, khoản) và ngày hiệu lực. Khi có tham số pháp lý đã kiểm của hệ thống thì hệ thống dùng tham số đó." />
      {(list.error as Error | null) && <PayrollErrorAlert error={list.error} />}
      <Tabs items={[{ key: 'eff', label: 'Đang hiệu lực', children: effective }, { key: 'all', label: 'Các dòng đã nhập', children: history }]} />
      <ParamDialog target={dialog} onClose={() => setDialog(null)} />
    </div>);
}
