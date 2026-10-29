import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Upload, message } from 'antd';
import type { ColDef } from 'ag-grid-community';
import { D, formatVnDate, formatVnNumber, parseVnNumber } from '@kt/domain';
import { COLOR, KeyboardGrid, PageHeader, Toolbar, useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NoFiscalYearNotice } from './NoFiscalYearNotice.js';

const MONTHS = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12'] as const;
type MKey = (typeof MONTHS)[number];
type GridRow = { accountPrefix?: string; costItemCode?: string; departmentCode?: string; projectCode?: string; note?: string } & Partial<Record<MKey, string>>;
interface Head { id: number; fiscalYear: number; version: number; name: string; status: string; lineCount: number; total: string }
interface LineDto { id: number; lineNo: number; accountPrefix: string; costItemCode: string | null; departmentCode: string | null; projectCode: string | null; months: string[]; note: string | null }
interface Detail { id: number; fiscalYear: number; version: number; name: string; status: string; note: string | null; lines: LineDto[] }
interface Cell { budget: string; actual: string; diff: string; pct: string | null }
interface RepLine { lineId: number; lineNo: number; accountPrefix: string; costItemCode: string | null; departmentCode: string | null; projectCode: string | null; kind: 'expense' | 'revenue'; month: Cell; ytd: Cell; year: Cell }
interface Report { budget: { id: number; name: string; status: string }; month: number; lines: RepLine[]; totals: { expense: { month: Cell; ytd: Cell; year: Cell }; revenue: { month: Cell; ytd: Cell; year: Cell } } }
interface Entry { voucherId: string; voucherNo: string | null; voucherType: string; postingDate: string; description: string | null; accountCode: string; amount: string }
interface Setting { enabled: boolean; warnPct: number; blockPct: number | null }

const STATUS: Record<string, { text: string; color: string }> = { draft: { text: 'Nháp', color: 'default' }, approved: { text: 'Đã duyệt', color: 'green' }, superseded: { text: 'Đã thay thế', color: 'orange' } };
const money = (v: string) => formatVnNumber(v);
const signed = (v: string) => { const x = D(v); return x.isNegative() ? `(${formatVnNumber(x.neg())})` : formatVnNumber(x); };

const numCol = (colId: MKey, n: number): ColDef<GridRow> => ({ colId, field: colId, headerName: `T${n}`, width: 104, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
  valueFormatter: (p) => (p.value ? formatVnNumber(String(p.value)) : ''),
  valueParser: (p) => { const s = parseVnNumber(String(p.newValue ?? '')); if (s === null || !/^\d{1,16}$/.test(s)) return p.oldValue; return s; } });
const toGrid = (l: LineDto): GridRow => ({ accountPrefix: l.accountPrefix, costItemCode: l.costItemCode ?? '', departmentCode: l.departmentCode ?? '', projectCode: l.projectCode ?? '', note: l.note ?? '', ...Object.fromEntries(MONTHS.map((m, i) => [m, l.months[i]])) });
const fromGrid = (r: GridRow) => ({ accountPrefix: (r.accountPrefix ?? '').trim(), costItemCode: r.costItemCode?.trim() || null, departmentCode: r.departmentCode?.trim() || null, projectCode: r.projectCode?.trim() || null,
  months: MONTHS.map((m) => r[m] || '0'), note: r.note?.trim() || null });

