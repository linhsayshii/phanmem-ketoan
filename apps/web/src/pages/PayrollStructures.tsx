import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PAYROLL_BUILTIN_COLUMNS, formatVnNumber, type PayrollColumn } from '@kt/domain';
import { LookupSelect } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NO_SALARY, PayrollErrorAlert } from './payrollUi.js';
import { FORMULA_HELP, PRORATION, builtinName, columnRound, columnToRow, formulaSuggestions, rowToColumn, structureProblem, type EditRow } from './payrollCommon.js';

const S = '/api/payroll/structures';
interface Structure { id: number; code: string; name: string; proration: string; isDefault: boolean; parentId: number | null; note: string | null; columns: PayrollColumn[]; inUse: boolean }
interface Preview { values: Record<string, string>; gross: string; net: string; warnings: { code: string; message: string }[] }
const KINDS = [{ value: 'builtin', label: 'Dựng sẵn' }, { value: 'input', label: 'Nhập tay' }, { value: 'formula', label: 'Công thức' }];

// Ô công thức có gợi ý mã cột: gõ vài chữ (hoặc "[") thì hiện danh sách cột, chọn thì thay bằng [mã_cột].
function FormulaInput({ value, columns, selfCode, disabled, onChange }: { value: string; columns: { code: string; name: string; kind: string }[]; selfCode: string; disabled: boolean; onChange: (v: string) => void }) {
  const options = useMemo(() => formulaSuggestions(value, columns, selfCode), [value, columns, selfCode]);
  return (
    <AutoComplete value={value} options={options} disabled={disabled} onChange={onChange} onSelect={onChange} style={{ width: '100%' }} popupMatchSelectWidth={360}>
      <Input aria-label="Công thức" placeholder="Ví dụ: IF([work_days] >= 26, 500000, 0)" />
    </AutoComplete>);
}

