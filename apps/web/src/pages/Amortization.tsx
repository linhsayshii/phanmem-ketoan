import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D, formatVnDate, formatVnNumber, isImeComposing, todayVn } from '@kt/domain';
import { LookupSelect, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import { fetchVoucherNos } from './settleCommon.js';

interface FiscalYear { fiscalYear: number; dateFrom: string; dateTo: string; periods: { periodNo: number; dateFrom: string; dateTo: string }[] }
interface Line { seq: number; fiscalYear: number; periodNo: number; amount: string; voucherId: string | null; voucherNo: string | null; voucherState: string | null }
interface Schedule { id: number; sourceVoucherId: string | null; fromAccountCode: string; toAccountCode: string; total: string; periods: number; startYear: number; startPeriod: number; description: string | null;
  isActive: boolean; started: boolean; postedAmount: string; lines: Line[] }
interface RunResult { fiscalYear: number; periodNo: number; created: { scheduleId: number; voucherId: string }[]; reversedVoucherIds: string[]; unchanged: number; skipped?: { scheduleId: number; reason: string }[] }
interface FormValues { fromAccountCode: string | null; toAccountCode: string | null; total: string | null; periods: number | null; startYear: number | null; startPeriod: number | null; description: string }

const money = (s: string) => formatVnNumber(s, 0);
const STATE_LABEL: Record<string, string> = { posted: 'Đã ghi sổ', reversed: 'Đã đảo' };
// Giá trị điền sẵn từ hóa đơn có dòng hạch toán vào 3387 (đường dẫn ?from=&to=&total=&description=&voucher=).
function prefillFromUrl(): Partial<FormValues> & { sourceVoucherId?: string } | null {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('from') && !q.has('total')) return null;
  return { fromAccountCode: q.get('from') ?? '3387', toAccountCode: q.get('to') ?? '5113', total: q.get('total'), description: q.get('description') ?? '', ...(q.get('voucher') ? { sourceVoucherId: q.get('voucher')! } : {}) };
}