function Editor({ id, onClose }: { id: number | 'new'; onClose: () => void }) {
  const { can } = useAuth(); const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number }[]>('/api/fiscal-years') });
  const [rows, setRows] = useState<GridRow[]>([{}]); const [name, setName] = useState('Ngân sách'); const [year, setYear] = useState<number>(); const [cur, setCur] = useState<number | 'new'>(id);
  const detail = useQuery({ queryKey: ['budget', cur], enabled: cur !== 'new', queryFn: () => api<Detail>(`/api/budgets/${cur as number}`) });
  useEffect(() => { if (detail.data) { setName(detail.data.name); setYear(detail.data.fiscalYear); setRows(detail.data.lines.length ? detail.data.lines.map(toGrid) : [{}]); } }, [detail.data]);
  useEffect(() => { if (year === undefined && years.data?.length) setYear(years.data[0]!.fiscalYear); }, [years.data, year]);
  const needYear = cur === 'new' && year === undefined; // công ty chưa có năm tài chính: chưa lập được ngân sách mới
  const status = cur === 'new' ? 'draft' : detail.data?.status ?? 'draft'; const editable = status === 'draft' && can(cur === 'new' ? 'budget.create' : 'budget.update');
  const columns = useMemo<ColDef<GridRow>[]>(() => [
    { colId: 'accountPrefix', field: 'accountPrefix', headerName: 'Tài khoản / nhóm', width: 130 }, { colId: 'costItemCode', field: 'costItemCode', headerName: 'Khoản mục phí', width: 120 },
    { colId: 'departmentCode', field: 'departmentCode', headerName: 'Bộ phận', width: 100 }, { colId: 'projectCode', field: 'projectCode', headerName: 'Dự án', width: 100 },
    ...MONTHS.map((m, i) => numCol(m, i + 1)),
    { colId: 'total', headerName: 'Cả năm', width: 130, editable: false, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header', valueGetter: (p) => MONTHS.reduce((a, m) => a.plus(p.data?.[m] || '0'), D(0)).toString(), valueFormatter: (p) => formatVnNumber(String(p.value ?? '0')) },
  ], []);
  const save = useMutation({
    mutationFn: async () => {
      const lines = rows.filter((r) => r.accountPrefix?.trim()).map(fromGrid);
      return cur === 'new' ? api<Detail>('/api/budgets', { method: 'POST', json: { fiscalYear: year, name, lines } }) : api<Detail>(`/api/budgets/${cur}`, { method: 'PUT', json: { name, lines } });
    },
    onSuccess: (d) => { setCur(d.id); void qc.invalidateQueries({ queryKey: ['budgets'] }); void qc.invalidateQueries({ queryKey: ['budget', d.id] }); void message.success('Đã lưu ngân sách'); },
    onError: (e) => void message.error((e as Error).message) });
  const approve = useMutation({ mutationFn: () => api(`/api/budgets/${cur}/approve`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['budgets'] }); void qc.invalidateQueries({ queryKey: ['budget', cur] }); void message.success('Đã duyệt ngân sách'); }, onError: (e) => void message.error((e as Error).message) });
  const newVersion = useMutation({ mutationFn: () => api<Detail>(`/api/budgets/${cur}/new-version`, { method: 'POST' }), onSuccess: (d) => { setCur(d.id); void qc.invalidateQueries({ queryKey: ['budgets'] }); void message.success(`Đã tạo phiên bản ${d.version}`); }, onError: (e) => void message.error((e as Error).message) });
  const importXlsx = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch(`/api/budgets/${cur}/import-lines?mode=commit`, { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json() as { lines?: number; error?: { message: string; details?: { row: number; column: string; message: string }[] } };
    if (!r.ok) void message.error(`${j.error?.message ?? 'Lỗi nhập'}${j.error?.details?.length ? `: dòng ${j.error.details[0]!.row}, ${j.error.details[0]!.message}` : ''}`);
    else { void message.success(`Đã nhập ${j.lines} dòng`); void qc.invalidateQueries({ queryKey: ['budget', cur] }); void detail.refetch(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!editable || needYear) return; (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => save.mutate(), 50); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [editable, needYear, save]);
  return (
    <Modal open title={cur === 'new' ? 'Thêm ngân sách' : `Ngân sách ${year} - phiên bản ${detail.data?.version ?? ''}`} onCancel={onClose} width={1280} destroyOnHidden
      footer={<Space>
        {cur !== 'new' && status === 'draft' && can('budget.approve') && <Button onClick={() => approve.mutate()}>Duyệt</Button>}
        {cur !== 'new' && status !== 'draft' && can('budget.create') && <Button onClick={() => newVersion.mutate()}>Tạo phiên bản mới</Button>}
        <Button onClick={onClose}>Đóng</Button>{editable && <Button type="primary" loading={save.isPending} disabled={needYear} onClick={() => save.mutate()}>Lưu (Ctrl+S)</Button>}</Space>}>
      {needYear && !years.isLoading && !years.data?.length && <NoFiscalYearNotice bare purpose="lập ngân sách" />}
      <Space style={{ marginBottom: 8 }} wrap>
        <Input aria-label="Tên ngân sách" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 280 }} disabled={!editable} />
        <Select aria-label="Năm tài chính" placeholder="Chưa có năm tài chính" value={year} onChange={setYear} disabled={cur !== 'new'} style={{ width: 120 }} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }))} />
        <Tag color={STATUS[status]?.color ?? 'default'}>{STATUS[status]?.text ?? status}</Tag>
        {cur !== 'new' && editable && <Upload accept=".xlsx" showUploadList={false} beforeUpload={(f) => { void importXlsx(f); return false; }}><Button size="small">Nhập Excel</Button></Upload>}
        {cur !== 'new' && <a href={`/api/budgets/${cur}/export.xlsx`}>Xuất Excel</a>}<a href="/api/budgets/template.xlsx">Tải mẫu Excel</a>
      </Space>
      {!editable && cur !== 'new' && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Ngân sách đã duyệt không sửa được; hãy tạo phiên bản mới." />}
      <KeyboardGrid<GridRow> rows={rows} columns={columns} onRowsChange={setRows} addRowTemplate={() => ({})} height={380} readOnly={!editable} />
    </Modal>
  );
}

