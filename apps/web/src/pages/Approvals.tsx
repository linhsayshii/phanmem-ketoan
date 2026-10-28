import { useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Badge, Button, Card, DatePicker, Descriptions, Drawer, Form, Grid, Input, List, Modal, Popconfirm, Radio, Select, Space, Steps, Switch, Table, Tabs, Tag, Timeline, Upload, message,
} from 'antd';
import { LookupSelect, VnNumberInput, useHotkeys } from '@kt/ui';
import { formatVnNumber } from '@kt/domain';
import { api, apiBlob } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor, bankAccountFetcher } from '../lookups.js';

// Đề nghị thanh toán / tạm ứng và hộp duyệt. Màn hình hẹp (điện thoại): danh sách thẻ, ngăn kéo chi tiết toàn màn hình.
interface Step { stepNo: number; roleId: string | null; roleName: string | null; userId: string | null; username: string | null }
export interface Request {
  id: string; kind: 'payment' | 'advance'; kindLabel: string; requestNo: string; requestDate: string; requesterName: string; partyCode: string | null; partyName: string | null; payeeName: string; reason: string;
  currencyCode: string; amountCurrency: string; fxRate: string | null; amount: string; accountCode: string; payMethod: 'cash' | 'bank'; bankAccountNo: string | null; dueDate: string | null;
  state: State; steps: Step[]; currentStep: number; rejectReason: string | null; voucherId: string | null; voucherNo: string | null; voucherType: string | null;
}
interface Detail extends Request { canAct: boolean; log: { stepNo: number; action: string; note: string | null; at: string; username: string }[]; attachments: { id: string; fileName: string; bytes: number }[] }
type State = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
type Box = 'mine' | 'inbox' | 'all';

const STATE: Record<State, { label: string; color: string }> = {
  draft: { label: 'Nháp', color: 'default' }, submitted: { label: 'Chờ duyệt', color: 'processing' }, approved: { label: 'Đã duyệt', color: 'success' },
  rejected: { label: 'Từ chối', color: 'error' }, cancelled: { label: 'Đã hủy', color: 'default' },
};
const ACTION: Record<string, string> = { submit: 'Gửi duyệt', approve: 'Duyệt', reject: 'Từ chối', cancel: 'Hủy' };
const fmtDate = (d: string | null) => (d ? dayjs(d).format('DD/MM/YYYY') : '–');
const money = (r: Pick<Request, 'amount' | 'currencyCode' | 'amountCurrency'>) =>
  r.currencyCode === 'VND' ? `${formatVnNumber(r.amount)} đ` : `${formatVnNumber(r.amountCurrency, 4)} ${r.currencyCode} (${formatVnNumber(r.amount)} đ)`;
const stepName = (s: Step) => s.username ?? s.roleName ?? '?';
const fail = (e: Error) => void message.error(e.message);

// Đầu trang: số đề nghị đang chờ chính người này duyệt (thông báo trong ứng dụng).
export function ApprovalBadge() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['approvals', 'count'], queryFn: () => api<{ count: number }>('/api/approvals/inbox/count'), enabled: can('approval_request.approve'), refetchInterval: 60_000 });
  if (!can('approval_request.approve')) return null;
  return <Link to="/phe-duyet" search={{}} aria-label={`Chờ duyệt: ${q.data?.count ?? 0}`}><Badge count={q.data?.count ?? 0} size="small" offset={[6, -2]}>Chờ duyệt</Badge></Link>;
}

