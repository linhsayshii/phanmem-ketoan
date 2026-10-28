import { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, InputNumber, Tabs, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

type Row = Record<string, unknown>;
type TabKey = 'summary' | 'card' | 'ledger' | 'in' | 'out' | 'expiry' | 'reconcile';
interface Banners { messages: string[] }
interface Card { itemCode: string; warehouseCode: string; openingQty: string; lines: Row[]; totalInQty: string; totalOutQty: string; closingQty: string }
interface Ledger { itemCode: string; warehouseCode: string; openingQty: string; openingValue: string; lines: Row[]; totalInQty: string; totalInValue: string; totalOutQty: string; totalOutValue: string; closingQty: string; closingValue: string }
interface Result { rows?: Row[]; cards?: Card[]; ledgers?: Ledger[]; differences?: Row[]; notes?: { message: string }[]; ok?: boolean; truncated?: boolean; banners?: Banners }

// Số 0 để trống như sổ giấy; số lượng hiện đủ số lẻ có thật.
const fmt = (v: unknown, scale = 0) => (typeof v === 'string' && !/^-?0+(\.0+)?$/.test(v) ? formatVnNumber(v, scale) : '');
const qty = (v: unknown) => fmt(v, typeof v === 'string' ? (v.split('.')[1]?.length ?? 0) : 0);
const num = (headerName: string, field: string, format: (v: unknown) => string = (v) => fmt(v), width = 120): ColDef<Row> => ({ field, headerName, width, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => format(p.value) });
const txt = (headerName: string, field: string, width?: number): ColDef<Row> => (width ? { field, headerName, width } : { field, headerName, flex: 1, minWidth: 160 });
const dt = (headerName: string, field: string): ColDef<Row> => ({ field, headerName, width: 110, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') });
const prov = (v: unknown) => (v ? ' (tạm tính)' : '');

const COLUMNS: Record<TabKey, ColDef<Row>[]> = {
  summary: [txt('Mã hàng', 'itemCode', 120), txt('Tên hàng', 'itemName'), txt('ĐVT', 'uomCode', 70), txt('Kho', 'warehouseCode', 90), txt('Lô', 'lotNo', 90),
    num('Đầu kỳ SL', 'openingQty', qty), num('Đầu kỳ GT', 'openingValue'), num('Nhập SL', 'inQty', qty), num('Nhập GT', 'inValue'), num('Xuất SL', 'outQty', qty),
    { ...num('Xuất GT', 'outValue'), valueFormatter: (p) => fmt(p.value) + prov(p.data?.['provisional']) }, num('Cuối kỳ SL', 'closingQty', qty), num('Cuối kỳ GT', 'closingValue')],
  card: [txt('Kho', 'warehouseCode', 90), dt('Ngày, tháng', 'postingDate'), txt('Số CT nhập', 'inVoucherNo', 130), txt('Số CT xuất', 'outVoucherNo', 130), txt('Diễn giải', 'description'), num('Nhập', 'inQty', qty), num('Xuất', 'outQty', qty), num('Tồn', 'balanceQty', qty)],
  ledger: [txt('Kho', 'warehouseCode', 90), txt('Mã hàng', 'itemCode', 110), dt('Ngày, tháng', 'postingDate'), txt('Số chứng từ', 'voucherNo', 130), txt('Diễn giải', 'description'), txt('TK đối ứng', 'counterAccountCode', 100),
    num('Đơn giá', 'unitPrice', (v) => fmt(v, 4), 110), num('Nhập SL', 'inQty', qty), num('Nhập thành tiền', 'inValue', undefined, 130), num('Xuất SL', 'outQty', qty), num('Xuất thành tiền', 'outValue', undefined, 130), num('Tồn SL', 'balanceQty', qty), num('Tồn thành tiền', 'balanceValue', undefined, 130)],
  in: [], out: [],
  expiry: [txt('Mã hàng', 'itemCode', 120), txt('Tên hàng', 'itemName'), txt('ĐVT', 'uomCode', 70), txt('Kho', 'warehouseCode', 90), txt('Lô', 'lotNo', 100), dt('Hạn dùng', 'expiryDate'), num('Tồn', 'quantity', qty), num('Số ngày còn lại', 'daysLeft', (v) => String(v ?? ''))],
  reconcile: [txt('Kho', 'warehouseCode', 90), txt('Mã hàng', 'itemCode', 120), txt('TK kho', 'accountCodes', 100), num('SL thẻ kho', 'cardQty', qty), num('SL sổ chi tiết', 'layerQty', qty), num('Chênh SL', 'qtyDiff', qty), num('GT sổ chi tiết', 'layerValue'), num('GT sổ cái', 'ledgerValue'), num('Chênh GT', 'valueDiff')],
};
COLUMNS.in = COLUMNS.out = [dt('Ngày', 'postingDate'), txt('Số chứng từ', 'voucherNo', 130), txt('Đối tượng', 'partyName', 180), txt('Mã hàng', 'itemCode', 110), txt('Tên hàng', 'itemName'), txt('ĐVT', 'uomCode', 70), txt('Kho', 'warehouseCode', 90),
  txt('Lô', 'lotNo', 90), num('Số lượng', 'quantity', qty), num('Đơn giá', 'unitPrice', (v) => fmt(v, 4), 110), { ...num('Thành tiền', 'value'), valueFormatter: (p) => fmt(p.value) + prov(p.data?.['provisional']) }];

// Thẻ kho và sổ chi tiết gồm nhiều cặp hàng – kho: phẳng thành một lưới, dòng số dư đầu kỳ và cộng đặt trước và sau từng cặp.
function flatten(tab: TabKey, d: Result): Row[] {
  if (tab === 'card') return (d.cards ?? []).flatMap((c) => [{ warehouseCode: c.warehouseCode, description: `Số dư đầu kỳ - ${c.itemCode}`, balanceQty: c.openingQty }, ...c.lines.map((l) => ({ warehouseCode: c.warehouseCode, ...l })),
    { warehouseCode: c.warehouseCode, description: 'Cộng phát sinh trong kỳ', inQty: c.totalInQty, outQty: c.totalOutQty, balanceQty: c.closingQty }]);
  if (tab === 'ledger') return (d.ledgers ?? []).flatMap((c) => [{ warehouseCode: c.warehouseCode, itemCode: c.itemCode, description: 'Số dư đầu kỳ', balanceQty: c.openingQty, balanceValue: c.openingValue }, ...c.lines.map((l) => ({ warehouseCode: c.warehouseCode, itemCode: c.itemCode, ...l })),
    { warehouseCode: c.warehouseCode, itemCode: c.itemCode, description: 'Cộng phát sinh trong kỳ', inQty: c.totalInQty, inValue: c.totalInValue, outQty: c.totalOutQty, outValue: c.totalOutValue, balanceQty: c.closingQty, balanceValue: c.closingValue }]);
  return (tab === 'reconcile' ? d.differences : d.rows) ?? [];
}

export default function StockReportsPage() {
  const { me, can } = useAuth();
  const cost = !!me?.sensitive.includes('view_cost');
  const [tab, setTab] = useState<TabKey>(cost ? 'summary' : 'card');
  const [f, setF] = useRememberedFilter('stock-reports', { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), asOf: todayVn(), item: '', warehouse: '', days: 30 }, `${me?.tenantId}:${me?.userId}`);

  const url = useMemo(() => {
    const scope = { ...(f.item ? { item: f.item } : {}), ...(f.warehouse ? { warehouse: f.warehouse } : {}) };
    const p = (o: Record<string, string>) => new URLSearchParams(o).toString();
    switch (tab) {
      case 'summary': return `/api/reports/stock-summary?${p({ from: f.from, to: f.to, ...scope })}`;
      case 'card': return f.item ? `/api/reports/stock-card?${p({ from: f.from, to: f.to, ...scope })}` : null;
      case 'ledger': return `/api/reports/stock-ledger?${p({ from: f.from, to: f.to, ...scope })}`;
      case 'in': case 'out': return `/api/reports/stock-register?${p({ from: f.from, to: f.to, direction: tab, ...scope })}`;
      case 'expiry': return `/api/reports/stock-expiry?${p({ asOf: f.asOf, days: String(f.days), ...scope })}`;
      case 'reconcile': return `/api/reports/stock-reconcile?${p({ asOf: f.asOf })}`;
    }
  }, [tab, f]);
  const data = useQuery({ queryKey: ['stock-report', url], queryFn: () => api<Result>(url!), enabled: !!url, retry: false });
  const rows = useMemo(() => (data.data ? flatten(tab, data.data) : []), [data.data, tab]);
  const printAs = (format: 'pdf' | 'xlsx') => { if (url) window.open(`${url}&format=${format}`, '_blank'); };
  const dated = tab === 'expiry' || tab === 'reconcile';

  const body = () => {
    if (!url) return <Alert type="info" showIcon message="Chọn mã hàng (F4) để xem thẻ kho" style={{ marginBottom: 12 }} />;
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} style={{ marginBottom: 12 }} />;
    if (!data.data) return <Alert type="info" message="Đang tải…" style={{ marginBottom: 12 }} />;
    const d = data.data;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(d.banners?.messages ?? []).map((m) => <Alert key={m} type="warning" showIcon message={m} />)}
        {d.truncated && <Alert type="warning" showIcon message="Kết quả bị cắt bớt vì quá nhiều dòng; hãy thu hẹp bộ lọc hoặc xuất Excel." />}
        {tab === 'reconcile' && (d.ok ? <Alert type="success" showIcon message="Không có chênh lệch giữa thẻ kho, sổ chi tiết giá vốn và sổ cái." /> : <Alert type="error" showIcon message={`Có ${rows.length} dòng chênh lệch.`} />)}
        {tab === 'reconcile' && (d.notes ?? []).slice(0, 3).map((n) => <Alert key={n.message} type="info" showIcon message={n.message} />)}
        <KeyboardGrid<Row> rows={rows} columns={COLUMNS[tab]} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height="calc(100vh - 260px)" />
      </div>);
  };

  const tabs: { key: TabKey; label: string; sensitive?: boolean }[] = [{ key: 'summary', label: 'Nhập - Xuất - Tồn', sensitive: true }, { key: 'card', label: 'Thẻ kho' }, { key: 'ledger', label: 'Sổ chi tiết', sensitive: true },
    { key: 'in', label: 'Bảng kê nhập', sensitive: true }, { key: 'out', label: 'Bảng kê xuất', sensitive: true }, { key: 'expiry', label: 'Hạn dùng' }, { key: 'reconcile', label: 'Đối chiếu kế toán - kho', sensitive: true }];
  return (
    <>
      <PageHeader
        title="Báo cáo kho"
        extra={can('report.print') ? (
          <>
            <Button disabled={!url} onClick={() => printAs('pdf')}>In PDF</Button>
            <Button disabled={!url} onClick={() => printAs('xlsx')}>Xuất Excel</Button>
          </>
        ) : undefined}
      >
        <Toolbar>
          {dated ? <DatePicker format="DD/MM/YYYY" allowClear={false} aria-label="Tính đến ngày" value={dayjs(f.asOf)} onChange={(d) => d && setF({ ...f, asOf: d.format('YYYY-MM-DD') })} />
            : <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />}
          {tab !== 'reconcile' && <LookupSelect catalog="item" aria-label="Mã hàng" placeholder="Mã hàng (F4)" style={{ width: 220 }} value={f.item || null} onChange={(code) => setF({ ...f, item: code ?? '' })} />}
          {tab !== 'reconcile' && <LookupSelect catalog="warehouse" aria-label="Kho" placeholder="Kho (F4)" style={{ width: 180 }} value={f.warehouse || null} onChange={(code) => setF({ ...f, warehouse: code ?? '' })} />}
          {tab === 'expiry' && <InputNumber aria-label="Số ngày tới hạn" addonBefore="Trong" addonAfter="ngày" min={0} max={3650} value={f.days} onChange={(v) => setF({ ...f, days: v ?? 30 })} />}
          {!cost && <Tag style={{ marginRight: 0 }}>Không có quyền xem giá vốn: ẩn các báo cáo có giá trị</Tag>}
        </Toolbar>
      </PageHeader>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={tabs.filter((t) => cost || !t.sensitive).map((t) => ({ key: t.key, label: t.label }))} style={{ marginBottom: 12 }} />
      {body()}
    </>
  );
}
