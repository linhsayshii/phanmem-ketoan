import { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Input, Segmented, Select, Space, Tabs, theme } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface DetailRow { date: string; voucherId: string; voucherType: string; voucherNo: string | null; description: string | null; counterAccounts: string;
  debit: string; credit: string; balance: string; debitCurrency: string | null; creditCurrency: string | null; balanceCurrency: string | null }
interface Detail { kind: 'receivable' | 'payable'; partyName: string; currency: string | null; opening: string; closing: string; totalDebit: string; totalCredit: string;
  openingCurrency: string | null; closingCurrency: string | null; rows: DetailRow[] }
interface SummaryRow { partyCode: string; partyName: string; openingDebit: string; openingCredit: string; periodDebit: string; periodCredit: string; closingDebit: string; closingCredit: string }
interface Summary { rows: SummaryRow[]; totals: Omit<SummaryRow, 'partyCode' | 'partyName'>; closingNet: string; accountNet: string; matches: boolean }
interface AgingItem { itemId: number; docNo: string | null; docDate: string; dueDate: string | null; residual: string; daysOverdue: number | null; bucket: string }
interface Aging { kind: 'receivable' | 'payable'; columns: { key: string; label: string }[]; rows: ({ partyCode: string; partyName: string } & Record<string, string>)[]; totals: Record<string, string>; items?: AgingItem[] }
type TabKey = 'detail' | 'summary' | 'aging' | 'statement';
type Row = Record<string, unknown>;

const money = (v: unknown) => (typeof v === 'string' && v !== '0' ? formatVnNumber(v) : ''); // số 0 để trống như sổ giấy
const foreign = (v: unknown) => (typeof v === 'string' && !D(v).isZero() ? formatVnNumber(v, D(v).decimalPlaces()) : '');
const num = <T,>(headerName: string, get: (r: T) => unknown, format: (v: unknown) => string = money, width = 125): ColDef<T> => ({ headerName, width, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => (p.data ? get(p.data) : ''), valueFormatter: (p) => format(p.value) });
const date = <T,>(headerName: string, field: string): ColDef<T> => ({ field, headerName, width: 115, valueFormatter: (p: { value?: unknown }) => (p.value ? formatVnDate(p.value as string) : '') }) as unknown as ColDef<T>;
const text = <T,>(headerName: string, field: string, width?: number): ColDef<T> => (width ? { field, headerName, width } : { field, headerName, flex: 1, minWidth: 180 }) as unknown as ColDef<T>;
const readOnly = <T,>(cols: ColDef<T>[]): ColDef<T>[] => cols.map((c) => ({ ...c, editable: false }));
const openVoucher = (r: DetailRow) => { window.open(`/chung-tu/${r.voucherType}/${r.voucherId}`, '_blank', 'noopener'); };
// Số dư có dấu (Nợ dương, Có âm) tách hai cột Dư Nợ / Dư Có như sổ giấy.
const side = (net: string, debit: boolean) => (debit ? (D(net).gt(0) ? net : '0') : D(net).lt(0) ? D(net).neg().toFixed(0) : '0');

const dn = num<DetailRow>; const sn = num<SummaryRow>; const itn = num<AgingItem>;
const detailColumns = (fx: boolean): ColDef<DetailRow>[] => readOnly<DetailRow>([
  date('Ngày ghi sổ', 'date'), { field: 'voucherNo', headerName: 'Số chứng từ', width: 130 }, text('Diễn giải', 'description'), { field: 'counterAccounts', headerName: 'TK đối ứng', width: 120 },
  dn('Phát sinh Nợ', (r) => r.debit), dn('Phát sinh Có', (r) => r.credit), dn('Dư Nợ', (r) => side(r.balance, true)), dn('Dư Có', (r) => side(r.balance, false)),
  ...(fx ? [dn('Nợ (nguyên tệ)', (r) => r.debitCurrency, foreign, 150), dn('Có (nguyên tệ)', (r) => r.creditCurrency, foreign, 150), dn('Dư (nguyên tệ)', (r) => r.balanceCurrency, foreign, 150)] : []),
]).map((c) => ({ ...c, onCellDoubleClicked: (e) => { if (e.data) openVoucher(e.data); },
  suppressKeyboardEvent: (p) => { if (p.event.type === 'keydown' && p.event.key === 'Enter' && p.data) { p.event.preventDefault(); openVoucher(p.data); return true; } return false; } }));
const summaryColumns: ColDef<SummaryRow>[] = readOnly<SummaryRow>([{ field: 'partyCode', headerName: 'Mã đối tượng', width: 130 }, text('Tên đối tượng', 'partyName'),
  sn('Dư đầu kỳ Nợ', (r) => r.openingDebit), sn('Dư đầu kỳ Có', (r) => r.openingCredit), sn('Phát sinh Nợ', (r) => r.periodDebit), sn('Phát sinh Có', (r) => r.periodCredit),
  sn('Dư cuối kỳ Nợ', (r) => r.closingDebit), sn('Dư cuối kỳ Có', (r) => r.closingCredit)]);
