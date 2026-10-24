import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Segmented, Space, Tabs } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import type { Track } from './Contracts.js';

// Báo cáo hợp đồng, vụ việc (GĐ6 Task 13b): theo dõi thực hiện / quá hạn thu, trả (công nợ cần cờ công nợ ở API), lãi lỗ theo hợp đồng và theo vụ việc (cờ view_cost).
type TrackRow = Track & { id: number; code: string; name: string; kind: 'sale' | 'purchase'; partyName: string | null; currencyCode: string };
interface TrackReport { rows: TrackRow[]; totals: Record<string, string | number> }
interface Pnl { revenue: string; deduction: string; netRevenue: string; cogs: string; grossProfit: string; selling: string; admin: string; profit: string; production: string }
type PnlRow = Pnl & { code: string; name: string; level?: number; value?: string | null; valuePct?: string | null; budget?: string | null; budgetPct?: string | null };
interface PnlReport { rows: PnlRow[]; unassigned: Pnl; totals: Pnl }
type TabKey = 'track' | 'contract' | 'project';

const money = (v: unknown, dp = 0) => (typeof v === 'string' && !D(v).isZero() ? formatVnNumber(v, dp) : '');
const num = <T,>(headerName: string, field: string, dp = 0, width = 130): ColDef<T> => ({ field, headerName, width, editable: false, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => money(p.value, dp) }) as ColDef<T>;
const txt = <T,>(headerName: string, field: string, width?: number): ColDef<T> => ({ field, headerName, editable: false, ...(width ? { width } : { flex: 1, minWidth: 200 }) }) as ColDef<T>;
const KIND: Record<string, string> = { sale: 'Bán', purchase: 'Mua' };

