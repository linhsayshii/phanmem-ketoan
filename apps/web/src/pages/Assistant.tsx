import { useState } from 'react';
import dayjs from 'dayjs';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Switch, Table, Tabs, Tag, Typography, Upload, message } from 'antd';
import { LookupSelect, PageHeader, Section } from '@kt/ui';
import { formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import { SuggestList, useSuggest } from './SuggestEntry.js';

// Trợ lý: bút toán định kỳ (sinh chứng từ nháp), nhận diện hóa đơn (XML cục bộ; ảnh/PDF qua dịch vụ ngoài khi công ty bật), gợi ý định khoản. Không thao tác nào tự ghi sổ.
interface Line { accountCode: string; debit: string; credit: string; partyCode?: string | null; description?: string | null }
interface Entry { id: string; code: string; name: string; status: 'active' | 'paused' | 'ended'; frequency: 'monthly' | 'quarterly' | 'yearly'; dayOfMonth: number; startDate: string; endDate: string | null; catchUp: boolean; description: string | null; autoPost: boolean;
  lines: Line[]; createdCount?: number; skippedCount?: number; errorCount?: number; lastDate?: string | null; nextDate?: string | null }
interface RunRow { id: number; entryCode: string; entryName: string; periodKey: string; date: string; status: 'created' | 'skipped' | 'error'; reasonCode: string | null; message: string | null; voucherId: string | null; voucherNo: string | null; voucherState: string | null; trigger: string; runAt: string }
interface RunItem { entryId: string; entryCode: string; periodKey: string; date: string; status: 'created' | 'skipped' | 'error' | 'exists' | 'planned'; voucherId?: string | null; reasonCode?: string; message?: string }
interface RunResult { upTo: string; dryRun: boolean; items: RunItem[]; created: number; skipped: number; errors: number }

const FREQ = { monthly: 'Hằng tháng', quarterly: 'Hằng quý', yearly: 'Hằng năm' } as const;
const STATUS = { active: { text: 'Đang chạy', color: 'green' }, paused: { text: 'Tạm dừng', color: 'orange' }, ended: { text: 'Đã kết thúc', color: 'default' } } as const;
const RUN_STATUS: Record<string, { text: string; color: string }> = { created: { text: 'Đã lập nháp', color: 'green' }, skipped: { text: 'Bỏ qua', color: 'orange' }, error: { text: 'Lỗi', color: 'red' }, exists: { text: 'Đã có', color: 'default' }, planned: { text: 'Sẽ lập', color: 'blue' } };
const runTag = (s: string) => { const r = RUN_STATUS[s] ?? { text: s, color: 'default' }; return <Tag color={r.color}>{r.text}</Tag>; };
const VSTATE: Record<string, string> = { draft: 'Nháp', posted: 'Đã ghi sổ', reversed: 'Đã đảo', cancelled: 'Đã hủy' };
const blankLines = (): Line[] => [{ accountCode: '', debit: '0', credit: '0' }, { accountCode: '', debit: '0', credit: '0' }];

function EntryEditor({ entry, onClose }: { entry: Entry | 'new' | null; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['recurring-entry', entry !== 'new' && entry ? entry.id : null], enabled: !!entry && entry !== 'new', queryFn: () => api<Entry>(`/api/recurring-entries/${(entry as Entry).id}`) });
  const isNew = entry === 'new';
  return (
    <Drawer open={entry !== null} onClose={onClose} width={860} title={isNew ? 'Thêm mẫu bút toán định kỳ' : `Mẫu ${(entry as Entry | null)?.code ?? ''}`} destroyOnHidden>
      {isNew ? <EntryBody initial={null} onClose={onClose} /> : detail.data ? <EntryBody key={detail.data.id} initial={detail.data} onClose={onClose} /> : detail.error ? <Alert type="error" showIcon message={(detail.error as Error).message} /> : <Spin />}
    </Drawer>
  );
}

