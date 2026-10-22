import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { allocateLandedCost, canTransition, D, decideEdit, formatVnDate, formatVnNumber, parseVnNumber, sum, todayVn, VND_AMOUNT_RE, type LandedCostBasis, type VoucherState, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useUnsavedChanges } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import { STATE_LABEL } from './VoucherList.js';
import { Attachments, PickDialog, iso, quickAdd, reportError, text } from './voucherCommon.js';
import { DeclaredInvoices, declaredBody, declRowsOf, emptyDeclRow, type DeclRow } from './DeclaredInvoices.js';

// Chi phí mua hàng (CPM): chọn phiếu nhập đã ghi sổ (PNK mua hàng, MH), nhập các dòng chi phí, phân bổ vào giá nhập theo giá trị hoặc số lượng.
// Phân bổ xem trước bằng chính allocateLandedCost của @kt/domain mà máy chủ dùng khi lưu. Lập, sửa qua /api/landed-costs; ghi sổ, bỏ ghi sổ, đảo, hủy qua /api/vouchers/:id/*.
interface ReceiptLine { id: number; voucherId: string; voucherNo: string | null; postingDate: string; lineNo: number; itemCode: string; itemName: string; warehouseCode: string; quantity: string; value: string; accountCode: string }
interface Receipt { id: string; voucherType: string; voucherNo: string | null; postingDate: string; partyName: string | null; value: string; lines: ReceiptLine[] }
interface LedgerLine { lineNo: number; accountCode: string; accountName: string; debit: string; credit: string; partyCode?: string | null; itemCode?: string | null; warehouseCode?: string | null; description?: string | null }
interface LandedDoc { id: string; voucherNo: string | null; state: string; postingDate: string; documentDate: string; description: string | null; partyCode: string | null; version: number;
  periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean; basis: LandedCostBasis; receiptVoucherIds: string[]; lines: LedgerLine[];
  costLines: { accountCode: string; amount: string; vatAmount: string; description: string | null; partyCode: string | null }[];
  allocations: (ReceiptLine & { amount: string })[]; invoices: Parameters<typeof declRowsOf>[0] }
interface FormValues { postingDate: Dayjs; documentDate: Dayjs; partyCode?: string | null; basis: LandedCostBasis; description?: string | null }
interface CostRow { accountCode: string; partyCode: string; description: string; amount: string; vatAmount: string }
const emptyCostRow = (): CostRow => ({ accountCode: '', partyCode: '', description: '', amount: '', vatAmount: '' });
const blank = (r: CostRow) => Object.values(r).every((s) => s.trim() === '');

const BASIS_LABEL: Record<LandedCostBasis, string> = { value: 'Theo giá trị', quantity: 'Theo số lượng' };
const fmt = (s: string | null | undefined): string => (!s || D(s).isZero() ? '' : formatVnNumber(s, D(s).decimalPlaces()));
const moneyCol = (field: 'amount' | 'vatAmount', headerName: string): ColDef<CostRow> => ({ field, headerName, width: 150, cellClass: 'ag-right-aligned-cell', cellEditorParams: { useFormatter: true },
  valueFormatter: (p) => fmt(p.value as string), valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && VND_AMOUNT_RE.test(n) ? n : p.oldValue; } });
const muted = { color: 'rgba(0,0,0,.45)' };

