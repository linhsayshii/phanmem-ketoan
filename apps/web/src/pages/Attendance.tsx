import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Modal, Popover, Space, Table, Upload, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef, GridApi } from 'ag-grid-community';
import dayjs from 'dayjs';
import { ATTENDANCE_KIND_LABEL, D, checkAttendanceDay, formatAttendanceCell, parseAttendanceCell, workDays, type AttendanceItem, type AttendanceKind } from '@kt/domain';
import { COLOR, KeyboardGrid, LookupSelect, PageHeader, Toolbar, useRememberedFilter, useUnsavedChanges } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';

// Bảng chấm công: hàng nhân viên, cột ngày. Gõ X (1 ngày), N (nửa ngày), số (giờ làm việc), P/O/K/H (phép, ốm, không lương, nghỉ lễ), T/C/L + số giờ (làm thêm ngày thường/ngày nghỉ/ngày lễ).
const A = '/api/attendance';
const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const SAVE_BATCH = 5000;

interface Emp { id: number; code: string; name: string; departmentId: number | null; startDate: string | null; endDate: string | null }
interface Entry { employeeId: number; date: string; kind: AttendanceKind; qty: string }
interface Warning { employeeId: number; message: string; dates: string[] }
interface Grid { year: number; month: number; days: number; standardHoursPerDay: string | null; employees: Emp[]; entries: Entry[]; warnings: Warning[] }
type Row = { employeeId: number; code: string; name: string; startDate: string | null; endDate: string | null; total?: string } & { [k: `d${number}`]: string };

const dayKey = (n: number): `d${number}` => `d${n}`;
const dateOf = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const LEGEND: [string, string][] = [['X', '1 ngày công'], ['N', 'Nửa ngày'], ['4', 'Số giờ làm việc (quy đổi theo giờ chuẩn/ngày)'], ['P', 'Nghỉ phép hưởng lương (P0,5 = nửa ngày)'], ['O', 'Nghỉ ốm'], ['K', 'Nghỉ không lương'], ['H', 'Nghỉ lễ hưởng lương'],
  ['T2', 'Làm thêm ngày thường 2 giờ'], ['C3', 'Làm thêm ngày nghỉ hằng tuần 3 giờ'], ['L4', 'Làm thêm ngày lễ 4 giờ'], ['X T2', 'Nhiều mã trong một ô, cách nhau bằng dấu cách']];

// Tổng ngày công của hàng, tính tại chỗ từ chữ trong ô; rỗng khi có ô sai hoặc chưa khai giờ chuẩn mà có chấm công theo giờ.
function totalOf(row: Row, days: number, std: string | null): string {
  const items: AttendanceItem[] = [];
  for (let n = 1; n <= days; n++) {
    const t = row[dayKey(n)]; if (!t) continue;
    const p = parseAttendanceCell(t); if (!p.ok) return '';
    items.push(...p.entries);
  }
  if (items.some((i) => i.kind === 'hour') && !(std && D(std).gt(0))) return '';
  const w = workDays(items, std ?? '1');
  return D(w.workDays).toDecimalPlaces(2).toString().replace('.', ',');
}

