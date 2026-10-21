import { useMemo, useState } from 'react';
import { Alert, Button, InputNumber, Segmented, Select, Space, Tabs } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Bảng kê hóa đơn mua vào/bán ra (nội bộ, không phải mẫu bắt buộc) và đối chiếu thuế hóa đơn với sổ cái. Số liệu từ /api/tax/*.
interface Line { stt: number; groupCode: string; groupName: string; formNo: string | null; serial: string | null; invoiceNo: string; invoiceDate: string; partyName: string | null; partyTaxCode: string | null;
  baseAmount: string; taxRate: string | null; taxAmount: string; voucherId: string; voucherNo: string | null; voucherType: string; kind: 'original' | 'reversal'; isImport?: boolean }
interface Register { label: string; note: string | null; groups: { code: string; name: string; rows: Line[]; baseTotal: string; taxTotal: string }[]; totals: { baseAmount: string; taxAmount: string };
  otherTaxes: { rows: Line[]; baseTotal: string; taxTotal: string } }
interface Reconcile { purchaseTaxInvoices: string; debit1331: string; saleTaxInvoices: string; credit33311: string;
  differences: { voucherId: string; voucherNo: string | null; voucherType: string; direction: 'purchase' | 'sale'; invoiceTax: string; ledgerTax: string }[] }
type TabKey = 'purchase' | 'sale' | 'reconcile';
// Dòng lưới: dòng nhóm, dòng hóa đơn, dòng cộng nhóm. bold = dòng nhóm/cộng.
interface Row { key: string; bold: boolean; stt: number | null; serial: string; invoiceNo: string; invoiceDate: string; partyName: string; partyTaxCode: string; baseAmount: string | null; taxRate: string; taxAmount: string | null;
  voucherId: string; voucherType: string; voucherNo: string }

const blank = { stt: null, serial: '', invoiceNo: '', invoiceDate: '', partyName: '', partyTaxCode: '', baseAmount: null, taxRate: '', taxAmount: null, voucherId: '', voucherType: '', voucherNo: '' };
const lineRow = (x: Line, key: string): Row => ({ key, bold: false, stt: x.stt, serial: [x.formNo, x.serial].filter(Boolean).join(' '), invoiceNo: x.invoiceNo, invoiceDate: x.invoiceDate, partyName: x.partyName ?? '', partyTaxCode: x.partyTaxCode ?? '',
  baseAmount: x.baseAmount, taxRate: x.taxRate === null ? '' : `${x.taxRate}%`, taxAmount: x.taxAmount, voucherId: x.voucherId, voucherType: x.voucherType, voucherNo: `${x.voucherNo ?? ''}${x.kind === 'reversal' ? ' (đảo)' : ''}` });
export function registerRows(r: Register): Row[] {
  const out: Row[] = [];
  for (const g of r.groups) out.push({ ...blank, key: `g${g.code}`, bold: true, partyName: `Nhóm ${g.code} – ${g.name}` }, ...g.rows.map((x, i) => lineRow(x, `g${g.code}-${i}`)),
    { ...blank, key: `s${g.code}`, bold: true, partyName: `Cộng nhóm ${g.code}`, baseAmount: g.baseTotal, taxAmount: g.taxTotal });
  if (r.groups.length) out.push({ ...blank, key: 'total', bold: true, partyName: 'Tổng cộng', baseAmount: r.totals.baseAmount, taxAmount: r.totals.taxAmount });
  if (r.otherTaxes.rows.length) out.push({ ...blank, key: 'other', bold: true, partyName: 'Thuế nhập khẩu, tiêu thụ đặc biệt (không kê khai GTGT, không cộng vào tổng)' }, ...r.otherTaxes.rows.map((x, i) => lineRow(x, `o${i}`)),
    { ...blank, key: 'other-total', bold: true, partyName: 'Cộng', baseAmount: r.otherTaxes.baseTotal, taxAmount: r.otherTaxes.taxTotal });
  return out;
}

const bold = (c: ColDef<Row>): ColDef<Row> => ({ ...c, editable: false, cellStyle: (p) => (p.data?.bold ? { fontWeight: 'bold' } : undefined) });
const money = (field: 'baseAmount' | 'taxAmount', headerName: string): ColDef<Row> => bold({ field, headerName, width: 140, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => (p.value === null || p.value === undefined ? '' : formatVnNumber(p.value as string)) });
const registerColumns: ColDef<Row>[] = [
  bold({ field: 'stt', headerName: 'STT', width: 70 }), bold({ field: 'serial', headerName: 'Ký hiệu', width: 120 }), bold({ field: 'invoiceNo', headerName: 'Số hóa đơn', width: 120 }),
  bold({ field: 'invoiceDate', headerName: 'Ngày', width: 110, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') }), bold({ field: 'partyName', headerName: 'Tên người bán/mua', flex: 1, minWidth: 220 }),
  bold({ field: 'partyTaxCode', headerName: 'Mã số thuế', width: 130 }), money('baseAmount', 'Giá trị chưa thuế'), bold({ field: 'taxRate', headerName: 'Thuế suất', width: 90, cellClass: 'ag-right-aligned-cell' }), money('taxAmount', 'Thuế GTGT'),
  bold({ field: 'voucherNo', headerName: 'Số chứng từ', width: 150, cellRenderer: (p: { data?: Row }) => (p.data?.voucherId ? <a href={`/chung-tu/${p.data.voucherType}/${p.data.voucherId}`} target="_blank" rel="noopener noreferrer">{p.data.voucherNo}</a> : null) }),
];
type Diff = Reconcile['differences'][number];
const diffColumns: ColDef<Diff>[] = ([
  { headerName: 'Số chứng từ', width: 160, valueGetter: (p) => p.data?.voucherNo ?? '(nháp)', cellRenderer: (p: { data?: Diff; value?: string }) => (p.data ? <a href={`/chung-tu/${p.data.voucherType}/${p.data.voucherId}`} target="_blank" rel="noopener noreferrer">{p.value}</a> : null) },
  { headerName: 'Loại', width: 100, valueGetter: (p) => (p.data?.direction === 'purchase' ? 'Mua vào' : 'Bán ra') },
  { headerName: 'Thuế trên hóa đơn', width: 160, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => p.data?.invoiceTax, valueFormatter: (p) => formatVnNumber(p.value as string) },
  { headerName: 'Thuế trên sổ cái', width: 160, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => p.data?.ledgerTax, valueFormatter: (p) => formatVnNumber(p.value as string) },
  { headerName: 'Chênh lệch', width: 150, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => (p.data ? D(p.data.ledgerTax).minus(p.data.invoiceTax).toFixed(0) : ''), valueFormatter: (p) => formatVnNumber(p.value as string) },
] satisfies ColDef<Diff>[]).map((c) => ({ ...c, editable: false }));

// Mở từ tờ khai GTGT: ?direction=sale&year=2026&period=7&periodKind=month&group=10,08&importOnly=1&field=tax (nhóm cách nhau dấu phẩy; importOnly: chỉ hóa đơn hàng nhập khẩu; field: chỉ tiêu lấy giá trị chưa thuế hay thuế).
// Tham số của đường dẫn thắng bộ lọc đã nhớ cho tới khi người dùng đổi kỳ.
export interface UrlFilter { groups: string[]; importOnly: boolean; field: 'base' | 'tax' | null }
export function urlSelection(search: string): { tab: TabKey | null; sel: { periodKind: string; year: number; period: number } | null } & UrlFilter {
  const q = new URLSearchParams(search); const dir = q.get('direction'); const year = Number(q.get('year')); const period = Number(q.get('period')); const kind = q.get('periodKind'); const field = q.get('field');
  const ok = Number.isInteger(year) && year >= 2000 && year <= 2100 && Number.isInteger(period) && period >= 1 && period <= 12 && (kind === 'month' || kind === 'quarter');
  return { tab: dir === 'purchase' || dir === 'sale' ? dir : null, sel: ok ? { periodKind: kind, year, period } : null, groups: (q.get('group') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    importOnly: q.get('importOnly') === '1', field: field === 'base' || field === 'tax' ? field : null };
}
// Lọc bảng kê theo nhóm và hàng nhập khẩu; có lọc thì cộng nhóm và tổng cộng tính lại từ các dòng còn lại (khớp với chỉ tiêu của tờ khai).
export function filterRegister(r: Register, f: Pick<UrlFilter, 'groups' | 'importOnly'>): Register {
  if (!f.groups.length && !f.importOnly) return r;
  const sum = (rows: Line[], k: 'baseAmount' | 'taxAmount') => rows.reduce((a, x) => a.plus(x[k]), D(0)).toFixed(0);
  const groups = r.groups.filter((g) => !f.groups.length || f.groups.includes(g.code)).map((g) => {
    const rows = f.importOnly ? g.rows.filter((x) => x.isImport) : g.rows;
    return { ...g, rows, baseTotal: sum(rows, 'baseAmount'), taxTotal: sum(rows, 'taxAmount') };
  }).filter((g) => g.rows.length || !f.importOnly);
  const total = (k: 'baseTotal' | 'taxTotal') => groups.reduce((a, g) => a.plus(g[k]), D(0)).toFixed(0);
  return { ...r, groups, totals: { baseAmount: total('baseTotal'), taxAmount: total('taxTotal') }, otherTaxes: { rows: [], baseTotal: '0', taxTotal: '0' } };
}

export default function InvoiceRegisterPage() {
  const { me, can } = useAuth();
  const init = useMemo(() => urlSelection(typeof window === 'undefined' ? '' : window.location.search), []);
  const [tab, setTab] = useState<TabKey>(init.tab ?? 'purchase');
  const [filter, setFilter] = useState<UrlFilter>({ groups: init.groups, importOnly: init.importOnly, field: init.field });
  const filtered = filter.groups.length > 0 || filter.importOnly;
  const clearFilter = () => setFilter({ groups: [], importOnly: false, field: null });
  const [urlSel, setUrlSel] = useState(init.sel);
  const now = dayjs();
  const [remembered, setRemembered] = useRememberedFilter('tax-register', { periodKind: 'month', year: now.year(), period: now.month() + 1 }, `${me?.tenantId}:${me?.userId}`);
  const f = urlSel ?? remembered;
  const setF = (v: typeof remembered) => { setUrlSel(null); clearFilter(); setRemembered(v); };
  const kind = f.periodKind as 'month' | 'quarter';
  const period = Math.min(f.period, kind === 'month' ? 12 : 4);
  const qs = new URLSearchParams({ year: String(f.year), period: String(period), periodKind: kind });
  const url = tab === 'reconcile' ? `/api/tax/reconcile?${qs}` : `/api/tax/invoices?direction=${tab}&${qs}`;
  const data = useQuery({ queryKey: ['tax-register', url], queryFn: () => api<Register | Reconcile>(url), retry: false });
  const rows = useMemo(() => {
    if (tab === 'reconcile' || !data.data || !('groups' in data.data)) return [];
    return registerRows(filterRegister(data.data, filter));
  }, [tab, data.data, filter]);

  const stat = (label: string, value: string) => <span key={label}>{label}: <b>{formatVnNumber(value)}</b></span>;
  const body = () => {
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} />;
    const d = data.data;
    if (!d) return <Alert type="info" message="Đang tải…" />;
    if ('differences' in d) return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space size="large" wrap>{stat('Thuế GTGT đầu vào trên hóa đơn', d.purchaseTaxInvoices)}{stat('Thuế GTGT đầu vào trên sổ cái (thuần Nợ − Có, mọi TK thuế đầu vào)', d.debit1331)}{stat('Thuế GTGT đầu ra trên hóa đơn', d.saleTaxInvoices)}{stat('Thuế GTGT đầu ra trên sổ cái (thuần Có − Nợ, mọi TK thuế đầu ra)', d.credit33311)}</Space>
        {d.differences.length === 0 ? <Alert type="success" showIcon message="Thuế trên hóa đơn khớp sổ cái ở mọi chứng từ của kỳ" />
          : <><Alert type="warning" showIcon message={`${d.differences.length} chứng từ lệch giữa thuế trên hóa đơn và thuế ghi sổ`} />
            <KeyboardGrid<Diff> rows={d.differences} columns={diffColumns} onRowsChange={() => undefined} addRowTemplate={() => ({} as Diff)} readOnly height="calc(100vh - 380px)" /></>}
      </Space>);
    const r = filterRegister(d as Register, filter);
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        {filtered && <Alert type="info" showIcon message={`Đang lọc ${[filter.groups.length ? `theo nhóm kê khai ${filter.groups.join(', ')}` : '', filter.importOnly ? 'chỉ hàng nhập khẩu' : ''].filter(Boolean).join(', ')} (từ tờ khai GTGT); cộng nhóm và tổng cộng tính trên các dòng đang hiện`}
          action={<Button size="small" onClick={clearFilter}>Bỏ lọc</Button>} />}
        {r.note && <Alert type="info" showIcon message={r.note} />}
        <Space size="large" wrap>{stat(filter.field === 'base' ? 'Giá trị chưa thuế (chỉ tiêu tờ khai)' : 'Giá trị chưa thuế', r.totals.baseAmount)}{stat(filter.field === 'tax' ? 'Thuế GTGT (chỉ tiêu tờ khai)' : 'Thuế GTGT', r.totals.taxAmount)}</Space>
        {rows.length === 0 ? <Alert type="info" showIcon message={`Không có hóa đơn ${tab === 'purchase' ? 'mua vào' : 'bán ra'} trong ${r.label.toLowerCase()}`} />
          : <KeyboardGrid<Row> rows={rows} columns={registerColumns} onRowsChange={() => undefined} addRowTemplate={() => ({} as Row)} readOnly height="calc(100vh - 380px)" />}
      </Space>);
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Bảng kê hóa đơn</h2>
        <Segmented aria-label="Loại kỳ kê khai" value={kind} onChange={(v) => setF({ ...f, periodKind: String(v) })} options={[{ value: 'month', label: 'Tháng' }, { value: 'quarter', label: 'Quý' }]} />
        <InputNumber aria-label="Năm" min={2000} max={2100} precision={0} value={f.year} onChange={(v) => v && setF({ ...f, year: v })} style={{ width: 90 }} />
        <Select aria-label="Kỳ" style={{ width: 120 }} value={period} onChange={(v) => setF({ ...f, period: v })}
          options={Array.from({ length: kind === 'month' ? 12 : 4 }, (_, i) => ({ value: i + 1, label: `${kind === 'month' ? 'Tháng' : 'Quý'} ${i + 1}` }))} />
        {can('report.print') && <Button onClick={() => window.open(`${url}&format=xlsx`, '_blank')}>Xuất Excel</Button>}
      </Space>
      <Tabs activeKey={tab} onChange={(k) => { setTab(k as TabKey); clearFilter(); }} items={[{ key: 'purchase', label: 'Mua vào' }, { key: 'sale', label: 'Bán ra' }, { key: 'reconcile', label: 'Đối chiếu' }]} />
      {body()}
    </Space>
  );
}