// Thân ngăn kéo dựng khi đã có dữ liệu (giá trị đầu vào qua initialValues): không có bước đặt lại biểu mẫu muộn làm mất chữ đang gõ.
function EntryBody({ initial, onClose }: { initial: Entry | null; onClose: () => void }) {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const isNew = initial === null; const readOnly = !can('recurring.manage');
  const [lines, setLines] = useState<Line[]>(initial?.lines.length ? initial.lines : blankLines());
  const fetcher = accountFetcherFor(todayVn());
  const save = useMutation({
    mutationFn: async () => {
      const v = await form.validateFields();
      const body = { code: v.code, name: v.name, frequency: v.frequency, dayOfMonth: v.dayOfMonth, startDate: v.startDate.format('YYYY-MM-DD'), endDate: v.endDate ? v.endDate.format('YYYY-MM-DD') : null,
        catchUp: !!v.catchUp, description: v.description || null, autoPost: !!v.autoPost,
        lines: lines.filter((l) => l.accountCode.trim()).map((l) => ({ accountCode: l.accountCode.trim(), debit: l.debit.trim() || '0', credit: l.credit.trim() || '0', partyCode: l.partyCode || null, description: l.description || null })) };
      return isNew ? api('/api/recurring-entries', { method: 'POST', json: body }) : api(`/api/recurring-entries/${initial.id}`, { method: 'PUT', json: body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['recurring-entries'] }); void qc.invalidateQueries({ queryKey: ['recurring-entry'] }); void message.success('Đã lưu mẫu bút toán định kỳ'); onClose(); },
    onError: (e) => { if ((e as { errorFields?: unknown }).errorFields) return; void message.error((e as Error).message); },
  });
  const set = (i: number, k: keyof Line, v: string | null) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (<>
    <Space style={{ marginBottom: 12 }}><Button onClick={onClose}>Đóng</Button>{!readOnly && <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>Lưu mẫu</Button>}</Space>
    <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Mẫu sinh chứng từ phiếu kế toán ở trạng thái Nháp cho mỗi kỳ đến hạn. Bạn xem lại và ghi sổ; nếu bật Tự ghi sổ thì chứng từ được ghi sổ ngay sau khi lập."
      description="Số tiền là số nguyên đồng hoặc công thức: biến THANG, QUY, NAM, SO_NGAY; phép + - * / và ngoặc; hàm ROUND, MIN, MAX. Ví dụ MAX(1000000, 300000 * SO_NGAY). Tổng Nợ phải bằng tổng Có ở mọi tháng." />
    <Form form={form} layout="vertical" disabled={readOnly} autoComplete="off"
      initialValues={initial ? { ...initial, startDate: dayjs(initial.startDate), endDate: initial.endDate ? dayjs(initial.endDate) : null } : { frequency: 'monthly', dayOfMonth: 31, startDate: dayjs(), catchUp: false, autoPost: false }}>
      <Space align="start" wrap style={{ width: '100%' }}>
        <Form.Item name="code" label="Mã mẫu" rules={[{ required: true, message: 'Nhập mã mẫu' }, { pattern: /^[A-Za-z0-9_.-]{1,30}$/, message: 'Chữ, số, _ . - (tối đa 30)' }]}><Input style={{ width: 160 }} disabled={!isNew} /></Form.Item>
        <Form.Item name="name" label="Tên mẫu" rules={[{ required: true, message: 'Nhập tên mẫu' }]}><Input style={{ width: 360 }} /></Form.Item>
      </Space>
      <Space align="start" wrap style={{ width: '100%' }}>
        <Form.Item name="frequency" label="Tần suất"><Select style={{ width: 140 }} options={Object.entries(FREQ).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item name="dayOfMonth" label="Ngày trong tháng" tooltip="31 = cuối tháng; tháng ngắn hơn lấy ngày cuối tháng" rules={[{ required: true }]}><InputNumber min={1} max={31} style={{ width: 120 }} /></Form.Item>
        <Form.Item name="startDate" label="Bắt đầu từ" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
        <Form.Item name="endDate" label="Kết thúc (nếu có)"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item name="catchUp" label="Lập bù các kỳ trước" valuePropName="checked" tooltip="Tắt: bỏ các kỳ trước tháng lập mẫu"><Switch /></Form.Item>
        <Form.Item name="autoPost" label="Tự ghi sổ" valuePropName="checked" tooltip="Cần quyền Ghi sổ. Mặc định tắt: chỉ lập chứng từ nháp"><Switch disabled={!can('voucher.post')} /></Form.Item>
      </Space>
      <Form.Item name="description" label="Diễn giải chứng từ" tooltip="Dùng {THANG}, {QUY}, {NAM}"><Input placeholder="Ví dụ: Phân bổ chi phí thuê văn phòng {THANG}/{NAM}" /></Form.Item>
    </Form>
    <Table<Line> size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={lines}
      footer={() => (readOnly ? null : <Button onClick={() => setLines((ls) => [...ls, { accountCode: '', debit: '0', credit: '0' }])}>Thêm dòng</Button>)}
      columns={[
        { title: 'Tài khoản (F4)', width: 170, render: (_, l, i) => <LookupSelect catalog="account" fetcher={fetcher} disabled={readOnly} value={l.accountCode || undefined} style={{ width: '100%' }} onChange={(c) => set(i, 'accountCode', c ?? '')} /> },
        { title: 'Nợ (số hoặc công thức)', render: (_, l, i) => <Input aria-label={`Nợ dòng ${i + 1}`} disabled={readOnly} value={l.debit} onChange={(e) => set(i, 'debit', e.target.value)} /> },
        { title: 'Có (số hoặc công thức)', render: (_, l, i) => <Input aria-label={`Có dòng ${i + 1}`} disabled={readOnly} value={l.credit} onChange={(e) => set(i, 'credit', e.target.value)} /> },
        { title: 'Đối tượng', width: 150, render: (_, l, i) => <LookupSelect catalog="party" allowClear disabled={readOnly} value={l.partyCode ?? undefined} style={{ width: '100%' }} onChange={(c) => set(i, 'partyCode', c)} /> },
        { title: '', width: 50, render: (_, __, i) => (readOnly ? null : <Button type="text" danger aria-label={`Xóa dòng ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_x, j) => j !== i))}>×</Button>) },
      ]} />
  </>);
}

function RunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const [upTo, setUpTo] = useState(dayjs());
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api<RunResult>('/api/recurring-entries/run', { method: 'POST', json: { upTo: upTo.format('YYYY-MM-DD'), dryRun } }),
    onSuccess: (r) => { if (!r.dryRun) { void qc.invalidateQueries({ queryKey: ['recurring-entries'] }); void qc.invalidateQueries({ queryKey: ['recurring-runs'] }); void message.success(`Đã lập ${r.created} chứng từ nháp`); } },
    onError: (e) => void message.error((e as Error).message),
  });
  const r = run.data;
  return (
    <Modal open={open} onCancel={onClose} footer={<Button onClick={onClose}>Đóng</Button>} title="Chạy bút toán định kỳ" width={760} destroyOnHidden afterOpenChange={(o) => { if (!o) run.reset(); }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <span>Lập các kỳ đến hạn tới ngày</span>
        <DatePicker aria-label="Đến ngày" format="DD/MM/YYYY" allowClear={false} value={upTo} onChange={(d) => { if (d) { setUpTo(d); run.reset(); } }} />
        <Button onClick={() => run.mutate(true)} loading={run.isPending && run.variables === true}>Xem trước</Button>
        <Button type="primary" onClick={() => run.mutate(false)} loading={run.isPending && run.variables === false}>Lập chứng từ nháp</Button>
      </Space>
      <Typography.Paragraph type="secondary">Chạy lại không sinh trùng: kỳ đã có chứng từ được bỏ qua. Kỳ đã khóa sổ hoặc chưa có trong năm tài chính được bỏ qua kèm lý do.</Typography.Paragraph>
      {r && <>
        <Alert type={r.errors ? 'warning' : 'success'} showIcon style={{ marginBottom: 8 }} data-testid="run-summary"
          message={r.dryRun ? `Xem trước: ${r.items.filter((i) => i.status === 'planned').length} kỳ sẽ lập, ${r.items.filter((i) => i.status === 'exists').length} kỳ đã có` : `Đã lập ${r.created}, bỏ qua ${r.skipped}, lỗi ${r.errors}`} />
        <Table<RunItem> size="small" pagination={{ pageSize: 8, hideOnSinglePage: true }} rowKey={(i) => i.entryId + i.periodKey} dataSource={r.items}
          columns={[{ title: 'Mẫu', dataIndex: 'entryCode', width: 120 }, { title: 'Kỳ', dataIndex: 'periodKey', width: 90 }, { title: 'Ngày', dataIndex: 'date', width: 110, render: (d: string) => (d ? formatVnDate(d) : '') },
            { title: 'Kết quả', dataIndex: 'status', width: 120, render: (s: string) => runTag(s) },
            { title: 'Chi tiết', render: (_, i) => (i.voucherId ? <Link to="/chung-tu/$type/$id" params={{ type: 'PKT', id: i.voucherId }}>Mở chứng từ</Link> : i.message) }]} />
      </>}
    </Modal>
  );
}

function RecurringTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const manage = can('recurring.manage');
  const [editing, setEditing] = useState<Entry | 'new' | null>(null); const [runOpen, setRunOpen] = useState(false); const [runStatus, setRunStatus] = useState<string | undefined>();
  const list = useQuery({ queryKey: ['recurring-entries'], queryFn: () => api<Entry[]>('/api/recurring-entries') });
  const runs = useQuery({ queryKey: ['recurring-runs', runStatus], queryFn: () => api<RunRow[]>(`/api/recurring-runs?limit=100${runStatus ? `&status=${runStatus}` : ''}`) });
  const act = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' | 'ended' | 'delete' }) => (status === 'delete' ? api(`/api/recurring-entries/${id}`, { method: 'DELETE' }) : api(`/api/recurring-entries/${id}/status`, { method: 'POST', json: { status } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recurring-entries'] }), onError: (e) => void message.error((e as Error).message),
  });
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Section title="Mẫu bút toán định kỳ" extra={<Space>{manage && <Button type="primary" onClick={() => setEditing('new')}>Thêm mẫu</Button>}{manage && can('voucher.create') && <Button onClick={() => setRunOpen(true)}>Chạy ngay</Button>}</Space>}>
        <Table<Entry> size="small" loading={list.isLoading} rowKey="id" dataSource={list.data ?? []} pagination={false} locale={{ emptyText: 'Chưa có mẫu. Thêm mẫu cho các bút toán lặp lại hằng tháng, quý, năm: phân bổ chi phí, trích lập, khấu trừ...' }}
          columns={[
            { title: 'Mã', dataIndex: 'code', width: 110, render: (c: string, e) => <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditing(e)}>{c}</Button> }, { title: 'Tên mẫu', dataIndex: 'name' },
            { title: 'Tần suất', width: 150, render: (_, e) => `${FREQ[e.frequency]}, ngày ${e.dayOfMonth === 31 ? 'cuối tháng' : e.dayOfMonth}` },
            { title: 'Hiệu lực', width: 190, render: (_, e) => `${formatVnDate(e.startDate)} – ${e.endDate ? formatVnDate(e.endDate) : 'không hạn'}` },
            { title: 'Trạng thái', width: 120, render: (_, e) => <Space direction="vertical" size={0}><Tag color={STATUS[e.status].color}>{STATUS[e.status].text}</Tag>{e.autoPost && <Tag color="purple">Tự ghi sổ</Tag>}</Space> },
            { title: 'Kỳ kế tiếp', width: 110, render: (_, e) => (e.nextDate ? formatVnDate(e.nextDate) : '–') },
            { title: 'Đã lập / bỏ qua / lỗi', width: 150, render: (_, e) => `${e.createdCount ?? 0} / ${e.skippedCount ?? 0} / ${e.errorCount ?? 0}` },
            ...(manage ? [{ title: '', width: 230, render: (_: unknown, e: Entry) => (
              <Space size="small">
                {e.status === 'active' ? <Button size="small" onClick={() => act.mutate({ id: e.id, status: 'paused' })}>Tạm dừng</Button> : e.status === 'paused' ? <Button size="small" onClick={() => act.mutate({ id: e.id, status: 'active' })}>Tiếp tục</Button> : null}
                {e.status !== 'ended' && <Popconfirm title="Kết thúc mẫu?" description="Mẫu đã kết thúc không còn sinh chứng từ." okText="Kết thúc" cancelText="Không" onConfirm={() => act.mutate({ id: e.id, status: 'ended' })}><Button size="small">Kết thúc</Button></Popconfirm>}
                <Popconfirm title="Xóa mẫu?" description="Chỉ xóa được mẫu chưa sinh chứng từ." okText="Xóa" cancelText="Không" onConfirm={() => act.mutate({ id: e.id, status: 'delete' })}><Button size="small" danger>Xóa</Button></Popconfirm>
              </Space>) }] : []),
          ]} />
      </Section>
      <Section title="Lịch sử chạy" extra={<Select allowClear placeholder="Mọi kết quả" style={{ width: 160 }} value={runStatus} onChange={setRunStatus} options={[{ value: 'created', label: 'Đã lập nháp' }, { value: 'skipped', label: 'Bỏ qua' }, { value: 'error', label: 'Lỗi' }]} />}>
        <Table<RunRow> size="small" loading={runs.isLoading} rowKey="id" dataSource={runs.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa có lần chạy nào' }}
          columns={[{ title: 'Mẫu', dataIndex: 'entryCode', width: 110 }, { title: 'Kỳ', dataIndex: 'periodKey', width: 90 }, { title: 'Ngày', dataIndex: 'date', width: 110, render: (d: string) => formatVnDate(d) },
            { title: 'Kết quả', dataIndex: 'status', width: 120, render: (s: string) => runTag(s) },
            { title: 'Chứng từ', width: 220, render: (_, r) => (r.voucherId ? <Space><Link to="/chung-tu/$type/$id" params={{ type: 'PKT', id: r.voucherId }}>{r.voucherNo ?? 'Nháp (chưa cấp số)'}</Link><Tag>{r.voucherState ? VSTATE[r.voucherState] : 'Đã xóa'}</Tag></Space> : '–') },
            { title: 'Ghi chú', render: (_, r) => r.message ?? '' }, { title: 'Chạy lúc', width: 150, render: (_, r) => dayjs(r.runAt).format('DD/MM/YYYY HH:mm') }, { title: 'Nguồn', width: 90, render: (_, r) => (r.trigger === 'worker' ? 'Tự động' : 'Thủ công') }]} />
      </Section>
      <EntryEditor entry={editing} onClose={() => setEditing(null)} />
      <RunDialog open={runOpen} onClose={() => setRunOpen(false)} />
    </Space>
  );
}

// ---- Nhận diện hóa đơn ----
interface Field { value: string | null; confidence: number }
interface RLine { name: Field; uom: Field; quantity: Field; unitPrice: Field; amount: Field; taxRate: Field }
interface Recognition { provider: string; source: string; formNo: Field; serial: Field; invoiceNo: Field; issueDate: Field; currency: Field; seller: { name: Field; taxCode: Field; address: Field }; buyer: { name: Field; taxCode: Field; address: Field };
  lines: RLine[]; totals: { beforeTax: Field; tax: Field; total: Field }; warnings: { code: string; message: string }[]; needsReview: boolean }
interface RecognizeResult { recognition: Recognition; provider: string; external: boolean; inbound: { id: number; status: string } | null }
interface AssistantSettings { externalRecognition: boolean; provider: string; imageRecognitionAvailable: boolean }
interface LogRow { id: number; provider: string; external: boolean; fileName: string | null; bytes: number | null; status: string; errorCode: string | null; createdAt: string; username: string | null }

const Conf = ({ f, num }: { f: Field; num?: boolean }) => (f.value === null
  ? <Tag color="red">Thiếu</Tag>
  : <Space size={4}><span>{num ? formatVnNumber(f.value) : f.value}</span><Tag color={f.confidence >= 0.8 ? 'green' : 'orange'} title="Độ tin cậy">{Math.round(f.confidence * 100)}%</Tag></Space>);

function RecognizeTab() {
  const { can } = useAuth(); const qc = useQueryClient();
  const [external, setExternal] = useState(false); const [save, setSave] = useState(false); const [result, setResult] = useState<RecognizeResult | null>(null); const [err, setErr] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ['assistant-settings'], queryFn: () => api<AssistantSettings>('/api/assistant/settings') });
  const logs = useQuery({ queryKey: ['assistant-logs'], queryFn: () => api<LogRow[]>('/api/assistant/recognitions') });
  const toggle = useMutation({ mutationFn: (v: boolean) => api('/api/assistant/settings', { method: 'PUT', json: { externalRecognition: v } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['assistant-settings'] }), onError: (e) => void message.error((e as Error).message) });
  const s = settings.data;
  const send = async (file: File) => {
    setErr(null); setResult(null);
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch(`/api/assistant/recognize?external=${external}&save=${save}`, { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json() as RecognizeResult & { error?: { message: string } };
    void qc.invalidateQueries({ queryKey: ['assistant-logs'] });
    if (!r.ok) { setErr(j.error?.message ?? 'Không nhận diện được tệp'); return; }
    setResult(j);
  };
  const rec = result?.recognition;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Section title="Nhận diện hóa đơn đầu vào">
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Kết quả chỉ là bản nháp để bạn soát: trợ lý không tạo chứng từ và không ghi sổ. Văn bản trong hóa đơn chỉ được coi là dữ liệu."
          description="Hóa đơn điện tử XML (QĐ 1233) được đọc ngay trên máy chủ, không gửi đi đâu. Ảnh và PDF cần dịch vụ nhận diện bên ngoài do quản trị cấu hình; tệp chỉ rời máy chủ khi công ty bật cài đặt và bạn chọn gửi ở từng lần." />
        <Space direction="vertical" style={{ width: '100%' }}>
          {s && s.imageRecognitionAvailable && <Space wrap>
            <Switch checked={s.externalRecognition} disabled={!can('setting.update')} loading={toggle.isPending} onChange={(v) => toggle.mutate(v)} aria-label="Cho phép gửi tệp ra dịch vụ nhận diện bên ngoài" />
            <span>Cho phép công ty gửi ảnh/PDF ra dịch vụ nhận diện bên ngoài ({s.provider})</span>
            {s.externalRecognition && <Checkbox checked={external} onChange={(e) => setExternal(e.target.checked)}>Gửi tệp ở lần này</Checkbox>}
          </Space>}
          {s && !s.imageRecognitionAvailable && <Typography.Text type="secondary">Nhận diện ảnh/PDF chưa được cấu hình trên máy chủ (RECOGNIZER_PROVIDER đang tắt); hóa đơn XML vẫn dùng được.</Typography.Text>}
          {can('inbound_invoice.create') && <Checkbox checked={save} onChange={(e) => setSave(e.target.checked)}>Với tệp XML: lưu luôn vào Hóa đơn đầu vào</Checkbox>}
          <Upload.Dragger accept=".xml,.pdf,.png,.jpg,.jpeg" maxCount={1} showUploadList={false} beforeUpload={(f) => { void send(f); return false; }} data-testid="recognize-upload">
            <p>Kéo thả hoặc chọn tệp hóa đơn: XML, PDF, PNG, JPEG (XML tối đa 2 MB, ảnh/PDF tối đa 10 MB)</p>
          </Upload.Dragger>
          {err && <Alert type="error" showIcon data-testid="recognize-error" message={err} />}
        </Space>
      </Section>
      {rec && result && (
        <Section title={`Kết quả nhận diện (${result.provider}${result.external ? ', đã gửi ra ngoài' : ', cục bộ'})`} testId="recognize-result">
          {rec.needsReview ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Cần soát lại trước khi dùng" description="Có trường thiếu, độ tin cậy dưới 80% hoặc số liệu không khớp." />
            : <Alert type="success" showIcon style={{ marginBottom: 12 }} message="Các trường đều đủ và tin cậy cao" />}
          {rec.warnings.map((w) => <Alert key={w.code + w.message} type="warning" showIcon style={{ marginBottom: 6 }} message={w.message} />)}
          {result.inbound && <Alert type="success" showIcon style={{ marginBottom: 12 }} message={result.inbound.status === 'duplicate' ? 'Hóa đơn đã có trong Hóa đơn đầu vào' : 'Đã lưu vào Hóa đơn đầu vào'}
            description={<Link to="/hoa-don-dau-vao">Mở Hóa đơn đầu vào để lập chứng từ</Link>} />}
          <Descriptions size="small" bordered column={2} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="Mẫu số"><Conf f={rec.formNo} /></Descriptions.Item><Descriptions.Item label="Ký hiệu"><Conf f={rec.serial} /></Descriptions.Item>
            <Descriptions.Item label="Số hóa đơn"><Conf f={rec.invoiceNo} /></Descriptions.Item><Descriptions.Item label="Ngày lập"><Conf f={rec.issueDate} /></Descriptions.Item>
            <Descriptions.Item label="Người bán"><Conf f={rec.seller.name} /></Descriptions.Item><Descriptions.Item label="MST người bán"><Conf f={rec.seller.taxCode} /></Descriptions.Item>
            <Descriptions.Item label="Người mua"><Conf f={rec.buyer.name} /></Descriptions.Item><Descriptions.Item label="MST người mua"><Conf f={rec.buyer.taxCode} /></Descriptions.Item>
            <Descriptions.Item label="Tiền hàng"><Conf num f={rec.totals.beforeTax} /></Descriptions.Item><Descriptions.Item label="Tiền thuế"><Conf num f={rec.totals.tax} /></Descriptions.Item>
            <Descriptions.Item label="Tổng thanh toán"><Conf num f={rec.totals.total} /></Descriptions.Item><Descriptions.Item label="Loại tiền"><Conf f={rec.currency} /></Descriptions.Item>
          </Descriptions>
          <Table<RLine> size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={rec.lines}
            columns={[{ title: 'Tên hàng', render: (_, l) => <Conf f={l.name} /> }, { title: 'ĐVT', width: 80, render: (_, l) => l.uom.value ?? '' }, { title: 'Số lượng', width: 100, render: (_, l) => l.quantity.value ?? '' },
              { title: 'Đơn giá', width: 120, render: (_, l) => (l.unitPrice.value ? formatVnNumber(l.unitPrice.value) : '') }, { title: 'Thành tiền', width: 170, render: (_, l) => <Conf num f={l.amount} /> }, { title: 'Thuế suất', width: 90, render: (_, l) => l.taxRate.value ?? '' }]} />
        </Section>)}
      <Section title="Nhật ký nhận diện">
        <Table<LogRow> size="small" loading={logs.isLoading} rowKey="id" dataSource={logs.data ?? []} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa nhận diện tệp nào' }}
          columns={[{ title: 'Lúc', width: 150, render: (_, r) => dayjs(r.createdAt).format('DD/MM/YYYY HH:mm') }, { title: 'Tệp', dataIndex: 'fileName' }, { title: 'Người dùng', dataIndex: 'username', width: 120 },
            { title: 'Bộ nhận diện', width: 110, dataIndex: 'provider' }, { title: 'Gửi ra ngoài', width: 110, render: (_, r) => (r.external ? <Badge status="warning" text="Có" /> : 'Không') },
            { title: 'Kết quả', width: 160, render: (_, r) => (r.status === 'ok' ? <Tag color="green">Thành công</Tag> : <Tag color="red">{r.errorCode ?? 'Lỗi'}</Tag>) }]} />
      </Section>
    </Space>
  );
}

// ---- Gợi ý định khoản (thử nhanh) ----
function SuggestTab() {
  const q = useSuggest(); const [form] = Form.useForm();
  return (
    <Section title="Gợi ý định khoản">
      <Typography.Paragraph type="secondary">Nhập đặc điểm của nghiệp vụ; trợ lý xếp hạng các cặp tài khoản Nợ/Có đã dùng cho nghiệp vụ tương tự trong sổ của công ty và giải thích lý do. Khi nhập chứng từ, bấm Ctrl+G để gợi ý ngay trên phiếu.</Typography.Paragraph>
      <Form form={form} layout="inline" style={{ marginBottom: 12, rowGap: 8 }} onFinish={(v) => q.mutate({ voucherType: v.voucherType, partyCode: v.partyCode, description: v.description, amount: v.amount })}>
        <Form.Item name="voucherType" label="Loại chứng từ"><Select allowClear style={{ width: 150 }} options={['PKT', 'PT', 'PC', 'BC', 'BN', 'HDM', 'HDB'].map((value) => ({ value, label: value }))} /></Form.Item>
        <Form.Item name="partyCode" label="Đối tượng"><LookupSelect catalog="party" allowClear style={{ width: 200 }} onChange={(c) => form.setFieldValue('partyCode', c ?? undefined)} /></Form.Item>
        <Form.Item name="description" label="Diễn giải"><Input style={{ width: 260 }} placeholder="Ví dụ: thuê văn phòng tháng 10" /></Form.Item>
        <Form.Item name="amount" label="Số tiền" rules={[{ pattern: /^\d{1,16}$/, message: 'Số nguyên đồng' }]}><Input style={{ width: 150 }} inputMode="numeric" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={q.isPending}>Gợi ý</Button>
      </Form>
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      {q.data && <><Typography.Paragraph type="secondary">Đã xét {q.data.considered} chứng từ đến ngày {formatVnDate(q.data.asOf)}.</Typography.Paragraph><SuggestList data={q.data} /></>}
    </Section>
  );
}

export default function AssistantPage() {
  const { can } = useAuth();
  const items = [
    ...(can('recurring.view') ? [{ key: 'recurring', label: 'Bút toán định kỳ', children: <RecurringTab /> }] : []),
    ...(can('assistant.use') ? [{ key: 'recognize', label: 'Nhận diện hóa đơn', children: <RecognizeTab /> }, { key: 'suggest', label: 'Gợi ý định khoản', children: <SuggestTab /> }] : []),
  ];
  return (
    <>
      <PageHeader
        title="Trợ lý"
        description="Bút toán định kỳ, nhận diện hóa đơn và gợi ý định khoản"
      />
      {items.length ? <Tabs items={items} destroyInactiveTabPane /> : <Alert type="warning" showIcon message="Bạn chưa có quyền dùng trợ lý" />}
    </>
  );
}
