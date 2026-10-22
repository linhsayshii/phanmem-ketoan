import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { canTransition, D, decideEdit, formatVnDate, formatVnNumber, parseVnNumber, todayVn, type StockVoucherType, type VoucherState, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useUnsavedChanges } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { STATE_LABEL } from './VoucherList.js';
import { PickDialog, iso, quickAdd, reportError, text } from './voucherCommon.js';
import { dateCell, emptyStockRow, itemsBody, kindLabel, kindsOf, QTY_RE, rowAmount, type StockRow } from './stockCalc.js';

// Phiếu nhập kho, xuất kho, chuyển kho (PNK, PXK, CK): lập qua /api/stock-vouchers; ghi sổ, bỏ ghi sổ, đảo, hủy qua /api/vouchers/:id/*.
// Phiếu xuất, chuyển ghi sổ theo giá tạm tính; giá vốn thật do kỳ tính giá vốn xác định sau.
interface ItemDto { lineNo: number; itemCode: string; itemName: string; uomCode: string; quantity: string; unitPrice: string | null; unitCost: string | null; amount: string;
  lotNo: string | null; mfgDate: string | null; expiryDate: string | null }
interface LedgerDto { lineNo: number; accountCode: string; accountName: string; debit: string; credit: string; itemCode: string | null; warehouseCode: string | null }
interface StockDoc { id: string; voucherType: string; voucherNo: string | null; state: string; postingDate: string; documentDate: string; description: string | null; partyCode: string | null; personName: string | null;
  version: number; periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean; stockKind: string | null; warehouseCode: string | null; destWarehouseCode: string | null; items: ItemDto[]; ledgerLines: LedgerDto[];
  warnings?: { code: string; message: string }[] }
interface FormValues { postingDate: Dayjs; documentDate: Dayjs; stockKind: string; warehouseCode?: string | null; destWarehouseCode?: string | null; partyCode?: string | null; personName?: string | null; description?: string | null }
interface ItemInfo { name: string; baseUom: string; tracking: string }

const plain = (s: string | null | undefined): string => (s == null ? '' : D(s).toFixed());
const money = (v: string | null | undefined): string => (!v || D(v).isZero() ? '' : formatVnNumber(v, D(v).decimalPlaces()));
const numCol = (field: keyof StockRow, headerName: string, width = 110): ColDef<StockRow> => ({ field, headerName, width, cellClass: 'ag-right-aligned-cell',
  valueFormatter: (p) => { const s = p.value as string | undefined; return s ? formatVnNumber(s, D(s).decimalPlaces()) : ''; },
  valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && QTY_RE.test(n) ? n : p.oldValue; } });
const dateCol = (field: keyof StockRow, headerName: string): ColDef<StockRow> => ({ field, headerName, width: 110, headerTooltip: 'Ngày/tháng/năm' });

