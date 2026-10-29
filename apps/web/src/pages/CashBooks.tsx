import { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Space, Switch, Tabs, theme } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, useRememberedFilter, type LookupRow } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor, bankAccountFetcher } from '../lookups.js';

interface BookRow { date: string; documentDate: string; voucherId: string; voucherType: string; voucherNo: string | null; receiptNo: string | null; paymentNo: string | null; description: string | null; counterAccounts: string;
  in: string; out: string; balance: string; inCurrency: string | null; outCurrency: string | null; balanceCurrency: string | null }
interface Book { currency: string | null; opening: string; openingCurrency: string | null; totalIn: string; totalOut: string; totalInCurrency: string | null; totalOutCurrency: string | null;
  closing: string; closingCurrency: string | null; rows: BookRow[] }
type TabKey = 'cash' | 'bank';

const UNASSIGNED_ACCOUNT = '112'; // khoản tiền gửi chưa gán tài khoản ngân hàng nào
const money = (v: string | null) => (v && v !== '0' ? formatVnNumber(v) : ''); // số 0 để trống như sổ giấy
const foreign = (v: string | null) => (v && !D(v).isZero() ? formatVnNumber(v, D(v).decimalPlaces()) : '');
const num = (headerName: string, get: (r: BookRow) => string | null, format = money, width = 130): ColDef<BookRow> => ({ headerName, width, cellClass: 'ag-right-aligned-cell', valueGetter: (p) => (p.data ? get(p.data) : ''), valueFormatter: (p) => format(p.value as string | null) });
const text = (headerName: string, field: keyof BookRow, width?: number): ColDef<BookRow> => (width ? { field, headerName, width } : { field, headerName, flex: 1, minWidth: 180 });
const date = (headerName: string, field: 'date' | 'documentDate'): ColDef<BookRow> => ({ field, headerName, width: 115, valueFormatter: (p) => formatVnDate(p.value as string) });
const openVoucher = (r: BookRow) => { window.open(`/chung-tu/${r.voucherType}/${r.voucherId}`, '_blank', 'noopener'); };
// Nhấn đúp hoặc Enter trên dòng mở chứng từ; lưới chỉ đọc.
const drillable = (cols: ColDef<BookRow>[]): ColDef<BookRow>[] => cols.map((c) => ({ ...c, editable: false,
  suppressKeyboardEvent: (p) => { if (p.event.type === 'keydown' && p.event.key === 'Enter' && p.data) { p.event.preventDefault(); openVoucher(p.data); return true; } return false; },
  onCellDoubleClicked: (e) => { if (e.data) openVoucher(e.data); } }));

const columnsFor = (tab: TabKey, fx: boolean): ColDef<BookRow>[] => {
  const side = tab === 'cash' ? ['Thu', 'Chi', 'Tồn'] : ['Gửi vào', 'Rút ra', 'Còn lại'];
  return drillable([
    date('Ngày ghi sổ', 'date'), date('Ngày CT', 'documentDate'),
    ...(tab === 'cash' ? [{ field: 'receiptNo', headerName: 'Số phiếu thu', width: 120 } as ColDef<BookRow>, { field: 'paymentNo', headerName: 'Số phiếu chi', width: 120 } as ColDef<BookRow>]
      : [{ field: 'voucherNo', headerName: 'Số chứng từ', width: 130 } as ColDef<BookRow>]),
    text('Diễn giải', 'description'), { field: 'counterAccounts', headerName: 'TK đối ứng', width: 120 },
    num(side[0]!, (r) => r.in), num(side[1]!, (r) => r.out), num(side[2]!, (r) => r.balance),
    ...(fx ? [num(`${side[0]} (nguyên tệ)`, (r) => r.inCurrency, foreign, 150), num(`${side[1]} (nguyên tệ)`, (r) => r.outCurrency, foreign, 150), num(`${side[2]} (nguyên tệ)`, (r) => r.balanceCurrency, foreign, 150)] : []),
  ]);
};

// Tài khoản quỹ chỉ thuộc nhóm 111 (tiền mặt).
const cashAccountFetcher = (date: string) => {
  const base = accountFetcherFor(date, true, true);
  return async (q: string): Promise<LookupRow[]> => (await base(q || '111')).filter((r) => r.code.startsWith('111'));
};

