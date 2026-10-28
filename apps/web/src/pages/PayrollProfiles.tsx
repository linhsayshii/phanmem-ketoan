import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Empty, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Upload, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber } from '@kt/domain';
import { LookupSelect, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { iso, text } from './voucherCommon.js';

const P = '/api/payroll/profiles';
const money = (s: string | null | undefined) => formatVnNumber(s ?? '0', 0);
const RELATIONSHIPS: Record<string, string> = { child: 'Con', spouse: 'Vợ/chồng', father: 'Cha', mother: 'Mẹ', sibling: 'Anh chị em ruột', other: 'Khác' };
const PAY_METHODS = [{ value: 'transfer', label: 'Chuyển khoản' }, { value: 'cash', label: 'Tiền mặt' }];
const RESIDENCY = [{ value: 'resident', label: 'Cư trú' }, { value: 'non_resident', label: 'Không cư trú' }];
const CONTRACTS = [{ value: 'long', label: 'Từ 3 tháng trở lên' }, { value: 'short', label: 'Dưới 3 tháng' }, { value: 'none', label: 'Không hợp đồng' }];
const REGIONS = ['I', 'II', 'III', 'IV'].map((v) => ({ value: v, label: `Vùng ${v}` }));

interface ListRow { employeeId: number; code: string; name: string; departmentName: string | null; isActive: boolean; hasProfile: boolean; currentSalary: string | null }
interface Profile { payMethod: string; bankCode: string | null; bankName: string | null; bankAccountNo: string | null; bankAccountName: string | null; taxResidency: string; contractType: string; startDate: string | null; endDate: string | null;
  region: string | null; siNo: string | null; siParticipates: boolean; hiParticipates: boolean; uiParticipates: boolean; occupationalParticipates: boolean; siSalary: string | null;
  unionEmployer: boolean; unionMember: boolean; pitAuthorized: boolean; defaultProjectId: number | null; defaultProjectCode: string | null; note: string | null }
interface Allowance { id: number; code: string; name: string; amount: string; taxable: boolean; siBase: boolean; validFrom: string | null; validTo: string | null }
interface Dependent { id: number; name: string; relationship: string; taxCode: string | null; idNumber: string | null; birthDate: string | null; fromMonth: string; toMonth: string | null; note: string | null }
interface SalaryRow { id: number; validFrom: string; monthlySalary: string; note: string | null }
interface SplitRow { projectId: number; projectCode: string; projectName: string; pct: string }
interface Detail { employee: { id: number; code: string; name: string; taxCode: string | null; idNumber: string | null; position: string | null; departmentName: string | null };
  profile: Profile | null; allowances: Allowance[]; dependents: Dependent[]; salaryHistory: SalaryRow[]; currentSalary: string | null; costSplit: SplitRow[] }
type FormValues = Omit<Profile, 'startDate' | 'endDate' | 'defaultProjectId' | 'defaultProjectCode'> & { startDate: dayjs.Dayjs | null; endDate: dayjs.Dayjs | null; defaultProjectCode: string | null };

const DEFAULTS: FormValues = { payMethod: 'transfer', bankCode: null, bankName: null, bankAccountNo: null, bankAccountName: null, taxResidency: 'resident', contractType: 'long', startDate: null, endDate: null, region: null, siNo: null,
  siParticipates: false, hiParticipates: false, uiParticipates: false, occupationalParticipates: false, siSalary: null, unionEmployer: false, unionMember: false, pitAuthorized: false, defaultProjectCode: null, note: null };
const dateRule = (dt: dayjs.Dayjs | null) => (dt ? iso(dt) : null);

// Hộp thoại thêm/sửa một dòng con (phụ cấp, người phụ thuộc, mức lương): lưu bằng Enter hoặc nút; lỗi máy chủ hiện trong hộp thoại.
function RowDialog<V extends object>({ open, title, form, formName, onClose, onSave, children }: { open: boolean; title: string; form: ReturnType<typeof Form.useForm<V>>[0]; formName: string; onClose: () => void; onSave: (v: V) => Promise<unknown>; children: React.ReactNode }) {
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  // busy về false cùng lúc hộp thoại ẩn: hiệu ứng thu biểu tượng loading không chạy xong, forceRender giữ nút đó cho lần mở sau ("loading Lưu"). Mỗi lần mở dựng lại chân hộp thoại.
  const [gen, setGen] = useState(0);
  useEffect(() => { if (open) { setErr(null); setGen((g) => g + 1); } }, [open]);
  const submit = () => { void form.validateFields().then(async (v) => { setBusy(true); try { await onSave(v); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }, () => undefined); };
  return (
    <Modal open={open} title={title} onCancel={onClose} onOk={submit} okText="Lưu" cancelText="Bỏ qua" confirmLoading={busy} destroyOnHidden forceRender
      footer={(_, { OkBtn, CancelBtn }) => <span key={gen}><CancelBtn /><OkBtn /></span>}>
      <Form form={form} name={formName} layout="vertical" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLElement).closest('.ant-select')) { e.preventDefault(); submit(); } }}>
        {children}{err && <Alert type="error" showIcon message={err} />}
      </Form>
    </Modal>);
}