interface ImportResult { total: number; cells: number; inserted?: number; updated?: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }
function ImportDialog({ open, year, month, departmentId, onClose, onDone }: { open: boolean; year: number; month: number; departmentId: number | null; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [result, setResult] = useState<ImportResult | null>(null); const [failure, setFailure] = useState<string | null>(null); const [valid, setValid] = useState(false);
  useEffect(() => { if (open) { setFile(null); setResult(null); setFailure(null); setValid(false); } }, [open]);
  const q = `year=${year}&month=${month}${departmentId ? `&departmentId=${departmentId}` : ''}`;
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    setFailure(null);
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`${A}/import?${q}&mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setValid(false); setResult(body.error?.code === 'IMPORT_ERRORS' ? { total: 0, cells: 0, errors: body.error.details ?? [] } : null); if (body.error?.code !== 'IMPORT_ERRORS') setFailure(body.error?.message ?? 'Không nhập được tệp'); return; }
    const r = body as ImportResult; setResult(r); setValid(mode === 'validate' && r.errors.length === 0);
    if (mode === 'commit') { void message.success(`Đã nhập chấm công ${r.cells} ô`); onDone(); onClose(); }
  };
  return (
    <Modal open={open} title={`Nhập chấm công từ Excel (tháng ${String(month).padStart(2, '0')}/${year})`} onCancel={onClose} width={720} footer={null} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Button href={`${A}/import/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); setFailure(null); setValid(false); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !valid}>Nhập</Button>
        </Space>
        <div>Mỗi dòng: mã nhân viên, ngày, loại, số lượng. Loại đã có trong ô được thay; có lỗi ở dòng nào thì không nhập dòng nào.</div>
        {failure && <Alert type="error" showIcon message={failure} />}
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ (${result.cells} ô chấm công)`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errorCount ?? result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}-${r.message}`} dataSource={result.errors} pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 70 }, { title: 'Cột', dataIndex: 'column', width: 130 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Modal>);
}