function RequestForm({ open, initial, onClose }: { open: boolean; initial: Request | null; onClose(saved?: boolean): void }) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const kind = Form.useWatch('kind', form) as Request['kind'] | undefined;
  const currency = (Form.useWatch('currencyCode', form) as string | undefined) ?? 'VND';
  const payMethod = Form.useWatch('payMethod', form) as string | undefined;
  const date = Form.useWatch('requestDate', form) as dayjs.Dayjs | undefined;
  const accountFetcher = useMemo(() => accountFetcherFor(date?.format('YYYY-MM-DD')), [date]);
  const save = useMutation({
    mutationFn: async ({ body, andSubmit }: { body: object; andSubmit: boolean }) => {
      const id = initial ? (await api(`/api/approvals/${initial.id}`, { method: 'PUT', json: body }), initial.id) : (await api<{ id: string }>('/api/approvals', { method: 'POST', json: body })).id;
      if (andSubmit) await api(`/api/approvals/${id}/submit`, { method: 'POST', json: {} });
      return andSubmit;
    },
    onError: fail,
    onSuccess: (sent) => { void message.success(sent ? 'Đã gửi duyệt' : 'Đã lưu đề nghị'); void qc.invalidateQueries({ queryKey: ['approvals'] }); onClose(true); },
  });
  const submit = async (andSubmit: boolean) => {
    const v = await form.validateFields();
    save.mutate({ andSubmit, body: {
      kind: v.kind, requestDate: v.requestDate.format('YYYY-MM-DD'), partyCode: v.partyCode || null, payeeName: v.payeeName, reason: v.reason, currencyCode: v.currencyCode || 'VND',
      amountCurrency: v.amountCurrency, fxRate: v.currencyCode && v.currencyCode !== 'VND' ? v.fxRate : null, accountCode: v.accountCode || null, payMethod: v.payMethod,
      bankAccountNo: v.payMethod === 'bank' ? v.bankAccountNo : null, dueDate: v.dueDate ? v.dueDate.format('YYYY-MM-DD') : null,
    } });
  };
  const init = initial ? { ...initial, requestDate: dayjs(initial.requestDate), dueDate: initial.dueDate ? dayjs(initial.dueDate) : undefined }
    : { kind: 'payment', requestDate: dayjs(), currencyCode: 'VND', payMethod: 'cash' };
  return (
    <Modal title={initial ? `Sửa ${initial.kindLabel.toLowerCase()} ${initial.requestNo}` : 'Lập đề nghị'} open={open} onCancel={() => onClose()} destroyOnHidden width={640}
      footer={[<Button key="c" onClick={() => onClose()}>Hủy</Button>, <Button key="s" loading={save.isPending} onClick={() => void submit(false)}>Lưu nháp (Ctrl+S)</Button>,
        <Button key="g" type="primary" loading={save.isPending} onClick={() => void submit(true)}>Lưu và gửi duyệt</Button>]}>
      <Form form={form} layout="vertical" initialValues={init} preserve={false}
        onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void submit(false); } }}>
        <Form.Item name="kind" label="Loại đề nghị"><Radio.Group disabled={!!initial} options={[{ value: 'payment', label: 'Đề nghị thanh toán' }, { value: 'advance', label: 'Đề nghị tạm ứng' }]} /></Form.Item>
        <Space wrap>
          <Form.Item name="requestDate" label="Ngày đề nghị" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="dueDate" label="Hạn thanh toán"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        </Space>
        <Form.Item name="partyCode" label="Đối tượng (F4)" extra={kind === 'payment' ? 'Bắt buộc khi thanh toán cho nhà cung cấp (TK 331)' : undefined}>
          <LookupSelect catalog="party" allowClear placeholder="Chọn đối tượng" onChange={(code, row) => { form.setFieldValue('partyCode', code); if (row && !form.getFieldValue('payeeName')) form.setFieldValue('payeeName', row.name); }} />
        </Form.Item>
        <Form.Item name="payeeName" label="Người nhận tiền" rules={[{ required: true, whitespace: true, message: 'Nhập người nhận tiền' }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="reason" label="Lý do" rules={[{ required: true, whitespace: true, message: 'Nhập lý do' }]}><Input.TextArea rows={2} maxLength={1000} /></Form.Item>
        <Space wrap align="start">
          <Form.Item name="currencyCode" label="Loại tiền"><LookupSelect catalog="currency" style={{ width: 120 }} /></Form.Item>
          <Form.Item name="amountCurrency" label="Số tiền" rules={[{ required: true, message: 'Nhập số tiền' }]}><VnNumberInput scale={currency === 'VND' ? 0 : 4} style={{ width: 200 }} /></Form.Item>
          {currency !== 'VND' && <Form.Item name="fxRate" label="Tỷ giá" rules={[{ required: true, message: 'Nhập tỷ giá' }]}><VnNumberInput scale={4} style={{ width: 140 }} /></Form.Item>}
        </Space>
        <Space wrap align="start">
          <Form.Item name="accountCode" label="TK Nợ (F4)" extra={`Để trống: ${kind === 'advance' ? '141' : '331'}`}><LookupSelect catalog="account" fetcher={accountFetcher} allowClear style={{ width: 220 }} /></Form.Item>
          <Form.Item name="payMethod" label="Hình thức chi"><Radio.Group options={[{ value: 'cash', label: 'Tiền mặt' }, { value: 'bank', label: 'Chuyển khoản' }]} /></Form.Item>
          {payMethod === 'bank' && <Form.Item name="bankAccountNo" label="TK ngân hàng chi (F4)" rules={[{ required: true, message: 'Chọn tài khoản ngân hàng' }]}><LookupSelect catalog="bank_account" fetcher={bankAccountFetcher} style={{ width: 220 }} /></Form.Item>}
        </Space>
      </Form>
    </Modal>
  );
}