export default function LandedCost({ def, id }: { def: VoucherTypeDef; id: string }) {
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const [costs, setCosts] = useState<CostRow[]>(() => [emptyCostRow()]); const costsRef = useRef(costs);
  const [decl, setDecl] = useState<DeclRow[]>(() => [emptyDeclRow()]); const declRef = useRef(decl);
  const [picked, setPicked] = useState<string[]>([]);
  const [from, setFrom] = useState<Dayjs>(() => dayjs(todayVn()).subtract(2, 'month').startOf('month'));
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const [reverse, setReverse] = useState<{ date: Dayjs; description: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [idempotencyKey] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  const v = useQuery({ queryKey: ['landed-cost', id], queryFn: () => api<LandedDoc>(`/api/landed-costs/${id}`), enabled: !isNew });
  const state = (v.data?.state ?? 'draft') as VoucherState;
  const editable = state === 'draft'; const posted = state === 'posted';
  const decision = posted ? decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'amount', canEditPosted: can('voucher.edit_posted'), canBackdateLocked: can('voucher.backdate_locked') }) : null;
  const confirmIfDirty = useUnsavedChanges(dirty && editable);
  const postingDate = Form.useWatch('postingDate', form); const postingIso = postingDate?.isValid() ? iso(postingDate) : todayVn();
  const basis = (Form.useWatch('basis', form) ?? v.data?.basis ?? 'value') as LandedCostBasis;

  const setCostRows = useCallback((next: CostRow[], mark = true) => { costsRef.current = next; setCosts(next); if (mark) setDirty(true); }, []);
  const setDeclRows = useCallback((next: DeclRow[], mark = true) => { declRef.current = next; setDecl(next); if (mark) setDirty(true); }, []);
  useEffect(() => {
    const d = v.data; if (!d) return;
    form.setFieldsValue({ postingDate: dayjs(d.postingDate), documentDate: dayjs(d.documentDate), partyCode: d.partyCode, basis: d.basis, description: d.description });
    const loaded = d.costLines.map((c): CostRow => ({ accountCode: c.accountCode, partyCode: c.partyCode ?? '', description: c.description ?? '', amount: c.amount, vatAmount: D(c.vatAmount).isZero() ? '' : c.vatAmount }));
    setCostRows(d.state === 'draft' ? [...loaded, emptyCostRow()] : loaded, false);
    const dr = declRowsOf(d.invoices); setDeclRows(d.state === 'draft' ? [...dr, emptyDeclRow()] : dr, false);
    setPicked(d.receiptVoucherIds);
    const first = d.allocations.map((a) => a.postingDate).sort()[0]; if (first) setFrom(dayjs(first).startOf('month'));
    setDirty(false);
  }, [v.data, form, setCostRows, setDeclRows]);

  // Phiếu nhập đã ghi sổ từ ngày chọn đến ngày hạch toán (CPM không phân bổ cho phiếu nhập sau ngày của nó).
  const receipts = useQuery({ queryKey: ['landed-receipts', iso(from), postingIso], enabled: editable && can('stock_voucher.view'),
    queryFn: () => api<Receipt[]>(`/api/landed-costs/receipts?from=${iso(from)}&to=${postingIso}`) });
  const pickedLines = useMemo(() => (editable ? (receipts.data ?? []).filter((r) => picked.includes(r.id)).flatMap((r) => r.lines) : v.data?.allocations ?? []), [editable, receipts.data, picked, v.data]);
  const validCosts = costs.filter((c) => VND_AMOUNT_RE.test(c.amount));
  const costTotal = sum(validCosts.map((c) => c.amount)).toFixed(); const vatTotal = sum(validCosts.map((c) => c.vatAmount || '0')).toFixed();
  const preview = useMemo((): { alloc: Record<string, string>; error: string | null } => {
    if (!editable) return { alloc: Object.fromEntries((v.data?.allocations ?? []).map((a) => [String(a.id), a.amount])), error: null };
    if (!pickedLines.length || D(costTotal).isZero()) return { alloc: {}, error: null };
    try { return { alloc: allocateLandedCost(validCosts.map((c) => c.amount), pickedLines.map((l) => ({ id: String(l.id), qty: l.quantity, value: l.value })), basis), error: null }; }
    catch (e) { return { alloc: {}, error: (e as Error).message }; }
  }, [editable, v.data, pickedLines, validCosts, costTotal, basis]);

  const invalidate = (voucherId = id) => Promise.all([qc.invalidateQueries({ queryKey: ['landed-cost', voucherId] }), qc.invalidateQueries({ queryKey: ['vouchers'] }), qc.invalidateQueries({ queryKey: ['landed-receipts'] })]);
  const conflict = useRef<{ destroy(): void } | null>(null);
  const onErr = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      conflict.current?.destroy();
      conflict.current = Modal.confirm({ title: 'Chứng từ đã được người khác sửa', content: `${e.message}. Tải lại sẽ bỏ phần bạn đang nhập.`, okText: 'Tải lại', cancelText: 'Giữ bản đang nhập', onOk: () => invalidate() });
      return;
    }
    reportError(e, navigate);
  };
  const flushEditing = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); };
  const body = (f: FormValues) => {
    if (!picked.length) throw new Error('Chọn ít nhất một phiếu nhập ở tab Phiếu nhập');
    const costLines = costsRef.current.flatMap((c, k) => {
      if (blank(c)) return [];
      if (!c.accountCode.trim()) throw new Error(`Chi phí dòng ${k + 1}: chọn tài khoản thanh toán`);
      if (!c.amount) throw new Error(`Chi phí dòng ${k + 1}: nhập số tiền`);
      return [{ accountCode: c.accountCode.trim(), amount: c.amount, ...(c.vatAmount ? { vatAmount: c.vatAmount } : {}), description: text(c.description), ...(c.partyCode.trim() ? { partyCode: c.partyCode.trim() } : {}) }];
    });
    if (!costLines.length) throw new Error('Nhập ít nhất một dòng chi phí');
    const invoices = declaredBody(declRef.current);
    return { postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), ...(f.partyCode ? { partyCode: f.partyCode } : {}), basis: f.basis, description: text(f.description) ?? def.name,
      receiptVoucherIds: picked, costLines, ...(invoices.length ? { invoices } : {}) };
  };
  const persist = async (postAfter: boolean): Promise<LandedDoc> => {
    await flushEditing();
    const payload = body(await form.validateFields());
    if (isNew) return api<LandedDoc>('/api/landed-costs', { method: 'POST', json: { ...payload, idempotencyKey, ...(postAfter ? { autoPost: true } : {}) } });
    const saved = await api<LandedDoc>(`/api/landed-costs/${id}`, { method: 'PUT', json: { ...payload, version: v.data!.version } });
    if (!postAfter) return saved;
    return api<LandedDoc>(`/api/vouchers/${id}/post`, { method: 'POST', json: {} }).then(() => saved).catch((e: unknown) => { void invalidate(); throw e; });
  };
  const save = useMutation({ mutationFn: (postAfter: boolean) => persist(postAfter), onError: onErr,
    onSuccess: async (r, postAfter) => {
      void message.success(postAfter ? 'Đã ghi sổ' : 'Đã lưu'); setDirty(false);
      if (isNew) void navigate({ to: '/chung-tu/$type/$id', params: { type: def.code, id: r.id } });
      await invalidate(r.id);
    } });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<{ id: string; voucherNo: string | null }>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }), onError: onErr,
    onSuccess: async (r, p) => { void message.success({ unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy' }[p.act] ?? 'Xong');
      if (p.act === 'reverse') { setReverse(null); void navigate({ to: '/chung-tu/$type/$id', params: { type: def.code, id: r.id } }); } else await invalidate(); } });

  const ready = isNew || !!v.data;
  const mayEdit = editable && (isNew ? can('voucher.create') && can('stock_voucher.create') : can('voucher.update') && can('stock_voucher.update'));
  const mayPost = (isNew || canTransition(state, 'post')) && can('voucher.post') && can('stock_voucher.post');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'; const isPost = e.key === 'F9';
      if (!isSave && !isPost) return;
      e.preventDefault();
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return;
      if (isSave && ready && mayEdit && !save.isPending) save.mutate(false);
      if (isPost && ready && mayEdit && mayPost && !save.isPending) save.mutate(true);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [save, ready, mayEdit, mayPost]);
  const mayUnpost = canTransition(state, 'unpost') && decision === 'unpost_edit_post' && can('voucher.unpost');
  const mayReverse = canTransition(state, 'reverse') && decision !== 'adjust_in_open_period' && can('voucher.post');

  const accountFetcher = useMemo(() => accountFetcherFor(postingIso), [postingIso]);
  const costCols = useMemo<ColDef<CostRow>[]>(() => [
    { field: 'accountCode', headerName: 'TK thanh toán (F4)', width: 150, headerTooltip: 'Tài khoản ghi Có: 331, 111, 112...' },
    { field: 'partyCode', headerName: 'Đối tượng (F4)', width: 140, headerTooltip: 'Để trống là lấy đối tượng của chứng từ' },
    { field: 'description', headerName: 'Diễn giải', flex: 1, minWidth: 200 },
    moneyCol('amount', 'Số tiền'), moneyCol('vatAmount', 'Thuế GTGT'),
  ], []);
  const onLookup = useCallback((col: string, row: number) => { if (editable && (col === 'accountCode' || col === 'partyCode')) setLookup({ col, row }); }, [editable]);

  const pickedReceipts = (receipts.data ?? []).filter((r) => picked.includes(r.id));
  const allocTotal = sum(Object.values(preview.alloc)).toFixed();
  const receiptTab = editable ? (<>
    <Space style={{ marginBottom: 8 }} wrap>
      <label htmlFor="receipt-from">Phiếu nhập từ ngày</label>
      <DatePicker id="receipt-from" format="DD/MM/YYYY" allowClear={false} value={from} onChange={(d) => d && setFrom(d)} />
      <span style={muted}>đến ngày hạch toán {formatVnDate(postingIso)}</span>
    </Space>
    <Table<Receipt> size="small" rowKey="id" pagination={false} scroll={{ y: 300 }} loading={receipts.isFetching} dataSource={receipts.data ?? []} data-testid="receipts"
      locale={{ emptyText: receipts.error ? (receipts.error as Error).message : 'Không có phiếu nhập kho mua hàng hoặc chứng từ mua hàng đã ghi sổ trong khoảng ngày này' }}
      rowSelection={{ selectedRowKeys: picked, onChange: (keys) => { setPicked(keys as string[]); setDirty(true); } }}
      columns={[
        { title: 'Số chứng từ', dataIndex: 'voucherNo', width: 140 }, { title: 'Loại', dataIndex: 'voucherType', width: 80 },
        { title: 'Ngày', dataIndex: 'postingDate', width: 110, render: (s: string) => formatVnDate(s) }, { title: 'Nhà cung cấp', dataIndex: 'partyName', render: (s: string | null) => s ?? '' },
        { title: 'Số dòng', width: 90, align: 'right', render: (_: unknown, r) => r.lines.length }, { title: 'Giá trị nhập', dataIndex: 'value', width: 150, align: 'right', render: fmt },
      ]} />
    <div style={{ marginTop: 8 }}>Đã chọn <b>{pickedReceipts.length}</b> chứng từ, giá trị nhập <b>{formatVnNumber(sum(pickedReceipts.map((r) => r.value)).toFixed())}</b></div>
  </>) : <div style={muted}>Chứng từ đã ghi sổ: các dòng nhập được phân bổ xem ở tab Phân bổ.</div>;
  const costTab = (<>
    <KeyboardGrid<CostRow> rows={costs} columns={costCols} readOnly={!editable} onRowsChange={setCostRows} addRowTemplate={emptyCostRow} onLookup={onLookup} height={240} />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
      <span>Chi phí: <b>{formatVnNumber(costTotal)}</b></span><span>Thuế GTGT: <b>{formatVnNumber(vatTotal)}</b></span><b>Cộng thanh toán: {formatVnNumber(sum([costTotal, vatTotal]).toFixed())}</b>
    </div>
  </>);
  const allocTab = (<>
    {preview.error && <Alert type="error" showIcon message={preview.error} style={{ marginBottom: 8 }} />}
    <Table<ReceiptLine> size="small" rowKey="id" pagination={false} scroll={{ y: 320 }} dataSource={pickedLines} data-testid="allocations" locale={{ emptyText: 'Chọn phiếu nhập và nhập chi phí để xem phân bổ' }}
      columns={[
        { title: 'Chứng từ nhập', dataIndex: 'voucherNo', width: 140 }, { title: 'Mã hàng', dataIndex: 'itemCode', width: 120 }, { title: 'Tên hàng', dataIndex: 'itemName' },
        { title: 'Kho', dataIndex: 'warehouseCode', width: 100 }, { title: 'TK kho', dataIndex: 'accountCode', width: 90 },
        { title: 'Số lượng', dataIndex: 'quantity', width: 110, align: 'right', render: fmt }, { title: 'Giá trị nhập', dataIndex: 'value', width: 140, align: 'right', render: fmt },
        { title: 'Chi phí phân bổ', key: 'alloc', width: 140, align: 'right', render: (_: unknown, l) => fmt(preview.alloc[String(l.id)]) },
        { title: 'Giá trị sau phân bổ', key: 'after', width: 150, align: 'right', render: (_: unknown, l) => fmt(D(l.value).plus(preview.alloc[String(l.id)] ?? '0').toFixed()) },
      ]} />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
      <span>{BASIS_LABEL[basis]}</span><b>Đã phân bổ: {formatVnNumber(allocTotal)} / {formatVnNumber(editable ? costTotal : allocTotal)}</b>
    </div>
    {editable && <div style={{ ...muted, marginTop: 4 }}>Phân bổ xem trước; máy chủ tính lại theo giá trị nhập mới nhất khi lưu.</div>}
  </>);
  const ledgerTab = (v.data?.lines.length ?? 0) > 0
    ? <Table size="small" pagination={false} rowKey="lineNo" dataSource={v.data!.lines} data-testid="ledger-lines" columns={[
      { title: 'Tài khoản', dataIndex: 'accountCode', width: 110 }, { title: 'Tên tài khoản', dataIndex: 'accountName' }, { title: 'Hàng', dataIndex: 'itemCode', width: 120, render: (s: string | null) => s ?? '' },
      { title: 'Kho', dataIndex: 'warehouseCode', width: 100, render: (s: string | null) => s ?? '' }, { title: 'Đối tượng', dataIndex: 'partyCode', width: 120, render: (s: string | null) => s ?? '' },
      { title: 'Nợ', dataIndex: 'debit', align: 'right', width: 140, render: fmt }, { title: 'Có', dataIndex: 'credit', align: 'right', width: 140, render: fmt }]} />
    : <div style={muted}>Bút toán hiện sau khi lưu: Nợ tài khoản kho của từng dòng nhập, Nợ 1331 thuế GTGT / Có tài khoản thanh toán.</div>;

  return (
    <Card title={<Space><span>{def.name} {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
        {mayEdit && <Button onClick={() => save.mutate(false)} type="primary" loading={save.isPending} disabled={!ready}>Lưu (Ctrl+S)</Button>}
        {mayEdit && mayPost && <Button onClick={() => save.mutate(true)} disabled={!ready || save.isPending}>Ghi sổ (F9)</Button>}
        {!isNew && mayUnpost && <Button onClick={() => confirmIfDirty(() => action.mutate({ act: 'unpost' }))}>Bỏ ghi sổ</Button>}
        {!isNew && mayReverse && v.data && <Button onClick={() => confirmIfDirty(() => { const p = v.data!.postingDate; const today = todayVn(); setReverse({ date: dayjs(today >= p ? today : p), description: `Đảo chứng từ ${v.data!.voucherNo} ngày ${formatVnDate(p)}` }); })}>Đảo</Button>}
        {!isNew && editable && canTransition(state, 'discard') && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy chứng từ?', content: 'Số chứng từ (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
      </Space>}>
      {v.error && <Alert type="error" showIcon message={(v.error as Error).message} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" disabled={!editable} onValuesChange={() => setDirty(true)} initialValues={{ postingDate: dayjs(todayVn()), documentDate: dayjs(todayVn()), basis: 'value' }}>
        <Row gutter={12}>
          <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true, message: 'Nhập ngày hạch toán' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true, message: 'Nhập ngày chứng từ' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={8}><Form.Item label="Đối tượng" name="partyCode" tooltip="Nhà cung cấp dịch vụ (vận chuyển, bốc xếp...); dòng chi phí không ghi đối tượng thì lấy đối tượng này"><LookupSelect catalog="party" quickAddFields={quickAdd} allowClear /></Form.Item></Col>
          <Col span={8}><Form.Item label="Phân bổ" name="basis" rules={[{ required: true }]}><Select options={(Object.keys(BASIS_LABEL) as LandedCostBasis[]).map((b) => ({ value: b, label: BASIS_LABEL[b] }))} /></Form.Item></Col>
          <Col span={24}><Form.Item label="Diễn giải" name="description"><Input maxLength={500} /></Form.Item></Col>
        </Row>
      </Form>
      <Tabs size="small" items={[
        { key: 'receipts', label: `Phiếu nhập (${picked.length})`, forceRender: true, children: receiptTab }, { key: 'costs', label: 'Chi phí', forceRender: true, children: costTab },
        { key: 'alloc', label: 'Phân bổ', forceRender: true, children: allocTab }, { key: 'invoices', label: 'Hóa đơn', forceRender: true, children: <DeclaredInvoices rows={decl} onRowsChange={setDeclRows} editable={editable} /> },
        { key: 'ledger', label: 'Hạch toán', forceRender: true, children: ledgerTab },
      ]} />
      {!isNew && <Attachments voucherId={id} canEdit={can('voucher.update')} />}
      <PickDialog open={!!lookup} catalog={lookup?.col === 'partyCode' ? 'party' : 'account'} {...(lookup?.col === 'accountCode' ? { fetcher: accountFetcher } : {})}
        onPick={(code) => { if (lookup) { const copy = [...costsRef.current]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code }; setCostRows(copy); } }} onClose={() => setLookup(null)} />
      <Modal open={!!reverse} title="Lập chứng từ đảo" okText="Lập chứng từ đảo" cancelText="Không" destroyOnHidden onCancel={() => setReverse(null)}
        okButtonProps={{ loading: action.isPending, disabled: !reverse?.date }}
        onOk={() => { if (reverse) action.mutate({ act: 'reverse', body: { postingDate: iso(reverse.date), ...(reverse.description.trim() ? { description: reverse.description.trim() } : {}) } }); }}>
        {reverse && <Space direction="vertical" style={{ width: '100%' }}>
          <label htmlFor="reverse-date">Ngày hạch toán chứng từ đảo</label>
          <DatePicker id="reverse-date" format="DD/MM/YYYY" allowClear={false} value={reverse.date} disabledDate={(d) => !!v.data && d.isBefore(dayjs(v.data.postingDate), 'day')} onChange={(d) => d && setReverse({ ...reverse, date: d })} />
          <label htmlFor="reverse-desc">Diễn giải chứng từ đảo</label>
          <Input id="reverse-desc" value={reverse.description} maxLength={500} onChange={(e) => setReverse({ ...reverse, description: e.target.value })} />
        </Space>}
      </Modal>
    </Card>
  );
}
