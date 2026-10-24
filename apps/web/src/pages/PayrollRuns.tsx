import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef, GridApi, NewValueParams } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnNumber, type PayrollColumn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NO_SALARY, PayrollErrorAlert } from './payrollUi.js';
import { RUN_KIND, RUN_STATUS, columnRound, lineToRow, money, parseManualInput, patchRow, totalRow, type GridRow, type RunLine } from './payrollCommon.js';

const R = '/api/payroll/runs';
interface RunSummary { id: number; year: number; month: number; kind: string; status: string; name: string; departmentName: string | null; structureName: string; employeeCount: number;
  totals: { gross: string; siEmp: string; siEr: string; pit: string; net: string }; calculatedAt: string | null }
interface RunDetail extends Omit<RunSummary, 'totals'> { warnings: { code: string; message: string }[]; stale: boolean; columns: PayrollColumn[]; lines: RunLine[]; proration: string; note: string | null; voucherId: string | null }
interface StructureRow { id: number; code: string; name: string; isDefault: boolean }
const monthText = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;

function CreateDialog({ open, year, month, onClose, onCreated }: { open: boolean; year: number; month: number; onClose: () => void; onCreated: (r: RunDetail) => void }) {
  const [form] = Form.useForm<{ period: dayjs.Dayjs; kind: string; departmentCode: string | null; structureId: number | null; name: string; note: string }>();
  const deptId = useRef<number | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const structures = useQuery({ queryKey: ['payroll-structures'], enabled: open, queryFn: () => api<StructureRow[]>('/api/payroll/structures') });
  useEffect(() => { if (open) { setErr(null); deptId.current = null; form.resetFields(); form.setFieldsValue({ period: dayjs(`${year}-${String(month).padStart(2, '0')}-01`), kind: 'regular', departmentCode: null, structureId: null }); } }, [open, year, month, form]);
  const submit = () => {
    void form.validateFields().then(async (v) => {
      setBusy(true); setErr(null);
      try {
        const r = await api<RunDetail>(R, { method: 'POST', json: { year: v.period.year(), month: v.period.month() + 1, kind: v.kind, departmentId: v.departmentCode ? deptId.current : null,
          structureId: v.structureId ?? undefined, name: v.name?.trim() || undefined, note: v.note?.trim() || undefined } });
        onCreated(r); onClose();
      } catch (e) { setErr(e); } finally { setBusy(false); }
    }, () => undefined);
  };
  return (
    <Modal open={open} title="Tạo bảng lương" onCancel={onClose} onOk={submit} okText="Tạo" cancelText="Bỏ qua" confirmLoading={busy} destroyOnHidden forceRender width={560}>
      <Form form={form} name="payroll-run" layout="vertical" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLElement).closest('.ant-select')) { e.preventDefault(); submit(); } }}>
        <Space align="start" wrap>
          <Form.Item label="Kỳ lương" name="period" rules={[{ required: true }]}><DatePicker picker="month" format="MM/YYYY" allowClear={false} aria-label="Kỳ lương" /></Form.Item>
          <Form.Item label="Loại bảng" name="kind"><Select style={{ width: 170 }} aria-label="Loại bảng" options={Object.entries(RUN_KIND).map(([value, label]) => ({ value, label }))} /></Form.Item>
        </Space>
        <Form.Item label="Bộ phận (trống = tất cả nhân viên có hồ sơ lương)" name="departmentCode">
          <LookupSelect catalog="department" allowClear aria-label="Bộ phận" onChange={(code, row) => { deptId.current = row ? Number(row.id) : null; form.setFieldValue('departmentCode', code); }} />
        </Form.Item>
        <Form.Item label="Cấu trúc bảng lương (trống = cấu trúc mặc định)" name="structureId">
          <Select allowClear aria-label="Cấu trúc bảng lương" options={(structures.data ?? []).map((s) => ({ value: s.id, label: `${s.code} - ${s.name}${s.isDefault ? ' (mặc định)' : ''}` }))} />
        </Form.Item>
        <Form.Item label="Tên bảng lương (trống = tự đặt theo kỳ)" name="name"><Input maxLength={200} aria-label="Tên bảng lương" /></Form.Item>
        <Form.Item label="Ghi chú" name="note"><Input maxLength={500} aria-label="Ghi chú" /></Form.Item>
        <PayrollErrorAlert error={err} />
      </Form>
    </Modal>);
}