const trackCols: ColDef<TrackRow>[] = [
  txt('Số hợp đồng', 'code', 120), txt('Tên hợp đồng', 'name'), { field: 'kind', headerName: 'Loại', width: 70, editable: false, valueFormatter: (p) => KIND[p.value as string] ?? '' }, txt('Đối tác', 'partyName', 180),
  txt('Tiền', 'currencyCode', 65), num('Giá trị (gồm phụ lục)', 'adjustedValue', 0, 150), num('Đã xuất/nhận hóa đơn', 'invoiced', 0, 150), num('% thực hiện', 'performedPct', 2, 105),
  { ...num<TrackRow>('Còn phải thu/trả', 'outstanding', 0, 140), valueFormatter: (p) => (p.data?.debtHidden ? 'Ẩn' : money(p.value)) }, num('Đã thu/trả', 'settled'), num('Quá hạn', 'overdueDebt'),
  { field: 'overdueMilestoneCount', headerName: 'Đợt quá hạn', width: 105, editable: false, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => (p.value ? String(p.value) : '') },
  { field: 'nextDueDate', headerName: 'Đợt kế tiếp', width: 115, editable: false, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') },
];
const pnlCols = (project: boolean): ColDef<PnlRow>[] => [
  txt(project ? 'Mã vụ việc' : 'Số hợp đồng', 'code', 130),
  { field: 'name', headerName: 'Tên', flex: 1, minWidth: 220, editable: false, valueFormatter: (p) => `${'   '.repeat(Math.max(0, (p.data?.level ?? 1) - 1))}${p.value as string}` },
  num('Doanh thu', 'revenue'), num('Giảm trừ', 'deduction', 0, 110), num('Doanh thu thuần', 'netRevenue'), num('Giá vốn', 'cogs'), num('Lãi gộp', 'grossProfit'), num('Chi phí bán hàng', 'selling'),
  num('Chi phí quản lý', 'admin'), num('Lãi (lỗ)', 'profit'), num('Chi phí sản xuất phát sinh', 'production', 0, 170),
  ...(project ? [num<PnlRow>('Dự toán', 'budget'), num<PnlRow>('% dự toán', 'budgetPct', 2, 105)] : [num<PnlRow>('Giá trị hợp đồng', 'value'), num<PnlRow>('% giá trị', 'valuePct', 2, 105)]),
];

export default function ContractReportsPage() {
  const { me, can } = useAuth();
  const cost = !!me?.sensitive.includes('view_cost');
  const [tab, setTab] = useState<TabKey>('track');
  const [f, setF] = useRememberedFilter('contract-reports', { asOf: todayVn(), kind: '', overdue: false, from: dayjs().startOf('year').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD') },
    `${me?.tenantId}:${me?.userId}`);
  const urls: Record<TabKey, string> = {
    track: `/api/contracts/track?${new URLSearchParams({ asOf: f.asOf, overdue: String(f.overdue), ...(f.kind ? { kind: f.kind } : {}) })}`,
    contract: `/api/contracts/pnl?from=${f.from}&to=${f.to}`,
    project: `/api/projects/pnl?from=${f.from}&to=${f.to}`,
  };
  const url = urls[tab];
  const data = useQuery({ queryKey: ['contract-report', url], queryFn: () => api<TrackReport | PnlReport>(url), retry: false });
  const cols = useMemo(() => pnlCols(tab === 'project'), [tab]);
  const open = (format: 'pdf' | 'xlsx') => { window.open(`${url}&format=${format}`, '_blank'); };

  const body = () => {
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} />;
    if (!data.data) return <Alert type="info" message="Đang tải…" />;
    if (tab === 'track') {
      const r = data.data as TrackReport;
      return (<>
        <Space size="large" wrap style={{ marginBottom: 8 }}>
          <span>Còn phải thu/trả: <b>{formatVnNumber(String(r.totals['outstanding']))}</b></span><span>Quá hạn: <b data-testid="total-overdue">{formatVnNumber(String(r.totals['overdueDebt']))}</b></span>
          <span>Đợt quá hạn: <b>{String(r.totals['overdueMilestoneCount'])}</b></span>
        </Space>
        <KeyboardGrid<TrackRow> rows={r.rows} columns={trackCols} onRowsChange={() => undefined} addRowTemplate={() => ({} as TrackRow)} readOnly height="calc(100vh - 300px)" />
      </>);
    }
    const r = data.data as PnlReport;
    const un = { code: '', name: tab === 'project' ? 'Chưa gắn vụ việc (chi phí chung chưa phân bổ)' : 'Chưa gắn hợp đồng (chi phí chung chưa phân bổ)', ...r.unassigned };
    return (<>
      <Space size="large" wrap style={{ marginBottom: 8 }}>
        <span>Doanh thu thuần: <b>{formatVnNumber(r.totals.netRevenue)}</b></span><span>Lãi (lỗ): <b data-testid="total-profit">{formatVnNumber(r.totals.profit)}</b></span>
        <span>Chi phí chung chưa phân bổ: <b>{formatVnNumber(D(r.unassigned.selling).plus(r.unassigned.admin).toString())}</b></span>
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Lãi (lỗ) = doanh thu thuần − giá vốn − chi phí bán hàng, quản lý gắn trực tiếp. Chi phí sản xuất chỉ để xem: đi vào giá vốn qua 154, không trừ thêm." />
      <KeyboardGrid<PnlRow> rows={r.rows} columns={cols} onRowsChange={() => undefined} addRowTemplate={() => ({} as PnlRow)} readOnly height="calc(100vh - 360px)"
        pinnedBottomRows={[un, { code: 'Cộng', name: '', ...r.totals }]} />
    </>);
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Báo cáo hợp đồng, vụ việc</h2>
        {tab === 'track' ? <>
          <DatePicker format="DD/MM/YYYY" allowClear={false} aria-label="Tại ngày" value={dayjs(f.asOf)} onChange={(d) => d && setF({ ...f, asOf: d.format('YYYY-MM-DD') })} />
          <Segmented aria-label="Loại hợp đồng" value={f.kind} onChange={(v) => setF({ ...f, kind: String(v) })} options={[{ value: '', label: 'Bán và mua' }, { value: 'sale', label: 'Bán (phải thu)' }, { value: 'purchase', label: 'Mua (phải trả)' }]} />
          <Checkbox checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })}>Chỉ hợp đồng quá hạn</Checkbox>
        </> : <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} aria-label="Khoảng ngày"
          onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />}
        {can('report.print') && <><Button onClick={() => open('pdf')}>In PDF</Button><Button onClick={() => open('xlsx')}>Xuất Excel</Button></>}
      </Space>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={[{ key: 'track', label: 'Theo dõi thực hiện, quá hạn' },
        ...(cost ? [{ key: 'contract', label: 'Lãi lỗ theo hợp đồng' }, { key: 'project', label: 'Lãi lỗ theo vụ việc' }] : [])]} />
      {body()}
    </Space>);
}
