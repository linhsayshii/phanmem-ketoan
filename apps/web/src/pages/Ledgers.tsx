import { useMemo, useState } from 'react';
import { Alert, DatePicker, Radio, Space, Switch, Table, Tabs } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';

interface Side { debit: string; credit: string }
interface JournalRow { postingDate: string; voucherId: string; voucherNo: string; voucherType: string; documentDate: string; description: string | null; accountCode: string; accountName: string; debit: string; credit: string }
interface LedgerRow { postingDate: string; voucherId: string; voucherNo: string; description: string | null; counterAccountCode: string; debit: string; credit: string; running: Side;
  partyCode: string | null; partyName: string | null; costItemCode: string | null; projectCode: string | null; departmentCode: string | null }
interface SubRow { accountCode: string; accountName: string; opening: Side; period: Side; closing: Side }
interface TrialRow extends SubRow { level: number; isGroup: boolean }
interface Totals { opening: Side; totalDebit: string; totalCredit: string; closing: Side }
type TabKey = 'journal' | 'ledger' | 'detail' | 'trial';
type Mode = 'voucher' | 'subaccount' | 't';

const money = (v: unknown) => (typeof v === 'string' && v !== '0' ? formatVnNumber(v) : ''); // số 0 để trống như sổ giấy
const num = <T,>(headerName: string, get: (r: T) => string, width = 120): ColDef<T> => ({ headerName, width, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => (p.data ? get(p.data) : ''), valueFormatter: (p) => money(p.value) });
const text = <T,>(headerName: string, field: string, width?: number): ColDef<T> => (width ? { field, headerName, width } : { field, headerName, flex: 1, minWidth: 160 }) as ColDef;
const date = <T,>(headerName: string, field: string): ColDef<T> => ({ field, headerName, width: 115, valueFormatter: (p) => formatVnDate(p.value as string) }) as ColDef;
// Nhấn đúp hoặc Enter trên dòng = truy ngược (mở chứng từ hoặc sổ của tài khoản); lưới chỉ đọc.
const drillable = <T,>(cols: ColDef<T>[], open: (r: T) => void): ColDef<T>[] => cols.map((c) => ({ ...c, editable: false,
  suppressKeyboardEvent: (p) => { if (p.event.type === 'keydown' && p.event.key === 'Enter' && p.data) { p.event.preventDefault(); open(p.data); return true; } return false; },
  onCellDoubleClicked: (e) => { if (e.data) open(e.data); } }));
const openVoucher = (id: string) => { window.open(`/chung-tu/phieu-ke-toan/${id}`, '_blank', 'noopener'); };
const sideCols = <T,>(title: string, get: (r: T) => Side, width = 120): ColDef<T>[] => [num<T>(`${title} Nợ`, (r) => get(r).debit, width), num<T>(`${title} Có`, (r) => get(r).credit, width)];

function Summary({ items }: { items: [string, Side][] }) {
  return <Space size="large" wrap>{items.map(([label, s]) => <span key={label}>{label}: Nợ <b>{formatVnNumber(s.debit)}</b> / Có <b>{formatVnNumber(s.credit)}</b></span>)}</Space>;
}
const Grid = <T extends object>({ rows, columns }: { rows: T[]; columns: ColDef<T>[] }) =>
  <KeyboardGrid<T> rows={rows} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({} as T)} readOnly height="calc(100vh - 330px)" />;