const itemColumns: ColDef<AgingItem>[] = readOnly<AgingItem>([{ field: 'docNo', headerName: 'Số chứng từ', width: 140 }, date('Ngày chứng từ', 'docDate'), date('Hạn thanh toán', 'dueDate'), itn('Còn nợ', (r) => r.residual),
  itn('Số ngày quá hạn', (r) => (r.daysOverdue !== null && r.daysOverdue > 0 ? String(r.daysOverdue) : ''), (v) => String(v ?? ''), 140)]);

export default function ArapReportsPage() {
  const { me, can } = useAuth();
  const { token } = theme.useToken();
  const [tab, setTab] = useState<TabKey>('detail');
  const [f, setF] = useRememberedFilter('arap-reports', { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), asOf: todayVn(),
    accountCode: '131', partyCode: '', currency: '', by: 'due', buckets: '30,60,90,180' }, `${me?.tenantId}:${me?.userId}`);
  const [bucketsDraft, setBucketsDraft] = useState<string | null>(null); // gõ xong (Enter hoặc rời ô) mới tính lại
  const receivable = f.accountCode === '131';

  const range = new URLSearchParams({ accountCode: f.accountCode, from: f.from, to: f.to });
  const party = f.partyCode ? { partyCode: f.partyCode } : {};
  const query = (extra: Record<string, string>) => new URLSearchParams({ ...Object.fromEntries(range), ...extra }).toString();
  const urls: Record<TabKey, string | null> = {
    detail: f.partyCode ? `/api/reports/arap/detail?${query({ ...party, ...(f.currency ? { currency: f.currency } : {}) })}` : null,
    statement: f.partyCode ? `/api/reports/arap/detail?${query(party)}` : null,
    summary: `/api/reports/arap/summary?${query({})}`,
    aging: `/api/reports/arap/aging?${new URLSearchParams({ accountCode: f.accountCode, asOf: f.asOf, by: f.by, buckets: f.buckets, ...party }).toString()}`,
  };
  const url = urls[tab];
  const data = useQuery({ queryKey: ['arap-report', url], queryFn: () => api<Detail | Summary | Aging>(url!), enabled: !!url, retry: false });
  const printUrl = (kind: 'statement' | 'reminder') => `/api/reports/arap/${kind}?${kind === 'statement' ? query(party) : new URLSearchParams({ accountCode: f.accountCode, asOf: f.asOf, ...party }).toString()}`;
  const open = (u: string) => { window.open(u, '_blank'); };
  const printAs = (format: 'pdf' | 'xlsx') => { if (url && tab !== 'statement') open(`${url}&format=${format}`); };

  const agingColumns = useMemo<ColDef<Row>[]>(() => {
    const d = data.data as Aging | undefined;
    return d && 'columns' in d ? readOnly<Row>([{ field: 'partyCode', headerName: 'Mã đối tượng', width: 130 }, text('Tên đối tượng', 'partyName'), ...d.columns.map((c) => num<Row>(c.label, (r) => r[c.key]))]) : [];
  }, [data.data]);

  const stat = (label: string, value: string, cur?: string | null, red = false) => (
    <span key={label}>{label}: <b style={red && D(value).lt(0) ? { color: token.colorError } : undefined}>{formatVnNumber(value)}</b>{cur ? <> (<b>{formatVnNumber(cur, D(cur).decimalPlaces())}</b>)</> : null}</span>);
  const verdict = (net: string) => {
    const x = D(net);
    if (x.isZero()) return 'Hai bên không còn công nợ.';
    // Sổ của công ty: dư Nợ là đối tượng còn nợ công ty (cả TK 131 lẫn TK 331 trả trước), dư Có là công ty còn nợ đối tượng.
    return `${x.gt(0) ? 'Đối tượng còn nợ công ty' : 'Công ty còn nợ đối tượng'} ${formatVnNumber(x.abs().toFixed(0))} đồng.`;
  };

  const body = () => {
    if (!url) return <Alert type="info" showIcon message="Chọn đối tượng (F4) để xem" />;
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} />;
    const d = data.data;
    if (!d) return <Alert type="info" message="Đang tải…" />;
    if (tab === 'summary') {
      const s = d as Summary; const t = s.totals;
      return (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space size="large" wrap>{stat('Dư đầu kỳ Nợ', t.openingDebit)}{stat('Dư đầu kỳ Có', t.openingCredit)}{stat('Phát sinh Nợ', t.periodDebit)}{stat('Phát sinh Có', t.periodCredit)}{stat('Dư cuối kỳ Nợ', t.closingDebit)}{stat('Dư cuối kỳ Có', t.closingCredit)}</Space>
          {s.matches ? <span>Khớp số dư tài khoản {f.accountCode} tại ngày {formatVnDate(f.to)}: <b>{formatVnNumber(s.accountNet)}</b></span>
            : <Alert type="warning" showIcon message={`Tổng dư cuối kỳ các đối tượng (${formatVnNumber(s.closingNet)}) lệch số dư tài khoản ${f.accountCode} (${formatVnNumber(s.accountNet)})`} />}
          <KeyboardGrid<SummaryRow> rows={s.rows} columns={summaryColumns} onRowsChange={() => undefined} addRowTemplate={() => ({} as SummaryRow)} readOnly height="calc(100vh - 340px)" />
        </Space>);
    }
    if (tab === 'aging') {
      const a = d as Aging;
      return (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space size="large" wrap>{a.columns.map((c) => stat(c.label, a.totals[c.key] ?? '0', undefined, c.key === 'credit'))}</Space>
          <KeyboardGrid<Row> rows={a.rows} columns={agingColumns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly height={a.items ? 220 : 'calc(100vh - 340px)'} />
          {a.items && <><b>Các khoản còn nợ của đối tượng {f.partyCode}</b>
            <KeyboardGrid<AgingItem> rows={a.items} columns={itemColumns} onRowsChange={() => undefined} addRowTemplate={() => ({} as AgingItem)} readOnly height="calc(100vh - 640px)" /></>}
        </Space>);
    }
    const x = d as Detail; const fx = !!x.currency && x.currency !== 'VND';
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space size="large" wrap>
          {stat('Dư đầu kỳ', x.opening, fx ? x.openingCurrency : null, true)}{stat('Phát sinh Nợ', x.totalDebit)}{stat('Phát sinh Có', x.totalCredit)}{stat('Dư cuối kỳ', x.closing, fx ? x.closingCurrency : null, true)}
        </Space>
        {tab === 'statement' && <Alert type="info" showIcon message={`Biên bản đối chiếu với ${x.partyName}: số dư tại ngày ${formatVnDate(f.to)}. ${verdict(x.closing)}`} />}
        <KeyboardGrid<DetailRow> rows={x.rows} columns={detailColumns(fx)} onRowsChange={() => undefined} addRowTemplate={() => ({} as DetailRow)} readOnly height="calc(100vh - 360px)" />
      </Space>);
  };

  const commitBuckets = () => { if (bucketsDraft !== null) { setF({ ...f, buckets: bucketsDraft.replace(/\s/g, '') }); setBucketsDraft(null); } };
  const rangePicker = <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />;
  const partyPicker = (placeholder: string) => <LookupSelect catalog="party" includeInactive aria-label={placeholder} placeholder={placeholder} style={{ width: 240 }} value={f.partyCode || null} onChange={(code) => setF({ ...f, partyCode: code ?? '' })} />;
  const canPrint = can('report.print');

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Báo cáo công nợ</h2>
        <Segmented aria-label="Loại công nợ" value={f.accountCode} onChange={(v) => setF({ ...f, accountCode: String(v) })} options={[{ value: '131', label: 'Phải thu (131)' }, { value: '331', label: 'Phải trả (331)' }]} />
        {tab === 'aging' ? <>
          <DatePicker format="DD/MM/YYYY" allowClear={false} aria-label="Tính đến ngày" value={dayjs(f.asOf)} onChange={(d) => d && setF({ ...f, asOf: d.format('YYYY-MM-DD') })} />
          <Select aria-label="Tính tuổi nợ theo" style={{ width: 170 }} value={f.by} onChange={(by) => setF({ ...f, by })} options={[{ value: 'due', label: 'Theo hạn thanh toán' }, { value: 'doc', label: 'Theo ngày chứng từ' }]} />
          <Input aria-label="Mốc tuổi nợ (ngày)" prefix="Mốc (ngày)" style={{ width: 210 }} value={bucketsDraft ?? f.buckets} onChange={(e) => setBucketsDraft(e.target.value)} onBlur={commitBuckets} onPressEnter={commitBuckets} />
          {partyPicker('Đối tượng (không bắt buộc)')}
        </> : <>
          {rangePicker}
          {tab !== 'summary' && partyPicker('Đối tượng (F4)')}
          {tab === 'detail' && <LookupSelect catalog="currency" aria-label="Loại tiền" placeholder="Loại tiền" style={{ width: 140 }} value={f.currency || null} onChange={(currency) => setF({ ...f, currency: currency ?? '' })} />}
        </>}
        {canPrint && <>
          <Button disabled={!url || tab === 'statement'} onClick={() => printAs('pdf')}>In PDF</Button>
          <Button disabled={!url || tab === 'statement'} onClick={() => printAs('xlsx')}>Xuất Excel</Button>
          <Button type="primary" disabled={!f.partyCode} onClick={() => open(printUrl('statement'))}>In biên bản</Button>
          {receivable && <Button disabled={!f.partyCode} onClick={() => open(printUrl('reminder'))}>Thư nhắc nợ</Button>}</>}
      </Space>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={[{ key: 'detail', label: 'Sổ chi tiết' }, { key: 'summary', label: 'Tổng hợp' }, { key: 'aging', label: 'Tuổi nợ' }, { key: 'statement', label: 'Đối chiếu' }]} />
      {body()}
    </Space>
  );
}
