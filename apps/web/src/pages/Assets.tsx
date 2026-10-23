import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { LookupSelect, useHotkeys, useRememberedFilter, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor, assetCategoryFetcher } from '../lookups.js';
import { AllocationGrid, EVENT_TITLE, EventDialog, KIND_LABEL, allocBody, emptyAlloc, type AllocRow, type AssetKind, type DialogAsset, type EventKindName } from './assetDialogs.js';
import { iso, text } from './voucherCommon.js';

interface Alloc { expenseAccountCode: string; departmentCode: string | null; projectCode: string | null; costItemCode: string | null; ratio: string }
interface AssetRow { id: number; code: string; name: string; kind: AssetKind; categoryCode: string | null; assetAccountCode: string; depreciationAccountCode: string | null; departmentCode: string | null;
  useDate: string | null; depreciationStartDate: string | null; lifeUnits: number | null; isDepreciable: boolean; quantity: string; uom: string | null; status: string; decreaseDate: string | null; note: string | null;
  allocations: Alloc[]; cost: string; accumulated: string }
interface Category { id: number; code: string; name: string; kind: AssetKind; assetAccountCode: string; depreciationAccountCode: string | null; defaultLifeUnits: number | null; isActive: boolean }
interface ScheduleRow { fiscalYear: number; periodNo: number; units: string; amount: string; accumulated: string }
interface EventRow { id: string; kind: string; eventDate: string; voucherId: string | null; voucherNo: string | null; state: 'active' | 'cancelled' }
const money = (s: string) => formatVnNumber(s, 0);
const EVENT_KIND_LABEL: Record<string, string> = { increase: 'Ghi tăng', decrease: 'Ghi giảm', value_adjust: 'Điều chỉnh giá trị', revaluation: 'Đánh giá lại', transfer: 'Điều chuyển', suspend: 'Dừng khấu hao', resume: 'Tiếp tục khấu hao', life_change: 'Điều chỉnh thời gian sử dụng' };
const STATUS_LABEL: Record<string, string> = { active: 'Đang dùng', decreased: 'Đã ghi giảm' };
const PATH_SLUG: Record<AssetKind, string> = { fixed: 'tscd', tool: 'ccdc', prepaid: 'chi-phi-tra-truoc' };

// Nút nghiệp vụ theo loại thẻ: TSCĐ có đánh giá lại, dừng/tiếp tục; CCDC và chi phí trả trước ghi giảm bằng decrease-tool và điều chỉnh giá trị.
const actionsOf = (kind: AssetKind, suspended: boolean): EventKindName[] => kind === 'fixed'
  ? ['increase', 'decrease', 'revalue', 'transfer', suspended ? 'resume' : 'suspend', 'life'] : ['increase', 'decrease-tool', 'adjust-value', 'transfer', 'life'];

interface InfoValues { code: string; name: string; categoryCode: string | null; departmentCode: string | null; useDate: dayjs.Dayjs | null; depreciationStartDate: dayjs.Dayjs | null; lifeUnits: number | null;
  quantity: string | null; uom: string; isDepreciable: boolean; note: string }