export default function LedgersPage() {
  const { me } = useAuth();
  const [tab, setTab] = useState<TabKey>('journal');
  const [f, setF] = useRememberedFilter('ledgers', { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), accountCode: '', mode: 'voucher' as Mode, level: 0,
    splitParty: true, partyCode: '', costItemCode: '', projectCode: '', departmentCode: '' }, `${me?.tenantId}:${me?.userId}`);
  const accountFetcher = useMemo(() => accountFetcherFor(f.from, true), [f.from]); // gồm tài khoản tổng hợp: sổ Cái của cả nhóm
  const drillToAccount = (accountCode: string, mode: Mode = 'voucher') => { setF({ ...f, accountCode, mode }); setTab('ledger'); };

  const range = { from: f.from, to: f.to };
  const query = (o: Record<string, string>) => new URLSearchParams({ ...range, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v)) }).toString();
  const url = { journal: `/api/reports/ledgers/general-journal?${query({})}`,
    ledger: `/api/reports/ledgers/account?${query({ accountCode: f.accountCode, mode: f.mode })}`,
    detail: `/api/reports/ledgers/detail?${query({ accountCode: f.accountCode, partyCode: f.partyCode, costItemCode: f.costItemCode, projectCode: f.projectCode, departmentCode: f.departmentCode })}`,
    trial: `/api/reports/ledgers/trial-balance?${query({ level: f.level ? String(f.level) : '', splitParty: String(f.splitParty) })}` }[tab];
  const needAccount = (tab === 'ledger' || tab === 'detail') && !f.accountCode;
  const data = useQuery({ queryKey: ['ledgers', url], queryFn: () => api<Record<string, unknown>>(url), enabled: !needAccount, retry: false });

  const columns = useMemo(() => {
    const journal = drillable<JournalRow>([date('Ngày', 'postingDate'), { field: 'voucherNo', headerName: 'Số chứng từ', width: 130 }, date('Ngày CT', 'documentDate'), text('Diễn giải', 'description'),
      { field: 'accountCode', headerName: 'Tài khoản', width: 100 }, text('Tên tài khoản', 'accountName', 200), num('Số phát sinh Nợ', (r) => r.debit, 140), num('Số phát sinh Có', (r) => r.credit, 140)], (r) => openVoucher(r.voucherId));
    const voucherCols = [date<LedgerRow>('Ngày', 'postingDate'), { field: 'voucherNo', headerName: 'Số chứng từ', width: 130 } as ColDef<LedgerRow>, text<LedgerRow>('Diễn giải', 'description'),
      { field: 'counterAccountCode', headerName: 'TK đối ứng', width: 115 } as ColDef<LedgerRow>, num<LedgerRow>('Phát sinh Nợ', (r) => r.debit), num<LedgerRow>('Phát sinh Có', (r) => r.credit),
      ...sideCols<LedgerRow>('Dư', (r) => r.running)];
    const ledger = drillable(voucherCols, (r) => openVoucher(r.voucherId));
    const detail = drillable<LedgerRow>([...voucherCols.slice(0, 3), text<LedgerRow>('Đối tượng', 'partyName', 160), text<LedgerRow>('Khoản mục', 'costItemCode', 100), text<LedgerRow>('Vụ việc', 'projectCode', 100),
      text<LedgerRow>('Bộ phận', 'departmentCode', 100), ...voucherCols.slice(3)], (r) => openVoucher(r.voucherId));
    const balanceCols = <T extends SubRow>(): ColDef<T>[] => [{ field: 'accountCode', headerName: 'Tài khoản', width: 100, cellStyle: (p) => ((p.data as Partial<TrialRow> | undefined)?.isGroup ? { fontWeight: 600 } : null) } as ColDef<T>,
      text<T>('Tên tài khoản', 'accountName'), ...sideCols<T>('Dư đầu', (r) => r.opening), ...sideCols<T>('Phát sinh', (r) => r.period), ...sideCols<T>('Dư cuối', (r) => r.closing)];
    return { journal, ledger, detail, sub: drillable(balanceCols<SubRow>(), (r) => drillToAccount(r.accountCode)), trial: drillable(balanceCols<TrialRow>(), (r) => drillToAccount(r.accountCode)) };
    // drillToAccount đọc bộ lọc hiện tại: dựng lại cột khi bộ lọc đổi
  }, [f, me]);

  const d = data.data;
  const body = () => {
    if (needAccount) return <Alert type="info" showIcon message="Chọn tài khoản để xem sổ" />;
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} />;
    if (!d) return null;
    if (tab === 'journal') return <Space direction="vertical" style={{ width: '100%' }}><Summary items={[['Tổng phát sinh', { debit: d['totalDebit'] as string, credit: d['totalCredit'] as string }]]} />
      <Grid<JournalRow> rows={d['rows'] as JournalRow[]} columns={columns.journal} /></Space>;
    if (tab === 'trial') {
      const t = d['totals'] as { opening: Side; period: Side; closing: Side };
      return <Space direction="vertical" style={{ width: '100%' }}><Summary items={[['Tổng dư đầu', t.opening], ['Tổng phát sinh', t.period], ['Tổng dư cuối', t.closing]]} />
        <Grid<TrialRow> rows={d['rows'] as TrialRow[]} columns={columns.trial} /></Space>;
    }
    const t = d as unknown as Totals;
    const sums = <Summary items={[['Dư đầu', t.opening], ['Phát sinh', { debit: t.totalDebit, credit: t.totalCredit }], ['Dư cuối', t.closing]]} />;
    if (tab === 'ledger' && f.mode === 'subaccount') return <Space direction="vertical" style={{ width: '100%' }}>{sums}<Grid<SubRow> rows={d['rows'] as SubRow[]} columns={columns.sub} /></Space>;
    if (tab === 'ledger' && f.mode === 't') {
      const pane = (title: string, rows: { counterAccountCode: string; amount: string }[], total: string) => (
        <Table size="small" bordered pagination={false} rowKey="counterAccountCode" dataSource={rows} style={{ width: 360 }} title={() => <b>{title}</b>}
          columns={[{ title: 'TK đối ứng', dataIndex: 'counterAccountCode' }, { title: 'Số tiền', dataIndex: 'amount', align: 'right', render: money }]}
          summary={() => <Table.Summary.Row><Table.Summary.Cell index={0}>Cộng</Table.Summary.Cell><Table.Summary.Cell index={1} align="right"><b>{formatVnNumber(total)}</b></Table.Summary.Cell></Table.Summary.Row>} />);
      return <Space direction="vertical" style={{ width: '100%' }}>{sums}<Space align="start" size="large">{pane('Bên Nợ', d['debitSide'] as never, t.totalDebit)}{pane('Bên Có', d['creditSide'] as never, t.totalCredit)}</Space></Space>;
    }
    return <Space direction="vertical" style={{ width: '100%' }}>{sums}<Grid<LedgerRow> rows={d['rows'] as LedgerRow[]} columns={tab === 'detail' ? columns.detail : columns.ledger} /></Space>;
  };

  const lookup = (catalog: string, field: 'partyCode' | 'costItemCode' | 'projectCode' | 'departmentCode', placeholder: string) =>
    <LookupSelect catalog={catalog} placeholder={placeholder} style={{ width: 200 }} value={f[field] || null} onChange={(code) => setF({ ...f, [field]: code ?? '' })} />;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Sổ sách kế toán</h2>
        <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />
        {(tab === 'ledger' || tab === 'detail') && <LookupSelect catalog="account" fetcher={accountFetcher} placeholder="Tài khoản" style={{ width: 300 }} value={f.accountCode || null} onChange={(accountCode) => setF({ ...f, accountCode: accountCode ?? '' })} />}
        {tab === 'ledger' && <Radio.Group optionType="button" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as Mode })}
          options={[{ value: 'voucher', label: 'Theo chứng từ' }, { value: 'subaccount', label: 'Theo tiểu khoản' }, { value: 't', label: 'Chữ T' }]} />}
        {tab === 'trial' && <>
          <Radio.Group optionType="button" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as number })} options={[{ value: 1, label: 'Cấp 1' }, { value: 2, label: 'Cấp 2' }, { value: 3, label: 'Cấp 3' }, { value: 0, label: 'Tất cả' }]} />
          <span><Switch checked={f.splitParty} onChange={(splitParty) => setF({ ...f, splitParty })} /> Tách dư hai bên theo đối tượng</span></>}
      </Space>
      {tab === 'detail' && <Space wrap>{lookup('party', 'partyCode', 'Đối tượng')}{lookup('cost_item', 'costItemCode', 'Khoản mục')}{lookup('project', 'projectCode', 'Vụ việc')}{lookup('department', 'departmentCode', 'Bộ phận')}</Space>}
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={[{ key: 'journal', label: 'Nhật ký chung' }, { key: 'ledger', label: 'Sổ Cái' }, { key: 'detail', label: 'Sổ chi tiết' }, { key: 'trial', label: 'Bảng cân đối số phát sinh' }]} />
      {data.isFetching && !d ? <Alert type="info" message="Đang tải…" /> : body()}
    </Space>
  );
}
