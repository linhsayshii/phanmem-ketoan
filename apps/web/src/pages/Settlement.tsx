import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Modal, Segmented, Space, Table, Tabs, message, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { COLOR, LookupSelect, PageHeader, Section, Toolbar, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { PickGrid, buildRows, fetchVoucherNos, formatAmount, overResidual, pairOff, sumPicks, type OpenItem, type PickRow } from './settleCommon.js';

interface SettlementRow {
  id: number; groupId: string; kind: 'manual' | 'auto' | 'plan' | 'fx' | 'reversal'; settleDate: string; accountCode: string; partyCode: string; currency: string;
  debitDocNo: string | null; creditDocNo: string | null; amount: string; amountCurrency: string; fxVoucherId: string | null; fxVoucherNo: string | null;
}
interface Group { groupId: string; kind: SettlementRow['kind']; settleDate: string; partyCode: string; currency: string; debitDocNo: string | null; creditDocNo: string | null; amount: string; amountCurrency: string; extra: number; fxVoucherId: string | null; fxVoucherNo: string | null }
interface Result { pairs: number; failed: string | null; vouchers: { id: string; no: string }[] }

const KIND_LABEL: Record<SettlementRow['kind'], string> = { manual: 'Thủ công', auto: 'Tự động', plan: 'Theo chứng từ', fx: 'Chênh lệch tỷ giá', reversal: 'Đảo chứng từ' };

// Mỗi nhóm đối trừ một dòng: dòng chính là khoản đối trừ đầu tiên không phải chênh lệch tỷ giá; dòng fx con chỉ góp số chứng từ CL.
function groupsOf(rows: SettlementRow[]): Group[] {
  const by = new Map<string, SettlementRow[]>();
  for (const r of rows) by.set(r.groupId, [...(by.get(r.groupId) ?? []), r]);
  return [...by.values()].map((g) => {
    const main = g.filter((r) => r.kind !== 'fx'); const first = main[0] ?? g[0]!; const fx = g.find((r) => r.fxVoucherId);
    return { groupId: first.groupId, kind: first.kind, settleDate: first.settleDate, partyCode: first.partyCode, currency: first.currency, debitDocNo: first.debitDocNo, creditDocNo: first.creditDocNo,
      amount: main.reduce((a, r) => a.plus(r.amount), D(0)).toFixed(0), amountCurrency: main.reduce((a, r) => a.plus(r.amountCurrency), D(0)).toFixed(), extra: Math.max(0, main.length - 1),
      fxVoucherId: fx?.fxVoucherId ?? null, fxVoucherNo: fx?.fxVoucherNo ?? null };
  });
}

export default function SettlementPage() {
  const { me, can } = useAuth();
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'pick' | 'history'>('pick');
  const [f, setF] = useRememberedFilter('settlement', { accountCode: '131', partyCode: '', currency: 'VND' }, `${me?.tenantId}:${me?.userId}`);
  const [settleDate, setSettleDate] = useState<string | null>(null); // trống: máy chủ lấy ngày của khoản sau
  const [range, setRange] = useState<[string, string] | null>(null);
  const [debit, setDebit] = useState<PickRow[]>([]); const [credit, setCredit] = useState<PickRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const fx = f.currency !== 'VND';

  // Đã chọn ngày đối trừ thì liệt kê khoản còn dư đến ngày đó (mặc định máy chủ lấy hôm nay, không thấy khoản lập sau hôm nay).
  const items = useQuery({ queryKey: ['open-items', f.accountCode, f.partyCode, settleDate], enabled: !!f.partyCode, retry: false,
    // Đổi ngày thì giữ danh sách cũ trong lúc tải lại; đổi tài khoản hoặc đối tượng thì không (tránh chọn nhầm khoản của đối tượng trước).
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === f.accountCode && prevQuery?.queryKey[2] === f.partyCode ? prev : undefined),
    queryFn: () => api<OpenItem[]>(`/api/open-items?${new URLSearchParams({ accountCode: f.accountCode, partyCode: f.partyCode, onlyOpen: 'true', ...(settleDate ? { asOf: settleDate } : {}) })}`) });
  // Dựng lại hai lưới khi dữ liệu hoặc loại tiền đổi; các dòng giữ nguyên đối tượng giữa các lần sửa ô (AG Grid ghi thẳng vào đối tượng dòng).
  useEffect(() => { const b = buildRows(items.data ?? [], f.currency); setDebit(b.debit); setCredit(b.credit); }, [items.data, f.currency]);

  const totalD = sumPicks(debit); const totalC = sumPicks(credit); const diff = totalD.minus(totalC).abs();
  const over = [...overResidual(debit), ...overResidual(credit)];
  const balanced = totalD.gt(0) && totalD.eq(totalC) && over.length === 0;
  const canCreate = can('settlement.create');

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['open-items'] }), qc.invalidateQueries({ queryKey: ['settlements'] })]);
  const settle = async () => {
    if (busy) return;
    // Nút Đối trừ đã khóa theo các điều kiện này; Ctrl+S đi qua đây nên phải nói lý do thay vì lặng lẽ bỏ qua.
    const why = !canCreate ? 'Bạn không có quyền đối trừ' : tab !== 'pick' ? 'Chuyển sang thẻ "Chọn để đối trừ" để đối trừ'
      : !f.partyCode ? 'Chọn đối tượng (F4) để xem các khoản còn dư' : over.length > 0 ? 'Có khoản đối trừ vượt số còn dư'
      : totalD.isZero() && totalC.isZero() ? 'Chưa chọn khoản nào để đối trừ' : !balanced ? `Tổng Nợ chọn khác tổng Có chọn, chênh lệch ${formatAmount(diff, fx)}` : null;
    if (why) { void message.warning(why); return; }
    const pairs = pairOff(debit, credit); setBusy(true); setResult(null);
    const fxIds = new Set<string>(); let done = 0; let failed: string | null = null;
    try {
      for (const p of pairs) {
        const body = { debitItemId: p.debitItemId, creditItemId: p.creditItemId, ...(fx ? { amountCurrency: p.amount } : { amount: p.amount }), ...(settleDate ? { date: settleDate } : {}) };
        const r = await api<{ fxVoucherId: string | null }>('/api/settlements', { method: 'POST', json: body });
        done++; if (r.fxVoucherId) fxIds.add(r.fxVoucherId);
      }
    } catch (e) { failed = (e as Error).message; }
    const ids = [...fxIds]; const nos = await fetchVoucherNos(ids);
    setResult({ pairs: done, failed, vouchers: ids.map((id, i) => ({ id, no: nos[i]! })) });
    await refresh(); setBusy(false);
  };
  // Ctrl+S: cửa sổ nhận phím vì hotkey chung bỏ qua phím gõ trong ô nhập; ô lưới đang sửa được chốt (blur) trước khi đọc số.
  const run = useRef(settle); run.current = settle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || (e.target as Partial<Element> | null)?.closest?.('.ant-modal-root')) return;
      e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur?.(); setTimeout(() => { void run.current(); }, 0);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const autoSettle = () => {
    const date = settleDate ?? todayVn();
    Modal.confirm({ title: 'Đối trừ tự động', okText: 'Thực hiện', cancelText: 'Hủy',
      content: `Ghép các khoản Nợ và Có của TK ${f.accountCode} (kể cả tài khoản con), mọi loại tiền${f.partyCode ? `, đối tượng ${f.partyCode}` : ', mọi đối tượng'}, đã ghi sổ đến ngày ${formatVnDate(date)} theo thứ tự ngày chứng từ.`,
      onOk: async () => {
        try {
          const r = await api<{ groups: number; more: boolean }>('/api/settlements/auto', { method: 'POST', json: { accountCode: f.accountCode, ...(f.partyCode ? { partyCode: f.partyCode } : {}), date } });
          void message.success(`Đã đối trừ tự động ${r.groups} nhóm${r.more ? '; còn khoản chưa ghép, chạy lại để tiếp tục' : ''}`);
          await refresh();
        } catch (e) { void message.error((e as Error).message); }
      } });
  };

  const history = useQuery({ queryKey: ['settlements', f.accountCode, f.partyCode, range], enabled: tab === 'history', retry: false,
    queryFn: () => api<SettlementRow[]>(`/api/settlements?${new URLSearchParams({ accountCode: f.accountCode, ...(f.partyCode ? { partyCode: f.partyCode } : {}), ...(range ? { from: range[0], to: range[1] } : {}) })}`) });
  const groups = useMemo(() => groupsOf(history.data ?? []), [history.data]);
  const cancel = (g: Group) => Modal.confirm({ title: 'Hủy đối trừ?', okText: 'Xác nhận hủy', cancelText: 'Không', okButtonProps: { danger: true },
    content: `Nhóm đối trừ ${g.debitDocNo ?? ''} - ${g.creditDocNo ?? ''} (${formatVnNumber(g.amount)}) bị hủy; công nợ của các khoản trở lại như trước khi đối trừ${g.fxVoucherNo ? `, chứng từ ${g.fxVoucherNo} được đảo` : ''}.`,
    onOk: async () => {
      try { await api(`/api/settlements/groups/${g.groupId}`, { method: 'DELETE' }); void message.success('Đã hủy đối trừ'); await refresh(); } catch (e) { void message.error((e as Error).message); }
    } });
  const historyColumns: ColumnsType<Group> = [
    { title: 'Ngày đối trừ', dataIndex: 'settleDate', width: 120, render: (v: string) => formatVnDate(v) },
    { title: 'Hình thức', dataIndex: 'kind', width: 140, render: (k: Group['kind']) => KIND_LABEL[k] },
    { title: 'Đối tượng', dataIndex: 'partyCode', width: 120 },
    { title: 'Chứng từ Nợ', dataIndex: 'debitDocNo' },
    { title: 'Chứng từ Có', dataIndex: 'creditDocNo', render: (v: string | null, g) => <>{v}{g.extra > 0 ? ` (+${g.extra} khoản)` : ''}</> },
    { title: 'Số tiền (VND)', dataIndex: 'amount', align: 'right', render: (v: string) => formatVnNumber(v) },
    { title: 'Nguyên tệ', dataIndex: 'amountCurrency', align: 'right', render: (v: string, g) => (g.currency !== 'VND' ? formatAmount(v, true) : '') },
    { title: 'Chứng từ CL', dataIndex: 'fxVoucherNo', render: (v: string | null, g) => (v && g.fxVoucherId ? <a href={`/chung-tu/CL/${g.fxVoucherId}`} target="_blank" rel="noopener noreferrer">{v}</a> : '') },
    { title: '', width: 130, render: (_, g) => <Button size="small" danger disabled={g.kind === 'reversal' || !can('settlement.delete')} onClick={() => cancel(g)}>Hủy đối trừ</Button> },
  ];

  const section = (label: string, rows: PickRow[], set: (r: PickRow[]) => void) => (
    <section aria-label={label} style={{ flex: 1, minWidth: 0 }}>
      <Section title={label} bodyPadding={0}>
        <PickGrid rows={rows} fx={fx} onChange={set} height="calc(100vh - 470px)" />
      </Section>
    </section>);

  const pickPane = !f.partyCode ? <Alert type="info" showIcon message="Chọn đối tượng (F4) để xem các khoản còn dư" />
    : items.error ? <Alert type="error" showIcon message={(items.error as Error).message} />
    : (
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div style={{ display: 'flex', gap: 12 }}>{section('Phát sinh Nợ còn dư', debit, setDebit)}{section('Phát sinh Có còn dư', credit, setCredit)}</div>
        <Space size="large" wrap>
          <span>Tổng Nợ chọn: <b>{formatAmount(totalD, fx)}</b></span><span>Tổng Có chọn: <b>{formatAmount(totalC, fx)}</b></span>
          <span style={diff.isZero() ? undefined : { color: token.colorError }}>Chênh lệch: <b>{formatAmount(diff, fx)}</b></span>
        </Space>
        {over.length > 0 && <Alert type="error" showIcon message={`Số đối trừ của ${over.map((r) => `${r.docNo} vượt số còn dư ${formatAmount(r.remain, fx)}`).join('; ')}`} />}
        {fx && <span style={{ color: COLOR.textSecondary, fontSize: 13 }}>Khoản ngoại tệ đối trừ lệch tỷ giá sẽ tự sinh chứng từ CL (chênh lệch tỷ giá).</span>}
        {result && <Alert type={result.failed ? 'warning' : 'success'} showIcon message={`Đã đối trừ ${result.pairs} cặp`}
          description={<>{result.failed && <div>{`Dừng ở lỗi: ${result.failed}`}</div>}{result.vouchers.length > 0 && <span>Chứng từ chênh lệch tỷ giá: {result.vouchers.map((v, i) => <span key={v.id}>{i > 0 && ', '}<a href={`/chung-tu/CL/${v.id}`} target="_blank" rel="noopener noreferrer">{v.no}</a></span>)}</span>}</>} />}
      </Space>);

  return (
    <>
      <PageHeader
        title="Đối trừ chứng từ"
        description="Đối trừ công nợ giữa các chứng từ phát sinh Nợ và phát sinh Có theo từng đối tượng"
        extra={canCreate && (
          <Space>
            <Button type="primary" disabled={!balanced || busy || tab !== 'pick'} loading={busy} onClick={() => { void settle(); }}>Đối trừ (Ctrl+S)</Button>
            <Button onClick={autoSettle}>Đối trừ tự động</Button>
          </Space>
        )}
      >
        <Toolbar>
          <Segmented aria-label="Loại công nợ" value={f.accountCode} onChange={(v) => setF({ ...f, accountCode: String(v) })} options={[{ value: '131', label: 'Phải thu (131)' }, { value: '331', label: 'Phải trả (331)' }]} />
          <LookupSelect catalog="party" includeInactive aria-label="Đối tượng (F4)" placeholder="Đối tượng (F4)" style={{ width: 240 }} value={f.partyCode || null} onChange={(code) => setF({ ...f, partyCode: code ?? '' })} />
          <LookupSelect catalog="currency" aria-label="Loại tiền (F4)" placeholder="Loại tiền (F4)" style={{ width: 140 }} value={f.currency} onChange={(code) => setF({ ...f, currency: code ?? 'VND' })} />
          <DatePicker format="DD/MM/YYYY" placeholder="Mặc định theo chứng từ" aria-label="Ngày đối trừ" value={settleDate ? dayjs(settleDate) : null} onChange={(d) => setSettleDate(d ? d.format('YYYY-MM-DD') : null)} />
        </Toolbar>
      </PageHeader>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as 'pick' | 'history')} style={{ marginBottom: 12 }} items={[
        { key: 'pick', label: 'Chọn để đối trừ', children: pickPane },
        { key: 'history', label: 'Đã đối trừ', children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <DatePicker.RangePicker format="DD/MM/YYYY" allowClear aria-label="Khoảng ngày đối trừ" value={range ? [dayjs(range[0]), dayjs(range[1])] : null} onChange={(r) => setRange(r?.[0] && r[1] ? [r[0].format('YYYY-MM-DD'), r[1].format('YYYY-MM-DD')] : null)} />
            {history.error ? <Alert type="error" showIcon message={(history.error as Error).message} />
              : (
                <Section bodyPadding={0}>
                  <Table<Group> size="small" rowKey="groupId" loading={history.isLoading} columns={historyColumns} dataSource={groups} pagination={{ pageSize: 50, hideOnSinglePage: true }} />
                </Section>
              )}
          </Space>) },
      ]} />
    </>
  );
}
