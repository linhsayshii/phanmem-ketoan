import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DatePicker, Descriptions, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Upload, message } from 'antd';
import dayjs from 'dayjs';
import { CASH_PURPOSES, D, formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { COLOR, EmptyState, LookupSelect, PageHeader, Section, Toolbar, useHotkeys, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Giao dịch ngân hàng: hộp thư giao dịch từ webhook / sao kê, gợi ý đối chiếu, lập Giấy báo Có/Nợ, đối chiếu sổ phụ.
export interface BankAccountRow { id: number; code: string; name: string; account_no: string; account_name: string | null; currency_code: string | null }
export const useBankAccounts = () => useQuery({ queryKey: ['bank-accounts'], queryFn: async () => (await api<{ rows: BankAccountRow[] }>('/api/catalogs/bank_account?size=100&active=all')).rows });

interface Txn {
  id: number; bankAccountId: number; source: string; valueDate: string; amountIn: string; amountOut: string; balanceAfter: string | null; description: string | null; reference: string | null;
  counterName: string | null; paymentCode: string | null; status: 'new' | 'matched' | 'ignored'; voucherId: string | null;
}
type Suggestion =
  | { kind: 'voucher'; voucherId: string; voucherNo: string | null; date: string; amount: string; score: number; reasons: string[] }
  | { kind: 'open_item'; openItemId: number; partyCode: string; partyName: string; invoiceNo: string | null; dueDate: string | null; residual: string; score: number; reasons: string[] };
interface OpenItem { id: number; voucherNo: string | null; docNo: string | null; docDate: string; dueDate: string | null; residual: string }
interface Recon {
  accountNo: string; glAccountCode: string; from: string; to: string; ledgerOpening: string; ledgerClosing: string; statementBalance: string | null; statementBalanceDate: string | null; difference: string | null;
  unmatchedTransactions: { id: number; valueDate: string; amountIn: string; amountOut: string; description: string | null; reference: string | null; counterName: string | null }[];
  unmatchedLedgerLines: { voucherNo: string | null; postingDate: string; debit: string; credit: string; description: string | null }[];
}
const STATUS = { new: { label: 'Mới', color: 'blue' }, matched: { label: 'Đã đối chiếu', color: 'green' }, ignored: { label: 'Đã bỏ qua', color: 'default' } } as const;
const isIn = (t: Txn) => D(t.amountIn).gt(0);
const amountOf = (t: Txn) => (isIn(t) ? t.amountIn : t.amountOut);
const num = (v: string | null | undefined) => (v === null || v === undefined ? '' : formatVnNumber(v));

// Lập Giấy báo Có (tiền vào) hoặc Giấy báo Nợ (tiền ra) từ giao dịch: chọn đối tượng, mục đích, các khoản công nợ cần đối trừ.
function VoucherModal({ txn, preset, onClose, onDone }: { txn: Txn | null; preset: { partyCode: string; openItemId: number } | null; onClose: () => void; onDone: (voucherId: string) => void }) {
  const { can } = useAuth();
  const [party, setParty] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [desc, setDesc] = useState('');
  const inbound = txn ? isIn(txn) : true; const type = inbound ? 'BC' : 'BN';
  useEffect(() => { if (txn) { setParty(preset?.partyCode ?? null); setPicked(preset ? [preset.openItemId] : []); setPurpose(null); setDesc(txn.description ?? ''); } }, [txn, preset]);
  const items = useQuery({ queryKey: ['bank-open-items', inbound, party], enabled: !!txn && !!party,
    queryFn: () => api<OpenItem[]>(`/api/open-items?accountCode=${inbound ? '131' : '331'}&partyCode=${encodeURIComponent(party!)}&asOf=${todayVn()}&onlyOpen=true`) });
  const purposes = CASH_PURPOSES.filter((p) => (p.types as string[]).includes(type));
  // Phân bổ lần lượt theo thứ tự chọn: mỗi khoản nhận tối đa dư còn lại, tổng không vượt số tiền giao dịch.
  const plan = useMemo(() => {
    let left = D(txn ? amountOf(txn) : '0'); const out: { openItemId: number; amount: string }[] = [];
    for (const id of picked) { const it = items.data?.find((x) => x.id === id); if (!it || left.lte(0)) continue; const take = D(it.residual).abs().lt(left) ? D(it.residual).abs() : left; if (take.gt(0)) { out.push({ openItemId: id, amount: take.toFixed(0) }); left = left.minus(take); } }
    return out;
  }, [picked, items.data, txn]);
  const run = useMutation({
    mutationFn: () => api<{ voucher: { id: string } }>(`/api/bank-transactions/${txn!.id}/create-voucher`, { method: 'POST', json: {
      post: true, ...(party ? { partyCode: party } : {}), ...(plan.length ? { settle: plan } : purpose ? { purposeCode: purpose } : {}), ...(desc.trim() ? { description: desc.trim() } : {}) } }),
    onSuccess: (r) => { void message.success(`Đã lập và ghi sổ Giấy báo ${inbound ? 'Có' : 'Nợ'}`); onDone(r.voucher.id); }, onError: (e: Error) => void message.error(e.message),
  });
  const canGo = !!txn && can('voucher.create') && can('voucher.post') && (plan.length > 0 || !!purpose) && !run.isPending;
  const go = useRef(() => {}); go.current = () => { if (canGo) run.mutate(); };
  useEffect(() => {
    if (!txn) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); go.current(); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [txn]);
  const total = plan.reduce((s, x) => s.plus(x.amount), D(0));
  return (
    <Modal title={`Lập Giấy báo ${inbound ? 'Có' : 'Nợ'}`} open={!!txn} onCancel={onClose} width={760} destroyOnHidden
      footer={<Space><Button onClick={onClose}>Đóng</Button><Button type="primary" disabled={!canGo} loading={run.isPending} onClick={() => run.mutate()}>Ghi sổ (Ctrl+S)</Button></Space>}>
      {txn && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Descriptions size="small" column={3}>
            <Descriptions.Item label="Ngày">{formatVnDate(txn.valueDate)}</Descriptions.Item>
            <Descriptions.Item label="Số tiền"><b>{num(amountOf(txn))}</b></Descriptions.Item>
            <Descriptions.Item label="Tham chiếu">{txn.reference ?? ''}</Descriptions.Item>
          </Descriptions>
          <Form layout="vertical" component={false}>
            <Space align="start" wrap>
              <Form.Item label="Đối tượng (F4)" style={{ width: 300 }}><LookupSelect catalog="party" value={party} onChange={(c) => { setParty(c); setPicked([]); }} aria-label="Đối tượng" /></Form.Item>
              <Form.Item label="Mục đích" style={{ width: 300 }}><Select allowClear aria-label="Mục đích" value={purpose} onChange={(v) => setPurpose(v ?? null)} disabled={plan.length > 0} placeholder={plan.length ? 'Theo khoản đối trừ' : 'Chọn mục đích'} options={purposes.map((p) => ({ value: p.code, label: p.label }))} /></Form.Item>
            </Space>
            <Form.Item label="Diễn giải"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={1000} aria-label="Diễn giải" /></Form.Item>
          </Form>
          {party && (
            <Table<OpenItem> rowKey="id" size="small" loading={items.isLoading} dataSource={items.data ?? []} pagination={false} scroll={{ y: 200 }} locale={{ emptyText: 'Đối tượng này không có khoản cần đối trừ' }}
              rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]) }}
              columns={[
                { title: 'Chứng từ', render: (_, r) => r.docNo ?? r.voucherNo ?? '' }, { title: 'Ngày', dataIndex: 'docDate', width: 100, render: (d: string) => formatVnDate(d) },
                { title: 'Hạn', dataIndex: 'dueDate', width: 100, render: (d: string | null) => (d ? formatVnDate(d) : '') },
                { title: 'Còn lại', dataIndex: 'residual', align: 'right', width: 120, render: (v: string) => num(D(v).abs().toFixed(0)) },
                { title: 'Đối trừ', align: 'right', width: 120, render: (_, r) => num(plan.find((p) => p.openItemId === r.id)?.amount) },
              ]} />)}
          {plan.length > 0 && <div>Đối trừ <b>{num(total.toFixed(0))}</b> / {num(amountOf(txn))}{total.lt(amountOf(txn)) && <> (phần dư ghi nhận trả trước)</>}</div>}
        </Space>)}
    </Modal>
  );
}

