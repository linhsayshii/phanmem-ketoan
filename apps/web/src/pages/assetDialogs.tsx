import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, DatePicker, Form, Input, Modal, Select, Space, Tag } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { D, formatVnDate, isImeComposing, parseVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { accountFetcherFor } from '../lookups.js';
import { PickDialog, iso, text } from './voucherCommon.js';

export type AssetKind = 'fixed' | 'tool' | 'prepaid';
export interface AllocRow { expenseAccountCode: string; departmentCode: string; projectCode: string; costItemCode: string; ratio: string }
export const emptyAlloc = (): AllocRow => ({ expenseAccountCode: '', departmentCode: '', projectCode: '', costItemCode: '', ratio: '' });
export const isBlankAlloc = (r: AllocRow) => Object.values(r).every((v) => v.trim() === '');
export const KIND_LABEL: Record<AssetKind, string> = { fixed: 'Tài sản cố định', tool: 'Công cụ dụng cụ', prepaid: 'Chi phí trả trước' };
const RATIO_RE = /^\d{1,3}(\.\d{1,6})?$/;
const ALLOC_LOOKUP: Record<string, string> = { expenseAccountCode: 'account', departmentCode: 'department', projectCode: 'project', costItemCode: 'cost_item' };

// Tổng tỷ lệ các dòng phân bổ (dòng trống bỏ qua); chuỗi rỗng khi có tỷ lệ sai.
export const allocTotal = (rows: AllocRow[]): string => rows.filter((r) => !isBlankAlloc(r)).reduce<string | null>((s, r) => (s === null || !RATIO_RE.test(r.ratio) ? null : D(s).plus(r.ratio).toString()), '0') ?? '';
// Thân gửi API từ lưới; ném Error tiếng Việt khi thiếu dữ liệu hoặc tổng tỷ lệ khác 100.
export function allocBody(rows: AllocRow[]) {
  const used = rows.filter((r) => !isBlankAlloc(r));
  if (!used.length) throw new Error('Nhập ít nhất một dòng phân bổ chi phí');
  used.forEach((r, i) => {
    if (!r.expenseAccountCode.trim()) throw new Error(`Dòng phân bổ ${i + 1}: chọn tài khoản chi phí`);
    if (!RATIO_RE.test(r.ratio)) throw new Error(`Dòng phân bổ ${i + 1}: tỷ lệ không hợp lệ`);
  });
  if (!D(allocTotal(used)).eq(100)) throw new Error('Tổng tỷ lệ phân bổ phải bằng 100%');
  return used.map((r) => ({ expenseAccountCode: r.expenseAccountCode.trim(), departmentCode: text(r.departmentCode), projectCode: text(r.projectCode), costItemCode: text(r.costItemCode), ratio: r.ratio }));
}

// Lưới phân bổ chi phí (TK chi phí F4, bộ phận, vụ việc, khoản mục, tỷ lệ %): dùng ở thẻ tài sản, điều chuyển và chuyển TSCĐ thành CCDC.
export function AllocationGrid({ rows, onChange, date, readOnly, height = 200 }: { rows: AllocRow[]; onChange: (r: AllocRow[]) => void; date?: string | undefined; readOnly?: boolean; height?: number }) {
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const fetcher = useMemo(() => accountFetcherFor(date), [date]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const columns = useMemo<ColDef<AllocRow>[]>(() => [
    { field: 'expenseAccountCode', headerName: 'TK chi phí (F4)', width: 140 }, { field: 'departmentCode', headerName: 'Bộ phận (F4)', width: 130 },
    { field: 'projectCode', headerName: 'Vụ việc (F4)', width: 130 }, { field: 'costItemCode', headerName: 'Khoản mục (F4)', width: 140 },
    { field: 'ratio', headerName: 'Tỷ lệ (%)', width: 110, cellClass: 'ag-right-aligned-cell',
      valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && RATIO_RE.test(n) ? n : p.oldValue; } },
  ], []);
  const total = allocTotal(rows);
  return (<>
    <KeyboardGrid<AllocRow> rows={rows} columns={columns} onRowsChange={onChange} addRowTemplate={emptyAlloc} readOnly={!!readOnly} height={height}
      onLookup={(col, row) => { if (!readOnly && col in ALLOC_LOOKUP) setLookup({ col, row }); }} />
    <div style={{ marginTop: 4 }}>Tổng tỷ lệ: <Tag color={total !== '' && D(total).eq(100) ? 'green' : 'red'} data-testid="alloc-total">{total === '' ? 'không hợp lệ' : `${total}%`}</Tag></div>
    <PickDialog open={!!lookup} catalog={lookup ? ALLOC_LOOKUP[lookup.col]! : 'account'} withQuickAdd={!!lookup && lookup.col !== 'expenseAccountCode'} {...(lookup?.col === 'expenseAccountCode' ? { fetcher } : {})}
      onPick={(code) => { if (lookup) onChange(rowsRef.current.map((r, i) => (i === lookup.row ? { ...r, [lookup.col]: code } : r))); }} onClose={() => setLookup(null)} />
  </>);
}

export type EventKindName = 'increase' | 'decrease' | 'decrease-tool' | 'adjust-value' | 'revalue' | 'transfer' | 'suspend' | 'resume' | 'life';
export const EVENT_TITLE: Record<EventKindName, string> = { increase: 'Ghi tăng', decrease: 'Ghi giảm', 'decrease-tool': 'Ghi giảm', 'adjust-value': 'Điều chỉnh giá trị', revalue: 'Đánh giá lại',
  transfer: 'Điều chuyển', suspend: 'Dừng khấu hao', resume: 'Tiếp tục khấu hao', life: 'Điều chỉnh thời gian sử dụng' };
const INCREASE_REASONS = [{ value: 'construction', label: 'Hoàn thành xây dựng cơ bản' }, { value: 'contribution', label: 'Nhận góp vốn' }, { value: 'finance_lease', label: 'Thuê tài chính' }, { value: 'donation', label: 'Được biếu tặng' }, { value: 'other', label: 'Khác' }];
const DECREASE_REASONS = [{ value: 'liquidation', label: 'Thanh lý, nhượng bán' }, { value: 'contribution', label: 'Góp vốn' }, { value: 'to_tool', label: 'Chuyển thành công cụ dụng cụ' }, { value: 'loss', label: 'Mất mát' }, { value: 'other', label: 'Khác' }];
export interface DialogAsset { id: number; code: string; kind: string; departmentCode: string | null; allocations: { expenseAccountCode: string; departmentCode: string | null; projectCode: string | null; costItemCode: string | null; ratio: string }[] }
interface EventResult { eventId: string; voucherId: string | null; value?: string; partialDepreciation?: unknown }
interface Values { date: Dayjs; reason?: string; counterAccountCode?: string; partyCode?: string; description?: string; amount?: string; quantity?: string; delta?: string;
  newCost?: string; newAccumulated?: string; remainingUnits?: string; departmentCode?: string; toolCode?: string; toolName?: string; toolPeriods?: string }
const toRows = (a: DialogAsset['allocations']): AllocRow[] => a.map((x) => ({ expenseAccountCode: x.expenseAccountCode, departmentCode: x.departmentCode ?? '', projectCode: x.projectCode ?? '', costItemCode: x.costItemCode ?? '', ratio: D(x.ratio).toString() }));

// Hộp thoại nghiệp vụ biến động tài sản. API chạy lại các kỳ đã chạy từ kỳ của ngày nghiệp vụ ngay khi lưu (không có bước xem trước), nên hộp thoại báo trước và báo lại sau khi lưu.
export function EventDialog({ asset, kind, onClose, onDone }: { asset: DialogAsset; kind: EventKindName | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm<Values>();
  const [err, setErr] = useState<string | null>(null); const [result, setResult] = useState<EventResult | null>(null);
  const [alloc, setAlloc] = useState<AllocRow[]>([emptyAlloc()]);
  const date = Form.useWatch('date', form) as Dayjs | undefined; const reason = Form.useWatch('reason', form) as string | undefined;
  const dateIso = date ? iso(date) : undefined;
  const fetcher = useMemo(() => accountFetcherFor(dateIso), [dateIso]);
  const reasonOf = kind === 'increase' || kind === 'decrease';
  const money = (name: keyof Values, label: string, required = true) => <Form.Item label={label} name={name} rules={required ? [{ required: true, message: `Nhập ${label.toLowerCase()}` }] : []}><VnNumberInput aria-label={label} /></Form.Item>;
  const account = (name: keyof Values, label: string, required = true) => <Form.Item label={label} name={name} rules={required ? [{ required: true, message: `Chọn ${label.toLowerCase()}` }] : []}><LookupSelect catalog="account" fetcher={fetcher} allowClear /></Form.Item>;

  const bodyOf = (v: Values): Record<string, unknown> => {
    const base = { date: iso(v.date) };
    switch (kind) {
      case 'increase': return { ...base, reason: v.reason, counterAccountCode: v.counterAccountCode, amount: v.amount, partyCode: text(v.partyCode), description: text(v.description) };
      case 'decrease': return { ...base, reason: v.reason, ...(v.counterAccountCode ? { counterAccountCode: v.counterAccountCode } : {}),
        ...(v.reason === 'to_tool' ? { toolCard: { code: v.toolCode?.trim(), name: v.toolName?.trim(), periods: Number(v.toolPeriods), allocations: allocBody(alloc) } } : {}) };
      case 'decrease-tool': return { ...base, ...(v.quantity ? { quantity: v.quantity } : {}), counterAccountCode: v.counterAccountCode, reason: text(v.description) };
      case 'adjust-value': return { ...base, delta: v.delta, counterAccountCode: v.counterAccountCode, partyCode: text(v.partyCode) };
      case 'revalue': return { ...base, newCost: v.newCost, newAccumulated: v.newAccumulated, ...(v.remainingUnits ? { remainingUnits: v.remainingUnits } : {}), ...(v.counterAccountCode ? { counterAccountCode: v.counterAccountCode } : {}) };
      case 'transfer': return { ...base, departmentCode: text(v.departmentCode), allocations: allocBody(alloc) };
      case 'suspend': return { ...base, reason: v.description?.trim() };
      case 'life': return { ...base, remainingUnits: v.remainingUnits };
      default: return base;
    }
  };
  const run = useMutation({
    mutationFn: (v: Values) => api<EventResult>(`/api/assets/${asset.id}/${kind}`, { method: 'POST', json: bodyOf(v) }),
    onError: (e) => setErr((e as Error).message), onSuccess: (r) => { setResult(r); onDone(); } });
  const submit = () => { setErr(null); void form.validateFields().then((v) => { try { run.mutate(v); } catch (e) { setErr((e as Error).message); } }, () => undefined); };
  // Enter trong ô nhập (không phải danh sách chọn, không phải lưới) và Ctrl+S lưu hộp thoại.
  const onKey = (e: React.KeyboardEvent) => {
    if (result || isImeComposing(e.nativeEvent) || run.isPending) return;
    const t = e.target as HTMLElement;
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') || (e.key === 'Enter' && t.tagName === 'INPUT' && !t.closest('.ant-select, .ag-root'))) { e.preventDefault(); submit(); }
  };
  const needAlloc = kind === 'transfer' || (kind === 'decrease' && reason === 'to_tool');
  const fields: ReactNode = (() => {
    switch (kind) {
      case 'increase': return (<>
        <Form.Item label="Lý do ghi tăng" name="reason" rules={[{ required: true, message: 'Chọn lý do' }]}><Select options={INCREASE_REASONS} aria-label="Lý do ghi tăng" /></Form.Item>
        {account('counterAccountCode', 'TK đối ứng (Có, F4)')}{money('amount', 'Giá trị ghi tăng')}
        <Form.Item label="Đối tượng" name="partyCode"><LookupSelect catalog="party" allowClear /></Form.Item>
        <Form.Item label="Diễn giải" name="description"><Input maxLength={500} /></Form.Item></>);
      case 'decrease': return (<>
        <Form.Item label="Lý do ghi giảm" name="reason" rules={[{ required: true, message: 'Chọn lý do' }]}><Select options={DECREASE_REASONS} aria-label="Lý do ghi giảm" /></Form.Item>
        {reason !== 'to_tool' && account('counterAccountCode', 'TK đối ứng (F4)', false)}
        {reason === 'to_tool' && (<>
          <Space align="start" wrap>
            <Form.Item label="Mã thẻ CCDC" name="toolCode" rules={[{ required: true, message: 'Nhập mã thẻ CCDC' }]}><Input maxLength={30} /></Form.Item>
            <Form.Item label="Tên CCDC" name="toolName" rules={[{ required: true, message: 'Nhập tên CCDC' }]}><Input maxLength={200} style={{ width: 260 }} /></Form.Item>
            <Form.Item label="Số kỳ phân bổ" name="toolPeriods" rules={[{ required: true, pattern: /^\d{1,4}$/, message: 'Nhập số kỳ phân bổ' }]}><Input inputMode="numeric" style={{ width: 120 }} /></Form.Item>
          </Space>
          <div style={{ marginBottom: 8 }}>Phân bổ chi phí của thẻ CCDC mới</div></>)}</>);
      case 'decrease-tool': return (<>
        {account('counterAccountCode', 'TK đối ứng (F4)')}
        <Form.Item label="Số lượng ghi giảm" name="quantity" extra="Để trống: ghi giảm toàn bộ số lượng còn lại"><VnNumberInput scale={4} aria-label="Số lượng ghi giảm" /></Form.Item>
        <Form.Item label="Lý do" name="description"><Input maxLength={500} /></Form.Item></>);
      case 'adjust-value': return (<>
        <Form.Item label="Số tiền điều chỉnh" name="delta" extra="Số dương tăng giá trị, số âm giảm giá trị" rules={[{ required: true, pattern: /^-?\d{1,16}$/, message: 'Nhập số tiền điều chỉnh (số nguyên, khác 0)' }]}><Input aria-label="Số tiền điều chỉnh" inputMode="numeric" style={{ textAlign: 'right' }} /></Form.Item>
        {account('counterAccountCode', 'TK đối ứng (F4)')}<Form.Item label="Đối tượng" name="partyCode"><LookupSelect catalog="party" allowClear /></Form.Item></>);
      case 'revalue': return (<>{money('newCost', 'Nguyên giá mới')}{money('newAccumulated', 'Hao mòn lũy kế mới')}
        <Form.Item label="Số kỳ còn lại" name="remainingUnits"><Input inputMode="decimal" style={{ width: 160 }} /></Form.Item>{account('counterAccountCode', 'TK chênh lệch đánh giá lại (F4)', false)}</>);
      case 'transfer': return (<>
        <Form.Item label="Bộ phận sử dụng mới" name="departmentCode"><LookupSelect catalog="department" allowClear /></Form.Item>
        <div style={{ marginBottom: 8 }}>Phân bổ chi phí từ ngày điều chuyển</div></>);
      case 'suspend': return <Form.Item label="Lý do dừng" name="description" rules={[{ required: true, whitespace: true, message: 'Nhập lý do dừng' }]}><Input maxLength={500} /></Form.Item>;
      case 'life': return <Form.Item label="Số kỳ còn lại" name="remainingUnits" rules={[{ required: true, pattern: /^\d{1,4}(\.\d{1,12})?$/, message: 'Nhập số kỳ còn lại' }]}><Input inputMode="decimal" style={{ width: 160 }} /></Form.Item>;
      default: return null;
    }
  })();
  const open = kind !== null;
  return (
    <Modal open={open} title={kind ? `${EVENT_TITLE[kind]} ${asset.code}` : ''} destroyOnHidden width={needAlloc ? 760 : 520} okText={result ? 'Đóng' : 'Lưu (Ctrl+S)'} cancelText={result ? undefined : 'Bỏ qua'} cancelButtonProps={{ style: result ? { display: 'none' } : {} }}
      okButtonProps={{ loading: run.isPending }} onCancel={onClose} onOk={() => (result ? onClose() : submit())}
      afterOpenChange={(o) => { if (o) { form.resetFields(); form.setFieldsValue({ date: dayjs(todayVn()), ...(kind === 'revalue' ? { counterAccountCode: '412' } : {}) }); setErr(null); setResult(null);
        setAlloc(kind === 'transfer' && asset.allocations.length ? toRows(asset.allocations) : [emptyAlloc()]); } }}>
      {open && <div onKeyDown={onKey}>
        {result ? (
          <Alert type="success" showIcon data-testid="event-result" message={`Đã ghi nhận ${EVENT_TITLE[kind].toLowerCase()}`} description={<>
            {result.voucherId && <div>Chứng từ: <a href={`/chung-tu/TS/${result.voucherId}`}>mở chứng từ tài sản</a></div>}
            {result.value && <div>Giá trị ghi giảm: {D(result.value).toFixed(0)}</div>}
            <div>Các kỳ đã chạy từ kỳ chứa ngày {formatVnDate(dateIso ?? todayVn())} đã được chạy lại (chứng từ cũ được đảo, chứng từ mới được lập).</div></>} />
        ) : (<>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`Các kỳ ${kind && asset.kind === 'fixed' ? 'khấu hao' : 'phân bổ'} đã chạy từ kỳ chứa ngày nghiệp vụ sẽ được chạy lại khi lưu: chứng từ cũ được đảo, chứng từ mới được lập.`} />
          <Form form={form} layout="vertical">
            <Form.Item label="Ngày nghiệp vụ" name="date" rules={[{ required: true, message: 'Nhập ngày nghiệp vụ' }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
            {fields}
          </Form>
          {needAlloc && <AllocationGrid rows={alloc} onChange={setAlloc} date={dateIso} />}
          {err && <Alert type="error" showIcon style={{ marginTop: 12 }} message={err} />}
        </>)}
        {reasonOf && null}
      </div>}
    </Modal>
  );
}