const cellCols = (key: 'month' | 'ytd' | 'year', title: string) => ({ title, children: [
  { title: 'Ngân sách', width: 110, align: 'right' as const, render: (_: unknown, r: RepLine) => money(r[key].budget) },
  { title: 'Thực tế', width: 110, align: 'right' as const, render: (_: unknown, r: RepLine) => money(r[key].actual) },
  { title: 'Chênh lệch', width: 110, align: 'right' as const, render: (_: unknown, r: RepLine) => signed(r[key].diff) },
  { title: '%', width: 70, align: 'right' as const, render: (_: unknown, r: RepLine) => (r[key].pct === null ? '' : `${r[key].pct}%`) }] });

function ReportTab({ budgets }: { budgets: Head[] }) {
  const [id, setId] = useState<number>(); const [month, setMonth] = useState(12); const [drill, setDrill] = useState<RepLine | null>(null);
  useEffect(() => { if (id === undefined && budgets.length) setId((budgets.find((b) => b.status === 'approved') ?? budgets[0])!.id); }, [budgets, id]);
  const rep = useQuery({ queryKey: ['budget-report', id, month], enabled: id !== undefined, retry: false, queryFn: () => api<Report>(`/api/budgets/${id}/report?month=${month}`) });
  const entries = useQuery({ queryKey: ['budget-entries', id, drill?.lineId, month], enabled: !!drill, queryFn: () => api<{ rows: Entry[]; truncated: boolean }>(`/api/budgets/${id}/lines/${drill!.lineId}/entries?month=${month}`) });
  const dim = (r: RepLine) => [r.costItemCode, r.departmentCode, r.projectCode].filter(Boolean).join(' / ');
  return (<>
    <Toolbar style={{ marginBottom: 12 }}>
      <Select aria-label="Ngân sách" value={id} onChange={setId} style={{ width: 320 }} options={budgets.map((b) => ({ value: b.id, label: `${b.fiscalYear} - ${b.name} (v${b.version}, ${STATUS[b.status]?.text})` }))} />
      <Select aria-label="Đến tháng" value={month} onChange={setMonth} style={{ width: 130 }} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Đến tháng ${i + 1}` }))} />
    </Toolbar>
    {rep.error && <Alert type="error" showIcon message={(rep.error as Error).message} />}
    <Table<RepLine> size="small" rowKey="lineId" loading={rep.isFetching} pagination={false} dataSource={rep.data?.lines ?? []} scroll={{ x: 1300 }}
      onRow={(r) => ({ onDoubleClick: () => setDrill(r) })}
      columns={[{ title: 'Tài khoản', dataIndex: 'accountPrefix', width: 90, fixed: 'left' }, { title: 'Chiều phân tích', width: 150, render: (_: unknown, r) => dim(r) },
        { title: 'Loại', dataIndex: 'kind', width: 90, render: (k: string) => (k === 'expense' ? 'Chi phí' : 'Doanh thu') },
        cellCols('month', `Tháng ${month}`), cellCols('ytd', 'Lũy kế'), cellCols('year', 'Cả năm'),
        { title: '', width: 90, fixed: 'right', render: (_: unknown, r) => <Button type="link" size="small" onClick={() => setDrill(r)}>Truy ngược</Button> }]} />
    {rep.data && <p style={{ marginTop: 8, color: COLOR.textSecondary }}>Chênh lệch = Thực tế - Ngân sách. Thực tế lấy từ sổ cái (bỏ bút toán kết chuyển). Nhấp đúp một dòng để xem chứng từ.</p>}
    <Drawer open={!!drill} onClose={() => setDrill(null)} width={760} title={drill ? `Chứng từ tạo nên số thực tế - ${drill.accountPrefix} tháng ${month}` : ''}>
      <Table<Entry> size="small" rowKey={(r) => `${r.voucherId}|${r.accountCode}|${r.amount}`} loading={entries.isFetching} pagination={{ pageSize: 50, hideOnSinglePage: true }} dataSource={entries.data?.rows ?? []} columns={[
        { title: 'Ngày', dataIndex: 'postingDate', width: 100, render: formatVnDate }, { title: 'Chứng từ', width: 120, render: (_: unknown, r) => r.voucherNo ?? r.voucherType }, { title: 'TK', dataIndex: 'accountCode', width: 80 },
        { title: 'Diễn giải', dataIndex: 'description' }, { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 120, render: signed }]} />
    </Drawer>
  </>);
}

function AlertTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm<{ enabled: boolean; warnPct: number; blockPct: number | null; hard: boolean }>();
  const q = useQuery({ queryKey: ['budget-setting'], queryFn: () => api<Setting>('/api/budget-settings') });
  useEffect(() => { if (q.data) form.setFieldsValue({ ...q.data, hard: q.data.blockPct !== null, blockPct: q.data.blockPct ?? 100 }); }, [q.data, form]);
  const save = useMutation({ mutationFn: (v: { enabled: boolean; warnPct: number; blockPct: number | null; hard: boolean }) => api('/api/budget-settings', { method: 'PUT', json: { enabled: v.enabled, warnPct: v.warnPct, blockPct: v.hard ? v.blockPct : null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['budget-setting'] }); void message.success('Đã lưu cấu hình cảnh báo'); }, onError: (e) => void message.error((e as Error).message) });
  const hard = Form.useWatch('hard', form);
  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 480 }} onFinish={(v) => save.mutate(v)} disabled={!can('budget.approve')}>
      <Form.Item name="enabled" label="Bật cảnh báo vượt ngân sách khi ghi sổ" valuePropName="checked"><Switch aria-label="Bật cảnh báo vượt ngân sách" /></Form.Item>
      <Form.Item name="warnPct" label="Cảnh báo khi thực hiện lũy kế từ (%) ngân sách lũy kế" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><InputNumber min={1} max={1000} precision={0} style={{ width: 160 }} aria-label="Mức cảnh báo" /></Form.Item>
      <Form.Item name="hard" label="Chặn ghi sổ khi vượt mức" valuePropName="checked"><Switch aria-label="Chặn ghi sổ" /></Form.Item>
      <Form.Item name="blockPct" label="Chặn từ (%)"><InputNumber min={1} max={1000} precision={0} disabled={!hard} style={{ width: 160 }} aria-label="Mức chặn" /></Form.Item>
      {can('budget.approve') && <Button type="primary" htmlType="submit" loading={save.isPending}>Lưu cấu hình</Button>}
      <Alert style={{ marginTop: 16 }} type="info" showIcon message="So sánh thực tế lũy kế đến tháng của chứng từ với ngân sách lũy kế đến tháng đó, cho các dòng ngân sách chi phí (Nợ) của ngân sách đã duyệt. Chứng từ tự động của hệ thống (giá vốn, khấu hao, kết chuyển) không bị kiểm tra." />
    </Form>
  );
}

export default function BudgetPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const list = useQuery({ queryKey: ['budgets'], queryFn: () => api<Head[]>('/api/budgets') });
  const [edit, setEdit] = useState<number | 'new' | null>(null); const [copyOpen, setCopyOpen] = useState(false); const [form] = Form.useForm();
  const del = useMutation({ mutationFn: (id: number) => api(`/api/budgets/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['budgets'] }); void message.success('Đã xóa ngân sách'); }, onError: (e) => void message.error((e as Error).message) });
  const copy = useMutation({ mutationFn: (v: { fiscalYear: number; sourceYear: number; name: string; factor: string }) => api<{ budget: Detail; skipped: string[] }>('/api/budgets/copy-actual', { method: 'POST', json: v }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['budgets'] }); setCopyOpen(false); setEdit(r.budget.id); void message.success(r.skipped.length ? `Đã sao chép, bỏ qua tài khoản bị che: ${r.skipped.join(', ')}` : 'Đã sao chép từ thực tế'); }, onError: (e) => void message.error((e as Error).message) });
  useHotkeys({ Insert: () => { if (can('budget.create') && edit === null) setEdit('new'); } });
  const data = list.data ?? [];
  return (<>
    <PageHeader title="Ngân sách" />
    <Tabs items={[
      { key: 'list', label: 'Danh sách ngân sách', children: (<>
        <Space style={{ marginBottom: 12 }}>
          {can('budget.create') && <Button type="primary" onClick={() => setEdit('new')}>Thêm (Insert)</Button>}
          {can('budget.create') && <Button onClick={() => { form.setFieldsValue({ factor: '1', name: 'Ngân sách từ thực tế' }); setCopyOpen(true); }}>Sao chép từ thực tế năm trước</Button>}
        </Space>
        <Table<Head> size="small" rowKey="id" dataSource={data} pagination={false} columns={[
          { title: 'Năm', dataIndex: 'fiscalYear', width: 80 }, { title: 'Phiên bản', dataIndex: 'version', width: 90 }, { title: 'Tên ngân sách', dataIndex: 'name' },
          { title: 'Trạng thái', dataIndex: 'status', width: 120, render: (s: string) => <Tag color={STATUS[s]?.color ?? 'default'}>{STATUS[s]?.text ?? s}</Tag> },
          { title: 'Số dòng', dataIndex: 'lineCount', align: 'right', width: 90 }, { title: 'Tổng cả năm', dataIndex: 'total', align: 'right', width: 150, render: money },
          { title: '', width: 150, render: (_v, r) => (<Space size={0}><Button type="link" size="small" onClick={() => setEdit(r.id)}>{r.status === 'draft' ? 'Sửa' : 'Xem'}</Button>
            {can('budget.delete') && r.status === 'draft' && <Button type="link" size="small" danger onClick={() => Modal.confirm({ title: `Xóa ngân sách ${r.name}?`, okText: 'Xóa', cancelText: 'Hủy', onOk: () => del.mutateAsync(r.id) })}>Xóa</Button>}</Space>) }]} />
      </>) },
      { key: 'report', label: 'Thực hiện so với ngân sách', children: <ReportTab budgets={data} /> },
      { key: 'alert', label: 'Cảnh báo vượt ngân sách', children: <AlertTab /> },
    ]} />
    {edit !== null && <Editor key={String(edit)} id={edit} onClose={() => setEdit(null)} />}
    <Modal title="Sao chép từ thực tế năm trước" open={copyOpen} onCancel={() => setCopyOpen(false)} onOk={() => form.submit()} okText="Tạo ngân sách nháp" cancelText="Hủy" destroyOnHidden forceRender>
      <Form form={form} layout="vertical" onFinish={(v) => copy.mutate(v)}>
        <Form.Item name="name" label="Tên ngân sách mới" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><Input /></Form.Item>
        <Form.Item name="sourceYear" label="Năm thực tế làm gốc" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><InputNumber min={2000} max={2100} precision={0} style={{ width: '100%' }} aria-label="Năm thực tế" /></Form.Item>
        <Form.Item name="fiscalYear" label="Năm lập ngân sách" rules={[{ required: true, message: 'Bắt buộc nhập' }]}><InputNumber min={2000} max={2100} precision={0} style={{ width: '100%' }} aria-label="Năm lập ngân sách" /></Form.Item>
        <Form.Item name="factor" label="Hệ số (ví dụ 1.1 = tăng 10%)" rules={[{ required: true, pattern: /^\d{1,3}(\.\d{1,4})?$/, message: 'Hệ số không hợp lệ' }]}><Input /></Form.Item>
      </Form>
    </Modal>
  </>);
}
