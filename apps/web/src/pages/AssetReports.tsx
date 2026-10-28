import { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, InputNumber, Select, Tabs } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, PageHeader, Toolbar, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

type Row = Record<string, unknown>;
type TabKey = 'register' | 'card' | 'location' | 'depreciation' | 'movement' | 'tool' | 'allocation';
interface Group { categoryName?: string; departmentName?: string; rows: Row[]; totalCost?: string; totalAnnual?: string; totalIncrease?: string; totalDecrease?: string }
interface Result {
  groups?: Group[]; rows?: Row[]; totals?: Row; accounts?: string[]; departments?: { code: string; name: string }[];
  asset?: { code: string; name: string }; costLines?: Row[]; wear?: Row[];
}

// Số 0 để trống như sổ giấy.
const fmt = (v: unknown, scale = 0) => (typeof v === 'string' && !/^-?0+(\.0+)?$/.test(v) ? formatVnNumber(v, scale) : '');
const num = (headerName: string, field: string, scale = 0, width = 130): ColDef<Row> => ({ field, headerName, width, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => fmt(p.value, scale) });
const txt = (headerName: string, field: string, width?: number): ColDef<Row> => (width ? { field, headerName, width } : { field, headerName, flex: 1, minWidth: 180 });
const dt = (headerName: string, field: string): ColDef<Row> => ({ field, headerName, width: 110, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') });

const COLUMNS: Record<Exclude<TabKey, 'depreciation'>, ColDef<Row>[]> = {
  register: [txt('STT', 'stt', 60), txt('Số chứng từ tăng', 'incVoucherNo', 130), dt('Ngày chứng từ', 'incDate'), txt('Tên, đặc điểm, ký hiệu TSCĐ', 'name'), txt('Nước sản xuất', 'country', 110), dt('Đưa vào sử dụng', 'useDate'), txt('Số hiệu TSCĐ', 'cardNo', 120),
    num('Nguyên giá', 'cost'), num('Tỷ lệ KH (%)', 'ratePct', 2, 110), num('Mức KH năm', 'annualDepreciation'), num('KH đã tính đến khi ghi giảm', 'accumulatedAtDecrease', 0, 150), txt('Số CT giảm', 'decVoucherNo', 130), dt('Ngày giảm', 'decDate'), txt('Lý do giảm', 'decReason', 170)],
  card: [txt('Số chứng từ', 'voucherNo', 130), dt('Ngày', 'date'), txt('Diễn giải', 'description'), num('Nguyên giá', 'amount'), txt('Năm', 'year', 80), num('Giá trị hao mòn', 'value'), num('Cộng dồn', 'accumulated')],
  location: [txt('Số CT tăng', 'incVoucherNo', 130), dt('Ngày tăng', 'incDate'), txt('Tên, quy cách TSCĐ và CCDC', 'name'), txt('ĐVT', 'uom', 70), num('Số lượng', 'incQty', 4, 100), num('Đơn giá', 'unitPrice'), num('Số tiền tăng', 'incAmount'),
    txt('Số CT giảm', 'decVoucherNo', 130), dt('Ngày giảm', 'decDate'), txt('Lý do', 'decReason', 160), num('SL giảm', 'decQty', 4, 100), num('Số tiền giảm', 'decAmount')],
  movement: [txt('Loại tài sản', 'categoryName'), num('NG đầu kỳ', 'openingCost'), num('NG tăng', 'increaseCost'), num('NG giảm', 'decreaseCost'), num('NG cuối kỳ', 'closingCost'),
    num('HM đầu kỳ', 'openingAccumulated'), num('HM tăng', 'increaseAccumulated'), num('HM giảm', 'decreaseAccumulated'), num('HM cuối kỳ', 'closingAccumulated'), num('Còn lại đầu kỳ', 'openingNet'), num('Còn lại cuối kỳ', 'closingNet')],
  tool: [txt('Mã', 'assetCode', 110), txt('Tên', 'name'), txt('Bộ phận', 'departmentCode', 100), dt('Ngày ghi tăng', 'startDate'), txt('Số chứng từ', 'voucherNo', 130), num('Số kỳ PB', 'lifeUnits', 0, 90), num('Giá trị ban đầu', 'initial'),
    num('Phân bổ trong kỳ', 'allocatedPeriod'), num('Đã phân bổ lũy kế', 'allocatedTotal'), num('Ghi giảm', 'decreased'), num('Còn lại cuối kỳ', 'remaining'), num('Số kỳ còn lại', 'remainingUnits', 4, 100)],
  allocation: [txt('Đối tượng sử dụng (Nợ TK)', 'label'), num('Có TK 242 - CCDC', 'tool'), num('Có TK 242 - Chi phí trả trước', 'prepaid'), num('Cộng', 'total')],
};

// Nhóm theo loại / bộ phận: tiêu đề nhóm và dòng Cộng chen vào lưới phẳng.
function flatten(tab: TabKey, d: Result): Row[] {
  if (tab === 'register' || tab === 'location') {
    return (d.groups ?? []).flatMap((g) => [{ name: g.categoryName ?? g.departmentName }, ...g.rows,
      tab === 'register' ? { name: 'Cộng', cost: g.totalCost, annualDepreciation: g.totalAnnual } : { name: 'Cộng', incAmount: g.totalIncrease, decAmount: g.totalDecrease }]);
  }
  if (tab === 'card') { const n = Math.max(d.costLines?.length ?? 0, d.wear?.length ?? 0); return Array.from({ length: n }, (_, i) => ({ ...(d.costLines?.[i] ?? {}), ...(d.wear?.[i] ?? {}) })); }
  if (tab === 'depreciation') return (d.rows ?? []).map((r) => ({ ...r, ...Object.fromEntries(Object.entries((r['byAccount'] ?? {}) as Record<string, string>).map(([a, v]) => [`a_${a}`, v])) }));
  const rows = d.rows ?? [];
  return d.totals ? [...rows, { ...d.totals, categoryName: 'Cộng', label: 'Cộng', name: 'Cộng' }] : rows;
}

export default function AssetReportsPage() {
  const { me, can } = useAuth();
  const [tab, setTab] = useState<TabKey>('register');
  const [f, setF] = useRememberedFilter('asset-reports', { from: dayjs().startOf('year').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), to2: todayVn(), year: dayjs().year(), period: dayjs().month() + 1, kind: 'fixed', toolKind: 'tool', assetId: 0 }, `${me?.tenantId}:${me?.userId}`);

  const assets = useQuery({ queryKey: ['asset-lookup-fixed'], queryFn: () => api<{ id: number; code: string; name: string }[]>('/api/lookups/assets?kind=fixed&size=200'), enabled: tab === 'card' });
  const url = useMemo(() => {
    const p = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const range = { from: f.from, to: f.to };
    switch (tab) {
      case 'register': return `/api/asset-reports/register?${p({ ...range, kind: 'fixed' })}`;
      case 'card': return f.assetId ? `/api/asset-reports/card/${f.assetId}?${p({ to: f.to2 })}` : null;
      case 'location': return `/api/asset-reports/by-location?${p(range)}`;
      case 'depreciation': return `/api/asset-reports/depreciation-sheet?${p({ fiscalYear: String(f.year), periodNo: String(f.period) })}`;
      case 'movement': return `/api/asset-reports/movement?${p({ ...range, kind: f.kind })}`;
      case 'tool': return `/api/asset-reports/tool-register?${p({ ...range, kind: f.toolKind })}`;
      case 'allocation': return `/api/asset-reports/allocation-sheet?${p({ fiscalYear: String(f.year), periodNo: String(f.period) })}`;
    }
  }, [tab, f]);
  const data = useQuery({ queryKey: ['asset-report', url], queryFn: () => api<Result>(url!), enabled: !!url, retry: false });
  const rows = useMemo(() => (data.data ? flatten(tab, data.data) : []), [data.data, tab]);
  const columns = useMemo<ColDef<Row>[]>(() => tab !== 'depreciation' ? COLUMNS[tab]
    : [txt('Chỉ tiêu', 'label'), num('Nguyên giá TSCĐ', 'cost'), num('Số khấu hao', 'depreciation'), ...(data.data?.accounts ?? []).map((a) => num(a.startsWith('(') ? 'Chưa phân bổ' : `TK ${a}`, `a_${a}`))], [tab, data.data]);
  const printAs = (format: 'pdf' | 'xlsx') => { if (url) window.open(`${url}&format=${format}`, '_blank'); };
  const periodic = tab === 'depreciation' || tab === 'allocation';

  const body = () => {
    if (!url) return <Alert type="info" showIcon message="Chọn tài sản để xem thẻ tài sản" style={{ marginBottom: 12 }} />;
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} style={{ marginBottom: 12 }} />;
    if (!data.data) return <Alert type="info" message="Đang tải…" style={{ marginBottom: 12 }} />;
    return <KeyboardGrid<Row> rows={rows} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height="calc(100vh - 260px)" />;
  };

  const tabs: { key: TabKey; label: string }[] = [{ key: 'register', label: 'Sổ TSCĐ' }, { key: 'card', label: 'Thẻ TSCĐ' }, { key: 'location', label: 'Sổ theo nơi sử dụng' }, { key: 'depreciation', label: 'Bảng khấu hao' },
    { key: 'movement', label: 'Tăng giảm tài sản' }, { key: 'tool', label: 'Sổ CCDC, trả trước' }, { key: 'allocation', label: 'Bảng phân bổ CCDC' }];
  return (
    <>
      <PageHeader
        title="Báo cáo tài sản"
        extra={can('report.print') ? (
          <>
            <Button disabled={!url} onClick={() => printAs('pdf')}>In PDF</Button>
            <Button disabled={!url} onClick={() => printAs('xlsx')}>Xuất Excel</Button>
          </>
        ) : undefined}
      >
        <Toolbar>
          {periodic ? <>
            <InputNumber aria-label="Năm" addonBefore="Năm" min={1900} max={2200} value={f.year} onChange={(v) => setF({ ...f, year: v ?? f.year })} />
            <InputNumber aria-label="Kỳ" addonBefore="Kỳ" min={1} max={12} value={f.period} onChange={(v) => setF({ ...f, period: v ?? f.period })} />
          </> : tab === 'card' ? <>
            <DatePicker format="DD/MM/YYYY" allowClear={false} aria-label="Tính đến ngày" value={dayjs(f.to2)} onChange={(d) => d && setF({ ...f, to2: d.format('YYYY-MM-DD') })} />
            <Select showSearch optionFilterProp="label" aria-label="Tài sản" placeholder="Tài sản (F4)" style={{ width: 280 }} value={f.assetId || undefined} onChange={(v) => setF({ ...f, assetId: v ?? 0 })}
              options={(assets.data ?? []).map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }))} />
          </> : <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />}
          {tab === 'movement' && <Select aria-label="Nhóm tài sản" style={{ width: 200 }} value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: 'fixed', label: 'Tài sản cố định' }, { value: 'tool', label: 'Công cụ, dụng cụ' }, { value: 'prepaid', label: 'Chi phí trả trước' }]} />}
          {tab === 'tool' && <Select aria-label="Sổ theo dõi" style={{ width: 200 }} value={f.toolKind} onChange={(v) => setF({ ...f, toolKind: v })} options={[{ value: 'tool', label: 'Công cụ, dụng cụ' }, { value: 'prepaid', label: 'Chi phí trả trước' }]} />}
        </Toolbar>
      </PageHeader>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={tabs} style={{ marginBottom: 12 }} />
      {body()}
    </>
  );
}