function RequestDrawer({ id, onClose, onEdit }: { id: string | null; onClose(): void; onEdit(r: Request): void }) {
  const qc = useQueryClient(); const { me } = useAuth(); const screens = Grid.useBreakpoint();
  const d = useQuery({ queryKey: ['approvals', 'detail', id], queryFn: () => api<Detail>(`/api/approvals/${id}`), enabled: !!id });
  const [rejecting, setRejecting] = useState(false); const [reason, setReason] = useState(''); const [note, setNote] = useState('');
  const done = (msg: string) => { void message.success(msg); void qc.invalidateQueries({ queryKey: ['approvals'] }); };
  const call = useMutation({ mutationFn: ({ path, body }: { path: string; body: object }) => api(`/api/approvals/${id}/${path}`, { method: 'POST', json: body }), onError: fail });
  const r = d.data;
  const mine = r && me && r.requesterName === me.username;
  const download = async (a: { id: string; fileName: string }) => {
    try { const url = URL.createObjectURL(await apiBlob(`/api/approval-attachments/${a.id}`)); const el = document.createElement('a'); el.href = url; el.download = a.fileName; el.click(); URL.revokeObjectURL(url); } catch (e) { fail(e as Error); }
  };
  return (
    <Drawer open={!!id} onClose={onClose} width={screens.md ? 640 : '100%'} title={r ? `${r.kindLabel} ${r.requestNo}` : 'Đề nghị'} destroyOnHidden
      extra={r && <Tag color={STATE[r.state].color}>{STATE[r.state].label}</Tag>}>
      {r && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Số tiền"><strong>{money(r)}</strong></Descriptions.Item>
            <Descriptions.Item label="Người nhận">{r.payeeName}{r.partyCode ? ` (${r.partyCode})` : ''}</Descriptions.Item>
            <Descriptions.Item label="Lý do">{r.reason}</Descriptions.Item>
            <Descriptions.Item label="Người đề nghị">{r.requesterName}, ngày {fmtDate(r.requestDate)}</Descriptions.Item>
            <Descriptions.Item label="Chi">{r.payMethod === 'cash' ? 'Tiền mặt' : `Chuyển khoản từ ${r.bankAccountNo}`}, Nợ TK {r.accountCode}{r.dueDate ? `, hạn ${fmtDate(r.dueDate)}` : ''}</Descriptions.Item>
            {r.rejectReason && <Descriptions.Item label="Lý do từ chối">{r.rejectReason}</Descriptions.Item>}
            {r.voucherId && <Descriptions.Item label="Chứng từ"><Link to="/chung-tu/$type/$id" params={{ type: r.voucherType!, id: r.voucherId }}>{r.voucherType} {r.voucherNo ?? '(nháp)'}</Link></Descriptions.Item>}
          </Descriptions>
          {r.steps.length > 0 && (
            <Steps size="small" direction={screens.sm ? 'horizontal' : 'vertical'} current={r.state === 'approved' ? r.steps.length : r.currentStep - 1} status={r.state === 'rejected' ? 'error' : 'process'}
              items={r.steps.map((s) => ({ title: `Bước ${s.stepNo}`, description: stepName(s) }))} />
          )}
          {r.attachments.length > 0 && <List size="small" header="Tệp đính kèm" dataSource={r.attachments} renderItem={(a) => <List.Item><a onClick={() => void download(a)}>{a.fileName}</a></List.Item>} />}
          {mine && (r.state === 'draft' || r.state === 'submitted') && (
            <Upload showUploadList={false} withCredentials action={`/api/approvals/${r.id}/attachments`} onChange={(i) => { if (i.file.status === 'done') { void message.success('Đã đính kèm'); void d.refetch(); } if (i.file.status === 'error') void message.error('Không đính kèm được tệp'); }}>
              <Button>Đính kèm tệp</Button>
            </Upload>
          )}
          <Timeline items={r.log.map((l) => ({ color: l.action === 'reject' ? 'red' : l.action === 'approve' ? 'green' : 'blue', children: `${dayjs(l.at).format('DD/MM/YYYY HH:mm')} ${l.username}: ${ACTION[l.action] ?? l.action}${l.stepNo ? ` bước ${l.stepNo}` : ''}${l.note ? ` – ${l.note}` : ''}` }))} />
          {r.canAct && (
            <Card size="small" title="Quyết định của bạn">
              <Input.TextArea rows={2} placeholder="Ghi chú (không bắt buộc)" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 8 }} />
              <Space wrap>
                <Button type="primary" size="large" loading={call.isPending} onClick={() => call.mutate({ path: 'approve', body: note ? { note } : {} }, { onSuccess: () => { done('Đã duyệt'); onClose(); } })}>Duyệt</Button>
                <Button danger size="large" onClick={() => setRejecting(true)}>Từ chối</Button>
              </Space>
            </Card>
          )}
          {mine && (
            <Space wrap>
              {r.state === 'draft' && <Button onClick={() => onEdit(r)}>Sửa</Button>}
              {r.state === 'draft' && <Button type="primary" loading={call.isPending} onClick={() => call.mutate({ path: 'submit', body: {} }, { onSuccess: () => { done('Đã gửi duyệt'); void d.refetch(); } })}>Gửi duyệt</Button>}
              {(r.state === 'draft' || r.state === 'submitted') && (
                <Popconfirm title="Hủy đề nghị này?" okText="Hủy đề nghị" cancelText="Không" onConfirm={() => call.mutate({ path: 'cancel', body: {} }, { onSuccess: () => { done('Đã hủy đề nghị'); onClose(); } })}>
                  <Button danger>Hủy đề nghị</Button>
                </Popconfirm>
              )}
            </Space>
          )}
        </Space>
      )}
      <Modal title="Từ chối đề nghị" open={rejecting} okText="Từ chối" okButtonProps={{ danger: true, disabled: !reason.trim(), loading: call.isPending }} cancelText="Không" onCancel={() => setRejecting(false)}
        onOk={() => call.mutate({ path: 'reject', body: { reason } }, { onSuccess: () => { setRejecting(false); setReason(''); done('Đã từ chối'); onClose(); } })}>
        <Input.TextArea aria-label="Lý do từ chối" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Nhập lý do từ chối" autoFocus />
      </Modal>
    </Drawer>
  );
}

