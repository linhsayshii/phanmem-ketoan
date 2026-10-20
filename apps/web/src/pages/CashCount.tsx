import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Input, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, parseVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, type LookupRow } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';

interface Row { value: string; qty: number }
interface Member { name: string; role?: string }
interface Count { id: number; countDate: string; accountCode: string; accountName: string; currency: string; bookBalance: string; bookBalanceCurrency: string | null; denominations: Row[];
  countedTotal: string; difference: string; members: Member[]; note: string | null; voucherId: string | null; voucherNo: string | null; voucherState: string | null; createdAt: string }
interface Balance { balance: string; balanceCurrency: string }

const VND_DENOMINATIONS = ['500000', '200000', '100000', '50000', '20000', '10000', '5000', '2000', '1000'];
const blank = (): Row => ({ value: '', qty: 0 });
const defaultRows = (currency: string): Row[] => (currency === 'VND' ? VND_DENOMINATIONS.map((value) => ({ value, qty: 0 })) : [blank()]);
const scaleOf = (currency: string) => (currency === 'VND' ? 0 : 4);
// Số tiền ngoại tệ bỏ số 0 thừa ở cuối khi hiển thị (100 chứ không phải 100,0000).
const show = (v: string, currency: string) => formatVnNumber(v, currency === 'VND' ? 0 : D(v).decimalPlaces());
const amountOf = (r: Row) => (/^\d+(\.\d+)?$/.test(r.value) ? D(r.value).times(r.qty) : D(0));
const settled = (c: Count) => !!c.voucherId && c.voucherState !== 'cancelled';
const membersText = (ms: Member[]) => ms.map((m) => (m.role ? `${m.name}, ${m.role}` : m.name)).join('\n');
// Mỗi dòng một người: "Họ tên, chức danh".
const parseMembers = (t: string): Member[] => t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const i = l.indexOf(','); const role = i < 0 ? '' : l.slice(i + 1).trim();
  return { name: (i < 0 ? l : l.slice(0, i)).trim(), ...(role ? { role } : {}) };
});

// Tài khoản quỹ tiền mặt chi tiết (nhóm 111): TT99 là 111, TT133/TT200 là 1111, 1112...
const cashAccountFetcher = (date: string) => {
  const base = accountFetcherFor(date);
  return async (q: string): Promise<LookupRow[]> => (await base(q)).filter((r) => r.code.startsWith('111'));
};

const columnsFor = (currency: string): ColDef<Row>[] => {
  const scale = scaleOf(currency);
  return [
    { colId: 'value', field: 'value', headerName: 'Mệnh giá', width: 160, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
      valueFormatter: (p) => (p.value ? formatVnNumber(p.value as string, currency === 'VND' ? 0 : D(p.value as string).decimalPlaces()) : ''),
      valueParser: (p) => { const s = parseVnNumber(String(p.newValue ?? '')); return s === null ? p.oldValue : D(s).toDecimalPlaces(scale).toFixed(); } },
    { colId: 'qty', field: 'qty', headerName: 'Số lượng (tờ)', width: 140, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
      valueFormatter: (p) => (p.value ? formatVnNumber(String(p.value)) : ''),
      valueParser: (p) => { const s = parseVnNumber(String(p.newValue ?? '')); const n = s === null ? NaN : Number(s); return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : p.oldValue; } },
    { colId: 'amount', headerName: 'Thành tiền', flex: 1, minWidth: 150, editable: false, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header',
      valueGetter: (p) => (p.data ? amountOf(p.data).toFixed() : ''), valueFormatter: (p) => (p.value && p.value !== '0' ? show(p.value as string, currency) : '') },
  ];
};

