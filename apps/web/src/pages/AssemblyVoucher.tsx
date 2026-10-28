import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Col, DatePicker, Dropdown, Form, Input, Modal, Row, Segmented, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { canTransition, D, decideEdit, formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, todayVn, type VoucherState, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Section, useUnsavedChanges } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { STATE_LABEL } from './VoucherList.js';
import { PickDialog, iso, quickAdd, reportError, text } from './voucherCommon.js';
import { QTY_RE } from './stockCalc.js';

// Phiếu lắp ráp, tháo dỡ (LR): lập qua /api/assembly-vouchers; ghi sổ, bỏ ghi sổ, đảo, hủy qua /api/vouchers/:id/*.
// Hai lưới: thành phẩm và linh kiện. Tỷ lệ giá trị chỉ ở chiều nhập kho (thành phẩm khi lắp ráp, linh kiện khi tháo dỡ).
type Mode = 'assembly' | 'disassembly';
interface Row { itemCode: string; uomCode: string; quantity: string; costRatio: string; lotNo: string; expiryDate: string }
interface ItemDto { lineNo: number; itemCode: string; uomCode: string; lotNo: string | null; expiryDate: string | null; quantity: string; direction?: string; costRatio: string | null; amount: string }
interface LedgerDto { lineNo: number; accountCode: string; accountName: string; debit: string; credit: string; itemCode: string | null; warehouseCode: string | null }
interface Doc { id: string; voucherNo: string | null; state: string; postingDate: string; documentDate: string; description: string | null; personName: string | null; version: number;
  periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean; warehouseCode: string | null; items: (ItemDto & { direction: string })[]; ledgerLines: LedgerDto[];
  assembly: { mode: Mode; extraCost: string; extraCostAccountCode: string | null } | null }
interface FormValues { postingDate: Dayjs; documentDate: Dayjs; warehouseCode?: string | null; personName?: string | null; description?: string | null; extraCost?: string; extraCostAccountCode?: string | null }

const blank = (): Row => ({ itemCode: '', uomCode: '', quantity: '', costRatio: '', lotNo: '', expiryDate: '' });
const money = (v: string | null | undefined): string => (!v || D(v).isZero() ? '' : formatVnNumber(v, D(v).decimalPlaces()));
const numCol = (field: keyof Row, headerName: string, re: RegExp, width = 120): ColDef<Row> => ({ field, headerName, width, cellClass: 'ag-right-aligned-cell',
  valueFormatter: (p) => { const s = p.value as string | undefined; return s ? formatVnNumber(s, D(s).decimalPlaces()) : ''; },
  valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && re.test(n) ? n : p.oldValue; } });

const cols = (ratio: boolean): ColDef<Row>[] => [{ field: 'itemCode', headerName: 'Mã hàng (F4)', width: 130 }, { field: 'uomCode', headerName: 'ĐVT (F4)', width: 90 }, numCol('quantity', 'Số lượng', QTY_RE),
  ...(ratio ? [numCol('costRatio', 'Tỷ lệ giá trị (%)', /^\d{1,3}(\.\d{1,4})?$/, 150)] : []),
  { field: 'lotNo', headerName: 'Số lô', width: 90 }, { field: 'expiryDate', headerName: 'Hạn dùng', width: 100, headerTooltip: 'Ngày/tháng/năm' }];

