import { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, InputNumber, Select, Space, Tabs, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { RUN_KIND } from './payrollCommon.js';
import { NO_SALARY, PayrollErrorAlert } from './payrollUi.js';

// Báo cáo lương: bảng thanh toán, bảo hiểm, chi phí, thuế TNCN, so sánh hai kỳ, phiếu lương cá nhân, tệp BHXH và Sổ chi tiết 334 theo nhân viên.
// Số liệu do API tính (mô tả cột kèm theo) và kèm bảng đối chiếu với chứng từ LU của các bảng đã hạch toán.
const P = '/api/payroll/reports';
type Row = Record<string, unknown>;
type TabKey = 'payment' | 'insurance' | 'cost' | 'pit' | 'compare' | 'slips' | 'bhxh' | 'ledger';
interface Col { key: string; label: string; type?: 'text' | 'number' | 'date'; width?: string }
interface Recon { postedRuns: number; unpostedRuns: number; ok: boolean; items: { label: string; report: string; ledger: string; diff: string }[] }
interface Report { title: string; subtitle: string; columns: Col[]; rows: Row[]; footer?: Row; intro: string[]; reconciliation: Recon }
interface RunRow { id: number; name: string; kind: string; status: string }
interface Slip { employeeId: number; code: string; name: string; gross: string; totalDeductions: string; net: string }
interface Detail { opening: { debit: string; credit: string }; closing: { debit: string; credit: string }; totalDebit: string; totalCredit: string; rows: Row[] }

const fmt = (v: unknown) => (typeof v === 'string' && !/^-?0+(\.0+)?$/.test(v) ? formatVnNumber(v, 0) : '');
const toColDef = (c: Col): ColDef<Row> => c.type === 'number' ? { field: c.key, headerName: c.label, width: 140, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header', valueFormatter: (p) => fmt(p.value) }
  : c.type === 'date' ? { field: c.key, headerName: c.label, width: 120, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') }
    : c.key === 'stt' ? { field: c.key, headerName: c.label, width: 70 } : c.key === 'name' ? { field: c.key, headerName: c.label, flex: 1, minWidth: 200 } : { field: c.key, headerName: c.label, width: 130 };

const TABS: { key: TabKey; label: string }[] = [{ key: 'payment', label: 'Bảng thanh toán lương' }, { key: 'insurance', label: 'Tổng hợp bảo hiểm' }, { key: 'cost', label: 'Chi phí lương' }, { key: 'pit', label: 'Thuế TNCN khấu trừ' },
  { key: 'compare', label: 'So sánh hai kỳ' }, { key: 'slips', label: 'Phiếu lương' }, { key: 'bhxh', label: 'Tệp BHXH' }, { key: 'ledger', label: 'Sổ chi tiết 334' }];

function ReconAlert({ r }: { r: Recon }) {
  if (!r.items.length) return <Alert type="info" showIcon data-testid="recon" message={r.unpostedRuns ? 'Chưa có bảng lương đã hạch toán trong kỳ nên chưa đối chiếu được với sổ cái.' : 'Không có bảng lương trong kỳ.'} />;
  return (
    <Alert type={r.ok ? 'success' : 'error'} showIcon data-testid="recon" message={r.ok ? `Khớp sổ cái (chứng từ hạch toán lương): ${r.postedRuns} bảng đã hạch toán` : 'Số liệu lệch sổ cái: kiểm tra chứng từ hạch toán lương'}
      description={<ul style={{ margin: 0, paddingLeft: 18 }}>{r.items.map((i) => <li key={i.label}>{i.label}: báo cáo {formatVnNumber(i.report, 0)}, sổ cái {formatVnNumber(i.ledger, 0)}{i.diff !== '0' && <Tag color="red" style={{ marginLeft: 6 }}>lệch {formatVnNumber(i.diff, 0)}</Tag>}</li>)}</ul>} />);
}

export default function PayrollReportsPage() {
  const { me, can } = useAuth();
  const now = dayjs();
  const [tab, setTab] = useState<TabKey>('payment');
  const [f, setF] = useRememberedFilter('payroll-reports', { year: now.year(), month: now.month() + 1, kind: 'month', quarter: Math.ceil((now.month() + 1) / 3), groupBy: 'department', year2: now.subtract(1, 'month').year(), month2: now.subtract(1, 'month').month() + 1,
    runId: 0, employeeId: 0, employeeCode: '', accountCode: '334', from: now.startOf('year').format('YYYY-MM-DD'), to: now.endOf('month').format('YYYY-MM-DD') }, `${me?.tenantId}:${me?.userId}`);
  // Kỳ báo cáo hợp lệ theo từng báo cáo: bảo hiểm, chi phí chọn tháng hoặc quý; thuế TNCN chọn tháng hoặc cả năm.
  const kind = tab === 'pit' ? (f.kind === 'year' ? 'year' : 'month') : f.kind === 'quarter' ? 'quarter' : 'month';
  const periodQ = kind === 'quarter' ? `quarter=${f.quarter}` : `month=${f.month}`;
  const url = useMemo(() => {
    const p = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
    switch (tab) {
      case 'payment': return `${P}/payment-sheet?${p({ year: f.year, month: f.month, ...(f.runId ? { runId: f.runId } : {}) })}`;
      case 'insurance': return `${P}/insurance?year=${f.year}&${periodQ}`;
      case 'cost': return `${P}/cost?year=${f.year}&${periodQ}&groupBy=${f.groupBy}`;
      case 'pit': return `${P}/pit?${p({ year: f.year, ...(kind === 'month' ? { month: f.month } : {}) })}`;
      case 'compare': return `${P}/compare?${p({ year: f.year, month: f.month, year2: f.year2, month2: f.month2 })}`;
      case 'bhxh': return `${P}/bhxh-list?${p({ year: f.year, month: f.month })}`;
      case 'ledger': return f.employeeCode ? `/api/reports/ledgers/detail?${p({ accountCode: f.accountCode, from: f.from, to: f.to, employeeCode: f.employeeCode })}` : null;
      case 'slips': return f.runId ? `${P}/slips?runId=${f.runId}${f.employeeId ? `&employeeId=${f.employeeId}` : ''}` : null;
    }
  }, [tab, f, periodQ, kind]);
  const runs = useQuery({ queryKey: ['payroll-runs', f.year, f.month], queryFn: () => api<RunRow[]>(`/api/payroll/runs?year=${f.year}&month=${f.month}`), enabled: tab === 'payment' || tab === 'slips' });
  const data = useQuery({ queryKey: ['payroll-report', url], queryFn: () => api<Report & { slips?: Slip[] } & Detail>(url!), enabled: !!url, retry: false });

  const tabular = tab !== 'slips' && tab !== 'ledger';
  const columns = useMemo<ColDef<Row>[]>(() => {
    if (tab === 'ledger') return [{ field: 'postingDate', headerName: 'Ngày', width: 110, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') }, { field: 'voucherNo', headerName: 'Số hiệu', width: 130 }, { field: 'description', headerName: 'Diễn giải', flex: 1, minWidth: 220 },
      { field: 'counterAccountCode', headerName: 'TK đối ứng', width: 110 }, ...(['debit', 'credit'] as const).map((k): ColDef<Row> => ({ field: k, headerName: k === 'debit' ? 'Nợ' : 'Có', width: 140, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => fmt(p.value) }))];
    if (tab === 'slips') return [{ field: 'code', headerName: 'Mã NV', width: 100 }, { field: 'name', headerName: 'Họ và tên', flex: 1, minWidth: 200 },
      ...(['gross', 'totalDeductions', 'net'] as const).map((k): ColDef<Row> => ({ field: k, headerName: { gross: 'Tổng thu nhập', totalDeductions: 'Tổng khấu trừ', net: 'Thực lĩnh' }[k], width: 150, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => fmt(p.value) }))];
    return (data.data?.columns ?? []).map(toColDef);
  }, [tab, data.data]);
  const rows = useMemo<Row[]>(() => {
    const d = data.data; if (!d) return [];
    if (tab === 'slips') return (d.slips ?? []) as unknown as Row[];
    if (tab === 'ledger') return [{ description: 'Số dư đầu kỳ', debit: d.opening.debit, credit: d.opening.credit }, ...d.rows, { description: 'Cộng số phát sinh', debit: d.totalDebit, credit: d.totalCredit }, { description: 'Số dư cuối kỳ', debit: d.closing.debit, credit: d.closing.credit }];
    return [...d.rows, ...(d.footer ? [{ name: 'Cộng', ...d.footer }] : [])];
  }, [data.data, tab]);

  const open = (format: 'html' | 'xlsx' | 'csv') => { if (url) window.open(`${url}${url.includes('?') ? '&' : '?'}format=${format}`, '_blank'); };
  const exportOk = can('payroll.export');
  const yearInput = (key: 'year' | 'year2', label: string) => <InputNumber aria-label={label} addonBefore={label} min={2000} max={2100} value={f[key]} onChange={(v) => setF({ ...f, [key]: v ?? f[key] })} style={{ width: 130 }} />;
  const periodSel = (
    <Space.Compact>
      <Select aria-label="Kỳ báo cáo" value={kind} style={{ width: 90 }} onChange={(k) => setF({ ...f, kind: k })} options={[{ value: 'month', label: 'Tháng' }, tab === 'pit' ? { value: 'year', label: 'Cả năm' } : { value: 'quarter', label: 'Quý' }]} />
      {kind === 'quarter' ? <Select aria-label="Quý" value={f.quarter} style={{ width: 80 }} onChange={(quarter) => setF({ ...f, quarter })} options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Quý ${q}` }))} />
        : kind === 'month' ? <Select aria-label="Tháng" value={f.month} style={{ width: 90 }} onChange={(month) => setF({ ...f, month })} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }))} /> : null}
    </Space.Compact>);

  if (!me?.sensitive.includes('view_salary')) return NO_SALARY;
  const d = data.data;
  const body = () => {
    if (!url) return <Alert type="info" showIcon message={tab === 'ledger' ? 'Chọn nhân viên để xem Sổ chi tiết tài khoản phải trả người lao động' : 'Chọn bảng lương để in phiếu lương'} />;
    if (data.error) return <PayrollErrorAlert error={data.error} />;
    if (!d) return <Alert type="info" message="Đang tải…" />;
    return (<>
      {tabular && <>{d.intro.map((t) => <Alert key={t} type="warning" showIcon style={{ marginBottom: 8 }} message={t} />)}<div style={{ marginBottom: 8 }}><ReconAlert r={d.reconciliation} /></div></>}
      {tab === 'slips' && d.intro.map((t) => <Alert key={t} type="warning" showIcon style={{ marginBottom: 8 }} message={t} />)}
      <KeyboardGrid<Row> rows={rows} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly lockRows animateRows={false} height="calc(100vh - 380px)" />
      {tab === 'bhxh' && <Alert style={{ marginTop: 8 }} type="info" showIcon message="Tệp theo cột chung (mã số BHXH, họ tên, CCCD, lương đóng, phụ cấp, thời gian). Chưa phải mẫu D02-LT, TK1-TS của cơ quan bảo hiểm xã hội: đối chiếu mẫu hiện hành trước khi nộp." />}
    </>);
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Báo cáo lương</h2>
        {tab === 'ledger' ? <>
          <Select aria-label="Tài khoản" value={f.accountCode} style={{ width: 90 }} onChange={(accountCode) => setF({ ...f, accountCode })} options={[{ value: '334', label: '334' }, { value: '3341', label: '3341' }]} />
          <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />
          <LookupSelect catalog="employee" value={f.employeeCode || null} style={{ width: 280 }} placeholder="Nhân viên (F4)" aria-label="Nhân viên" onChange={(code) => setF({ ...f, employeeCode: code ?? '' })} />
        </> : <>
          {yearInput('year', 'Năm')}
          {(tab === 'insurance' || tab === 'cost' || tab === 'pit') ? periodSel : <Select aria-label="Tháng" value={f.month} style={{ width: 100 }} onChange={(month) => setF({ ...f, month, runId: 0 })} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }))} />}
          {tab === 'compare' && <>{yearInput('year2', 'So với năm')}<Select aria-label="Tháng so sánh" value={f.month2} style={{ width: 100 }} onChange={(month2) => setF({ ...f, month2 })} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }))} /></>}
          {tab === 'cost' && <Select aria-label="Nhóm theo" value={f.groupBy} style={{ width: 150 }} onChange={(groupBy) => setF({ ...f, groupBy })} options={[{ value: 'department', label: 'Theo bộ phận' }, { value: 'project', label: 'Theo vụ việc' }]} />}
          {(tab === 'payment' || tab === 'slips') && <Select aria-label="Bảng lương" allowClear placeholder={tab === 'payment' ? 'Mọi bảng lương trong tháng' : 'Chọn bảng lương'} style={{ width: 300 }} value={f.runId || undefined} onChange={(runId) => setF({ ...f, runId: runId ?? 0 })}
            options={(runs.data ?? []).filter((r) => r.status === 'calculated' || r.status === 'posted').map((r) => ({ value: r.id, label: `${r.name} (${RUN_KIND[r.kind] ?? r.kind})` }))} />}
          {tab === 'slips' && <LookupSelect catalog="employee" valueField="id" value={f.employeeId ? String(f.employeeId) : null} style={{ width: 260 }} placeholder="Một nhân viên (bỏ trống: cả bảng)" aria-label="Nhân viên" allowClear
            onChange={(_, row) => setF({ ...f, employeeId: row ? Number(row.id) : 0 })} />}
        </>}
        <Button disabled={!url || tab === 'ledger'} onClick={() => open('html')}>{tab === 'slips' ? 'In phiếu lương' : 'In'}</Button>
        {exportOk && tab !== 'slips' && tab !== 'ledger' && <Button disabled={!url} onClick={() => open('xlsx')}>Xuất Excel</Button>}
        {exportOk && tab === 'bhxh' && <Button disabled={!url} onClick={() => open('csv')}>Xuất CSV</Button>}
      </Space>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={TABS.filter((t) => t.key !== 'ledger' || can('report.view')).map((t) => ({ key: t.key, label: t.label }))} />
      {body()}
    </Space>
  );
}