export default function AmortizationPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const today = todayVn();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const list = useQuery({ queryKey: ['amortizations'], queryFn: () => api<Schedule[]>('/api/amortizations') });
  const fy = years.data ?? [];
  const cur = fy.find((y) => y.dateFrom <= today && today <= y.dateTo) ?? fy.at(-1);

  // ---- Chạy phân bổ theo kỳ ----
  const [runYear, setRunYear] = useState<number | null>(null); const [runPeriod, setRunPeriod] = useState<number | null>(null);
  const [runOut, setRunOut] = useState<{ r: RunResult; nos: string[] } | null>(null); const [runErr, setRunErr] = useState<string | null>(null);
  const year = fy.find((y) => y.fiscalYear === runYear) ?? cur;
  const run = useMutation({
    mutationFn: () => api<RunResult>('/api/amortizations/run', { method: 'POST', json: { fiscalYear: year!.fiscalYear, periodNo: runPeriod! } }),
    onMutate: () => { setRunErr(null); setRunOut(null); },
    onError: (e) => setRunErr((e as Error).message),
    onSuccess: async (r) => { setRunOut({ r, nos: await fetchVoucherNos(r.created.map((c) => c.voucherId)) }); void qc.invalidateQueries({ queryKey: ['amortizations'] }); },
  });

  // ---- Thêm, sửa lịch ----
  const pre = useMemo(prefillFromUrl, []);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(pre ? 'new' : null);
  const [form] = Form.useForm<FormValues>();
  const [sourceVoucherId, setSourceVoucherId] = useState<string | null>(pre?.sourceVoucherId ?? null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const open = (s: Schedule | 'new') => {
    setEditing(s); setFormErr(null); setSourceVoucherId(s === 'new' ? null : s.sourceVoucherId);
    form.setFieldsValue(s === 'new' ? { fromAccountCode: '3387', toAccountCode: '5113', total: null, periods: 12, startYear: cur?.fiscalYear ?? null, startPeriod: 1, description: '' }
      : { fromAccountCode: s.fromAccountCode, toAccountCode: s.toAccountCode, total: s.total, periods: s.periods, startYear: s.startYear, startPeriod: s.startPeriod, description: s.description ?? '' });
  };
  // Form được dựng sẵn (forceRender) nên đặt giá trị ngay được; lần đầu vào trang có tham số từ hóa đơn thì mở sẵn hộp thoại.
  useEffect(() => { if (pre && cur) { open('new'); form.setFieldsValue({ ...pre }); } }, [cur?.fiscalYear]);
  const watchedYear = Form.useWatch('startYear', form) as number | undefined;
  const startDate = watchedYear ? `${watchedYear}-01-01` : today;
  const accountFetcher = useMemo(() => accountFetcherFor(startDate), [startDate]);
  const startNos = fy.find((y) => y.fiscalYear === watchedYear)?.periods.filter((p) => p.periodNo > 0).map((p) => p.periodNo) ?? Array.from({ length: 12 }, (_, i) => i + 1);
  // Enter (trong ô nhập, không phải danh sách chọn) và Ctrl+S lưu hộp thoại; không dùng useHotkeys vì nó bỏ qua phím khi tiêu điểm nằm trong hộp thoại.
  const submitOnKey = (e: React.KeyboardEvent) => {
    if (isImeComposing(e.nativeEvent) || save.isPending) return;
    const t = e.target as HTMLElement;
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') || (e.key === 'Enter' && t.tagName === 'INPUT' && !t.closest('.ant-select'))) { e.preventDefault(); void form.validateFields().then((v) => save.mutate(v), () => undefined); }
  };
  const bodyOf = (v: FormValues, s?: { isActive?: boolean }) => ({ fromAccountCode: v.fromAccountCode, toAccountCode: v.toAccountCode, total: v.total, periods: v.periods, startYear: v.startYear, startPeriod: v.startPeriod,
    description: v.description.trim() || null, ...(sourceVoucherId ? { sourceVoucherId } : {}), ...(s?.isActive === undefined ? {} : { isActive: s.isActive }) });
  const save = useMutation({
    mutationFn: (v: FormValues) => (editing === 'new' || editing === null ? api<Schedule>('/api/amortizations', { method: 'POST', json: bodyOf(v) })
      : api<Schedule>(`/api/amortizations/${editing.id}`, { method: 'PUT', json: bodyOf(v, { isActive: editing.isActive }) })),
    onError: (e) => setFormErr((e as Error).message),
    onSuccess: () => { setEditing(null); void message.success('Đã lưu lịch phân bổ'); void qc.invalidateQueries({ queryKey: ['amortizations'] }); },
  });
  const toggle = useMutation({
    mutationFn: (s: Schedule) => api<Schedule>(`/api/amortizations/${s.id}`, { method: 'PUT', json: { fromAccountCode: s.fromAccountCode, toAccountCode: s.toAccountCode, total: s.total, periods: s.periods, startYear: s.startYear,
      startPeriod: s.startPeriod, description: s.description, ...(s.sourceVoucherId ? { sourceVoucherId: s.sourceVoucherId } : {}), isActive: !s.isActive } }),
    onError: (e) => { void message.error((e as Error).message); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['amortizations'] }); },
  });
  const del = useMutation({
    mutationFn: (s: Schedule) => api(`/api/amortizations/${s.id}`, { method: 'DELETE' }),
    onError: (e) => { void message.error((e as Error).message); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['amortizations'] }); },
  });

  const watch = Form.useWatch([], form) as Partial<FormValues> | undefined;
  const split = (() => {
    if (!watch?.total || !watch.periods || watch.periods < 1) return null;
    const each = D(watch.total).div(watch.periods).floor();
    return { each: each.toFixed(0), last: D(watch.total).minus(each.times(watch.periods - 1)).toFixed(0) };
  })();
  const yearOpt = fy.map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }));
  const writable = can('amortization.create') || can('amortization.update');

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <h2 style={{ margin: 0 }}>Phân bổ doanh thu nhận trước</h2>
      <span>Doanh thu nhận trước (TK 3387) được phân bổ đều theo kỳ vào doanh thu: mỗi kỳ một chứng từ phân bổ (PB), Nợ TK nhận trước / Có TK doanh thu, ghi ngày cuối kỳ. Kỳ cuối nhận phần dư làm tròn.</span>
      {can('amortization.run') && (
        <Space wrap>
          <Select<number> aria-label="Năm tài chính" style={{ width: 150 }} value={year?.fiscalYear ?? null} options={yearOpt} onChange={(v) => { setRunYear(v); setRunPeriod(null); }} />
          <Select<number> aria-label="Kỳ kế toán" placeholder="Chọn kỳ" virtual={false} style={{ width: 220 }} value={runPeriod} onChange={setRunPeriod}
            options={(year?.periods ?? []).filter((p) => p.periodNo > 0).map((p) => ({ value: p.periodNo, label: `Kỳ ${p.periodNo} (${formatVnDate(p.dateFrom).slice(0, 5)} - ${formatVnDate(p.dateTo).slice(0, 5)})` }))} />
          <Button type="primary" disabled={runPeriod === null || !year} loading={run.isPending} onClick={() => run.mutate()}>Chạy phân bổ kỳ</Button>
        </Space>
      )}
      {runErr && <Alert type="error" showIcon message={runErr} />}
      {runOut && (runOut.r.created.length === 0
        ? <Alert type="info" showIcon message={`Không có khoản phân bổ mới ở kỳ ${runOut.r.periodNo}/${runOut.r.fiscalYear}${runOut.r.unchanged ? ` (${runOut.r.unchanged} chứng từ đã ghi sổ, không đổi)` : ''}`} />
        : <Alert type="success" showIcon message={`Đã phân bổ kỳ ${runOut.r.periodNo}/${runOut.r.fiscalYear}: ${runOut.r.created.length} chứng từ${runOut.r.reversedVoucherIds.length ? `, đảo ${runOut.r.reversedVoucherIds.length} chứng từ cũ` : ''}`}
          description={runOut.r.created.map((c, i) => <span key={c.voucherId}>{i > 0 && ', '}<a href={`/chung-tu/PB/${c.voucherId}`} target="_blank" rel="noopener noreferrer">{runOut.nos[i] ?? c.voucherId}</a></span>)} />)}
      {!!runOut?.r.skipped?.length && <Alert type="warning" showIcon message={`Bỏ qua ${runOut.r.skipped.length} lịch vì chứng từ gốc không còn ghi sổ`}
        description={<ul style={{ margin: 0, paddingLeft: 18 }}>{runOut.r.skipped.map((k) => <li key={k.scheduleId}>{k.reason}</li>)}</ul>} />}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <b>Lịch phân bổ</b>
        {can('amortization.create') && <Button onClick={() => open('new')}>Thêm lịch</Button>}
      </div>
      {list.error && <Alert type="error" showIcon message={(list.error as Error).message} />}
      <Table<Schedule> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa có lịch phân bổ' }}
        expandable={{ expandedRowRender: (s) => (
          <Table<Line> size="small" rowKey="seq" pagination={false} dataSource={s.lines} columns={[
            { title: 'Kỳ phân bổ', dataIndex: 'seq', width: 100 }, { title: 'Kỳ kế toán', width: 120, render: (_, l) => `${l.periodNo}/${l.fiscalYear}` },
            { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 150, render: money },
            { title: 'Chứng từ', render: (_, l) => (l.voucherId ? <a href={`/chung-tu/PB/${l.voucherId}`} target="_blank" rel="noopener noreferrer">{l.voucherNo ?? l.voucherId} ({STATE_LABEL[l.voucherState ?? ''] ?? l.voucherState})</a> : 'Chưa phân bổ') }]} />) }}
        columns={[
          { title: 'Diễn giải', dataIndex: 'description', render: (v: string | null) => v ?? '' },
          { title: 'Nợ / Có', width: 130, render: (_, s) => `${s.fromAccountCode} / ${s.toAccountCode}` },
          { title: 'Tổng số tiền', dataIndex: 'total', align: 'right', width: 140, render: money },
          { title: 'Số kỳ', dataIndex: 'periods', align: 'right', width: 80 },
          { title: 'Bắt đầu', width: 90, render: (_, s) => `${s.startPeriod}/${s.startYear}` },
          { title: 'Đã phân bổ', dataIndex: 'postedAmount', align: 'right', width: 140, render: money },
          { title: 'Trạng thái', width: 110, render: (_, s) => <Tag color={s.isActive ? 'green' : 'default'}>{s.isActive ? 'Đang chạy' : 'Đã ngừng'}</Tag> },
          { title: '', key: 'act', width: 230, render: (_, s) => writable && (
            <Space size={4}>
              {can('amortization.update') && <Button size="small" aria-label={`Sửa lịch ${s.id}`} onClick={() => open(s)}>Sửa</Button>}
              {can('amortization.update') && <Button size="small" loading={toggle.isPending} onClick={() => toggle.mutate(s)}>{s.isActive ? 'Ngừng' : 'Tiếp tục'}</Button>}
              {can('amortization.delete') && <Popconfirm title="Xóa lịch phân bổ này?" okText="Xóa" cancelText="Không" disabled={s.started} onConfirm={() => del.mutate(s)}>
                <Button size="small" danger disabled={s.started}>Xóa</Button></Popconfirm>}
            </Space>) },
        ]} />

      <Modal open={editing !== null} title={editing === 'new' ? 'Thêm lịch phân bổ' : 'Sửa lịch phân bổ'} okText="Lưu" cancelText="Đóng" forceRender width={640} confirmLoading={save.isPending}
        onCancel={() => setEditing(null)} onOk={() => { void form.validateFields().then((v) => save.mutate(v), () => undefined); }}>
        {typeof editing === 'object' && editing?.started && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Lịch đã phân bổ ít nhất một kỳ: chỉ sửa được diễn giải" />}
        {formErr && <Alert type="error" showIcon message={formErr} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" onKeyDown={submitOnKey} disabled={typeof editing === 'object' && editing?.started === true} initialValues={{ fromAccountCode: '3387', toAccountCode: '5113', periods: 12, startPeriod: 1, description: '' }}>
          <Space align="start" size={12} style={{ display: 'flex' }}>
            <Form.Item label="Tài khoản nhận trước (Nợ, F4)" name="fromAccountCode" rules={[{ required: true, message: 'Chọn tài khoản' }]} style={{ width: 280 }}><LookupSelect catalog="account" fetcher={accountFetcher} /></Form.Item>
            <Form.Item label="Tài khoản doanh thu (Có, F4)" name="toAccountCode" rules={[{ required: true, message: 'Chọn tài khoản' }]} style={{ width: 280 }}><LookupSelect catalog="account" fetcher={accountFetcher} /></Form.Item>
          </Space>
          <Space align="start" size={12} style={{ display: 'flex' }}>
            <Form.Item label="Tổng số tiền" name="total" rules={[{ required: true, message: 'Nhập tổng số tiền' }]} style={{ width: 200 }}><VnNumberInput aria-label="Tổng số tiền" /></Form.Item>
            <Form.Item label="Số kỳ" name="periods" rules={[{ required: true, message: 'Nhập số kỳ' }]} style={{ width: 100 }}><InputNumber aria-label="Số kỳ" min={1} max={120} precision={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item label="Năm bắt đầu" name="startYear" rules={[{ required: true, message: 'Chọn năm' }]} style={{ width: 140 }}><Select aria-label="Năm bắt đầu" options={yearOpt} /></Form.Item>
            <Form.Item label="Kỳ bắt đầu" name="startPeriod" rules={[{ required: true, message: 'Chọn kỳ' }]} style={{ width: 100 }}><Select aria-label="Kỳ bắt đầu" virtual={false} options={startNos.map((n) => ({ value: n, label: `Kỳ ${n}` }))} /></Form.Item>
          </Space>
          <Form.Item label="Diễn giải" name="description"><Input maxLength={500} disabled={false} /></Form.Item>
        </Form>
        {split && <span style={{ opacity: 0.75 }}>Mỗi kỳ {money(split.each)}{split.last !== split.each ? `, kỳ cuối ${money(split.last)}` : ''}.</span>}
      </Modal>
    </Space>
  );
}