export default function AssemblyVoucher({ def, id }: { def: VoucherTypeDef; id: string }) {
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const wanted = (useSearch({ strict: false }) as { kind?: string }).kind;
  const [form] = Form.useForm<FormValues>();
  const [mode, setMode] = useState<Mode>(wanted === 'disassembly' ? 'disassembly' : 'assembly');
  const [outputs, setOutputs] = useState<Row[]>([blank()]); const [components, setComponents] = useState<Row[]>([blank()]);
  const outRef = useRef(outputs); const compRef = useRef(components);
  const [reverse, setReverse] = useState<{ date: Dayjs; description: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const v = useQuery({ queryKey: ['stock-voucher', id], queryFn: () => api<Doc>(`/api/stock-vouchers/${id}`), enabled: !isNew });
  const state = (v.data?.state ?? 'draft') as VoucherState;
  const editable = state === 'draft'; const posted = state === 'posted';
  const decision = posted ? decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'amount', canEditPosted: can('voucher.edit_posted'), canBackdateLocked: can('voucher.backdate_locked') }) : null;
  const confirmIfDirty = useUnsavedChanges(dirty && editable);
  const assembling = mode === 'assembly';

  const setOut = useCallback((r: Row[]) => { outRef.current = r; setOutputs(r); setDirty(true); }, []);
  const setComp = useCallback((r: Row[]) => { compRef.current = r; setComponents(r); setDirty(true); }, []);

  useEffect(() => {
    const d = v.data; if (!d) return;
    const m = d.assembly?.mode ?? 'assembly'; setMode(m);
    form.setFieldsValue({ postingDate: dayjs(d.postingDate), documentDate: dayjs(d.documentDate), warehouseCode: d.warehouseCode, personName: d.personName, description: d.description,
      extraCost: d.assembly?.extraCost && d.assembly.extraCost !== '0' ? d.assembly.extraCost : '', extraCostAccountCode: d.assembly?.extraCostAccountCode ?? null });
    // Lắp ráp: dòng nhập = thành phẩm; tháo dỡ: dòng nhập = linh kiện.
    const rowsOf = (dir: string) => d.items.filter((i) => i.direction === dir).map((i): Row => ({ itemCode: i.itemCode, uomCode: i.uomCode, quantity: D(i.quantity).toFixed(), costRatio: i.costRatio ? D(i.costRatio).toFixed() : '',
      lotNo: i.lotNo ?? '', expiryDate: i.expiryDate ? formatVnDate(i.expiryDate) : '' }));
    const outs = m === 'assembly' ? rowsOf('in') : rowsOf('out'); const comps = m === 'assembly' ? rowsOf('out') : rowsOf('in');
    const pad = (r: Row[]) => (d.state === 'draft' ? [...r, blank()] : r);
    outRef.current = pad(outs); compRef.current = pad(comps); setOutputs(outRef.current); setComponents(compRef.current);
    setDirty(false);
  }, [v.data, form]);

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
  const lines = (rows: Row[], what: string, ratio: boolean) => rows.flatMap((r, k) => {
    if (Object.values(r).every((x) => !x.trim())) return [];
    if (!r.itemCode.trim()) throw new Error(`${what} dòng ${k + 1}: nhập mã hàng`);
    if (!QTY_RE.test(r.quantity) || D(r.quantity).lte(0)) throw new Error(`${what} dòng ${k + 1}: số lượng phải lớn hơn 0`);
    const expiry = r.expiryDate.trim() ? parseVnDate(r.expiryDate.trim()) : null;
    if (r.expiryDate.trim() && !expiry) throw new Error(`${what} dòng ${k + 1}: hạn dùng phải có dạng ngày/tháng/năm`);
    return [{ itemCode: r.itemCode.trim(), ...(r.uomCode.trim() ? { uomCode: r.uomCode.trim() } : {}), quantity: r.quantity, ...(ratio && r.costRatio ? { costRatio: r.costRatio } : {}),
      ...(r.lotNo.trim() ? { lotNo: r.lotNo.trim() } : {}), ...(expiry ? { expiryDate: expiry } : {}) }];
  });
  const body = (f: FormValues) => {
    if (!f.warehouseCode) throw new Error('Chọn kho');
    const outs = lines(outRef.current, 'Thành phẩm', assembling); const comps = lines(compRef.current, 'Linh kiện', !assembling);
    if (!outs.length) throw new Error('Nhập ít nhất một thành phẩm'); if (!comps.length) throw new Error('Nhập ít nhất một linh kiện');
    const extra = (f.extraCost ?? '').trim();
    if (extra && !/^\d{1,16}$/.test(extra)) throw new Error('Chi phí phải là số nguyên VND');
    return { mode, postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), warehouseCode: f.warehouseCode, personName: text(f.personName), description: text(f.description) ?? (assembling ? 'Lắp ráp' : 'Tháo dỡ'),
      outputs: outs, components: comps, ...(extra ? { extraCost: extra } : {}), ...(extra && f.extraCostAccountCode ? { extraCostAccountCode: f.extraCostAccountCode } : {}) };
  };
  const persist = async (postAfter: boolean): Promise<Doc> => {
    await flushEditing();
    const payload = body(await form.validateFields());
    const saved = isNew ? await api<Doc>('/api/assembly-vouchers', { method: 'POST', json: payload })
      : await api<Doc>(`/api/assembly-vouchers/${id}`, { method: 'PUT', json: { ...payload, version: v.data!.version } });
    if (!postAfter) return saved;
    return api<Doc>(`/api/vouchers/${saved.id}/post`, { method: 'POST', json: {} }).then(() => saved).catch((e: unknown) => { void navigate({ to: '/chung-tu/$type/$id', params: { type: def.code, id: saved.id }, replace: true }); void invalidate(saved.id); throw e; });
  };
  const save = useMutation({ mutationFn: (postAfter: boolean) => persist(postAfter), onError: onErr,
    onSuccess: async (r, postAfter) => {
      void message.success(postAfter ? 'Đã ghi sổ' : 'Đã lưu');
      setDirty(false);
      if (isNew) void navigate({ to: '/chung-tu/$type/$id', params: { type: def.code, id: r.id } });
      await invalidate(r.id);
    } });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<{ id: string; voucherNo: string | null }>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }), onError: onErr,
    onSuccess: async (r, p) => { void message.success({ unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy' }[p.act] ?? 'Xong');
      if (p.act === 'reverse') { setReverse(null); void navigate({ to: '/chung-tu/$type/$id', params: { type: def.code, id: r.id } }); } else await invalidate(); } });

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

  // F4 trên ô Mã hàng hoặc ĐVT của một trong hai lưới mở hộp chọn danh mục
  const [look, setLook] = useState<{ side: 'out' | 'comp'; row: number; col: string } | null>(null);
  const onLookup = (side: 'out' | 'comp') => (col: string, row: number) => { if (editable && (col === 'itemCode' || col === 'uomCode')) setLook({ side, row, col }); };
  const pickCode = (code: string) => {
    if (!look) return;
    const ref = look.side === 'out' ? outRef : compRef; const set = look.side === 'out' ? setOut : setComp;
    set(ref.current.map((r, i) => (i === look.row ? (look.col === 'uomCode' ? { ...r, uomCode: code } : { ...r, itemCode: code, uomCode: '' }) : r)));
  };
  const outCols = useMemo(() => cols(assembling), [assembling]);
  const compCols = useMemo(() => cols(!assembling), [assembling]);

  return (
    <>
      <PageHeader
        title={`${def.name} - ${assembling ? 'Lắp ráp' : 'Tháo dỡ'} ${v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}`}
        tags={<Tag style={{ marginRight: 0 }}>{STATE_LABEL[state]}</Tag>}
        extra={<>
          {mayEdit && <Button onClick={() => save.mutate(false)} type="primary" loading={save.isPending} disabled={!ready}>Lưu (Ctrl+S)</Button>}
          {mayEdit && mayPost && <Button onClick={() => save.mutate(true)} disabled={!ready || save.isPending}>Ghi sổ (F9)</Button>}
          {!isNew && mayUnpost && <Button onClick={() => confirmIfDirty(() => action.mutate({ act: 'unpost' }))}>Bỏ ghi sổ</Button>}
          {!isNew && mayReverse && v.data && <Button onClick={() => confirmIfDirty(() => { const p = v.data!.postingDate; const today = todayVn(); setReverse({ date: dayjs(today >= p ? today : p), description: `Đảo chứng từ ${v.data!.voucherNo}` }); })}>Đảo</Button>}
          {!isNew && editable && canTransition(state, 'discard') && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy phiếu?', content: 'Số phiếu (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
          {!isNew && can('voucher.print') && <Dropdown trigger={['click']} menu={{ items: [{ key: '02-VT', label: <a href={`/api/vouchers/${id}/print?format=pdf&form=02-VT`} target="_blank" rel="noreferrer">Phiếu xuất kho (vật tư đem lắp, tháo)</a> }, { key: '01-VT', label: <a href={`/api/vouchers/${id}/print?format=pdf&form=01-VT`} target="_blank" rel="noreferrer">Phiếu nhập kho (thành phẩm, linh kiện)</a> }] }}><Button>In ▾</Button></Dropdown>}
        </>}
      />
      {v.error && <Alert type="error" showIcon message={(v.error as Error).message} style={{ marginBottom: 12 }} />}
      {posted && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Phiếu ghi sổ theo giá tạm tính; khi tính giá vốn, giá hàng nhập được cập nhật theo giá gán của hàng xuất và Phiếu giá vốn ghi phần chênh lệch." />}
      <Section title="Thông tin chung">
        <Form form={form} layout="vertical" disabled={!editable} onValuesChange={() => setDirty(true)} initialValues={{ postingDate: dayjs(todayVn()), documentDate: dayjs(todayVn()) }}>
          <Row gutter={12}>
            <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true, message: 'Nhập ngày hạch toán' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
            <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true, message: 'Nhập ngày chứng từ' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
            <Col span={5}><Form.Item label="Kho (F4)" name="warehouseCode" rules={[{ required: true, message: 'Chọn kho' }]}><LookupSelect catalog="warehouse" quickAddFields={quickAdd} /></Form.Item></Col>
            <Col span={5}><Form.Item label="Nghiệp vụ"><Segmented value={mode} disabled={!isNew || !editable} onChange={(m) => { setMode(m as Mode); setDirty(true); }}
              options={[{ value: 'assembly', label: 'Lắp ráp' }, { value: 'disassembly', label: 'Tháo dỡ' }]} /></Form.Item></Col>
            <Col span={6}><Form.Item label="Người lập" name="personName"><Input maxLength={200} /></Form.Item></Col>
            <Col span={12}><Form.Item label="Diễn giải" name="description"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item label="Chi phí phát sinh (đ)" name="extraCost" tooltip="Ghi Có tài khoản chi phí, cộng vào giá trị hàng nhập kho"><Input inputMode="numeric" /></Form.Item></Col>
            <Col span={6}><Form.Item label="TK ghi Có chi phí" name="extraCostAccountCode" tooltip="Bỏ trống: dùng TK 154"><Input placeholder="154" /></Form.Item></Col>
          </Row>
        </Form>
      </Section>
      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col span={12}>
          <Section title={`Thành phẩm ${assembling ? '(nhập kho)' : '(xuất kho)'}`} bodyPadding={0}>
            <KeyboardGrid<Row> rows={outputs} columns={outCols} readOnly={!editable} onRowsChange={setOut} addRowTemplate={blank} height={220} onLookup={onLookup('out')} />
          </Section>
        </Col>
        <Col span={12}>
          <Section title={`Linh kiện ${assembling ? '(xuất kho)' : '(nhập kho)'}`} bodyPadding={0}>
            <KeyboardGrid<Row> rows={components} columns={compCols} readOnly={!editable} onRowsChange={setComp} addRowTemplate={blank} height={220} onLookup={onLookup('comp')} />
          </Section>
        </Col>
      </Row>
      {(v.data?.ledgerLines.length ?? 0) > 0 && (
        <Section title="Hạch toán" style={{ marginTop: 12 }} bodyPadding={0}>
          <Table size="small" pagination={false} rowKey="lineNo" dataSource={v.data!.ledgerLines} data-testid="ledger-lines" columns={[
            { title: 'Tài khoản', dataIndex: 'accountCode', width: 110, className: 'kt-num' }, { title: 'Tên tài khoản', dataIndex: 'accountName' }, { title: 'Hàng', dataIndex: 'itemCode', width: 120, render: (s: string | null) => s ?? '' },
            { title: 'Nợ', dataIndex: 'debit', align: 'right', width: 140, render: money, className: 'kt-num' }, { title: 'Có', dataIndex: 'credit', align: 'right', width: 140, render: money, className: 'kt-num' }]} />
        </Section>
      )}
      <PickDialog open={look !== null} catalog={look?.col === 'uomCode' ? 'uom' : 'item'}
        fetcher={look?.col === 'itemCode' ? async (q) => api<{ id: number; code: string; name: string }[]>(`/api/lookups/items?q=${encodeURIComponent(q)}`) : undefined as never}
        onPick={pickCode} onClose={() => setLook(null)} />
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
    </>
  );
}