export default function CashCountPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [accountCode, setAccountCode] = useState('');
  const [currency, setCurrency] = useState('VND');
  const [rows, setRows] = useState<Row[]>(defaultRows('VND'));
  const [membersTxt, setMembersTxt] = useState('');
  const [note, setNote] = useState('');
  const [current, setCurrent] = useState<Count | null>(null); // kiểm kê đã lưu đang xem; null là đang lập kiểm kê mới
  const [settleOpen, setSettleOpen] = useState(false);
  const [counter, setCounter] = useState<string | null>(null);
  const [fxRate, setFxRate] = useState<string | null>(null);
  const [settleErr, setSettleErr] = useState('');

  const accountFetcher = useMemo(() => cashAccountFetcher(date), [date]);
  const counterFetcher = useMemo(() => accountFetcherFor(current?.countDate ?? date), [current, date]);
  const cur = current?.currency ?? currency;

  const balance = useQuery({ queryKey: ['cash-balance', accountCode, date, currency], enabled: !current && !!accountCode, retry: false,
    queryFn: () => api<Balance>(`/api/cash/balance?${new URLSearchParams({ accountCode, asOf: date, currency })}`) });
  const list = useQuery({ queryKey: ['cash-counts'], queryFn: () => api<Count[]>('/api/cash-counts'), retry: false });

  const counted = current ? current.countedTotal : rows.reduce((t, r) => t.plus(amountOf(r)), D(0)).toFixed();
  const book = current ? (current.currency === 'VND' ? current.bookBalance : current.bookBalanceCurrency ?? '0') : balance.data ? (currency === 'VND' ? balance.data.balance : balance.data.balanceCurrency) : null;
  const diff = current ? current.difference : book === null ? null : D(counted).minus(book).toFixed();
  const sign = diff === null ? 0 : D(diff).comparedTo(0);

  const buildPayload = () => ({ countDate: date, accountCode, currency, note: note.trim() || undefined, members: parseMembers(membersTxt),
    denominations: rows.filter((r) => /^\d+(\.\d+)?$/.test(r.value) && D(r.value).gt(0) && r.qty > 0) });
  const save = useMutation({
    mutationFn: () => api<Count>('/api/cash-counts', { method: 'POST', json: buildPayload() }),
    onSuccess: (c) => { setCurrent(c); void qc.invalidateQueries({ queryKey: ['cash-counts'] }); void message.success(`Đã lưu kiểm kê quỹ số ${c.id}`); },
    onError: (e: Error) => { void message.error(e.message); },
  });
  const settle = useMutation({
    mutationFn: (id: number) => api<Count>(`/api/cash-counts/${id}/settle`, { method: 'POST', json: { ...(counter ? { accountCode: counter } : {}), ...(fxRate ? { fxRate } : {}) } }),
    onSuccess: (c) => { setCurrent(c); setSettleOpen(false); void qc.invalidateQueries({ queryKey: ['cash-counts'] }); void message.success('Đã lập chứng từ xử lý chênh lệch (nháp)'); },
    onError: (e: Error) => { setSettleErr(e instanceof ApiError && e.code === 'FX_RATE_REQUIRED' ? 'Nhập tỷ giá để quy đổi chênh lệch ra đồng' : e.message); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api<void>(`/api/cash-counts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { startNew(); void qc.invalidateQueries({ queryKey: ['cash-counts'] }); void message.success('Đã xóa kiểm kê'); },
    onError: (e: Error) => { void message.error(e.message); },
  });

  const startNew = () => { setCurrent(null); setRows(defaultRows(currency)); setMembersTxt(''); setNote(''); };
  const openSaved = (c: Count) => { setCurrent(c); setRows(c.denominations); setMembersTxt(membersText(c.members)); setNote(c.note ?? ''); };
  const changeCurrency = (code: string) => { setCurrency(code); setRows(defaultRows(code)); };

  const mayCreate = can('cash_count.create');
  const canSave = !current && mayCreate && !!accountCode && !save.isPending;
  const saveRef = useRef(() => {}); saveRef.current = () => { if (canSave) save.mutate(); };
  // Ctrl+S: ô lưới đang sửa chốt giá trị khi mất tiêu điểm, nên rời ô trước rồi mới lưu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return;
      (document.activeElement as HTMLElement | null)?.blur?.(); setTimeout(() => saveRef.current(), 50);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openSettle = () => { setCounter(null); setFxRate(null); setSettleErr(''); setSettleOpen(true); };
  const surplus = current ? D(current.difference).gt(0) : false;
  const voucherType = surplus ? 'PT' : 'PC';
  const fmtDiff = (c: Count) => (D(c.difference).isZero() ? '0' : `${D(c.difference).gt(0) ? 'Thừa' : 'Thiếu'} ${show(D(c.difference).abs().toFixed(), c.currency)}`);

  const columns = useMemo(() => columnsFor(cur), [cur]);
  const diffColor = sign < 0 ? '#cf1322' : sign > 0 ? '#d46b08' : undefined;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Kiểm kê quỹ</h2>
        {current && <Button onClick={startNew}>Kiểm kê mới</Button>}
      </Space>

      <Space wrap size="middle" align="end">
        <Space direction="vertical" size={2}><label htmlFor="cc-date">Ngày kiểm kê</label>
          <DatePicker id="cc-date" format="DD/MM/YYYY" allowClear={false} disabled={!!current} value={dayjs(current?.countDate ?? date)} onChange={(d) => d && setDate(d.format('YYYY-MM-DD'))} /></Space>
        <Space direction="vertical" size={2}><label htmlFor="cc-account">Tài khoản quỹ</label>
          <LookupSelect id="cc-account" catalog="account" fetcher={accountFetcher} placeholder="Chọn tài khoản quỹ (F4)" style={{ width: 300 }} disabled={!!current}
            value={(current?.accountCode ?? accountCode) || null} onChange={(code) => setAccountCode(code ?? '')} /></Space>
        <Space direction="vertical" size={2}><label htmlFor="cc-currency">Loại tiền</label>
          <LookupSelect id="cc-currency" catalog="currency" style={{ width: 160 }} disabled={!!current} value={cur} onChange={(code) => changeCurrency(code ?? 'VND')} /></Space>
        {mayCreate && !current && <Button type="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>Lưu kiểm kê (Ctrl+S)</Button>}
      </Space>

      {balance.error && <Alert type="error" showIcon message={(balance.error as Error).message} />}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 460px', maxWidth: 620 }}>
          <KeyboardGrid<Row> rows={rows} columns={columns} onRowsChange={setRows} addRowTemplate={blank} readOnly={!!current} height={Math.min(480, 64 + Math.max(rows.length, 3) * 42)} />
        </div>
        <Card size="small" title="Kết quả kiểm kê" style={{ flex: '1 1 360px', maxWidth: 480 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Số dư theo sổ (cuối ngày {formatVnDate(current?.countDate ?? date)})</span>
              <b data-testid="cc-book">{book === null ? '…' : show(book, cur)}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Kiểm kê thực tế</span><b data-testid="cc-counted">{show(counted, cur)}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Chênh lệch (thực tế - sổ)</span>
              <span><b data-testid="cc-diff" style={diffColor ? { color: diffColor } : undefined}>{diff === null ? '…' : show(diff, cur)}</b>{' '}
                {diff !== null && <Tag color={sign < 0 ? 'error' : sign > 0 ? 'warning' : 'success'}>{sign < 0 ? 'Thiếu' : sign > 0 ? 'Thừa' : 'Khớp'}</Tag>}</span></div>
            <Input.TextArea aria-label="Thành viên kiểm kê" placeholder={'Thành viên kiểm kê, mỗi dòng một người: Họ tên, chức danh'} rows={3} disabled={!!current} value={membersTxt} onChange={(e) => setMembersTxt(e.target.value)} />
            <Input aria-label="Ghi chú" placeholder="Ghi chú (lý do chênh lệch...)" disabled={!!current} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            {current && (
              <Space wrap>
                {settled(current)
                  ? <Alert type="success" showIcon message={<>Đã xử lý bằng <Link to="/chung-tu/$type/$id" params={{ type: voucherType, id: current.voucherId! }}>{voucherType === 'PT' ? 'Phiếu thu' : 'Phiếu chi'} {current.voucherNo ?? '(nháp)'}</Link></>} />
                  : !D(current.difference).isZero() && can('cash_count.update') && can('voucher.create') && <Button type="primary" onClick={openSettle}>Xử lý chênh lệch</Button>}
                {can('cash_count.view') && <Button onClick={() => window.open(`/api/cash-counts/${current.id}/print?format=pdf`, '_blank')}>In bảng kiểm kê</Button>}
                {!settled(current) && can('cash_count.delete') && <Popconfirm title="Xóa kiểm kê quỹ này?" okText="Xóa" cancelText="Không" onConfirm={() => remove.mutate(current.id)}><Button danger>Xóa</Button></Popconfirm>}
              </Space>
            )}
          </Space>
        </Card>
      </div>

      <Table<Count> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }} title={() => <b>Các lần kiểm kê gần đây</b>}
        rowClassName={(c) => (c.id === current?.id ? 'ant-table-row-selected' : '')} onRow={(c) => ({ onClick: () => openSaved(c), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Số', dataIndex: 'id', width: 70 },
          { title: 'Ngày kiểm kê', dataIndex: 'countDate', width: 130, render: (d: string) => formatVnDate(d) },
          { title: 'Tài khoản', dataIndex: 'accountCode', width: 110 },
          { title: 'Loại tiền', dataIndex: 'currency', width: 90 },
          { title: 'Thực tế', dataIndex: 'countedTotal', align: 'right', render: (v: string, c) => show(v, c.currency) },
          { title: 'Chênh lệch', align: 'right', render: (_, c) => fmtDiff(c) },
          { title: 'Xử lý', render: (_, c) => (settled(c) ? <Tag color="success">{c.voucherNo ?? 'Chứng từ nháp'}</Tag> : D(c.difference).isZero() ? '' : <Tag>Chưa xử lý</Tag>) },
        ]} />

      <Modal title="Xử lý chênh lệch kiểm kê quỹ" open={settleOpen} onCancel={() => setSettleOpen(false)} okText="Lập chứng từ" cancelText="Hủy"
        confirmLoading={settle.isPending} onOk={() => current && settle.mutate(current.id)} destroyOnHidden>
        {current && <Space direction="vertical" style={{ width: '100%' }}>
          <div>Chênh lệch {fmtDiff(current).toLowerCase()} {current.currency}: lập {surplus ? 'Phiếu thu (Nợ quỹ / Có tài khoản thừa chờ xử lý)' : 'Phiếu chi (Nợ tài khoản thiếu chờ xử lý / Có quỹ)'}. Phiếu ở trạng thái nháp, kiểm tra rồi ghi sổ.</div>
          <label htmlFor="cc-counter">Tài khoản đối ứng (để trống: {surplus ? '3381' : '1381'})</label>
          <LookupSelect id="cc-counter" catalog="account" fetcher={counterFetcher} placeholder={`Mặc định ${surplus ? '3381' : '1381'}`} style={{ width: '100%' }} value={counter} onChange={setCounter} />
          {current.currency !== 'VND' && <>
            <label htmlFor="cc-fx">Tỷ giá quy đổi {current.currency}/VND</label>
            <VnNumberInput id="cc-fx" scale={4} value={fxRate} onChange={setFxRate} />
          </>}
          {settleErr && <Alert type="error" showIcon message={settleErr} />}
        </Space>}
      </Modal>
    </Space>
  );
}