function AssetDrawer({ kind, asset, onClose }: { kind: AssetKind; asset: AssetRow | 'new'; onClose: () => void }) {
  const qc = useQueryClient(); const { can } = useAuth();
  const isNew = asset === 'new'; const canEdit = can('asset.update') || (isNew && can('asset.create'));
  const [form] = Form.useForm<InfoValues>();
  const [id, setId] = useState<number | null>(isNew ? null : asset.id);
  const [event, setEvent] = useState<EventKindName | null>(null); const [err, setErr] = useState<string | null>(null); const [tab, setTab] = useState('info');
  const catFetcher = useMemo(() => assetCategoryFetcher(kind), [kind]);
  const detail = useQuery({ queryKey: ['asset', id], enabled: id !== null, queryFn: () => api<AssetRow>(`/api/assets/${id}`) });
  const events = useQuery({ queryKey: ['asset-events', id], enabled: id !== null, queryFn: () => api<EventRow[]>(`/api/assets/${id}/events`) });
  const schedule = useQuery({ queryKey: ['asset-schedule', id], enabled: id !== null, queryFn: () => api<ScheduleRow[]>(`/api/assets/${id}/schedule`) });
  const a = detail.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['asset'] }); void qc.invalidateQueries({ queryKey: ['asset-events'] }); void qc.invalidateQueries({ queryKey: ['asset-schedule'] }); void qc.invalidateQueries({ queryKey: ['assets'] }); };

  useEffect(() => {
    if (!a) { if (isNew) form.setFieldsValue({ quantity: '1', isDepreciable: true }); return; }
    form.setFieldsValue({ code: a.code, name: a.name, categoryCode: a.categoryCode, departmentCode: a.departmentCode, useDate: a.useDate ? dayjs(a.useDate) : null,
      depreciationStartDate: a.depreciationStartDate ? dayjs(a.depreciationStartDate) : null, lifeUnits: a.lifeUnits, quantity: a.quantity, uom: a.uom ?? '', isDepreciable: a.isDepreciable, note: a.note ?? '' });
  }, [a?.id, a?.status]);

  const save = useMutation({
    mutationFn: (v: InfoValues) => {
      const body = { code: v.code.trim(), name: v.name.trim(), kind, categoryCode: v.categoryCode, departmentCode: v.departmentCode, useDate: v.useDate ? iso(v.useDate) : null,
        depreciationStartDate: v.depreciationStartDate ? iso(v.depreciationStartDate) : null, lifeUnits: v.lifeUnits, ...(v.quantity ? { quantity: v.quantity } : {}), uom: text(v.uom),
        isDepreciable: v.isDepreciable, note: text(v.note) };
      return id === null ? api<AssetRow>('/api/assets', { method: 'POST', json: body }) : api<AssetRow>(`/api/assets/${id}`, { method: 'PUT', json: body });
    },
    onError: (e) => setErr((e as Error).message),
    onSuccess: (r) => { setErr(null); setId(r.id); void message.success('Đã lưu thẻ'); refresh(); } });
  const submitInfo = () => { void form.validateFields().then((v) => save.mutate(v), () => undefined); };

  // ---- Phân bổ chi phí ----
  const today = dayjs(todayVn());
  const [alloc, setAlloc] = useState<AllocRow[]>([emptyAlloc()]); const [fromYear, setFromYear] = useState<number>(today.year()); const [fromPeriod, setFromPeriod] = useState<number>(today.month() + 1);
  const [allocErr, setAllocErr] = useState<string | null>(null);
  useEffect(() => { if (a?.allocations.length) setAlloc(a.allocations.map((x) => ({ expenseAccountCode: x.expenseAccountCode, departmentCode: x.departmentCode ?? '', projectCode: x.projectCode ?? '', costItemCode: x.costItemCode ?? '', ratio: D(x.ratio).toString() }))); }, [a?.id]);
  const saveAlloc = useMutation({
    mutationFn: () => api<AssetRow>(`/api/assets/${id}/allocations`, { method: 'PUT', json: { validFromYear: fromYear, validFromPeriod: fromPeriod, lines: allocBody(alloc) } }),
    onError: (e) => setAllocErr((e as Error).message), onSuccess: () => { setAllocErr(null); void message.success('Đã lưu phân bổ chi phí'); refresh(); } });
  const doSaveAlloc = () => { try { allocBody(alloc); saveAlloc.mutate(); } catch (e) { setAllocErr((e as Error).message); } };

  const cancel = useMutation({ mutationFn: (eid: string) => api(`/api/asset-events/${eid}/cancel`, { method: 'POST' }), onError: (e) => void message.error((e as Error).message),
    onSuccess: () => { void message.success('Đã hủy biến động'); refresh(); } });

  const dialogAsset: DialogAsset | null = a ? { id: a.id, code: a.code, kind: a.kind, departmentCode: a.departmentCode, allocations: a.allocations } : null;
  const suspended = (events.data ?? []).filter((e) => e.state === 'active' && (e.kind === 'suspend' || e.kind === 'resume')).sort((x, y) => x.eventDate.localeCompare(y.eventDate)).at(-1)?.kind === 'suspend';
  const info = (
    <Form form={form} layout="vertical" disabled={!canEdit}>
      <Space align="start" wrap>
        <Form.Item label="Mã" name="code" rules={[{ required: true, whitespace: true, message: 'Nhập mã' }]}><Input maxLength={30} autoFocus /></Form.Item>
        <Form.Item label="Tên" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên' }]}><Input maxLength={200} style={{ width: 320 }} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Loại (F4)" name="categoryCode"><LookupSelect catalog="asset_category" fetcher={catFetcher} allowClear style={{ width: 240 }} /></Form.Item>
        <Form.Item label="Bộ phận sử dụng (F4)" name="departmentCode"><LookupSelect catalog="department" allowClear style={{ width: 240 }} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Ngày sử dụng" name="useDate"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label={kind === 'fixed' ? 'Ngày bắt đầu khấu hao' : 'Ngày bắt đầu phân bổ'} name="depreciationStartDate"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Số kỳ sử dụng" name="lifeUnits"><InputNumber min={1} max={1200} precision={0} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Số lượng" name="quantity"><VnNumberInput scale={4} aria-label="Số lượng" /></Form.Item>
        <Form.Item label="Đơn vị tính" name="uom"><Input maxLength={50} style={{ width: 120 }} /></Form.Item>
        {kind === 'fixed' && <Form.Item label=" " name="isDepreciable" valuePropName="checked"><Checkbox>Có tính khấu hao</Checkbox></Form.Item>}
      </Space>
      <Form.Item label="Ghi chú" name="note"><Input.TextArea rows={2} maxLength={1000} /></Form.Item>
      {a && <div style={{ marginBottom: 12 }}>TK tài sản: <b>{a.assetAccountCode}</b>{a.depreciationAccountCode && <> · TK hao mòn: <b>{a.depreciationAccountCode}</b></>} · Trạng thái: <Tag>{STATUS_LABEL[a.status] ?? a.status}</Tag></div>}
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
      {canEdit && <Button type="primary" onClick={submitInfo} loading={save.isPending}>Lưu (Ctrl+S)</Button>}
    </Form>);
  // Ctrl+S trong ô nhập (useHotkeys bỏ qua khi đang gõ) lưu thẻ hoặc phân bổ theo tab đang mở.
  const onKey = (e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !(e.target as HTMLElement).closest('.ant-modal')) { e.preventDefault(); if (tab === 'info') submitInfo(); else if (tab === 'alloc' && id !== null) doSaveAlloc(); } };
  const needCard = <Alert type="info" showIcon message="Lưu thông tin chung trước khi dùng thẻ này" />;
  const scheduleTab = id === null ? needCard : (
    <Table<ScheduleRow> size="small" rowKey={(r) => `${r.fiscalYear}-${r.periodNo}`} loading={schedule.isLoading} dataSource={schedule.data ?? []} pagination={{ pageSize: 24, hideOnSinglePage: true }} data-testid="schedule-table"
      locale={{ emptyText: 'Chưa có lịch: thẻ chưa có nguyên giá hoặc chưa nhập ngày bắt đầu' }}
      columns={[{ title: 'Kỳ', render: (_, r) => `${String(r.periodNo).padStart(2, '0')}/${r.fiscalYear}` }, { title: 'Số kỳ', dataIndex: 'units', align: 'right' },
        { title: kind === 'fixed' ? 'Khấu hao' : 'Phân bổ', dataIndex: 'amount', align: 'right', render: money }, { title: 'Lũy kế', dataIndex: 'accumulated', align: 'right', render: money }]} />);
  const eventsTab = id === null ? needCard : (<>
    {a && canEdit && <Space wrap style={{ marginBottom: 8 }}>{actionsOf(kind, suspended).map((k) => <Button key={k} onClick={() => setEvent(k)}>{EVENT_TITLE[k]}</Button>)}</Space>}
    <Table<EventRow> size="small" rowKey="id" loading={events.isLoading} dataSource={events.data ?? []} pagination={false} data-testid="events-table"
      columns={[{ title: 'Ngày', dataIndex: 'eventDate', render: formatVnDate }, { title: 'Nghiệp vụ', dataIndex: 'kind', render: (k: string) => EVENT_KIND_LABEL[k] ?? k },
        { title: 'Chứng từ', render: (_, r) => (r.voucherId ? <a href={`/chung-tu/TS/${r.voucherId}`}>{r.voucherNo ?? 'Xem'}</a> : '') },
        { title: 'Trạng thái', dataIndex: 'state', render: (s: string) => (s === 'active' ? <Tag color="green">Hiệu lực</Tag> : <Tag>Đã hủy</Tag>) },
        { title: '', render: (_, r) => (canEdit && r.state === 'active' ? <Popconfirm title="Hủy biến động này?" okText="Hủy biến động" cancelText="Không" onConfirm={() => cancel.mutate(r.id)}><Button size="small" danger>Hủy</Button></Popconfirm> : null) }]} />
  </>);
  const allocTab = id === null ? needCard : (<>
    <Space style={{ marginBottom: 8 }} wrap>Hiệu lực từ kỳ <InputNumber min={1} max={15} value={fromPeriod} onChange={(v) => setFromPeriod(v ?? 1)} aria-label="Từ kỳ" /> năm <InputNumber min={1900} max={2200} value={fromYear} onChange={(v) => setFromYear(v ?? today.year())} aria-label="Từ năm" /></Space>
    <AllocationGrid rows={alloc} onChange={setAlloc} readOnly={!canEdit} />
    {allocErr && <Alert type="error" showIcon message={allocErr} style={{ marginTop: 8 }} />}
    {canEdit && <Button type="primary" style={{ marginTop: 8 }} onClick={doSaveAlloc} loading={saveAlloc.isPending}>Lưu phân bổ</Button>}
  </>);
  return (
    <Drawer open width={760} title={isNew && id === null ? `Thêm ${KIND_LABEL[kind].toLowerCase()}` : `${KIND_LABEL[kind]} ${a?.code ?? ''}`} onClose={onClose} destroyOnHidden>
      <div onKeyDown={onKey}><Tabs activeKey={tab} onChange={setTab} items={[{ key: 'info', label: 'Thông tin chung', children: info }, { key: 'alloc', label: 'Phân bổ chi phí', children: allocTab },
        { key: 'schedule', label: kind === 'fixed' ? 'Lịch khấu hao' : 'Lịch phân bổ', children: scheduleTab }, { key: 'events', label: 'Biến động và chứng từ', children: eventsTab }]} /></div>
      {dialogAsset && <EventDialog asset={dialogAsset} kind={event} onClose={() => setEvent(null)} onDone={refresh} />}
    </Drawer>);
}

