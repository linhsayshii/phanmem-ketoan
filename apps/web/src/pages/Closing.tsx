import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { sum, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { useUnsavedChanges } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Ratio { account: string; percent: string }
interface Step { id: string; regime: string; stepOrder: number; name: string; mode: 'transfer' | 'allocate'; fromAccounts: string[]; toAccount: string | null; keepBalance: string; byDimension: 'project' | null;
  ratioSource: { ratios: Ratio[] } | null; runAt: 'period_end' | 'next_year_start'; isActive: boolean }
interface Run { id: number; stepName: string; postingDate: string; voucherNo: string | null; voucherId: string; status: 'done' | 'reversed'; createdAt: string }
// Biểu mẫu phẳng hơn dữ liệu máy chủ: tỷ lệ phân bổ và cờ "theo vụ việc" nằm cùng cấp với các trường khác.
type FormStep = Omit<Step, 'id' | 'regime' | 'ratioSource' | 'byDimension'> & { id?: string; ratios: Ratio[]; byProject: boolean };

const MODE = { transfer: 'Kết chuyển', allocate: 'Phân bổ' } as const;
const RUN_AT = { period_end: 'Cuối kỳ', next_year_start: 'Đầu năm sau' } as const;
const options = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));
const fmtDate = (d: string) => dayjs(d).format('DD/MM/YYYY');
const toForm = (s: Step): FormStep => ({ id: s.id, stepOrder: s.stepOrder, name: s.name, mode: s.mode, fromAccounts: s.fromAccounts, toAccount: s.toAccount, keepBalance: s.keepBalance,
  ratios: s.ratioSource?.ratios ?? [], byProject: s.byDimension === 'project', runAt: s.runAt, isActive: s.isActive });
const toPayload = ({ ratios, byProject, toAccount, ...s }: FormStep) => ({ ...s, byDimension: byProject ? 'project' : null,
  toAccount: s.mode === 'transfer' ? toAccount || null : null, ratioSource: s.mode === 'allocate' ? { ratios } : null });
const target = (s: Step) => (s.mode === 'allocate' ? (s.ratioSource?.ratios ?? []).map((r) => `${r.account} ${r.percent}%`).join(', ') : s.toAccount ?? '');

function RatioList({ name }: { name: number }) {
  return (
    <Form.List name={[name, 'ratios']}>
      {(fields, { add, remove }) => (
        <Space direction="vertical" size={4}>
          <span>Tỷ lệ phân bổ (tổng 100%)</span>
          {fields.map((r) => (
            <Space key={r.key} align="baseline">
              <Form.Item name={[r.name, 'account']} noStyle rules={[{ required: true, message: 'Nhập tài khoản' }]}><Input placeholder="TK đích" style={{ width: 110 }} /></Form.Item>
              <Form.Item name={[r.name, 'percent']} noStyle rules={[{ required: true, pattern: /^\d+(\.\d+)?$/, message: 'Nhập số' }]}><Input placeholder="Tỷ lệ" suffix="%" style={{ width: 100 }} /></Form.Item>
              <Button size="small" onClick={() => remove(r.name)}>Bỏ</Button>
            </Space>))}
          <Button size="small" onClick={() => add({ account: '', percent: '' })}>Thêm tỷ lệ</Button>
        </Space>)}
    </Form.List>
  );
}