function Editor({ employeeId }: { employeeId: number }) {
  const qc = useQueryClient(); const { can } = useAuth(); const canEdit = can('payroll.update');
  const [tab, setTab] = useState('profile'); const [err, setErr] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const projectId = useRef<number | null>(null);
  const detail = useQuery({ queryKey: ['payroll-profile', employeeId], queryFn: () => api<Detail>(`${P}/${employeeId}`) });
  const d = detail.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['payroll-profile', employeeId] }); void qc.invalidateQueries({ queryKey: ['payroll-profiles'] }); };

  useEffect(() => {
    if (!d) return;
    const p = d.profile;
    projectId.current = p?.defaultProjectId ?? null;
    form.setFieldsValue(p ? { ...p, startDate: p.startDate ? dayjs(p.startDate) : null, endDate: p.endDate ? dayjs(p.endDate) : null } : DEFAULTS);
  }, [d?.employee.id, detail.dataUpdatedAt]);

  const saveProfile = useMutation({
    mutationFn: (v: FormValues) => api(`${P}/${employeeId}`, { method: 'PUT', json: {
      payMethod: v.payMethod, bankCode: text(v.bankCode), bankName: text(v.bankName), bankAccountNo: text(v.bankAccountNo), bankAccountName: text(v.bankAccountName), taxResidency: v.taxResidency, contractType: v.contractType,
      startDate: dateRule(v.startDate), endDate: dateRule(v.endDate), region: v.region || null, siNo: text(v.siNo), siParticipates: !!v.siParticipates, hiParticipates: !!v.hiParticipates, uiParticipates: !!v.uiParticipates,
      occupationalParticipates: !!v.occupationalParticipates, siSalary: v.siSalary || null, unionEmployer: !!v.unionEmployer, unionMember: !!v.unionMember, pitAuthorized: !!v.pitAuthorized,
      defaultProjectId: v.defaultProjectCode ? projectId.current : null, note: text(v.note) } }),
    onError: (e) => setErr((e as Error).message), onSuccess: () => { setErr(null); void message.success('Đã lưu hồ sơ lương'); refresh(); } });

  const [splitRows, setSplitRows] = useState<{ key: number; code: string | null; projectId: number | null; pct: string | null }[]>([]);
  const nextKey = useRef(1);
  useEffect(() => { if (d) setSplitRows(d.costSplit.map((r) => ({ key: nextKey.current++, code: r.projectCode, projectId: r.projectId, pct: D(r.pct).toString() }))); }, [d?.employee.id, detail.dataUpdatedAt]);
  const splitTotal = splitRows.reduce((s, r) => s.plus(r.pct ?? 0), D(0));
  const saveSplit = useMutation({
    mutationFn: () => {
      const items = splitRows.filter((r) => r.projectId !== null || r.pct);
      if (items.some((r) => r.projectId === null || !r.pct)) throw new Error('Mỗi dòng phải chọn vụ việc và nhập tỷ lệ');
      return api(`${P}/${employeeId}/cost-split`, { method: 'PUT', json: { items: items.map((r) => ({ projectId: Number(r.projectId), pct: r.pct })) } });
    },
    onError: (e) => setErr((e as Error).message), onSuccess: () => { setErr(null); void message.success('Đã lưu phân bổ chi phí'); refresh(); } });

  const del = useMutation({ mutationFn: (path: string) => api(`${P}/${employeeId}/${path}`, { method: 'DELETE' }), onError: (e) => void message.error((e as Error).message), onSuccess: () => { void message.success('Đã xóa'); refresh(); } });

  // Hộp thoại con
  const [aForm] = Form.useForm<{ code: string; name: string; amount: string; taxable: boolean; siBase: boolean; validFrom: dayjs.Dayjs | null; validTo: dayjs.Dayjs | null }>();
  const [aEdit, setAEdit] = useState<Allowance | 'new' | null>(null);
  const openA = (a: Allowance | 'new') => { setAEdit(a); aForm.resetFields(); aForm.setFieldsValue(a === 'new' ? { taxable: true, siBase: false } : { ...a, validFrom: a.validFrom ? dayjs(a.validFrom) : null, validTo: a.validTo ? dayjs(a.validTo) : null }); };
  const [pForm] = Form.useForm<{ name: string; relationship: string; taxCode: string; idNumber: string; birthDate: dayjs.Dayjs | null; fromMonth: dayjs.Dayjs; toMonth: dayjs.Dayjs | null; note: string }>();
  const [pEdit, setPEdit] = useState<Dependent | 'new' | null>(null);
  const openP = (x: Dependent | 'new') => { setPEdit(x); pForm.resetFields(); pForm.setFieldsValue(x === 'new' ? { relationship: 'child', fromMonth: dayjs() } : { name: x.name, relationship: x.relationship, taxCode: x.taxCode ?? '', idNumber: x.idNumber ?? '', birthDate: x.birthDate ? dayjs(x.birthDate) : null,
    fromMonth: dayjs(`${x.fromMonth}-01`), toMonth: x.toMonth ? dayjs(`${x.toMonth}-01`) : null, note: x.note ?? '' }); };
  const [sForm] = Form.useForm<{ validFrom: dayjs.Dayjs; monthlySalary: string; note: string }>();
  const [sOpen, setSOpen] = useState(false);

  const onKey = (e: React.KeyboardEvent) => {
    if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') || (e.target as HTMLElement).closest('.ant-modal') || !canEdit) return;
    e.preventDefault();
    if (tab === 'profile') void form.validateFields().then((v) => saveProfile.mutate(v), () => undefined);
    else if (tab === 'split') saveSplit.mutate();
  };

  const profileTab = (
    <Form form={form} name="profile" layout="vertical" disabled={!canEdit} initialValues={DEFAULTS}>
      <Space align="start" wrap>
        <Form.Item label="Hình thức trả lương" name="payMethod"><Select style={{ width: 160 }} options={PAY_METHODS} /></Form.Item>
        <Form.Item label="Cư trú thuế" name="taxResidency"><Select style={{ width: 150 }} options={RESIDENCY} /></Form.Item>
        <Form.Item label="Loại hợp đồng lao động" name="contractType"><Select style={{ width: 190 }} options={CONTRACTS} /></Form.Item>
        <Form.Item label="Vùng lương tối thiểu" name="region"><Select style={{ width: 130 }} allowClear options={REGIONS} /></Form.Item>
        <Form.Item label="Ngày bắt đầu làm việc" name="startDate"><DatePicker format="DD/MM/YYYY" /></Form.Item>
        <Form.Item label="Ngày nghỉ việc" name="endDate"><DatePicker format="DD/MM/YYYY" /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Ngân hàng nhận lương" name="bankName"><Input maxLength={200} style={{ width: 220 }} /></Form.Item>
        <Form.Item label="Mã ngân hàng" name="bankCode"><Input maxLength={30} style={{ width: 120 }} /></Form.Item>
        <Form.Item label="Số tài khoản nhận lương" name="bankAccountNo"><Input maxLength={50} style={{ width: 200 }} /></Form.Item>
        <Form.Item label="Tên chủ tài khoản" name="bankAccountName"><Input maxLength={200} style={{ width: 220 }} /></Form.Item>
      </Space>
      <Space align="start" wrap>
        <Form.Item label="Mã số BHXH" name="siNo"><Input maxLength={30} style={{ width: 180 }} /></Form.Item>
        <Form.Item label="Mức lương đóng bảo hiểm (trống = theo lương)" name="siSalary"><VnNumberInput scale={0} aria-label="Mức lương đóng bảo hiểm" style={{ width: 220 }} /></Form.Item>
        <Form.Item label="Vụ việc mặc định (F4)" name="defaultProjectCode"><LookupSelect catalog="project" allowClear style={{ width: 240 }} onChange={(code, row) => { projectId.current = row ? Number(row.id) : null; form.setFieldValue('defaultProjectCode', code); }} /></Form.Item>
      </Space>
      <Space wrap size="large" style={{ marginBottom: 16 }}>
        {([['siParticipates', 'Tham gia BHXH'], ['hiParticipates', 'Tham gia BHYT'], ['uiParticipates', 'Tham gia BHTN'], ['occupationalParticipates', 'Tham gia BH TNLĐ-BNN'],
          ['unionEmployer', 'Đóng kinh phí công đoàn'], ['unionMember', 'Là đoàn viên'], ['pitAuthorized', 'Ủy quyền quyết toán thuế TNCN']] as const).map(([name, label]) =>
          <Form.Item key={name} name={name} valuePropName="checked" noStyle><Checkbox>{label}</Checkbox></Form.Item>)}
      </Space>
      <Form.Item label="Ghi chú" name="note"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      <h4>Phụ cấp</h4>
      {canEdit && <Button style={{ marginBottom: 8 }} onClick={() => openA('new')}>Thêm phụ cấp</Button>}
      <Table<Allowance> size="small" rowKey="id" pagination={false} dataSource={d?.allowances ?? []} data-testid="allowances" locale={{ emptyText: 'Chưa có phụ cấp' }}
        onRow={(r) => ({ onClick: () => canEdit && openA(r), style: { cursor: canEdit ? 'pointer' : 'default' } })}
        columns={[{ title: 'Mã', dataIndex: 'code' }, { title: 'Tên phụ cấp', dataIndex: 'name' }, { title: 'Số tiền/tháng', dataIndex: 'amount', align: 'right', render: money },
          { title: 'Chịu thuế TNCN', dataIndex: 'taxable', render: (v: boolean) => (v ? 'Có' : 'Không') }, { title: 'Tính vào lương đóng BH', dataIndex: 'siBase', render: (v: boolean) => (v ? 'Có' : 'Không') },
          { title: 'Hiệu lực', render: (_, r) => (r.validFrom || r.validTo ? `${r.validFrom ? formatVnDate(r.validFrom) : '…'} – ${r.validTo ? formatVnDate(r.validTo) : '…'}` : 'Mọi kỳ') },
          ...(canEdit ? [{ title: '', width: 60, render: (_: unknown, r: Allowance) => <Popconfirm title="Xóa phụ cấp này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(`allowances/${r.id}`)}><a onClick={(e) => e.stopPropagation()}>Xóa</a></Popconfirm> }] : [])]} />
    </Form>);

  const dependentsTab = (<>
    {canEdit && <Button style={{ marginBottom: 8 }} onClick={() => openP('new')}>Thêm người phụ thuộc</Button>}
    <Table<Dependent> size="small" rowKey="id" pagination={false} dataSource={d?.dependents ?? []} data-testid="dependents" locale={{ emptyText: 'Chưa có người phụ thuộc' }}
      onRow={(r) => ({ onClick: () => canEdit && openP(r), style: { cursor: canEdit ? 'pointer' : 'default' } })}
      columns={[{ title: 'Họ tên', dataIndex: 'name' }, { title: 'Quan hệ', dataIndex: 'relationship', render: (v: string) => RELATIONSHIPS[v] ?? v }, { title: 'MST', dataIndex: 'taxCode' }, { title: 'Số CCCD', dataIndex: 'idNumber' },
        { title: 'Từ tháng', dataIndex: 'fromMonth', render: (m: string) => `${m.slice(5)}/${m.slice(0, 4)}` }, { title: 'Đến tháng', dataIndex: 'toMonth', render: (m: string | null) => (m ? `${m.slice(5)}/${m.slice(0, 4)}` : 'Còn hiệu lực') },
        ...(canEdit ? [{ title: '', width: 60, render: (_: unknown, r: Dependent) => <Popconfirm title="Xóa người phụ thuộc này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(`dependents/${r.id}`)}><a onClick={(e) => e.stopPropagation()}>Xóa</a></Popconfirm> }] : [])]} />
    <div style={{ marginTop: 4 }}>Giảm trừ gia cảnh cho người phụ thuộc tính theo từng tháng có hiệu lực (đăng ký giữa tháng được tính cả tháng).</div></>);

  const salaryTab = (<>
    <div style={{ marginBottom: 8 }}>Lương cơ bản hiện tại: <b data-testid="current-salary">{d?.currentSalary ? money(d.currentSalary) : 'Chưa có'}</b></div>
    {canEdit && <Button style={{ marginBottom: 8 }} onClick={() => { sForm.resetFields(); sForm.setFieldsValue({ validFrom: dayjs() }); setSOpen(true); }}>Thêm mức lương</Button>}
    <Table<SalaryRow> size="small" rowKey="id" pagination={false} dataSource={d?.salaryHistory ?? []} data-testid="salary-history" locale={{ emptyText: 'Chưa có mức lương' }}
      columns={[{ title: 'Hiệu lực từ ngày', dataIndex: 'validFrom', render: formatVnDate }, { title: 'Lương cơ bản/tháng', dataIndex: 'monthlySalary', align: 'right', render: money }, { title: 'Ghi chú', dataIndex: 'note' },
        ...(canEdit ? [{ title: '', width: 60, render: (_: unknown, r: SalaryRow) => <Popconfirm title="Xóa mức lương này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(`salary-history/${r.id}`)}><a>Xóa</a></Popconfirm> }] : [])]} />
    <div style={{ marginTop: 4 }}>Mức lương đã được bảng lương dùng thì không thêm hoặc xóa được; muốn đổi lương, thêm dòng mới có ngày hiệu lực sau.</div></>);

  const splitTab = (<>
    <Table size="small" rowKey="key" pagination={false} dataSource={splitRows} data-testid="cost-split" locale={{ emptyText: 'Chưa phân bổ: chi phí lương tính theo vụ việc mặc định' }}
      columns={[
        { title: 'Vụ việc (F4)', render: (_, r) => <LookupSelect catalog="project" value={r.code} allowClear={false} disabled={!canEdit} style={{ width: 300 }} aria-label="Vụ việc"
          onChange={(code, row) => setSplitRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, code, projectId: row ? Number(row.id) : null } : x)))} /> },
        { title: 'Tỷ lệ (%)', align: 'right', render: (_, r) => <VnNumberInput scale={4} value={r.pct} disabled={!canEdit} aria-label="Tỷ lệ" style={{ width: 130 }} onChange={(v) => setSplitRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, pct: v } : x)))} /> },
        ...(canEdit ? [{ title: '', width: 60, render: (_: unknown, r: { key: number }) => <a onClick={() => setSplitRows((rs) => rs.filter((x) => x.key !== r.key))}>Xóa</a> }] : [])]} />
    <Space style={{ marginTop: 8 }}>
      {canEdit && <Button onClick={() => setSplitRows((rs) => [...rs, { key: nextKey.current++, code: null, projectId: null, pct: null }])}>Thêm dòng</Button>}
      <span>Tổng tỷ lệ: <Tag color={splitRows.length === 0 || splitTotal.eq(100) ? 'green' : 'red'} data-testid="split-total">{formatVnNumber(splitTotal.toString(), 4)}%</Tag></span>
      {canEdit && <Button type="primary" onClick={() => saveSplit.mutate()} loading={saveSplit.isPending}>Lưu phân bổ (Ctrl+S)</Button>}
    </Space>
    <div style={{ marginTop: 4 }}>Phân bổ chi phí lương của nhân viên cho nhiều vụ việc; tổng phải bằng 100%. Để trống thì tính theo vụ việc mặc định.</div></>);

  if (detail.isLoading) return <div>Đang tải…</div>;
  if (detail.error) return <Alert type="error" showIcon message={(detail.error as Error).message} />;
  return (
    <div onKeyDown={onKey}>
      <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }} align="start">
        <div><h3 style={{ margin: 0 }}>{d!.employee.code} - {d!.employee.name}</h3>
          <span>{d!.employee.departmentName ?? 'Chưa có bộ phận'}{d!.employee.position ? ` · ${d!.employee.position}` : ''}</span> {!d!.profile && <Tag color="orange">Chưa có hồ sơ lương</Tag>}</div>
        {canEdit && tab === 'profile' && <Button type="primary" loading={saveProfile.isPending} onClick={() => { void form.validateFields().then((v) => saveProfile.mutate(v), () => undefined); }}>Lưu hồ sơ (Ctrl+S)</Button>}
      </Space>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} closable onClose={() => setErr(null)} />}
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'profile', label: 'Lương và phụ cấp', children: profileTab }, { key: 'dependents', label: 'Người phụ thuộc', children: dependentsTab },
        { key: 'salary', label: 'Lịch sử lương', children: salaryTab }, { key: 'split', label: 'Phân bổ chi phí', children: splitTab }]} />

      <RowDialog open={aEdit !== null} title={aEdit === 'new' ? 'Thêm phụ cấp' : 'Sửa phụ cấp'} form={aForm} formName="allowance" onClose={() => setAEdit(null)} onSave={async (v) => {
        const body = { code: v.code.trim(), name: v.name.trim(), amount: v.amount, taxable: !!v.taxable, siBase: !!v.siBase, validFrom: dateRule(v.validFrom), validTo: dateRule(v.validTo) };
        await (aEdit === 'new' || aEdit === null ? api(`${P}/${employeeId}/allowances`, { method: 'POST', json: body }) : api(`${P}/${employeeId}/allowances/${aEdit.id}`, { method: 'PUT', json: body }));
        void message.success('Đã lưu phụ cấp'); refresh(); }}>
        <Space align="start" wrap>
          <Form.Item label="Mã phụ cấp" name="code" rules={[{ required: true, pattern: /^[a-z0-9_]+$/, message: 'Chữ thường không dấu, số, gạch dưới' }]}><Input maxLength={40} autoFocus /></Form.Item>
          <Form.Item label="Tên phụ cấp" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên phụ cấp' }]}><Input maxLength={200} style={{ width: 260 }} /></Form.Item></Space>
        <Form.Item label="Số tiền (VND/tháng)" name="amount" rules={[{ required: true, message: 'Nhập số tiền' }]}><VnNumberInput scale={0} aria-label="Số tiền phụ cấp" /></Form.Item>
        <Space wrap><Form.Item name="taxable" valuePropName="checked" noStyle><Checkbox>Chịu thuế TNCN</Checkbox></Form.Item><Form.Item name="siBase" valuePropName="checked" noStyle><Checkbox>Tính vào lương đóng bảo hiểm</Checkbox></Form.Item></Space>
        <Space wrap style={{ marginTop: 12 }}><Form.Item label="Hiệu lực từ ngày" name="validFrom"><DatePicker format="DD/MM/YYYY" /></Form.Item><Form.Item label="Đến ngày" name="validTo"><DatePicker format="DD/MM/YYYY" /></Form.Item></Space>
      </RowDialog>

      <RowDialog open={pEdit !== null} title={pEdit === 'new' ? 'Thêm người phụ thuộc' : 'Sửa người phụ thuộc'} form={pForm} formName="dependent" onClose={() => setPEdit(null)} onSave={async (v) => {
        const body = { name: v.name.trim(), relationship: v.relationship, taxCode: text(v.taxCode), idNumber: text(v.idNumber), birthDate: dateRule(v.birthDate), fromMonth: v.fromMonth.format('YYYY-MM'), toMonth: v.toMonth ? v.toMonth.format('YYYY-MM') : null, note: text(v.note) };
        await (pEdit === 'new' || pEdit === null ? api(`${P}/${employeeId}/dependents`, { method: 'POST', json: body }) : api(`${P}/${employeeId}/dependents/${pEdit.id}`, { method: 'PUT', json: body }));
        void message.success('Đã lưu người phụ thuộc'); refresh(); }}>
        <Space align="start" wrap>
          <Form.Item label="Họ tên" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập họ tên' }]}><Input maxLength={200} style={{ width: 260 }} autoFocus /></Form.Item>
          <Form.Item label="Quan hệ" name="relationship" rules={[{ required: true }]}><Select style={{ width: 170 }} options={Object.entries(RELATIONSHIPS).map(([value, label]) => ({ value, label }))} /></Form.Item></Space>
        <Space align="start" wrap>
          <Form.Item label="MST" name="taxCode"><Input maxLength={20} /></Form.Item><Form.Item label="Số CCCD" name="idNumber"><Input maxLength={20} /></Form.Item>
          <Form.Item label="Ngày sinh" name="birthDate"><DatePicker format="DD/MM/YYYY" /></Form.Item></Space>
        <Space align="start" wrap>
          <Form.Item label="Từ tháng" name="fromMonth" rules={[{ required: true, message: 'Chọn từ tháng' }]}><DatePicker picker="month" format="MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item label="Đến tháng (trống = còn hiệu lực)" name="toMonth"><DatePicker picker="month" format="MM/YYYY" /></Form.Item></Space>
        <Form.Item label="Ghi chú" name="note"><Input maxLength={500} /></Form.Item>
      </RowDialog>

      <RowDialog open={sOpen} title="Thêm mức lương" form={sForm} formName="salary" onClose={() => setSOpen(false)} onSave={async (v) => {
        await api(`${P}/${employeeId}/salary-history`, { method: 'POST', json: { validFrom: iso(v.validFrom), monthlySalary: v.monthlySalary, note: text(v.note) } });
        void message.success('Đã thêm mức lương'); refresh(); }}>
        <Form.Item label="Hiệu lực từ ngày" name="validFrom" rules={[{ required: true, message: 'Chọn ngày hiệu lực' }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
        <Form.Item label="Lương cơ bản (VND/tháng)" name="monthlySalary" rules={[{ required: true, message: 'Nhập lương cơ bản' }]}><VnNumberInput scale={0} aria-label="Lương cơ bản" /></Form.Item>
        <Form.Item label="Ghi chú" name="note"><Input maxLength={500} /></Form.Item>
      </RowDialog>
    </div>);
}

interface ImportResult { total: number; inserted: number; allowances?: number; dependents?: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }
function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [result, setResult] = useState<ImportResult | null>(null); const [failure, setFailure] = useState<string | null>(null); const [valid, setValid] = useState(false);
  useEffect(() => { if (open) { setFile(null); setResult(null); setFailure(null); setValid(false); } }, [open]);
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    setFailure(null);
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`${P}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setValid(false); setResult(body.error?.code === 'IMPORT_ERRORS' ? { total: 0, inserted: 0, errors: body.error.details ?? [] } : null); if (body.error?.code !== 'IMPORT_ERRORS') setFailure(body.error?.message ?? 'Không nhập được tệp'); return; }
    const r = body as ImportResult; setResult(r); setValid(mode === 'validate' && r.errors.length === 0);
    if (mode === 'commit') { void message.success(`Đã nhập ${r.inserted} hồ sơ lương`); onDone(); onClose(); }
  };
  return (
    <Modal open={open} title="Nhập hồ sơ lương từ Excel" onCancel={onClose} width={720} footer={null} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Button href={`${P}/import/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); setFailure(null); setValid(false); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !valid}>Nhập</Button>
        </Space>
        <div>Mỗi dòng sheet Du_lieu là một nhân viên chưa có hồ sơ lương; có lỗi ở dòng nào thì không nhập dòng nào.</div>
        {failure && <Alert type="error" showIcon message={failure} />}
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errorCount ?? result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}-${r.message}`} dataSource={result.errors} pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 70 }, { title: 'Cột', dataIndex: 'column', width: 160 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Modal>);
}

export default function PayrollProfilesPage() {
  const { me, can } = useAuth();
  const [q, setQ] = useState(''); const [sel, setSel] = useState<number | null>(null); const [importing, setImporting] = useState(false);
  const allowed = !!me?.sensitive.includes('view_salary');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['payroll-profiles', q], enabled: allowed, queryFn: () => api<ListRow[]>(`${P}?size=500&q=${encodeURIComponent(q)}`) });
  const rows = useMemo(() => list.data ?? [], [list.data]);
  if (!allowed) return <Alert type="warning" showIcon message="Không có quyền xem lương" description="Hồ sơ lương cần quyền xem lương của người quản trị." />;
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.employeeId === sel); const n = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) { setSel(n.employeeId); (document.querySelector(`[data-employee="${n.employeeId}"]`) as HTMLElement | null)?.focus(); }
  };
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Hồ sơ lương</h2>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 300, flexShrink: 0 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.Search placeholder="Tìm theo mã, tên nhân viên" allowClear onSearch={setQ} aria-label="Tìm nhân viên" />
            {can('payroll.update') && <Button block onClick={() => setImporting(true)}>Nhập Excel hồ sơ lương</Button>}
            <ul role="listbox" aria-label="Nhân viên" onKeyDown={move} data-testid="employee-list" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '70vh', overflow: 'auto', border: '1px solid #f0f0f0' }}>
              {rows.map((r) => (
                <li key={r.employeeId} role="option" aria-selected={sel === r.employeeId} tabIndex={0} data-employee={r.employeeId} onClick={() => setSel(r.employeeId)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(r.employeeId); }}
                  style={{ padding: '6px 10px', cursor: 'pointer', background: sel === r.employeeId ? '#e6f4ff' : undefined, borderBottom: '1px solid #f5f5f5', opacity: r.isActive ? 1 : 0.55 }}>
                  <b>{r.code}</b> - {r.name}<br /><small>{r.hasProfile ? (r.currentSalary ? `Lương ${money(r.currentSalary)}` : 'Có hồ sơ, chưa có mức lương') : <span style={{ color: '#d46b08' }}>Chưa có hồ sơ lương</span>}</small>
                </li>))}
              {!rows.length && !list.isLoading && <li style={{ padding: 12 }}><Empty description="Không có nhân viên" image={Empty.PRESENTED_IMAGE_SIMPLE} /></li>}
            </ul>
          </Space>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {list.error && <Alert type="error" showIcon message={(list.error as Error).message} style={{ marginBottom: 8 }} />}
          {sel === null ? <Empty description="Chọn nhân viên ở bên trái để xem hồ sơ lương" /> : <Editor key={sel} employeeId={sel} />}
        </div>
      </div>
      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['payroll-profiles'] })} />
    </div>);
}