export default function StockVoucher({ def, id }: { def: VoucherTypeDef; id: string }) {
  const type = def.code as StockVoucherType;
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const wanted = (useSearch({ strict: false }) as { kind?: string }).kind;
  const [form] = Form.useForm<FormValues>();
  const [rows, setRows] = useState<StockRow[]>(() => [emptyStockRow()]);
  const rowsRef = useRef(rows);
  const [lookupRow, setLookupRow] = useState<number | null>(null);
  const [info, setInfo] = useState<Record<string, ItemInfo | null>>({});
  const [serverCost, setServerCost] = useState<Record<number, { amount: string; unitCost: string | null }>>({});
  const [reverse, setReverse] = useState<{ date: Dayjs; description: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [idempotencyKey] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  const v = useQuery({ queryKey: ['stock-voucher', id], queryFn: () => api<StockDoc>(`/api/stock-vouchers/${id}`), enabled: !isNew });
  const state = (v.data?.state ?? 'draft') as VoucherState;
  const editable = state === 'draft'; const posted = state === 'posted';
  const decision = posted ? decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'amount', canEditPosted: can('voucher.edit_posted'), canBackdateLocked: can('voucher.backdate_locked') }) : null;
  const confirmIfDirty = useUnsavedChanges(dirty && editable);
  const kinds = kindsOf(type);
  const stockKind = Form.useWatch('stockKind', form) ?? v.data?.stockKind ?? wanted ?? kinds[0]!.code;
  const withPrice = type === 'PNK'; const transfer = type === 'CK';
  const warehouse = Form.useWatch('warehouseCode', form); const postingDate = Form.useWatch('postingDate', form);
  const postingIso = postingDate?.isValid() ? iso(postingDate) : todayVn();

  const setAll = useCallback((next: StockRow[]) => { rowsRef.current = next; setRows(next); }, []);
  const changeRows = useCallback((next: StockRow[]) => { setAll(next); setDirty(true); }, [setAll]);

  useEffect(() => {
    const d = v.data; if (!d) return;
    form.setFieldsValue({ postingDate: dayjs(d.postingDate), documentDate: dayjs(d.documentDate), stockKind: d.stockKind ?? kinds[0]!.code, warehouseCode: d.warehouseCode, destWarehouseCode: d.destWarehouseCode,
      partyCode: d.partyCode, personName: d.personName, description: d.description });
    const loaded = d.items.map((it): StockRow => ({ itemCode: it.itemCode, uomCode: it.uomCode, quantity: plain(it.quantity), unitPrice: plain(it.unitPrice), lotNo: it.lotNo ?? '', mfgDate: dateCell(it.mfgDate), expiryDate: dateCell(it.expiryDate) }));
    setAll(d.state === 'draft' ? [...loaded, emptyStockRow()] : loaded);
    setInfo((m) => ({ ...m, ...Object.fromEntries(d.items.map((it) => [it.itemCode, { name: it.itemName, baseUom: it.uomCode, tracking: it.lotNo || it.expiryDate ? 'lot' : 'none' }])) }));
    setServerCost(Object.fromEntries(d.items.map((it) => [it.lineNo, { amount: it.amount, unitCost: it.unitCost }])));
    setDirty(false);
  }, [v.data, form, kinds, setAll]);

  // Thông tin hàng (tên, ĐVT cơ sở, theo dõi lô) tra theo mã gõ trong lưới; mã lạ ghi null để không tra lại.
  useEffect(() => {
    for (const code of new Set(rows.map((r) => r.itemCode.trim()).filter(Boolean))) {
      if (code in info) continue;
      setInfo((m) => ({ ...m, [code]: null }));
      void api<{ code: string; name: string; baseUom: string; tracking: string }[]>(`/api/lookups/items?q=${encodeURIComponent(code)}&size=20`).then((list) => {
        const hit = list.find((r) => r.code === code);
        if (!hit) return;
        setInfo((m) => ({ ...m, [code]: { name: hit.name, baseUom: hit.baseUom, tracking: hit.tracking } }));
        // ĐVT còn trống thì điền ĐVT cơ sở của hàng
        const cur = rowsRef.current; if (cur.some((r) => r.itemCode.trim() === code && !r.uomCode)) setAll(cur.map((r) => (r.itemCode.trim() === code && !r.uomCode ? { ...r, uomCode: hit.baseUom } : r)));
      }).catch(() => undefined);
    }
  }, [rows, info, setAll]);

  // Tồn khả dụng của các hàng trên lưới tại kho đi, đến ngày hạch toán.
  const codes = useMemo(() => [...new Set(rows.map((r) => r.itemCode.trim()).filter((c) => c && info[c]))], [rows, info]);
  const stocks = useQueries({ queries: codes.map((code) => ({ queryKey: ['on-hand', code, warehouse, postingIso], enabled: !!warehouse && can('stock_voucher.view'), retry: false,
    queryFn: () => api<{ quantity: string }>(`/api/inventory/on-hand?itemCode=${encodeURIComponent(code)}&warehouseCode=${encodeURIComponent(warehouse!)}&date=${postingIso}`) })) });

  const invalidate = (voucherId = id) => Promise.all([qc.invalidateQueries({ queryKey: ['stock-voucher', voucherId] }), qc.invalidateQueries({ queryKey: ['vouchers'] }), qc.invalidateQueries({ queryKey: ['on-hand'] })]);
  const conflict = useRef<{ destroy(): void } | null>(null);
  const onErr = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      conflict.current?.destroy();
      conflict.current = Modal.confirm({ title: 'Phiếu đã được người khác sửa', content: `${e.message}. Tải lại sẽ bỏ phần bạn đang nhập.`, okText: 'Tải lại', cancelText: 'Giữ bản đang nhập', onOk: () => invalidate() });
      return;
    }
    reportError(e, navigate);
  };
  const flushEditing = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); };
  const body = (f: FormValues) => {
    const items = itemsBody(rowsRef.current, withPrice);
    if (!items.length) throw new Error('Nhập ít nhất một dòng hàng');
    if (!f.warehouseCode) throw new Error(transfer ? 'Chọn kho xuất' : 'Chọn kho');
    if (transfer && !f.destWarehouseCode) throw new Error('Chọn kho nhận');
    return { voucherType: type, stockKind: f.stockKind, postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), warehouseCode: f.warehouseCode, ...(transfer ? { destWarehouseCode: f.destWarehouseCode } : {}),
      ...(!transfer && f.partyCode ? { partyCode: f.partyCode } : {}), personName: text(f.personName), description: text(f.description) ?? kindLabel(type, f.stockKind), items };
  };
  const persist = async (postAfter: boolean): Promise<StockDoc> => {
    await flushEditing();
    const payload = body(await form.validateFields());
    const saved = isNew ? await api<StockDoc>('/api/stock-vouchers', { method: 'POST', json: { ...payload, idempotencyKey } })
      : await api<StockDoc>(`/api/stock-vouchers/${id}`, { method: 'PUT', json: { ...payload, version: v.data!.version } });
    if (!postAfter) return saved;
    // đã lưu mà ghi sổ lỗi (thiếu tồn, kỳ khóa...): nạp lại để version khớp bản vừa lưu
    return api<StockDoc>(`/api/vouchers/${saved.id}/post`, { method: 'POST', json: {} }).then(() => saved).catch((e: unknown) => { void navigate({ to: '/chung-tu/$type/$id', params: { type, id: saved.id }, replace: true }); void invalidate(saved.id); throw e; });
  };
  const save = useMutation({ mutationFn: (postAfter: boolean) => persist(postAfter), onError: onErr,
    onSuccess: async (r, postAfter) => {
      void message.success(postAfter ? 'Đã ghi sổ' : 'Đã lưu');
      for (const w of r.warnings ?? []) void message.warning({ content: w.message, duration: 10 });
      setDirty(false);
      if (isNew) void navigate({ to: '/chung-tu/$type/$id', params: { type, id: r.id } });
      await invalidate(r.id);
    } });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<{ id: string; voucherNo: string | null }>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }), onError: onErr,
    onSuccess: async (r, p) => { void message.success({ unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy' }[p.act] ?? 'Xong');
      if (p.act === 'reverse') { setReverse(null); void navigate({ to: '/chung-tu/$type/$id', params: { type, id: r.id } }); } else await invalidate(); } });

  const ready = isNew || !!v.data;
  const mayEdit = editable && (isNew ? can('stock_voucher.create') : can('stock_voucher.update'));
  const mayPost = (isNew || canTransition(state, 'post')) && can('voucher.post');
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

  const columns = useMemo<ColDef<StockRow>[]>(() => [
    { field: 'itemCode', headerName: 'Mã hàng (F4)', width: 130 },
    { colId: 'itemName', headerName: 'Tên hàng', flex: 1, minWidth: 160, editable: false, valueGetter: (p) => (p.data ? info[p.data.itemCode.trim()]?.name ?? '' : '') },
    { field: 'uomCode', headerName: 'ĐVT (F4)', width: 100 },
    numCol('quantity', 'Số lượng'),
    ...(withPrice ? [numCol('unitPrice', 'Đơn giá', 120)] : []),
    { colId: 'amount', headerName: withPrice ? 'Thành tiền' : 'Giá trị (giá tạm tính)', width: 150, editable: false, cellClass: 'ag-right-aligned-cell',
      valueGetter: (p) => { if (!p.data) return ''; if (withPrice) return rowAmount(p.data); const k = serverCost[p.node?.rowIndex != null ? p.node.rowIndex + 1 : 0]; return editable ? '' : k?.amount ?? ''; },
      valueFormatter: (p) => money(p.value as string), headerTooltip: withPrice ? 'Số lượng x đơn giá' : 'Hiện sau khi lưu: số lượng x giá vốn tạm tính' },
    { field: 'lotNo', headerName: 'Số lô', width: 100 }, dateCol('mfgDate', 'Ngày sản xuất'), dateCol('expiryDate', 'Hạn dùng'),
  ], [withPrice, info, serverCost, editable]);
  const total = rows.reduce((s, r) => s.plus(withPrice ? rowAmount(r) || '0' : '0'), D(0)).toFixed();
  const savedTotal = Object.values(serverCost).reduce((s, k) => s.plus(k.amount), D(0)).toFixed();
  const onLookup = useCallback((col: string, row: number) => { if (editable && (col === 'itemCode' || col === 'uomCode')) setLookupRow(row); }, [editable]);
  const lookupCol = useRef('itemCode');
  const pick = (code: string) => {
    if (lookupRow === null) return;
    const cur = rowsRef.current; const old = cur[lookupRow]; if (!old) return;
    changeRows(cur.map((r, i) => (i === lookupRow ? { ...r, itemCode: code, uomCode: '' } : r)));
  };

  const title = `${def.name}${kindLabel(type, stockKind) ? ` - ${kindLabel(type, stockKind)}` : ''}`;
  return (
    <Card title={<Space><span>{title} {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
        {mayEdit && <Button onClick={() => save.mutate(false)} type="primary" loading={save.isPending} disabled={!ready}>Lưu (Ctrl+S)</Button>}
        {mayEdit && mayPost && <Button onClick={() => save.mutate(true)} disabled={!ready || save.isPending}>Ghi sổ (F9)</Button>}
        {!isNew && mayUnpost && <Button onClick={() => confirmIfDirty(() => action.mutate({ act: 'unpost' }))}>Bỏ ghi sổ</Button>}
        {!isNew && mayReverse && v.data && <Button onClick={() => confirmIfDirty(() => { const p = v.data!.postingDate; const today = todayVn(); setReverse({ date: dayjs(today >= p ? today : p), description: `Đảo chứng từ ${v.data!.voucherNo} ngày ${formatVnDate(p)}` }); })}>Đảo</Button>}
        {!isNew && editable && canTransition(state, 'discard') && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy phiếu?', content: 'Số phiếu (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
      </Space>}>
      {v.error && <Alert type="error" showIcon message={(v.error as Error).message} style={{ marginBottom: 12 }} />}
      {posted && !withPrice && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Phiếu ghi sổ theo giá tạm tính; giá vốn thật được xác định khi tính giá vốn cuối kỳ." />}
      <Form form={form} layout="vertical" disabled={!editable} onValuesChange={() => setDirty(true)}
        initialValues={{ postingDate: dayjs(todayVn()), documentDate: dayjs(todayVn()), stockKind: kinds.some((k) => k.code === wanted) ? wanted : kinds[0]!.code }}>
        <Row gutter={12}>
          <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true, message: 'Nhập ngày hạch toán' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true, message: 'Nhập ngày chứng từ' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={6}><Form.Item label="Loại nghiệp vụ" name="stockKind" rules={[{ required: true }]}><Select options={kinds.map((k) => ({ value: k.code, label: k.label }))} /></Form.Item></Col>
          <Col span={5}><Form.Item label={transfer ? 'Kho xuất (F4)' : 'Kho (F4)'} name="warehouseCode" rules={[{ required: true, message: 'Chọn kho' }]}><LookupSelect catalog="warehouse" quickAddFields={quickAdd} /></Form.Item></Col>
          {transfer && <Col span={5}><Form.Item label="Kho nhận (F4)" name="destWarehouseCode" rules={[{ required: true, message: 'Chọn kho nhận' }]}><LookupSelect catalog="warehouse" /></Form.Item></Col>}
          {!transfer && <Col span={8}><Form.Item label="Đối tượng" name="partyCode"><LookupSelect catalog="party" quickAddFields={quickAdd} allowClear /></Form.Item></Col>}
          <Col span={6}><Form.Item label={type === 'PNK' ? 'Người giao' : 'Người nhận'} name="personName"><Input maxLength={200} /></Form.Item></Col>
          <Col span={18}><Form.Item label="Diễn giải" name="description"><Input /></Form.Item></Col>
        </Row>
      </Form>
      <KeyboardGrid<StockRow> rows={rows} columns={columns} readOnly={!editable} onRowsChange={changeRows} addRowTemplate={emptyStockRow}
        onLookup={(col, row) => { lookupCol.current = col; onLookup(col, row); }} height={300} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginTop: 8, flexWrap: 'wrap' }}>
        <span data-testid="on-hand">{codes.length > 0 && warehouse ? <>Tồn khả dụng tại kho {warehouse}: {codes.map((c, i) => <span key={c} style={{ marginRight: 12 }}>{c}: <b>{stocks[i]?.data ? formatVnNumber(stocks[i]!.data!.quantity, D(stocks[i]!.data!.quantity).decimalPlaces()) : '...'}</b> {info[c]?.baseUom ?? ''}</span>)}</> : null}</span>
        <b>{withPrice ? `Cộng: ${formatVnNumber(total)}` : posted || savedTotal !== '0' ? `Giá trị giá tạm tính: ${formatVnNumber(savedTotal)}` : ''}</b>
      </div>
      {(v.data?.ledgerLines.length ?? 0) > 0 && <Table size="small" style={{ marginTop: 12 }} pagination={false} rowKey="lineNo" dataSource={v.data!.ledgerLines} data-testid="ledger-lines" columns={[
        { title: 'Tài khoản', dataIndex: 'accountCode', width: 110 }, { title: 'Tên tài khoản', dataIndex: 'accountName' }, { title: 'Hàng', dataIndex: 'itemCode', width: 120, render: (s: string | null) => s ?? '' },
        { title: 'Kho', dataIndex: 'warehouseCode', width: 100, render: (s: string | null) => s ?? '' },
        { title: 'Nợ', dataIndex: 'debit', align: 'right', width: 140, render: money }, { title: 'Có', dataIndex: 'credit', align: 'right', width: 140, render: money }]} />}
      <PickDialog open={lookupRow !== null} catalog={lookupCol.current === 'uomCode' ? 'uom' : 'item'} fetcher={lookupCol.current === 'itemCode' ? async (q) => (await api<{ id: number; code: string; name: string }[]>(`/api/lookups/items?q=${encodeURIComponent(q)}`)) : undefined as never}
        onPick={(code) => { if (lookupCol.current === 'uomCode') { const cur = rowsRef.current; changeRows(cur.map((r, i) => (i === lookupRow ? { ...r, uomCode: code } : r))); } else pick(code); }} onClose={() => setLookupRow(null)} />
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