export default function CashBooksPage() {
  const { me, can } = useAuth();
  const { token } = theme.useToken();
  const [tab, setTab] = useState<TabKey>('cash');
  const [f, setF] = useRememberedFilter('cash-books', { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), accountCode: '111', currency: '', bankAccountNo: '', unassigned: false }, `${me?.tenantId}:${me?.userId}`);
  const accountFetcher = useMemo(() => cashAccountFetcher(f.from), [f.from]);

  const q = new URLSearchParams({ from: f.from, to: f.to });
  if (tab === 'cash') { q.set('accountCode', f.accountCode); if (f.currency) q.set('currency', f.currency); }
  else if (f.unassigned) q.set('accountCode', UNASSIGNED_ACCOUNT);
  else if (f.bankAccountNo) q.set('bankAccountNo', f.bankAccountNo);
  const url = `/api/reports/${tab === 'cash' ? 'cash-book' : 'bank-book'}?${q.toString()}`;
  const needChoice = tab === 'cash' ? !f.accountCode : !f.unassigned && !f.bankAccountNo;
  const data = useQuery({ queryKey: ['cash-book', url], queryFn: () => api<Book>(url), enabled: !needChoice, retry: false });
  const printAs = (format: 'pdf' | 'xlsx') => { window.open(`${url}&format=${format}`, '_blank'); }; // cùng bộ lọc với màn hình

  const d = data.data;
  const fx = !!d?.currency && d.currency !== 'VND';
  const columns = useMemo(() => columnsFor(tab, fx), [tab, fx]);
  const stat = (label: string, vnd: string, cur: string | null, negativeRed = false) => (
    <span key={label}>{label}: <b style={negativeRed && D(vnd).lt(0) ? { color: token.colorError } : undefined}>{formatVnNumber(vnd)}</b>
      {fx && cur !== null && <> (<b>{formatVnNumber(cur, D(cur).decimalPlaces())}</b> {d?.currency})</>}</span>);

  const body = () => {
    if (needChoice) return <Alert type="info" showIcon message={tab === 'cash' ? 'Chọn tài khoản quỹ để xem sổ' : 'Chọn tài khoản ngân hàng để xem sổ'} />;
    if (data.error) return <Alert type="error" showIcon message={(data.error as Error).message} />;
    if (!d) return <Alert type="info" message="Đang tải…" />;
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space size="large" wrap>
          {stat('Tồn đầu kỳ', d.opening, d.openingCurrency)}{stat(tab === 'cash' ? 'Thu' : 'Gửi vào', d.totalIn, d.totalInCurrency)}
          {stat(tab === 'cash' ? 'Chi' : 'Rút ra', d.totalOut, d.totalOutCurrency)}{stat('Tồn cuối kỳ', d.closing, d.closingCurrency, true)}
        </Space>
        <KeyboardGrid<BookRow> rows={d.rows} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({} as BookRow)} readOnly height="calc(100vh - 330px)" />
      </Space>
    );
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <PageHeader title="Sổ quỹ và tiền gửi" extra={can('report.print') && <>
        <Button disabled={needChoice} onClick={() => printAs('pdf')}>In PDF</Button>
        <Button disabled={needChoice} onClick={() => printAs('xlsx')}>Xuất Excel</Button></>}>
        <Toolbar>
          <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />
          {tab === 'cash' ? <>
            <LookupSelect catalog="account" fetcher={accountFetcher} placeholder="Tài khoản quỹ" style={{ width: 280 }} value={f.accountCode || null} onChange={(accountCode) => setF({ ...f, accountCode: accountCode ?? '' })} />
            <LookupSelect catalog="currency" placeholder="Loại tiền" style={{ width: 160 }} value={f.currency || null} onChange={(currency) => setF({ ...f, currency: currency ?? '' })} />
          </> : <>
            <LookupSelect catalog="bank_account" fetcher={bankAccountFetcher} placeholder="Tài khoản ngân hàng" style={{ width: 300 }} disabled={f.unassigned} value={f.bankAccountNo || null} onChange={(bankAccountNo) => setF({ ...f, bankAccountNo: bankAccountNo ?? '' })} />
            <span><Switch aria-label="Chưa gán tài khoản ngân hàng (TK 112)" checked={f.unassigned} onChange={(unassigned) => setF({ ...f, unassigned })} /> Chưa gán tài khoản ngân hàng (TK 112)</span>
          </>}
        </Toolbar>
      </PageHeader>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={[{ key: 'cash', label: 'Sổ quỹ' }, { key: 'bank', label: 'Sổ tiền gửi' }]} />
      {body()}
    </Space>
  );
}