function Editor({ source, isNew, templateColumns, onSaved, onDeleted, onClone }: { source: Structure | null; isNew: boolean; templateColumns: PayrollColumn[]; onSaved: (s: Structure) => void; onDeleted: () => void; onClone: (s: Structure) => void }) {
  const { can } = useAuth(); const qc = useQueryClient();
  const keySeq = useRef(1);
  const mk = (cols: PayrollColumn[]) => cols.map((c) => columnToRow(c, keySeq.current++));
  const [code, setCode] = useState(source?.code ?? ''); const [name, setName] = useState(source?.name ?? ''); const [note, setNote] = useState(source?.note ?? '');
  const [proration, setProration] = useState(source?.proration ?? 'calendar');
  const [rows, setRows] = useState<EditRow[]>(() => mk(source?.columns ?? templateColumns));
  const [err, setErr] = useState<unknown>(null);
  const locked = !!source?.inUse; const canEdit = can(isNew ? 'payroll.create' : 'payroll.update') && !locked;
  const columns = useMemo(() => rows.map(rowToColumn), [rows]);
  const problem = useMemo(() => structureProblem(columns), [columns]);
  const patch = (key: number, p: Partial<EditRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const move = (i: number, d: number) => setRows((rs) => { const j = i + d; if (j < 0 || j >= rs.length) return rs; const c = [...rs]; [c[i], c[j]] = [c[j]!, c[i]!]; return c; });
  const blank = (kind: EditRow['kind']): EditRow => ({ key: keySeq.current++, code: '', name: '', kind, formula: '', round: null, income: false, taxable: true, siBase: false, pitRelief: false, deduct: false, creditAccount: '' });
  const addBuiltin = () => {
    const free = PAYROLL_BUILTIN_COLUMNS.find((b) => !rows.some((r) => r.code === b.code));
    if (free) setRows((rs) => [...rs, { ...blank('builtin'), code: free.code, name: free.name }]);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = { code: code.trim(), name: name.trim(), note: note.trim() || null, proration, columns };
      return isNew || !source ? api<Structure>(S, { method: 'POST', json: body }) : api<Structure>(`${S}/${source.id}`, { method: 'PUT', json: body });
    },
    onError: setErr,
    onSuccess: (s) => { setErr(null); void message.success('Đã lưu cấu trúc bảng lương'); void qc.invalidateQueries({ queryKey: ['payroll-structures'] }); onSaved(s); },
  });
  const del = useMutation({
    mutationFn: () => api(`${S}/${source!.id}`, { method: 'DELETE' }),
    onError: setErr, onSuccess: () => { void message.success('Đã xóa cấu trúc'); void qc.invalidateQueries({ queryKey: ['payroll-structures'] }); onDeleted(); },
  });
  const trySave = () => { if (!canEdit) return; if (!code.trim() || !name.trim()) { setErr(new Error('Nhập mã và tên cấu trúc')); return; } if (problem) { setErr(new Error(problem)); return; } save.mutate(); };

  // Xem thử: gửi cấu trúc đang soạn (chưa lưu) với một nhân viên và một tháng.
  const [empId, setEmpId] = useState<number | null>(null); const [empCode, setEmpCode] = useState<string | null>(null); const [period, setPeriod] = useState(dayjs());
  const [pErr, setPErr] = useState<unknown>(null);
  const preview = useMutation({
    mutationFn: (employeeId: number) => api<Preview>(`${S}/preview`, { method: 'POST', json: { employeeId, year: period.year(), month: period.month() + 1, proration, columns } }),
    onError: setPErr, onSuccess: () => setPErr(null),
  });

  const flag = (r: EditRow, k: 'income' | 'taxable' | 'siBase' | 'pitRelief' | 'deduct', label: string) => (
    <Checkbox aria-label={`${label} (${r.code || 'cột mới'})`} checked={r[k]} disabled={!canEdit || r.kind === 'builtin' || (k === 'taxable' && !r.income)} onChange={(e) => patch(r.key, { [k]: e.target.checked })} />);

  return (
    <div onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); trySave(); } }}>
      {locked && (
        <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Cấu trúc đã được bảng lương dùng nên không sửa được"
          description="Để thay đổi, nhân bản cấu trúc rồi sửa bản mới; các bảng lương cũ vẫn giữ cấu trúc cũ." action={<Button size="small" onClick={() => onClone(source!)}>Nhân bản</Button>} />)}
      <Space wrap align="start">
        <Form.Item label="Mã cấu trúc" style={{ marginBottom: 8 }}><Input aria-label="Mã cấu trúc" value={code} maxLength={30} disabled={!canEdit} onChange={(e) => setCode(e.target.value)} style={{ width: 160 }} /></Form.Item>
        <Form.Item label="Tên cấu trúc" style={{ marginBottom: 8 }}><Input aria-label="Tên cấu trúc" value={name} maxLength={200} disabled={!canEdit} onChange={(e) => setName(e.target.value)} style={{ width: 280 }} /></Form.Item>
        <Form.Item label="Tính lương theo ngày công" style={{ marginBottom: 8 }}><Select aria-label="Tính lương theo ngày công" value={proration} disabled={!canEdit} onChange={setProration} options={PRORATION} style={{ width: 300 }} /></Form.Item>
        <Form.Item label="Ghi chú" style={{ marginBottom: 8 }}><Input aria-label="Ghi chú cấu trúc" value={note} maxLength={500} disabled={!canEdit} onChange={(e) => setNote(e.target.value)} style={{ width: 260 }} /></Form.Item>
      </Space>
      <Space wrap style={{ marginBottom: 8 }}>
        {canEdit && <Button type="primary" loading={save.isPending} onClick={trySave}>Lưu cấu trúc (Ctrl+S)</Button>}
        {source && can('payroll.create') && <Button onClick={() => onClone(source)}>Nhân bản</Button>}
        {source && !isNew && can('payroll.delete') && !source.isDefault && <Popconfirm title="Xóa cấu trúc này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate()}><Button danger>Xóa</Button></Popconfirm>}
      </Space>
      <PayrollErrorAlert error={err} onClose={() => setErr(null)} />
      {problem && canEdit && <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={`Cấu trúc chưa hợp lệ: ${problem}`} data-testid="structure-problem" />}
      <Table<EditRow> size="small" rowKey="key" pagination={false} dataSource={rows} data-testid="structure-columns" scroll={{ x: 1360 }} locale={{ emptyText: 'Chưa có cột' }}
        columns={[
          { title: 'Loại cột', width: 120, render: (_, r) => <Select aria-label="Loại cột" value={r.kind} disabled={!canEdit} style={{ width: 108 }} options={KINDS} onChange={(kind) => patch(r.key, { kind, ...(kind === 'builtin' ? { name: builtinName(r.code) } : {}) })} /> },
          { title: 'Mã cột', width: 200, render: (_, r) => r.kind === 'builtin'
            ? <Select aria-label="Mã cột" showSearch value={r.code || undefined} disabled={!canEdit} style={{ width: 188 }} optionFilterProp="label" onChange={(c: string | undefined) => patch(r.key, { code: c ?? '', name: builtinName(c ?? '') })}
              options={PAYROLL_BUILTIN_COLUMNS.map((b) => ({ value: b.code, label: `${b.code} - ${b.name}` }))} />
            : <Input aria-label="Mã cột" value={r.code} disabled={!canEdit} maxLength={40} placeholder="chữ_thường_không_dấu" onChange={(e) => patch(r.key, { code: e.target.value })} /> },
          { title: 'Tên cột', width: 220, render: (_, r) => <Input aria-label="Tên cột" value={r.name} disabled={!canEdit} maxLength={200} onChange={(e) => patch(r.key, { name: e.target.value })} /> },
          { title: 'Công thức', width: 300, render: (_, r) => r.kind === 'formula'
            ? <FormulaInput value={r.formula} columns={columns} selfCode={r.code} disabled={!canEdit} onChange={(v) => patch(r.key, { formula: v })} />
            : <span style={{ color: '#999' }}>{r.kind === 'input' ? 'Nhập tay trên bảng lương' : 'Tính theo quy tắc của hệ thống'}</span> },
          { title: 'Làm tròn', width: 90, render: (_, r) => r.kind === 'builtin' ? null : <InputNumber aria-label="Số chữ số làm tròn" min={0} max={6} precision={0} placeholder="0" value={r.round} disabled={!canEdit} style={{ width: 70 }} onChange={(v) => patch(r.key, { round: v })} /> },
          { title: 'Thu nhập', width: 80, align: 'center', render: (_, r) => flag(r, 'income', 'Thu nhập') },
          { title: 'Chịu thuế', width: 80, align: 'center', render: (_, r) => flag(r, 'taxable', 'Chịu thuế') },
          { title: 'Tính BH', width: 80, align: 'center', render: (_, r) => flag(r, 'siBase', 'Tính vào lương đóng BH') },
          { title: 'Giảm trừ thuế', width: 90, align: 'center', render: (_, r) => flag(r, 'pitRelief', 'Giảm trừ khi tính thuế') },
          { title: 'Khấu trừ', width: 80, align: 'center', render: (_, r) => flag(r, 'deduct', 'Khấu trừ vào thực lĩnh') },
          // Bỏ trống: cột advance ghi Có TK tạm ứng (141) theo nhân viên, cột khác ghi Có phải trả khác (3388).
          { title: 'TK Có khi hạch toán', width: 110, render: (_, r) => r.kind === 'builtin' || !r.deduct ? null
            : <Input aria-label={`Tài khoản Có (${r.code || 'cột mới'})`} value={r.creditAccount} disabled={!canEdit} maxLength={20} placeholder={r.code === 'advance' ? '141' : '3388'} onChange={(e) => patch(r.key, { creditAccount: e.target.value })} /> },
          ...(canEdit ? [{ title: '', width: 110, fixed: 'right' as const, render: (_: unknown, r: EditRow) => {
            const i = rows.findIndex((x) => x.key === r.key);
            return <Space size={4}><Button size="small" aria-label="Lên" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button><Button size="small" aria-label="Xuống" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</Button>
              <a onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Xóa</a></Space>;
          } }] : []),
        ]} />
      {canEdit && <Space style={{ marginTop: 8 }} wrap>
        <Button onClick={() => setRows((rs) => [...rs, blank('input')])}>Thêm cột nhập tay</Button>
        <Button onClick={() => setRows((rs) => [...rs, blank('formula')])}>Thêm cột công thức</Button>
        <Button onClick={addBuiltin}>Thêm cột dựng sẵn</Button></Space>}
      <div style={{ marginTop: 8, color: '#666' }}>{FORMULA_HELP}</div>

      <h4 style={{ marginTop: 20 }}>Xem thử với một nhân viên</h4>
      <Space wrap align="center">
        <LookupSelect catalog="employee" value={empCode} allowClear placeholder="Chọn nhân viên (F4)" style={{ width: 280 }} aria-label="Nhân viên xem thử" onChange={(c, row) => { setEmpCode(c); setEmpId(row ? Number(row.id) : null); }} />
        <DatePicker picker="month" format="MM/YYYY" allowClear={false} value={period} aria-label="Tháng xem thử" onChange={(v) => v && setPeriod(v)} />
        <Button loading={preview.isPending} disabled={!!problem} onClick={() => { if (empId === null) setPErr(new Error('Chọn nhân viên để xem thử')); else preview.mutate(empId); }}>Kiểm công thức</Button>
      </Space>
      <div style={{ marginTop: 8 }}><PayrollErrorAlert error={pErr} /></div>
      {preview.data && (
        <div data-testid="preview-result">
          {preview.data.warnings.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={preview.data.warnings.map((w) => w.message).join('; ')} />}
          <Table size="small" rowKey="code" pagination={false} dataSource={columns.map((c) => ({ code: c.code, name: c.name, value: preview.data!.values[c.code], round: columnRound(c) }))}
            columns={[{ title: 'Cột', render: (_, r) => `${r.code} - ${r.name}` }, { title: 'Giá trị', align: 'right', width: 200, render: (_, r) => (r.value === undefined ? '' : formatVnNumber(r.value, r.round)) }]} />
          <div style={{ marginTop: 4 }}>Thực lĩnh: <b data-testid="preview-net">{formatVnNumber(preview.data.net, 0)}</b></div>
        </div>)}
    </div>);
}