function RunView({ id, onGone }: { id: number; onGone: () => void }) {
  const qc = useQueryClient(); const { can } = useAuth();
  const key = ['payroll-run', id];
  const q = useQuery({ queryKey: key, queryFn: () => api<RunDetail>(`${R}/${id}`) });
  const run = q.data;
  const [rows, setRows] = useState<GridRow[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const gridApi = useRef<GridApi<GridRow> | null>(null);
  useEffect(() => { if (run) setRows(run.lines.map(lineToRow)); }, [run]);
  useEffect(() => { setErr(null); }, [id]);

  const open = run?.status === 'draft' || run?.status === 'calculated';
  const canEdit = can('payroll.update') && open;
  const refreshList = () => { void qc.invalidateQueries({ queryKey: ['payroll-runs'] }); };

  const calc = useMutation({
    mutationFn: () => api<RunDetail>(`${R}/${id}/calculate`, { method: 'POST' }),
    onError: setErr,
    onSuccess: (r) => { setErr(null); qc.setQueryData(key, r); refreshList(); void message.success(`Đã tính bảng lương ${r.employeeCount} nhân viên`); },
  });
  const cancel = useMutation({
    mutationFn: () => api<RunDetail>(`${R}/${id}/cancel`, { method: 'POST' }),
    onError: setErr, onSuccess: (r) => { setErr(null); qc.setQueryData(key, r); refreshList(); void message.success('Đã hủy bảng lương'); },
  });
  const del = useMutation({
    mutationFn: () => api(`${R}/${id}`, { method: 'DELETE' }),
    onError: setErr, onSuccess: () => { void message.success('Đã xóa bảng lương nháp'); refreshList(); onGone(); },
  });

  // Sửa ô nhập tay: gửi ngay từng ô; máy chủ tính lại riêng dòng đó và trả dòng mới. Cập nhật tại chỗ để không làm mất ô đang sửa kế bên.
  const saveCell = useCallback(async (e: NewValueParams<GridRow>, code: string) => {
    const row = e.data; const next = (e.newValue as string | null) ?? null; const prev = (e.oldValue as string | null) ?? null;
    if (next === prev) return;
    try {
      const line = await api<RunLine>(`${R}/${id}/lines/${row.employeeId}/values`, { method: 'PUT', json: { values: { [code]: next } } });
      patchRow(row, line); setErr(null); setRows((rs) => [...rs]);
    } catch (x) {
      row.vals = { ...row.vals, [code]: prev ?? '' }; setRows((rs) => [...rs]); setErr(x);
    }
  }, [id]);

  const columns = useMemo<ColDef<GridRow>[]>(() => {
    if (!run) return [];
    const cols: ColDef<GridRow>[] = [
      { colId: '_code', headerName: 'Mã NV', width: 110, pinned: 'left', editable: false, valueGetter: (p) => p.data?.code, cellStyle: (p) => (p.data?.isTotal ? { fontWeight: 600 } : null) },
      { colId: '_name', headerName: 'Họ tên', width: 190, pinned: 'left', editable: false, valueGetter: (p) => p.data?.name, cellStyle: (p) => (p.data?.isTotal ? { fontWeight: 600 } : null) },
      { colId: '_dept', headerName: 'Bộ phận', width: 150, editable: false, valueGetter: (p) => p.data?.dept },
    ];
    for (const c of run.columns) {
      const round = columnRound(c); const input = c.kind === 'input';
      cols.push({
        colId: c.code, headerName: c.name, headerTooltip: `${c.code}${input ? ' - cột nhập tay' : ''}`, width: 140, type: 'rightAligned',
        valueGetter: (p) => p.data?.vals[c.code] ?? '',
        valueFormatter: (p) => (p.value === '' || p.value == null ? '' : formatVnNumber(String(p.value), round)),
        editable: (p) => canEdit && input && !p.node.rowPinned,
        valueSetter: (p) => { p.data.vals = { ...p.data.vals, [c.code]: p.newValue ?? '' }; return true; },
        valueParser: (p) => {
          const v = parseManualInput(String(p.newValue ?? ''));
          if (v === undefined) { void message.warning('Nhập số hợp lệ (ví dụ 1.500.000); tối đa 6 chữ số thập phân'); return p.oldValue ?? null; }
          return v;
        },
        onCellValueChanged: (e) => { void saveCell(e, c.code); },
        cellStyle: (p) => {
          if (p.data?.isTotal) return { fontWeight: 600 };
          if (p.data?.manual.has(c.code)) return { background: 'rgba(250, 173, 20, 0.28)', fontWeight: 600 }; // ô đã sửa tay
          return input && canEdit ? { background: 'rgba(22, 119, 255, 0.07)' } : null; // ô nhập tay chưa có giá trị riêng
        },
      });
    }
    cols.push({
      colId: '_note', headerName: 'Ghi chú', width: 150, pinned: 'right', editable: false, valueGetter: (p) => (p.data?.warnings.length ? p.data.warnings.map((w) => w.message).join('\n') : ''),
      cellRenderer: (p: { data?: GridRow }) => {
        const d = p.data; if (!d || d.isTotal) return null;
        return (<Space size={4}>{d.stale && <Tag color="orange" style={{ margin: 0 }}>Cần tính lại</Tag>}
          {d.warnings.length > 0 && <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{d.warnings.map((w) => w.message).join('\n')}</div>}><Tag color="gold" style={{ margin: 0 }}>Cảnh báo {d.warnings.length}</Tag></Tooltip>}</Space>);
      },
    });
    return cols;
  }, [run, canEdit, saveCell]);

  // F9: chốt ô đang sửa rồi tính (lưu ý ô nhập tay đã gửi từng ô khi rời ô).
  const calcRef = useRef(() => undefined as void);
  calcRef.current = () => { if (can('payroll.update') && open && !calc.isPending) { gridApi.current?.stopEditing(); setTimeout(() => calc.mutate(), 0); } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'F9' || (e.target as Element | null)?.closest?.('.ant-modal-root')) return; e.preventDefault(); calcRef.current(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const total = useMemo(() => (run ? [totalRow(run.columns, rows)] : []), [run, rows]);
  if (q.isLoading) return <div>Đang tải…</div>;
  if (q.error) return <PayrollErrorAlert error={q.error} />;
  if (!run) return null;
  const st = RUN_STATUS[run.status] ?? { label: run.status, color: 'default' };
  const lineWarnings = rows.filter((r) => r.warnings.length);

  return (
    <div data-testid="run-detail">
      <Space wrap align="center" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{run.name}</h3>
        <Tag color={st.color} data-testid="run-status">{st.label}</Tag>
        {run.stale && <Tag color="orange" data-testid="run-stale">Cần tính lại</Tag>}
        <span>{RUN_KIND[run.kind] ?? run.kind} · Kỳ {monthText(run.year, run.month)} · {run.structureName} · {run.employeeCount} nhân viên{run.departmentName ? ` · ${run.departmentName}` : ''}
          {run.calculatedAt ? ` · Tính lúc ${dayjs(run.calculatedAt).format('DD/MM/YYYY HH:mm')}` : ''}</span>
      </Space>
      <Space wrap style={{ marginBottom: 8 }}>
        {can('payroll.update') && open && <Button type="primary" loading={calc.isPending} onClick={() => calcRef.current()}>{run.status === 'draft' ? 'Tính (F9)' : 'Tính lại (F9)'}</Button>}
        {/* Task 6b: nút "Hạch toán" đặt ở đây khi run.status === 'calculated' và API hạch toán đã có. */}
        {can('payroll.update') && open && <Popconfirm title="Hủy bảng lương này?" description="Nhân viên trong bảng được giải phóng để lập bảng khác." okText="Hủy bảng lương" cancelText="Không" onConfirm={() => cancel.mutate()}><Button>Hủy bảng lương</Button></Popconfirm>}
        {can('payroll.delete') && run.status === 'draft' && <Popconfirm title="Xóa bảng lương nháp này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate()}><Button danger>Xóa nháp</Button></Popconfirm>}
      </Space>
      <PayrollErrorAlert error={err} onClose={() => setErr(null)} />
      {run.status === 'draft' && <Alert style={{ marginBottom: 8 }} type="info" showIcon message="Bảng lương nháp chưa có số liệu: bấm Tính (F9). Ô nhập tay (nền xanh) sửa được trước hoặc sau khi tính." />}
      {run.stale && run.status !== 'draft' && <Alert style={{ marginBottom: 8 }} type="warning" showIcon message="Hồ sơ lương, chấm công, tham số hoặc cấu trúc đã đổi sau lần tính gần nhất: bấm Tính lại (F9) để cập nhật số liệu." />}
      {run.warnings.length > 0 && <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={`Cảnh báo cả bảng (${run.warnings.length})`} data-testid="run-warnings"
        description={<ul style={{ margin: 0, paddingLeft: 18 }}>{run.warnings.slice(0, 8).map((w) => <li key={w.code + w.message}>{w.message}</li>)}</ul>} />}
      {lineWarnings.length > 0 && <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={`${lineWarnings.length} nhân viên có cảnh báo`} data-testid="line-warnings"
        description={<ul style={{ margin: 0, paddingLeft: 18 }}>{lineWarnings.slice(0, 6).map((r) => <li key={r.employeeId}><b>{r.code}</b>: {r.warnings.map((w) => w.message).join('; ')}</li>)}{lineWarnings.length > 6 && <li>…</li>}</ul>} />}
      <div data-testid="payroll-grid">
        <KeyboardGrid<GridRow> rows={rows} columns={columns} readOnly={!canEdit} lockRows animateRows={false} pinnedBottomRows={total} height="calc(100vh - 430px)"
          onRowsChange={(next) => setRows(next)} addRowTemplate={() => ({} as GridRow)} onGridApi={(a) => { gridApi.current = a; }} />
      </div>
      <div style={{ marginTop: 4 }}>Chỉ cột nhập tay (nền xanh) sửa được; ô đã sửa tay có nền vàng, xóa trống ô để bỏ giá trị nhập tay. Số liệu mỗi dòng tính lại ngay sau khi sửa.</div>
    </div>);
}

function Runs() {
  const { me, can } = useAuth();
  const now = dayjs();
  const [f, setF] = useRememberedFilter('payroll-runs', { year: now.year(), month: now.month() + 1, kind: 'all' }, `${me?.tenantId}:${me?.userId}`);
  const [sel, setSel] = useState<number | null>(null); const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['payroll-runs', f.year, f.month], queryFn: () => api<RunSummary[]>(`${R}?year=${f.year}&month=${f.month}`) });
  const shown = (list.data ?? []).filter((r) => f.kind === 'all' || r.kind === f.kind);
  const qc = useQueryClient();
  return (
    <div>
      <Space wrap align="center" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Bảng lương</h2>
        <DatePicker picker="month" format="MM/YYYY" allowClear={false} value={dayjs(`${f.year}-${String(f.month).padStart(2, '0')}-01`)} aria-label="Kỳ lương" onChange={(v) => { if (v) { setSel(null); setF({ ...f, year: v.year(), month: v.month() + 1 }); } }} />
        <Select value={f.kind} style={{ width: 170 }} aria-label="Lọc loại bảng" onChange={(kind) => setF({ ...f, kind })}
          options={[{ value: 'all', label: 'Tất cả loại bảng' }, ...Object.entries(RUN_KIND).map(([value, label]) => ({ value, label }))]} />
        {can('payroll.create') && <Button type="primary" onClick={() => setCreating(true)}>Tạo bảng lương</Button>}
      </Space>
      {list.error && <PayrollErrorAlert error={list.error} />}
      <Table<RunSummary> size="small" rowKey="id" pagination={false} dataSource={shown} loading={list.isLoading} data-testid="run-list" scroll={{ y: 150 }} style={{ marginBottom: 12 }}
        locale={{ emptyText: `Chưa có bảng lương tháng ${monthText(f.year, f.month)}` }}
        rowClassName={(r) => (r.id === sel ? 'ant-table-row-selected' : '')}
        onRow={(r) => ({ onClick: () => setSel(r.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Tên bảng lương', dataIndex: 'name' }, { title: 'Loại', dataIndex: 'kind', width: 120, render: (k: string) => RUN_KIND[k] ?? k },
          { title: 'Trạng thái', dataIndex: 'status', width: 130, render: (s: string) => <Tag color={RUN_STATUS[s]?.color ?? 'default'}>{RUN_STATUS[s]?.label ?? s}</Tag> },
          { title: 'Số NV', dataIndex: 'employeeCount', width: 80, align: 'right' },
          { title: 'Tổng thu nhập', width: 150, align: 'right', render: (_, r) => money(r.totals.gross) }, { title: 'Thực lĩnh', width: 150, align: 'right', render: (_, r) => money(r.totals.net) },
          { title: 'Tính lúc', dataIndex: 'calculatedAt', width: 150, render: (v: string | null) => (v ? dayjs(v).format('DD/MM/YYYY HH:mm') : '') },
        ]} />
      {sel !== null ? <RunView key={sel} id={sel} onGone={() => setSel(null)} /> : <div>Chọn một bảng lương ở trên hoặc tạo bảng mới.</div>}
      <CreateDialog open={creating} year={f.year} month={f.month} onClose={() => setCreating(false)} onCreated={(r) => {
        void message.success('Đã tạo bảng lương'); qc.setQueryData(['payroll-run', r.id], r); setF({ ...f, year: r.year, month: r.month }); void qc.invalidateQueries({ queryKey: ['payroll-runs'] }); setSel(r.id);
      }} />
    </div>);
}

export default function PayrollRunsPage() {
  const { me } = useAuth();
  return me?.sensitive.includes('view_salary') ? <Runs /> : NO_SALARY;
}