export default function ClosingPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [date, setDate] = useState<Dayjs>(() => dayjs().endOf('month'));
  const postingDate = date.format('YYYY-MM-DD');
  const [form] = Form.useForm<{ steps: FormStep[] }>();
  // Sơ đồ đang sửa dở: đổi ngày kết chuyển nạp sơ đồ của ngày khác nên phải hỏi trước, cùng cơ chế với màn hình chứng từ.
  const [dirty, setDirty] = useState(false);
  const confirmIfDirty = useUnsavedChanges(dirty);
  const steps = useQuery({ queryKey: ['closing-steps', postingDate], queryFn: () => api<Step[]>(`/api/closing/steps?date=${postingDate}`) });
  const runs = useQuery({ queryKey: ['closing-runs', date.year()], queryFn: () => api<Run[]>(`/api/closing/runs?year=${date.year()}`) });
  useEffect(() => { if (steps.error) void message.error((steps.error as Error).message); }, [steps.error]);
  useEffect(() => { if (runs.error) void message.error((runs.error as Error).message); }, [runs.error]);
  const canEdit = can('closing_step.update');
  useEffect(() => { if (steps.data && canEdit) { form.setFieldsValue({ steps: steps.data.map(toForm) }); setDirty(false); } }, [steps.data, form, canEdit]);
  const onError = (e: unknown) => { void message.error((e as Error).message); };
  // Tải lại cả khi lỗi: chạy tất cả có thể đã xong vài bước trước khi gặp lỗi, nhật ký phải hiện đúng. Chạy bước không tải lại sơ đồ (biểu mẫu đang sửa dở sẽ bị đặt lại).
  const refresh = (...keys: string[]) => () => { for (const k of keys) void qc.invalidateQueries({ queryKey: [k] }); };
  // Chạy lại một bước không tự chạy lại các bước sau đã chạy cùng ngày: giữ cảnh báo trên màn hình tới lần chạy kế tiếp (hoặc khi người dùng đóng).
  const [laterDone, setLaterDone] = useState<string[]>([]);
  const exec = useMutation({
    mutationFn: ({ path, json }: { path: 'run' | 'rerun' | 'run-all'; json: object }) => api<{ voucherIds?: string[]; laterStepsDone?: string[]; steps?: { voucherIds: string[] }[] }>(`/api/closing/${path}`, { method: 'POST', json }),
    onMutate: () => { setLaterDone([]); },
    onError, onSettled: refresh('closing-runs', 'vouchers'),
    onSuccess: (r) => { setLaterDone(r.laterStepsDone ?? []); const n = r.voucherIds?.length ?? r.steps?.reduce((a, s) => a + s.voucherIds.length, 0) ?? 0; void message.success(n ? `Đã sinh ${n} chứng từ` : 'Không có số dư cần xử lý'); },
  });
  const save = useMutation({ mutationFn: (v: FormStep[]) => api('/api/closing/steps', { method: 'PUT', json: { steps: v.map(toPayload), date: postingDate } }), onError, onSettled: refresh('closing-steps'),
    onSuccess: () => { setDirty(false); void message.success('Đã lưu sơ đồ'); } });
  const reload = useMutation({ mutationFn: () => api('/api/closing/steps/reload', { method: 'POST', json: { date: postingDate } }), onError, onSettled: refresh('closing-steps', 'closing-runs'), onSuccess: () => { void message.success('Đã nạp lại sơ đồ mẫu'); } });

  const confirm = (title: string, content: string, okText: string, fn: () => Promise<unknown>) =>
    Modal.confirm({ title, content, okText, cancelText: 'Hủy', onOk: () => fn().catch(() => undefined) });
  const runOne = (s: Step) => exec.mutateAsync({ path: 'run', json: { stepId: s.id, postingDate } });
  const rerunOne = (s: Step) => confirm(`Chạy lại "${s.name}" ngày ${date.format('DD/MM/YYYY')}?`, 'Các chứng từ đã sinh của bước này tại ngày đó được đảo (không sửa đè), rồi bước được chạy lại theo số dư hiện tại. Các bước sau của sơ đồ đã chạy cùng ngày không tự chạy lại: hãy chạy lại các bước đó hoặc Chạy tất cả.', 'Đảo và chạy lại',
    () => exec.mutateAsync({ path: 'rerun', json: { stepId: s.id, postingDate } }));
  const regime = steps.data?.[0]?.regime;
  const periodEnd = (steps.data ?? []).filter((s) => s.isActive && s.runAt === 'period_end');
  const runAll = () => confirm(`Chạy ${periodEnd.length} bước cuối kỳ đến ngày ${date.format('DD/MM/YYYY')}?`, 'Các bước chạy lần lượt theo thứ tự và dừng ở bước lỗi đầu tiên; bước đã chạy được giữ lại.', 'Chạy tất cả',
    () => exec.mutateAsync({ path: 'run-all', json: { postingDate } }));
  const onFinish = (v: { steps: FormStep[] }) => {
    const bad = v.steps.find((s) => s.mode === 'allocate' && !sum(s.ratios.map((r) => r.percent)).equals(100));
    if (bad) void message.error(`Bước "${bad.name}": tổng tỷ lệ phân bổ phải bằng 100%`); else save.mutate(v.steps);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Kết chuyển cuối kỳ</h2>
        <span>Ngày kết chuyển</span>
        <DatePicker format="DD/MM/YYYY" allowClear={false} value={date} onChange={(d) => d && confirmIfDirty(() => setDate(d))} />
        {can('closing.run') && <Button type="primary" disabled={!periodEnd.length} loading={exec.isPending} onClick={runAll}>Chạy tất cả bước cuối kỳ</Button>}
      </Space>
      {laterDone.length > 0 && <Alert type="warning" showIcon closable onClose={() => setLaterDone([])} message={`Các bước sau đã chạy trước đó: ${laterDone.join(', ')}; hãy chạy lại các bước này hoặc Chạy tất cả`} />}
      <Card size="small" title={<>Các bước {regime && <Tag color="blue">Sơ đồ {regime}</Tag>}</>} extra="Bước &quot;Đầu năm sau&quot; chạy với ngày 01/01 của năm sau">
        <Table<Step> rowKey="id" size="small" pagination={false} loading={steps.isFetching} dataSource={steps.data ?? []} columns={[
          { title: 'Thứ tự', dataIndex: 'stepOrder', width: 80 },
          { title: 'Tên bước', dataIndex: 'name', render: (n: string, s) => <>{n} {!s.isActive && <Tag>Ngừng</Tag>}</> },
          { title: 'Chế độ', dataIndex: 'mode', width: 110, render: (m: Step['mode']) => MODE[m] },
          { title: 'TK nguồn', dataIndex: 'fromAccounts', width: 200, render: (a: string[]) => a.join(', ') },
          { title: 'TK đích', key: 'to', width: 160, render: (_, s) => target(s) },
          { title: 'Chạy lúc', dataIndex: 'runAt', width: 120, render: (r: Step['runAt']) => RUN_AT[r] },
          { title: '', key: 'act', width: 230, render: (_, s) => can('closing.run') && (
            <Space>
              <Button size="small" loading={exec.isPending} onClick={() => void runOne(s).catch(() => undefined)}>Chạy</Button>
              <Button size="small" onClick={() => rerunOne(s)}>Chạy lại (đảo cũ)</Button>
            </Space>) },
        ]} />
      </Card>
      <Card size="small" title={`Nhật ký chạy năm ${date.year()}`}>
        <Table<Run> rowKey="id" size="small" pagination={{ pageSize: 20, hideOnSinglePage: true }} loading={runs.isFetching} dataSource={runs.data ?? []} columns={[
          { title: 'Ngày', dataIndex: 'postingDate', width: 110, render: fmtDate },
          { title: 'Bước', dataIndex: 'stepName' },
          { title: 'Chứng từ', key: 'v', width: 140, render: (_, r) => <Link to="/chung-tu/$type/$id" params={{ type: 'KC', id: r.voucherId }}>{r.voucherNo ?? '(chưa số)'}</Link> },
          { title: 'Trạng thái', dataIndex: 'status', width: 110, render: (s: Run['status']) => (s === 'done' ? <Tag color="green">Đã chạy</Tag> : <Tag color="orange">Đã đảo</Tag>) },
          { title: 'Lúc chạy', dataIndex: 'createdAt', width: 150, render: (t: string) => dayjs(t).format('DD/MM/YYYY HH:mm') },
        ]} />
      </Card>
      {canEdit && (
        <Card size="small" title="Sơ đồ kết chuyển, phân bổ">
          <Form<{ steps: FormStep[] }> form={form} layout="vertical" onFinish={onFinish} onValuesChange={() => setDirty(true)}>
            <Form.List name="steps">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((f) => (
                    <Card key={f.key} size="small" style={{ marginBottom: 8 }} extra={<Button size="small" danger onClick={() => remove(f.name)}>Xóa bước</Button>}>
                      <Form.Item name={[f.name, 'id']} hidden><Input /></Form.Item>
                      <Space align="start" wrap>
                        <Form.Item name={[f.name, 'stepOrder']} label="Thứ tự" rules={[{ required: true, message: 'Nhập thứ tự' }]}><InputNumber min={1} precision={0} /></Form.Item>
                        <Form.Item name={[f.name, 'name']} label="Tên bước" rules={[{ required: true, message: 'Nhập tên bước' }]}><Input style={{ width: 320 }} /></Form.Item>
                        <Form.Item name={[f.name, 'mode']} label="Chế độ"><Select style={{ width: 120 }} options={options(MODE)} /></Form.Item>
                        <Form.Item name={[f.name, 'runAt']} label="Chạy lúc"><Select style={{ width: 140 }} options={options(RUN_AT)} /></Form.Item>
                        <Form.Item name={[f.name, 'isActive']} label="Hoạt động" valuePropName="checked"><Switch /></Form.Item>
                      </Space>
                      <Space align="start" wrap>
                        <Form.Item name={[f.name, 'fromAccounts']} label="TK nguồn (số hiệu hoặc đầu số)" rules={[{ required: true, type: 'array', min: 1, message: 'Nhập ít nhất một tài khoản' }]}>
                          <Select mode="tags" open={false} tokenSeparators={[',', ' ']} style={{ width: 280 }} />
                        </Form.Item>
                        <Form.Item noStyle dependencies={[['steps', f.name, 'mode']]}>
                          {({ getFieldValue }) => (getFieldValue(['steps', f.name, 'mode']) === 'allocate' ? <RatioList name={f.name} />
                            : <Form.Item name={[f.name, 'toAccount']} label="TK đích" rules={[{ required: true, message: 'Nhập tài khoản đích' }]}><Input style={{ width: 120 }} /></Form.Item>)}
                        </Form.Item>
                        <Form.Item name={[f.name, 'keepBalance']} label="Giữ lại số dư" rules={[{ pattern: VND_AMOUNT_RE, message: VND_AMOUNT_MSG }]}><Input style={{ width: 120 }} /></Form.Item>
                        <Form.Item name={[f.name, 'byProject']} label=" " valuePropName="checked"><Checkbox>Theo vụ việc</Checkbox></Form.Item>
                      </Space>
                    </Card>))}
                  <Button onClick={() => add({ stepOrder: Math.max(0, ...((form.getFieldValue('steps') ?? []) as FormStep[]).map((s) => s.stepOrder)) + 1, name: '', mode: 'transfer', fromAccounts: [], toAccount: '', keepBalance: '0',
                    ratios: [], byProject: false, runAt: 'period_end', isActive: true })}>Thêm bước</Button>
                </>)}
            </Form.List>
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" htmlType="submit" loading={save.isPending}>Lưu sơ đồ</Button>
              <Button loading={reload.isPending} onClick={() => confirm('Nạp lại sơ đồ mẫu?', `Sơ đồ ${regime ?? ''} hiện tại bị thay bằng sơ đồ mẫu của chế độ này (sơ đồ chế độ khác giữ nguyên). Nhật ký chạy được giữ lại.`, 'Nạp lại mẫu', () => reload.mutateAsync())}>Nạp lại mẫu</Button>
            </Space>
          </Form>
        </Card>)}
    </Space>
  );
}