function Structures() {
  const { can } = useAuth(); const qc = useQueryClient();
  const list = useQuery({ queryKey: ['payroll-structures'], queryFn: () => api<Structure[]>(S) });
  const [sel, setSel] = useState<number | 'new' | null>(null);
  const [cloning, setCloning] = useState<Structure | null>(null);
  const [cForm] = Form.useForm<{ code: string; name: string }>(); const [cErr, setCErr] = useState<unknown>(null); const [cBusy, setCBusy] = useState(false);
  const rows = list.data ?? [];
  const current = typeof sel === 'number' ? rows.find((r) => r.id === sel) ?? null : null;
  const template = rows.find((r) => r.isDefault)?.columns ?? [];
  useEffect(() => { if (cloning) { setCErr(null); cForm.setFieldsValue({ code: `${cloning.code}_2`, name: `${cloning.name} (bản sao)` }); } }, [cloning, cForm]);
  const doClone = () => {
    void cForm.validateFields().then(async (v) => {
      setCBusy(true); setCErr(null);
      try { const s = await api<Structure>(`${S}/${cloning!.id}/clone`, { method: 'POST', json: { code: v.code.trim(), name: v.name.trim() } }); void message.success('Đã nhân bản cấu trúc'); await qc.invalidateQueries({ queryKey: ['payroll-structures'] }); setCloning(null); setSel(s.id); }
      catch (e) { setCErr(e); } finally { setCBusy(false); }
    }, () => undefined);
  };
  return (
    <div>
      <Space wrap align="center" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Cấu trúc bảng lương</h2>
        {can('payroll.create') && <Button type="primary" onClick={() => setSel('new')}>Thêm cấu trúc</Button>}
      </Space>
      {list.error && <PayrollErrorAlert error={list.error} />}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 340, flexShrink: 0 }}>
          <Table<Structure> size="small" rowKey="id" pagination={false} dataSource={rows} loading={list.isLoading} data-testid="structure-list" showHeader={false}
            rowClassName={(r) => (r.id === sel ? 'ant-table-row-selected' : '')} onRow={(r) => ({ onClick: () => setSel(r.id), style: { cursor: 'pointer' } })}
            columns={[{ render: (_, r) => (<div><b>{r.code}</b> - {r.name}<div>{r.isDefault && <Tag color="blue">Mặc định</Tag>}{r.inUse && <Tag color="green">Đã dùng</Tag>}<Tag>{r.columns.length} cột</Tag></div></div>) }]} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {sel === null && <div>Chọn một cấu trúc để xem, hoặc thêm cấu trúc mới (bắt đầu từ các cột của cấu trúc mặc định).</div>}
          {sel === 'new' && <Editor key="new" source={null} isNew templateColumns={template} onSaved={(s) => setSel(s.id)} onDeleted={() => setSel(null)} onClone={setCloning} />}
          {current && <Editor key={`${current.id}:${current.inUse}`} source={current} isNew={false} templateColumns={template} onSaved={(s) => setSel(s.id)} onDeleted={() => setSel(null)} onClone={setCloning} />}
        </div>
      </div>
      <Modal open={cloning !== null} title="Nhân bản cấu trúc" onCancel={() => setCloning(null)} onOk={doClone} okText="Nhân bản" cancelText="Bỏ qua" confirmLoading={cBusy} destroyOnHidden forceRender>
        <Form form={cForm} name="clone" layout="vertical">
          <Form.Item label="Mã cấu trúc mới" name="code" rules={[{ required: true, whitespace: true, message: 'Nhập mã' }]}><Input maxLength={30} aria-label="Mã cấu trúc mới" /></Form.Item>
          <Form.Item label="Tên cấu trúc mới" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên' }]}><Input maxLength={200} aria-label="Tên cấu trúc mới" /></Form.Item>
          <PayrollErrorAlert error={cErr} />
        </Form>
      </Modal>
    </div>);
}

export default function PayrollStructuresPage() {
  const { me } = useAuth();
  return me?.sensitive.includes('view_salary') ? <Structures /> : NO_SALARY;
}
