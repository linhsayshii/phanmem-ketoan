import { useMemo } from 'react';
import { Alert, Button, DatePicker, Select, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

type Row = Record<string, unknown>;
interface Result { rows: Row[]; totals: Record<string, string>; costHidden: boolean; truncated: boolean; banners?: { messages: string[] } }
type Kind = 'sales' | 'purchases';

// Số 0 để trống như báo cáo giấy; số lượng hiện đủ số lẻ có thật.
const fmt = (v: unknown, scale = 0) => (typeof v === 'string' && !/^-?0+(\.0+)?$/.test(v) ? formatVnNumber(v, scale) : '');
const qty = (v: unknown) => fmt(v, typeof v === 'string' ? (v.split('.')[1]?.length ?? 0) : 0);
const num = (headerName: string, field: string, format: (v: unknown) => string = (v) => fmt(v), width = 130): ColDef<Row> => ({ field, headerName, width, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => format(p.value) });

const GROUPS: Record<Kind, { value: string; label: string }[]> = {
  sales: [{ value: 'party', label: 'Khách hàng' }, { value: 'item', label: 'Mặt hàng' }, { value: 'salesperson', label: 'Nhân viên bán hàng' }, { value: 'item_group', label: 'Nhóm hàng' }, { value: 'month', label: 'Tháng' }],
  purchases: [{ value: 'party', label: 'Nhà cung cấp' }, { value: 'item', label: 'Mặt hàng' }, { value: 'month', label: 'Tháng' }],
};
const COLUMNS: Record<Kind, ColDef<Row>[]> = {
  sales: [num('SL bán', 'soldQty', qty, 100), num('SL trả lại', 'returnQty', qty, 100), num('Doanh số', 'grossSales'), num('Chiết khấu', 'discount'), num('Giảm giá, trả lại', 'returns', undefined, 150), num('Doanh thu thuần', 'netRevenue'),
    num('Giá vốn', 'cogs'), num('Lãi gộp', 'grossProfit')],
  purchases: [num('SL mua', 'qty', qty, 100), num('SL trả lại', 'returnQty', qty, 100), num('Giá trị mua', 'purchaseValue'), num('Chiết khấu', 'discount'), num('Trả lại, giảm giá', 'returns', undefined, 140), num('Giá trị thuần', 'netPurchase'),
    num('Thuế GTGT', 'vat'), num('Thuế nhập khẩu', 'importTax'), num('Thuế TTĐB', 'exciseTax'), num('GTGT hàng nhập khẩu', 'importVat', undefined, 160), num('Chi phí mua', 'landedCost')],
};

export function TradeReportsPage({ kind }: { kind: Kind }) {
  const { me, can } = useAuth();
  const [f, setF] = useRememberedFilter(`${kind}-reports`, { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), groupBy: 'party', item: '', group: '' }, `${me?.tenantId}:${me?.userId}`);
  const url = useMemo(() => `/api/reports/${kind}?${new URLSearchParams({ from: f.from, to: f.to, groupBy: f.groupBy, ...(f.item ? { item: f.item } : {}), ...(f.group ? { group: f.group } : {}) })}`, [kind, f]);
  const data = useQuery({ queryKey: ['trade-report', url], queryFn: () => api<Result>(url), retry: false });
  const label = GROUPS[kind].find((g) => g.value === f.groupBy)?.label ?? GROUPS[kind][0]!.label;
  const columns = useMemo(() => [{ field: 'name', headerName: label, flex: 1, minWidth: 220 } as ColDef<Row>, ...COLUMNS[kind].filter((c) => !data.data?.costHidden || !['cogs', 'grossProfit', 'landedCost'].includes(c.field!))], [kind, label, data.data?.costHidden]);
  const rows = useMemo(() => (data.data ? [...data.data.rows, { name: 'Cộng', ...data.data.totals }] : []), [data.data]);
  const title = kind === 'sales' ? 'Báo cáo bán hàng' : 'Báo cáo mua hàng';
  const printAs = (format: 'pdf' | 'xlsx') => window.open(`${url}&format=${format}`, '_blank');

  return (
    <>
      <PageHeader
        title={title}
        extra={can('report.print') ? (
          <>
            <Button onClick={() => printAs('pdf')}>In PDF</Button>
            <Button onClick={() => printAs('xlsx')}>Xuất Excel</Button>
          </>
        ) : undefined}
      >
        <Toolbar>
          <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />
          <Select aria-label="Nhóm theo" style={{ width: 200 }} value={GROUPS[kind].some((g) => g.value === f.groupBy) ? f.groupBy : 'party'} options={GROUPS[kind].map((g) => ({ ...g, label: `Theo ${g.label.toLowerCase()}` }))} onChange={(v) => setF({ ...f, groupBy: v })} />
          <LookupSelect catalog="item" aria-label="Mã hàng" placeholder="Mã hàng (F4)" style={{ width: 200 }} value={f.item || null} onChange={(code) => setF({ ...f, item: code ?? '' })} />
          {data.data?.costHidden && <Tag style={{ marginRight: 0 }}>{kind === 'sales' ? 'Không có quyền xem giá vốn: ẩn cột giá vốn và lãi gộp' : 'Không có quyền xem giá vốn: ẩn cột chi phí mua'}</Tag>}
        </Toolbar>
      </PageHeader>
      {data.error ? <Alert type="error" showIcon message={(data.error as Error).message} style={{ marginBottom: 12 }} /> : !data.data ? <Alert type="info" message="Đang tải…" style={{ marginBottom: 12 }} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data.data.banners?.messages ?? []).map((m) => <Alert key={m} type="warning" showIcon message={m} />)}
          {data.data.truncated && <Alert type="warning" showIcon message="Kết quả bị cắt bớt vì quá nhiều dòng; hãy thu hẹp bộ lọc hoặc xuất Excel." />}
          <KeyboardGrid<Row> rows={rows} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height="calc(100vh - 260px)" />
        </div>)}
    </>
  );
}
export const SalesReportsPage = () => <TradeReportsPage kind="sales" />;
export const PurchaseReportsPage = () => <TradeReportsPage kind="purchases" />;