function ImportModal({ open, accountId, onClose, onDone }: { open: boolean; accountId?: number | undefined; onClose: () => void; onDone: () => void }) {
  const formats = useQuery({ queryKey: ['bank-formats'], queryFn: () => api<{ id: number; name: string }[]>('/api/bank-statement-formats'), enabled: open });
  const [formatId, setFormatId] = useState<number | null>(null); const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    mutationFn: async () => { const fd = new FormData(); fd.append('bankAccountId', String(accountId)); fd.append('formatId', String(formatId)); fd.append('file', file!); return api<{ inserted: number; skipped: number; errors?: unknown[] }>('/api/bank-transactions/import', { method: 'POST', body: fd }); },
    onSuccess: (r) => { void message.success(`Đã nhập ${r.inserted} giao dịch${r.skipped ? `, bỏ ${r.skipped} dòng trùng hoặc lỗi` : ''}`); setFile(null); onDone(); }, onError: (e: Error) => void message.error(e.message),
  });
  return (
    <Modal title="Nhập sao kê" open={open} okText="Nhập" cancelText="Đóng" okButtonProps={{ disabled: !accountId || !formatId || !file, loading: run.isPending }} onOk={() => run.mutate()} onCancel={onClose} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }}>
        {!accountId && <Alert type="warning" showIcon message="Chọn tài khoản ngân hàng ở bộ lọc trước khi nhập sao kê." />}
        <Select style={{ width: '100%' }} placeholder="Mẫu cột sao kê" aria-label="Mẫu cột sao kê" value={formatId} onChange={setFormatId} options={(formats.data ?? []).map((f) => ({ value: f.id, label: f.name }))} notFoundContent="Chưa có mẫu, khai ở Kết nối ngân hàng" />
        <Upload beforeUpload={(f) => { setFile(f); return false; }} maxCount={1} accept=".xlsx,.csv" onRemove={() => setFile(null)}><Button>Chọn tệp sao kê (.xlsx, .csv)</Button></Upload>
      </Space>
    </Modal>
  );
}