export function AssetsPage({ kind }: { kind: AssetKind }) {
  const { me, can } = useAuth();
  const [f, setF] = useRememberedFilter(`assets-${kind}`, { q: '', categoryCode: '' as string, departmentCode: '' as string, status: '' as string }, `${me?.tenantId}:${me?.userId}`);
  const [open, setOpen] = useState<AssetRow | 'new' | null>(null);
  const catFetcher = useMemo(() => assetCategoryFetcher(kind), [kind]);
  const list = useQuery({ queryKey: ['assets', kind, f.q], queryFn: () => api<AssetRow[]>(`/api/assets?kind=${kind}${f.q ? `&q=${encodeURIComponent(f.q)}` : ''}`) });
  const rows = (list.data ?? []).filter((r) => (!f.categoryCode || r.categoryCode === f.categoryCode) && (!f.departmentCode || r.departmentCode === f.departmentCode) && (!f.status || r.status === f.status));
  useHotkeys({ Insert: () => { if (can('asset.create') && !open) setOpen('new'); } });
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{KIND_LABEL[kind]}</h2>
        <Input.Search placeholder="Tìm theo mã, tên" allowClear defaultValue={f.q} onSearch={(q) => setF({ ...f, q })} style={{ width: 220 }} />
        <LookupSelect catalog="asset_category" fetcher={catFetcher} allowClear placeholder="Loại" value={f.categoryCode || null} onChange={(c) => setF({ ...f, categoryCode: c ?? '' })} style={{ width: 200 }} />
        <LookupSelect catalog="department" allowClear placeholder="Bộ phận" value={f.departmentCode || null} onChange={(c) => setF({ ...f, departmentCode: c ?? '' })} style={{ width: 200 }} />
        <select aria-label="Trạng thái" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Mọi trạng thái</option><option value="active">Đang dùng</option><option value="decreased">Đã ghi giảm</option></select>
        {can('asset.create') && <Button type="primary" onClick={() => setOpen('new')}>Thêm (Insert)</Button>}
      </Space>
      <Table<AssetRow> size="small" rowKey="id" loading={list.isLoading} dataSource={rows} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="assets-table"
        onRow={(r) => ({ onClick: () => setOpen(r), style: { cursor: 'pointer' } })} locale={{ emptyText: 'Chưa có thẻ nào' }}
        columns={[{ title: 'Mã', dataIndex: 'code' }, { title: 'Tên', dataIndex: 'name' }, { title: 'Loại', dataIndex: 'categoryCode' }, { title: 'Bộ phận', dataIndex: 'departmentCode' },
          { title: 'Ngày sử dụng', dataIndex: 'useDate', render: (d: string | null) => (d ? formatVnDate(d) : '') },
          { title: 'Nguyên giá', dataIndex: 'cost', align: 'right', render: money }, { title: 'Hao mòn lũy kế', dataIndex: 'accumulated', align: 'right', render: money },
          { title: 'Giá trị còn lại', align: 'right', render: (_, r) => money(D(r.cost).minus(r.accumulated).toString()) },
          // shortcut: API chưa trả số kỳ còn lại; hiện số kỳ sử dụng, đổi khi API thêm trường này.
          { title: 'Số kỳ sử dụng', dataIndex: 'lifeUnits', align: 'right' }, { title: 'Trạng thái', dataIndex: 'status', render: (s: string) => STATUS_LABEL[s] ?? s }]} />
      {open && <AssetDrawer kind={kind} asset={open} onClose={() => setOpen(null)} />}
    </div>);
}
export const FixedAssetsPage = () => <AssetsPage kind="fixed" />;
export const ToolsPage = () => <AssetsPage kind="tool" />;
export const PrepaidPage = () => <AssetsPage kind="prepaid" />;
export { PATH_SLUG };