export default function AttendancePage() {
  const qc = useQueryClient(); const { me, can } = useAuth(); const canEdit = can('attendance.update');
  const now = dayjs();
  const [f, setF] = useRememberedFilter('attendance', { year: now.year(), month: now.month() + 1, departmentCode: null as string | null, departmentId: null as number | null }, `${me?.tenantId}:${me?.userId}`);
  const query = `year=${f.year}&month=${f.month}${f.departmentId ? `&departmentId=${f.departmentId}` : ''}`;
  const grid = useQuery({ queryKey: ['attendance', query], queryFn: () => api<Grid>(`${A}?${query}`) });
  const data = grid.data;

  const [rows, setRows] = useState<Row[]>([]); const rowsRef = useRef<Row[]>([]);
  const original = useRef(new Map<string, string>());
  const [dirty, setDirty] = useState(false); const [importing, setImporting] = useState(false);
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  const gridApi = useRef<GridApi<Row> | null>(null);
  const confirmIfDirty = useUnsavedChanges(dirty);

  // Dựng hàng từ dữ liệu máy chủ; nhớ chữ gốc từng ô để chỉ gửi các ô đã sửa.
  useEffect(() => {
    if (!data) return;
    const by = new Map<string, AttendanceItem[]>();
    for (const e of data.entries) { const k = `${e.employeeId}|${Number(e.date.slice(8))}`; (by.get(k) ?? by.set(k, []).get(k)!).push({ kind: e.kind, qty: e.qty }); }
    original.current = new Map();
    const next = data.employees.map((emp): Row => {
      const r = { employeeId: emp.id, code: emp.code, name: emp.name, startDate: emp.startDate, endDate: emp.endDate } as Row;
      for (let n = 1; n <= data.days; n++) {
        const t = by.has(`${emp.id}|${n}`) ? formatAttendanceCell(by.get(`${emp.id}|${n}`)!) : '';
        r[dayKey(n)] = t; if (t) original.current.set(`${emp.id}|${n}`, t);
      }
      r.total = totalOf(r, data.days, data.standardHoursPerDay);
      return r;
    });
    rowsRef.current = next; setRows(next); setDirty(false); setSaveWarnings([]);
  }, [data]);

  const onRowsChange = useCallback((next: Row[]) => {
    for (const r of next) r.total = totalOf(r, data?.days ?? 31, data?.standardHoursPerDay ?? null);
    rowsRef.current = next; setRows(next); setDirty(true);
  }, [data?.days, data?.standardHoursPerDay]);

  const columns = useMemo<ColDef<Row>[]>(() => {
    if (!data) return [];
    const bad = (t: string | undefined) => !!t && !parseAttendanceCell(t).ok;
    const day = (n: number): ColDef<Row> => {
      const date = dateOf(data.year, data.month, n); const wd = dayjs(date).day();
      return { colId: dayKey(n), field: dayKey(n), headerName: `${n} ${WEEKDAY[wd]}`, width: 64, headerTooltip: dayjs(date).format('DD/MM/YYYY'),
        valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (!t) return ''; const r = parseAttendanceCell(t); return r.ok ? formatAttendanceCell(r.entries) : t; },
        cellStyle: (p) => {
          if (bad(p.value as string)) return { background: 'rgba(255, 77, 79, 0.25)' };
          const d = p.data; if (d && ((d.startDate && date < d.startDate) || (d.endDate && date > d.endDate))) return { background: 'rgba(250, 173, 20, 0.25)' };
          return wd === 0 || wd === 6 ? { background: 'rgba(128, 128, 128, 0.12)' } : null;
        },
        tooltipValueGetter: (p) => { const t = p.value as string | undefined; if (!t) return null; const r = parseAttendanceCell(t); return r.ok ? r.entries.map((e) => `${ATTENDANCE_KIND_LABEL[e.kind]}: ${e.qty.replace('.', ',')}`).join('; ') : r.error; } };
    };
    return [
      { field: 'code', headerName: 'Mã NV', width: 100, pinned: 'left', editable: false },
      { field: 'name', headerName: 'Họ tên', width: 180, pinned: 'left', editable: false },
      ...Array.from({ length: data.days }, (_, i) => day(i + 1)),
      { field: 'total', headerName: 'Tổng công', width: 100, pinned: 'right', editable: false, cellClass: 'ag-right-aligned-cell' },
    ];
  }, [data]);

  // Các ô đã sửa so với chữ gốc, kèm kiểm tra: ô sai mã, ô vượt 1 ngày, giờ làm việc khi chưa khai giờ chuẩn.
  const collect = (): { cells: { employeeId: number; date: string; entries: AttendanceItem[] }[]; errors: string[] } => {
    const cells: { employeeId: number; date: string; entries: AttendanceItem[] }[] = []; const errors: string[] = [];
    for (const r of rowsRef.current) for (let n = 1; n <= (data?.days ?? 0); n++) {
      const t = r[dayKey(n)] ?? '';
      if (t === (original.current.get(`${r.employeeId}|${n}`) ?? '')) continue;
      const p = parseAttendanceCell(t);
      if (!p.ok) { errors.push(`${r.code} ngày ${n}: ${p.error}`); continue; }
      const c = checkAttendanceDay(p.entries, data?.standardHoursPerDay ?? null);
      if (c) { errors.push(`${r.code} ngày ${n}: ${c.message}`); continue; }
      cells.push({ employeeId: r.employeeId, date: dateOf(data!.year, data!.month, n), entries: p.entries });
    }
    return { cells, errors };
  };
  const save = useMutation({
    mutationFn: async () => {
      const { cells, errors } = collect();
      if (errors.length) throw new Error(`Có ${errors.length} ô chưa hợp lệ (tô đỏ): ${errors.slice(0, 3).join('; ')}`);
      const warnings: string[] = [];
      for (let i = 0; i < cells.length; i += SAVE_BATCH) {
        const r = await api<{ warnings: { message: string }[] }>(`${A}?${query}`, { method: 'PUT', json: { cells: cells.slice(i, i + SAVE_BATCH) } });
        warnings.push(...r.warnings.map((w) => w.message));
      }
      return { n: cells.length, warnings };
    },
    onError: (e) => { void message.error(e instanceof ApiError || e instanceof Error ? e.message : 'Không lưu được'); },
    onSuccess: ({ n, warnings }) => {
      void message.success(n ? `Đã lưu chấm công ${n} ô` : 'Không có thay đổi để lưu'); setSaveWarnings(warnings);
      void qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
  const copy = useMutation({
    mutationFn: () => api<{ copied: number; skipped: number }>(`${A}/copy-previous?${query}`, { method: 'POST' }),
    onError: (e) => { void message.error((e as Error).message); },
    onSuccess: (r) => { void message.success(r.copied ? `Đã sao chép ${r.copied} dòng chấm công từ tháng trước (bỏ qua ${r.skipped})` : 'Không có ô trống nào để sao chép'); void qc.invalidateQueries({ queryKey: ['attendance'] }); },
  });

  // Ctrl+S khi đang sửa ô: chốt ô trước, rồi lưu.
  const saveRef = useRef(() => undefined as void); saveRef.current = () => { if (canEdit && !save.isPending) { gridApi.current?.stopEditing(); setTimeout(() => save.mutate(), 0); } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) return;
      e.preventDefault();
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return;
      saveRef.current();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const warnings = [...(data?.warnings.map((w) => w.message) ?? []), ...saveWarnings.filter((m) => !data?.warnings.some((w) => w.message === m))];
  const hoursMissing = !!data && !data.standardHoursPerDay;
  const change = (patch: Partial<typeof f>) => confirmIfDirty(() => setF({ ...f, ...patch }));

  return (
    <>
      <PageHeader
        title="Bảng chấm công"
        description="Chấm công theo ngày cho nhân viên, quy đổi ngày công và giờ làm thêm"
        extra={
          <>
            {canEdit && <Button type="primary" loading={save.isPending} disabled={!dirty} onClick={() => saveRef.current()}>Lưu (Ctrl+S)</Button>}
            {canEdit && <Button loading={copy.isPending} onClick={() => confirmIfDirty(() => copy.mutate())}>Sao chép từ tháng trước</Button>}
            {canEdit && <Button onClick={() => confirmIfDirty(() => setImporting(true))}>Nhập Excel</Button>}
            <Popover title="Mã chấm công" trigger="click" content={<table><tbody>{LEGEND.map(([k, v]) => <tr key={k}><td style={{ paddingRight: 12 }}><b>{k}</b></td><td>{v}</td></tr>)}</tbody></table>}><Button>Bảng mã</Button></Popover>
          </>
        }
      >
        <Toolbar>
          <DatePicker picker="month" format="MM/YYYY" allowClear={false} value={dayjs(`${f.year}-${String(f.month).padStart(2, '0')}-01`)} aria-label="Tháng chấm công"
            onChange={(v) => { if (v) change({ year: v.year(), month: v.month() + 1 }); }} />
          <LookupSelect catalog="department" value={f.departmentCode} allowClear placeholder="Tất cả bộ phận" style={{ width: 220 }} aria-label="Bộ phận"
            onChange={(code, row) => change({ departmentCode: code, departmentId: row ? Number(row.id) : null })} />
          {data?.employees.length ? <span style={{ color: COLOR.textSecondary, marginLeft: 'auto' }}>{data.employees.length} nhân viên</span> : null}
        </Toolbar>
      </PageHeader>
      {hoursMissing && <Alert style={{ marginBottom: 8 }} type="info" showIcon message="Chưa khai số giờ làm việc chuẩn mỗi ngày (Cài đặt công ty > Tùy chọn hệ thống): chưa chấm công theo giờ được." />}
      {grid.error && <Alert style={{ marginBottom: 8 }} type="error" showIcon message={(grid.error as Error).message} />}
      {warnings.length > 0 && <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={`Cảnh báo chấm công (${warnings.length})`} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.slice(0, 8).map((m) => <li key={m}>{m}</li>)}</ul>} />}
      <div data-testid="attendance-grid">
        <KeyboardGrid<Row> rows={rows} columns={columns} readOnly={!canEdit} lockRows animateRows={false} onRowsChange={onRowsChange} addRowTemplate={() => ({} as Row)} height="calc(100vh - 220px)" onGridApi={(a) => { gridApi.current = a; }} />
      </div>
      <ImportDialog open={importing} year={f.year} month={f.month} departmentId={f.departmentId} onClose={() => setImporting(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['attendance'] })} />
    </>);
}