function RequestList({ box, onOpen }: { box: Box; onOpen(id: string): void }) {
  const screens = Grid.useBreakpoint();
  const [state, setState] = useState<State | undefined>();
  const q = useQuery({ queryKey: ['approvals', box, state], queryFn: () => api<Request[]>(`/api/approvals?box=${box}${state ? `&state=${state}` : ''}`) });
  const empty = box === 'inbox' ? 'Không có đề nghị nào chờ bạn duyệt' : 'Chưa có đề nghị nào';
  return (
    <div>
      {box !== 'inbox' && (
        <Select aria-label="Lọc trạng thái" allowClear placeholder="Mọi trạng thái" style={{ width: 180, marginBottom: 12 }} value={state} onChange={setState}
          options={Object.entries(STATE).map(([value, s]) => ({ value, label: s.label }))} />
      )}
      {screens.md ? (
        <Table<Request> rowKey="id" size="small" loading={q.isLoading} dataSource={q.data ?? []} pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: empty }}
          onRow={(r) => ({ onClick: () => onOpen(r.id), onKeyDown: (e) => { if (e.key === 'Enter') onOpen(r.id); }, tabIndex: 0, style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Số', dataIndex: 'requestNo', width: 150 },
            { title: 'Ngày', dataIndex: 'requestDate', width: 100, render: fmtDate },
            { title: 'Loại', dataIndex: 'kindLabel', width: 160 },
            { title: 'Người đề nghị', dataIndex: 'requesterName', width: 130 },
            { title: 'Người nhận', dataIndex: 'payeeName' },
            { title: 'Lý do', dataIndex: 'reason', ellipsis: true },
            { title: 'Số tiền', width: 170, align: 'right', render: (_, r) => money(r) },
            { title: 'Trạng thái', dataIndex: 'state', width: 150, render: (s: State, r) => <Tag color={STATE[s].color}>{STATE[s].label}{s === 'submitted' && r.steps.length > 1 ? ` ${r.currentStep}/${r.steps.length}` : ''}</Tag> },
          ]} />
      ) : (
        <List loading={q.isLoading} dataSource={q.data ?? []} locale={{ emptyText: empty }} renderItem={(r) => (
          <List.Item onClick={() => onOpen(r.id)} style={{ cursor: 'pointer' }} aria-label={`${r.requestNo} ${r.payeeName}`}>
            <List.Item.Meta title={<Space style={{ justifyContent: 'space-between', width: '100%' }}><span>{r.payeeName}</span><strong>{money(r)}</strong></Space>}
              description={<span>{r.requestNo} · {r.requesterName} · {fmtDate(r.requestDate)} <Tag color={STATE[r.state].color}>{STATE[r.state].label}</Tag><br />{r.reason}</span>} />
          </List.Item>)} />
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  const { can } = useAuth();
  const count = useQuery({ queryKey: ['approvals', 'count'], queryFn: () => api<{ count: number }>('/api/approvals/inbox/count'), enabled: can('approval_request.approve') });
  const tabs = [
    ...(can('approval_request.approve') ? [{ key: 'inbox' as Box, label: <Badge count={count.data?.count ?? 0} size="small" offset={[10, 0]}>Chờ tôi duyệt</Badge> }] : []),
    ...(can('approval_request.create') ? [{ key: 'mine' as Box, label: 'Đề nghị của tôi' }] : []),
    ...(can('approval_request.view') ? [{ key: 'all' as Box, label: 'Tất cả' }] : []),
  ];
  const [box, setBox] = useState<Box | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ r: Request | null } | null>(null);
  useHotkeys({ Insert: () => { if (can('approval_request.create') && !editing) setEditing({ r: null }); } });
  if (!tabs.length) return <Alert type="warning" showIcon message="Bạn không có quyền với đề nghị thanh toán, tạm ứng" />;
  const active = box ?? tabs[0]!.key;
  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
        <h2 style={{ margin: 0 }}>Đề nghị thanh toán, tạm ứng</h2>
        <Space wrap>
          {can('setting.update') && <Link to="/phe-duyet/quy-trinh">Quy trình phê duyệt</Link>}
          {can('approval_request.create') && <Button type="primary" onClick={() => setEditing({ r: null })}>Lập đề nghị (Insert)</Button>}
        </Space>
      </Space>
      <Tabs activeKey={active} onChange={(k) => setBox(k as Box)} items={tabs.map((t) => ({ key: t.key, label: t.label, children: <RequestList box={t.key} onOpen={setOpen} /> }))} />
      <RequestDrawer id={open} onClose={() => setOpen(null)} onEdit={(r) => { setOpen(null); setEditing({ r }); }} />
      {editing && <RequestForm open initial={editing.r} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---- Cấu hình quy trình ----
interface Flow { id: number; kind: Request['kind']; name: string; minAmount: string; isActive: boolean; steps: Step[] }
export function ApprovalFlowsPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const flows = useQuery({ queryKey: ['approval-flows'], queryFn: () => api<Flow[]>('/api/approval-flows'), enabled: can('setting.update') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ id: string; code: string; name: string }[]>('/api/roles'), enabled: can('setting.update') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ id: string; username: string; fullName: string }[]>('/api/users'), enabled: can('user.view') });
  const [editing, setEditing] = useState<Flow | 'new' | null>(null);
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (b: { id?: number; body: object }) => (b.id ? api(`/api/approval-flows/${b.id}`, { method: 'PUT', json: b.body }) : api('/api/approval-flows', { method: 'POST', json: b.body })),
    onError: fail, onSuccess: () => { void message.success('Đã lưu quy trình'); setEditing(null); void qc.invalidateQueries({ queryKey: ['approval-flows'] }); },
  });
  const approvers = [...(roles.data ?? []).map((r) => ({ value: `role:${r.id}`, label: `Vai trò: ${r.name}` })), ...(users.data ?? []).map((u) => ({ value: `user:${u.id}`, label: `Người: ${u.fullName || u.username} (${u.username})` }))];
  const openEdit = (f: Flow | 'new') => {
    form.setFieldsValue(f === 'new' ? { kind: 'payment', name: '', minAmount: '0', isActive: true, steps: [undefined] }
      : { ...f, steps: f.steps.map((s) => (s.roleId ? `role:${s.roleId}` : `user:${s.userId}`)) });
    setEditing(f);
  };
  const submit = (v: { kind: string; name: string; minAmount: string | null; isActive: boolean; steps: string[] }) => save.mutate({
    ...(editing !== 'new' && editing ? { id: editing.id } : {}),
    body: { kind: v.kind, name: v.name, minAmount: v.minAmount || '0', isActive: v.isActive, steps: v.steps.map((s) => { const [k, id] = s.split(':'); return k === 'role' ? { roleId: id } : { userId: id }; }) },
  });
  useHotkeys({ Insert: () => { if (can('setting.update') && !editing) openEdit('new'); } });
  if (!can('setting.update')) return <Alert type="warning" showIcon message="Cần quyền sửa tùy chọn hệ thống để cấu hình quy trình phê duyệt" />;
  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        <h2 style={{ margin: 0 }}>Quy trình phê duyệt</h2>
        <Button type="primary" onClick={() => openEdit('new')}>Thêm quy trình (Insert)</Button>
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Đề nghị dùng quy trình đang dùng cùng loại có hạn mức lớn nhất không vượt số tiền (quy đổi VND). Sửa quy trình không đổi các đề nghị đã gửi duyệt." />
      <Table<Flow> rowKey="id" size="small" loading={flows.isLoading} dataSource={flows.data ?? []} pagination={false} locale={{ emptyText: 'Chưa có quy trình nào: đề nghị chưa gửi duyệt được' }}
        onRow={(f) => ({ onDoubleClick: () => openEdit(f) })}
        columns={[
          { title: 'Loại', dataIndex: 'kind', width: 170, render: (k: string) => (k === 'payment' ? 'Đề nghị thanh toán' : 'Đề nghị tạm ứng') },
          { title: 'Tên', dataIndex: 'name' },
          { title: 'Từ số tiền', dataIndex: 'minAmount', width: 150, align: 'right', render: (m: string) => formatVnNumber(m) },
          { title: 'Các bước', dataIndex: 'steps', render: (s: Step[]) => s.map(stepName).join(' → ') },
          { title: 'Đang dùng', dataIndex: 'isActive', width: 100, render: (a: boolean) => (a ? <Tag color="green">Có</Tag> : <Tag>Không</Tag>) },
          { title: '', width: 80, render: (_, f) => <Button size="small" onClick={() => openEdit(f)} aria-label={`Sửa ${f.name}`}>Sửa</Button> },
        ]} />
      <Modal title={editing === 'new' ? 'Thêm quy trình phê duyệt' : 'Sửa quy trình phê duyệt'} open={!!editing} okText="Lưu" cancelText="Hủy" confirmLoading={save.isPending} onCancel={() => setEditing(null)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submit} onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); form.submit(); } }}>
          <Form.Item name="kind" label="Loại đề nghị"><Radio.Group options={[{ value: 'payment', label: 'Thanh toán' }, { value: 'advance', label: 'Tạm ứng' }]} /></Form.Item>
          <Form.Item name="name" label="Tên quy trình" rules={[{ required: true, whitespace: true, message: 'Nhập tên quy trình' }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="minAmount" label="Áp dụng từ số tiền (VND)"><VnNumberInput style={{ width: 200 }} /></Form.Item>
          <Form.List name="steps">
            {(fields, { add, remove }) => (
              <div>
                {fields.map((f, i) => (
                  <Space key={f.key} align="baseline">
                    <Form.Item {...f} label={`Bước ${i + 1}`} rules={[{ required: true, message: 'Chọn người duyệt' }]}>
                      <Select style={{ width: 340 }} showSearch optionFilterProp="label" options={approvers} placeholder="Vai trò hoặc người duyệt" />
                    </Form.Item>
                    {fields.length > 1 && <Button onClick={() => remove(f.name)} aria-label={`Bỏ bước ${i + 1}`}>Bỏ</Button>}
                  </Space>
                ))}
                {fields.length < 10 && <Button onClick={() => add()} style={{ marginBottom: 12 }}>Thêm bước</Button>}
              </div>
            )}
          </Form.List>
          <Form.Item name="isActive" label="Đang dùng" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