// ---- Loại tài sản ----
interface CatValues { code: string; name: string; kind: AssetKind; assetAccountCode: string | null; depreciationAccountCode: string | null; defaultLifeUnits: number | null; isActive: boolean }
export function AssetCategoriesPage() {
  const qc = useQueryClient(); const { can } = useAuth();
  const [editing, setEditing] = useState<Category | 'new' | null>(null); const [form] = Form.useForm<CatValues>(); const [err, setErr] = useState<string | null>(null);
  const kind = Form.useWatch('kind', form) as AssetKind | undefined;
  const fetcher = useMemo(() => accountFetcherFor(), []);
  const list = useQuery({ queryKey: ['asset-categories'], queryFn: () => api<Category[]>('/api/asset-categories') });
  const openEdit = (c: Category | 'new') => { setEditing(c); setErr(null); form.resetFields(); form.setFieldsValue(c === 'new' ? { kind: 'fixed', isActive: true } : { ...c }); };
  const save = useMutation({
    mutationFn: (v: CatValues) => { const body = { ...v, depreciationAccountCode: v.kind === 'fixed' ? v.depreciationAccountCode : null }; return editing === 'new' ? api('/api/asset-categories', { method: 'POST', json: body }) : api(`/api/asset-categories/${(editing as Category).id}`, { method: 'PUT', json: body }); },
    onError: (e) => setErr((e as Error).message), onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: ['asset-categories'] }); void message.success('Đã lưu loại tài sản'); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/asset-categories/${id}`, { method: 'DELETE' }), onError: (e) => void message.error((e as Error).message), onSuccess: () => void qc.invalidateQueries({ queryKey: ['asset-categories'] }) });
  return (
    <div>
      <Space style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>Loại tài sản</h2>{can('asset.create') && <Button type="primary" onClick={() => openEdit('new')}>Thêm loại</Button>}</Space>
      <Table<Category> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={false} data-testid="categories-table"
        columns={[{ title: 'Mã', dataIndex: 'code' }, { title: 'Tên', dataIndex: 'name' }, { title: 'Nhóm', dataIndex: 'kind', render: (k: AssetKind) => KIND_LABEL[k] }, { title: 'TK tài sản', dataIndex: 'assetAccountCode' },
          { title: 'TK hao mòn', dataIndex: 'depreciationAccountCode' }, { title: 'Số kỳ mặc định', dataIndex: 'defaultLifeUnits', align: 'right' }, { title: 'Dùng', dataIndex: 'isActive', render: (b: boolean) => (b ? 'Có' : 'Ngưng') },
          { title: '', render: (_, r) => (<Space>{can('asset.update') && <Button size="small" onClick={() => openEdit(r)}>Sửa</Button>}
            {can('asset.delete') && <Popconfirm title="Xóa loại này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><Button size="small" danger>Xóa</Button></Popconfirm>}</Space>) }]} />
      <Modal open={editing !== null} title={editing === 'new' ? 'Thêm loại tài sản' : 'Sửa loại tài sản'} okText="Lưu" cancelText="Bỏ qua" onCancel={() => setEditing(null)} onOk={() => { void form.validateFields().then((v) => save.mutate(v), () => undefined); }} confirmLoading={save.isPending} forceRender>
        <Form form={form} layout="vertical">
          <Form.Item label="Mã" name="code" rules={[{ required: true, whitespace: true }]}><Input maxLength={30} /></Form.Item>
          <Form.Item label="Tên" name="name" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
          <Form.Item label="Nhóm" name="kind"><select aria-label="Nhóm" disabled={editing !== 'new'} onChange={(e) => form.setFieldValue('kind', e.target.value)} value={kind}><option value="fixed">Tài sản cố định</option><option value="tool">Công cụ dụng cụ</option><option value="prepaid">Chi phí trả trước</option></select></Form.Item>
          <Form.Item label="TK tài sản (F4)" name="assetAccountCode" rules={[{ required: true, message: 'Chọn tài khoản tài sản' }]}><LookupSelect catalog="account" fetcher={fetcher} /></Form.Item>
          {kind === 'fixed' && <Form.Item label="TK hao mòn (F4)" name="depreciationAccountCode" rules={[{ required: true, message: 'Chọn tài khoản hao mòn' }]}><LookupSelect catalog="account" fetcher={fetcher} /></Form.Item>}
          <Form.Item label="Số kỳ sử dụng mặc định" name="defaultLifeUnits"><InputNumber min={1} max={1200} precision={0} /></Form.Item>
          <Form.Item name="isActive" valuePropName="checked"><Checkbox>Đang dùng</Checkbox></Form.Item>
          {err && <Alert type="error" showIcon message={err} />}
        </Form>
      </Modal>
    </div>);
}