function ReconTab({ accountId }: { accountId?: number | undefined }) {
  const [r, setR] = useState<[string, string]>([dayjs().startOf('month').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')]);
  const [run, setRun] = useState<{ accountId: number; from: string; to: string } | null>(null);
  const q = useQuery({ queryKey: ['bank-recon', run], enabled: !!run, queryFn: () => api<Recon>(`/api/bank-reconciliation?bankAccountId=${run!.accountId}&from=${run!.from}&to=${run!.to}`) });
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Toolbar>
        <DatePicker.RangePicker format="DD/MM/YYYY" value={[dayjs(r[0]), dayjs(r[1])]} allowClear={false} onChange={(v) => v?.[0] && v[1] && setR([v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')])} />
        <Button type="primary" disabled={!accountId} onClick={() => setRun({ accountId: accountId!, from: r[0], to: r[1] })}>Đối chiếu</Button>
        {run && <Button href={`/api/bank-reconciliation?bankAccountId=${run.accountId}&from=${run.from}&to=${run.to}&format=xlsx`}>Xuất Excel</Button>}
        {!accountId && <Tag color="orange">Chọn tài khoản ngân hàng ở bộ lọc phía trên</Tag>}
      </Toolbar>
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      {q.data && (
        <>
          <Descriptions bordered size="small" column={2} title={`Tài khoản ${q.data.accountNo} (TK ${q.data.glAccountCode}), ${formatVnDate(q.data.from)} – ${formatVnDate(q.data.to)}`}>
            <Descriptions.Item label="Số dư đầu kỳ theo sổ">{num(q.data.ledgerOpening)}</Descriptions.Item>
            <Descriptions.Item label="Số dư cuối kỳ theo sổ">{num(q.data.ledgerClosing)}</Descriptions.Item>
            <Descriptions.Item label={`Số dư theo sổ phụ${q.data.statementBalanceDate ? ` (${formatVnDate(q.data.statementBalanceDate)})` : ''}`}>{q.data.statementBalance === null ? 'Chưa có' : num(q.data.statementBalance)}</Descriptions.Item>
            <Descriptions.Item label="Chênh lệch"><b>{q.data.difference === null ? '' : num(q.data.difference)}</b></Descriptions.Item>
          </Descriptions>
          <Section title={`Giao dịch ngân hàng chưa có chứng từ (${q.data.unmatchedTransactions.length})`} bodyPadding={0}>
            <Table size="small" rowKey="id" pagination={false} dataSource={q.data.unmatchedTransactions} locale={{ emptyText: 'Không có' }}
              columns={[{ title: 'Ngày', dataIndex: 'valueDate', width: 100, render: (d: string) => formatVnDate(d) }, { title: 'Diễn giải', dataIndex: 'description' }, { title: 'Tham chiếu', dataIndex: 'reference', width: 140 },
                { title: 'Tiền vào', dataIndex: 'amountIn', align: 'right', className: 'kt-num', width: 120, render: (v: string) => (D(v).gt(0) ? num(v) : '') }, { title: 'Tiền ra', dataIndex: 'amountOut', align: 'right', className: 'kt-num', width: 120, render: (v: string) => (D(v).gt(0) ? num(v) : '') }]} />
          </Section>
          <Section title={`Bút toán sổ cái chưa có giao dịch ngân hàng (${q.data.unmatchedLedgerLines.length})`} bodyPadding={0}>
            <Table size="small" rowKey={(_, i) => String(i)} pagination={false} dataSource={q.data.unmatchedLedgerLines} locale={{ emptyText: 'Không có' }}
              columns={[{ title: 'Ngày', dataIndex: 'postingDate', width: 100, render: (d: string) => formatVnDate(d) }, { title: 'Số chứng từ', dataIndex: 'voucherNo', width: 140 }, { title: 'Diễn giải', dataIndex: 'description' },
                { title: 'Nợ', dataIndex: 'debit', align: 'right', className: 'kt-num', width: 120, render: (v: string) => (D(v).gt(0) ? num(v) : '') }, { title: 'Có', dataIndex: 'credit', align: 'right', className: 'kt-num', width: 120, render: (v: string) => (D(v).gt(0) ? num(v) : '') }]} />
          </Section>
        </>)}
    </Space>
  );
}

export default function BankTransactionsPage() {
  const qc = useQueryClient(); const navigate = useNavigate(); const { can } = useAuth();
  const accounts = useBankAccounts();
  const [f, setF] = useRememberedFilter('bank-transactions', { accountId: 0, status: 'new', from: '', to: '', q: '' });
  const [sel, setSel] = useState<Txn | null>(null);
  const [form, setForm] = useState<{ txn: Txn; preset: { partyCode: string; openItemId: number } | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const accountId = f.accountId || undefined;
  const list = useQuery({ queryKey: ['bank-txns', f], queryFn: () => {
    const p = new URLSearchParams({ limit: '200' });
    if (f.accountId) p.set('bankAccountId', String(f.accountId)); if (f.status) p.set('status', f.status); if (f.from) p.set('from', f.from); if (f.to) p.set('to', f.to); if (f.q) p.set('q', f.q);
    return api<Txn[]>(`/api/bank-transactions?${p}`);
  } });
  const sug = useQuery({ queryKey: ['bank-suggest', sel?.id], enabled: !!sel && sel.status === 'new' && can('bank_feed.match'),
    queryFn: () => api<{ suggestions: Suggestion[]; hiddenBySensitivity: boolean }>(`/api/bank-transactions/${sel!.id}/suggestions`, { method: 'POST', json: {} }) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['bank-txns'] }); void qc.invalidateQueries({ queryKey: ['bank-suggest'] }); };
  const act = useMutation({
    mutationFn: (p: { id: number; op: 'ignore' | 'unignore' | 'unmatch' | 'match'; voucherId?: string }) => api<Txn>(`/api/bank-transactions/${p.id}/${p.op}`, { method: 'POST', json: p.voucherId ? { voucherId: p.voucherId } : {} }),
    onSuccess: (t) => { setSel(t); refresh(); }, onError: (e: Error) => void message.error(e.message),
  });
  useEffect(() => { if (sel && list.data) { const cur = list.data.find((t) => t.id === sel.id); if (cur && cur !== sel) setSel(cur); } }, [list.data, sel]);
  // Phím tắt: Insert lập Giấy báo cho dòng đang chọn.
  useHotkeys({ Insert: () => { if (sel?.status === 'new' && can('bank_feed.match')) setForm({ txn: sel, preset: null }); } });
  const accLabel = (id: number) => accounts.data?.find((a) => a.id === id)?.account_no ?? String(id);
  const matchAllowed = can('bank_feed.match');

  const txnTab = (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <Section bodyPadding={0} style={{ flex: 1, minWidth: 0 }}>
        <Table<Txn> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []} pagination={false} scroll={{ y: 'calc(100vh - 330px)' }} locale={{ emptyText: 'Không có giao dịch' }}
          onRow={(t) => ({ onClick: () => setSel(t), 'aria-selected': sel?.id === t.id, style: { cursor: 'pointer', background: sel?.id === t.id ? COLOR.selectedBg : undefined } })}
          columns={[
            { title: 'Ngày', dataIndex: 'valueDate', width: 100, render: (d: string) => formatVnDate(d) },
            { title: 'Diễn giải', dataIndex: 'description', ellipsis: true },
            { title: 'Tham chiếu', dataIndex: 'reference', width: 130, ellipsis: true },
            { title: 'Tiền vào', dataIndex: 'amountIn', width: 120, align: 'right', className: 'kt-num', render: (v: string) => (D(v).gt(0) ? num(v) : '') },
            { title: 'Tiền ra', dataIndex: 'amountOut', width: 120, align: 'right', className: 'kt-num', render: (v: string) => (D(v).gt(0) ? num(v) : '') },
            { title: 'Số dư', dataIndex: 'balanceAfter', width: 130, align: 'right', className: 'kt-num', render: (v: string | null) => num(v) },
            { title: 'Trạng thái', dataIndex: 'status', width: 120, render: (s: Txn['status']) => <Tag color={STATUS[s].color}>{STATUS[s].label}</Tag> },
            { title: 'Chứng từ', dataIndex: 'voucherId', width: 90, render: (id: string | null, t) => (id ? <a onClick={(e) => { e.stopPropagation(); void navigate({ to: '/chung-tu/$type/$id', params: { type: isIn(t) ? 'BC' : 'BN', id } }); }}>Mở</a> : '') },
            ...(accountId ? [] : [{ title: 'TK', dataIndex: 'bankAccountId', width: 110, render: (id: number) => accLabel(id) }]),
          ]} />
      </Section>
      <Section style={{ width: 360, flex: 'none' }} title={sel ? `Giao dịch ${formatVnDate(sel.valueDate)}: ${num(amountOf(sel))}` : 'Gợi ý đối chiếu'}>
        {!sel ? <EmptyState title="Chọn một giao dịch" /> : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div style={{ color: COLOR.textSecondary }}>{sel.description}</div>
            {sel.counterName && <div>Người chuyển/nhận: {sel.counterName}</div>}
            <Space wrap>
              {sel.status === 'new' && matchAllowed && <Button type="primary" onClick={() => setForm({ txn: sel, preset: null })}>{isIn(sel) ? 'Lập Giấy báo Có' : 'Lập Giấy báo Nợ'}</Button>}
              {sel.status === 'new' && matchAllowed && <Button onClick={() => act.mutate({ id: sel.id, op: 'ignore' })}>Bỏ qua</Button>}
              {sel.status === 'ignored' && matchAllowed && <Button onClick={() => act.mutate({ id: sel.id, op: 'unignore' })}>Bỏ trạng thái bỏ qua</Button>}
              {sel.voucherId && matchAllowed && <Button danger onClick={() => act.mutate({ id: sel.id, op: 'unmatch' })}>Gỡ liên kết</Button>}
            </Space>
            {sel.status === 'new' && matchAllowed && (
              <>
                <b>Gợi ý</b>
                {sug.isLoading && <div>Đang tìm gợi ý...</div>}
                {sug.data?.hiddenBySensitivity && <Alert type="info" showIcon message="Một số gợi ý công nợ bị ẩn do quyền xem công nợ." />}
                {sug.data && !sug.data.suggestions.length && <EmptyState title="Không có gợi ý" />}
                {sug.data?.suggestions.map((s) => s.kind === 'voucher' ? (
                  <Section key={`v${s.voucherId}`} testId="suggestion">
                    <div><b>{s.voucherNo ?? 'Chứng từ nháp'}</b> · {formatVnDate(s.date)} · {num(s.amount)}</div>
                    <div style={{ fontSize: 12, color: COLOR.textSecondary }}>{s.reasons.join('; ')}</div>
                    <Button size="small" type="primary" style={{ marginTop: 6 }} loading={act.isPending} onClick={() => act.mutate({ id: sel.id, op: 'match', voucherId: s.voucherId })}>Gắn</Button>
                  </Section>
                ) : (
                  <Section key={`o${s.openItemId}`} testId="suggestion">
                    <div><b>{s.partyName}</b> ({s.partyCode})</div>
                    <div>Hóa đơn {s.invoiceNo ?? ''} · còn {num(D(s.residual).abs().toFixed(0))}{s.dueDate ? ` · hạn ${formatVnDate(s.dueDate)}` : ''}</div>
                    <div style={{ fontSize: 12, color: COLOR.textSecondary }}>{s.reasons.join('; ')}</div>
                    <Button size="small" type="primary" style={{ marginTop: 6 }} onClick={() => setForm({ txn: sel, preset: { partyCode: s.partyCode, openItemId: s.openItemId } })}>{isIn(sel) ? 'Lập Giấy báo Có' : 'Lập Giấy báo Nợ'}</Button>
                  </Section>))}
              </>)}
          </Space>)}
      </Section>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Giao dịch ngân hàng"
        description="Hộp thư giao dịch từ webhook / sao kê, gợi ý đối chiếu và lập Giấy báo Có/Nợ"
        extra={can('bank_feed.create') ? <Button onClick={() => setImporting(true)}>Nhập sao kê</Button> : null}
      >
        <Toolbar>
          <Select
            style={{ width: 240 }}
            allowClear
            placeholder="Tài khoản ngân hàng"
            aria-label="Tài khoản ngân hàng"
            value={f.accountId || undefined}
            onChange={(v: number | undefined) => setF({ ...f, accountId: v ?? 0 })}
            options={(accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.account_no}${a.account_name ? ` – ${a.account_name}` : ''}` }))}
          />
          <Select
            style={{ width: 150 }}
            aria-label="Trạng thái"
            value={f.status}
            onChange={(v) => setF({ ...f, status: v })}
            options={[{ value: '', label: 'Mọi trạng thái' }, ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))]}
          />
          <DatePicker.RangePicker
            format="DD/MM/YYYY"
            value={f.from && f.to ? [dayjs(f.from), dayjs(f.to)] : null}
            onChange={(r) => setF({ ...f, from: r?.[0]?.format('YYYY-MM-DD') ?? '', to: r?.[1]?.format('YYYY-MM-DD') ?? '' })}
          />
          <Input.Search
            style={{ width: 200 }}
            allowClear
            placeholder="Tìm diễn giải, tham chiếu"
            defaultValue={f.q}
            onSearch={(q) => setF({ ...f, q })}
          />
          {list.data && (
            <span style={{ marginLeft: 'auto', color: COLOR.textSecondary, fontSize: 13 }}>
              {formatVnNumber(String(list.data.length))} giao dịch
            </span>
          )}
        </Toolbar>
      </PageHeader>
      <Tabs items={[{ key: 'txn', label: 'Giao dịch', children: txnTab }, { key: 'recon', label: 'Đối chiếu sổ phụ', children: <ReconTab accountId={accountId} /> }]} />
      <VoucherModal txn={form?.txn ?? null} preset={form?.preset ?? null} onClose={() => setForm(null)} onDone={() => { setForm(null); setSel(null); refresh(); void qc.invalidateQueries({ queryKey: ['bank-recon'] }); }} />
      <ImportModal open={importing} accountId={accountId} onClose={() => setImporting(false)} onDone={() => { setImporting(false); refresh(); }} />
    </div>
  );
}
