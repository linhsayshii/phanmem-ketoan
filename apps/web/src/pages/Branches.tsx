import { useState } from 'react';
import { Alert, Button, DatePicker, Form, Input, Modal, Radio, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { D, formatVnNumber } from '@kt/domain';
import { useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { HO_LABEL, unitOptions, useBranches, type Branch } from './branchCommon.js';

const fail = (e: Error) => void message.error(e.message);
// Như màn Báo cáo tài chính: dòng "âm" in số âm trong ngoặc, số 0 để trống.
const money = (v: string, negate = false) => { const x = negate ? D(v).neg() : D(v); return x.isZero() ? '' : x.isNegative() ? `(${formatVnNumber(x.neg())})` : formatVnNumber(x); };

// Danh mục chi nhánh (đơn vị trực thuộc): mã, tên, MST đơn vị trực thuộc, đơn vị cấp trên.
function BranchCatalog() {
  const qc = useQueryClient(); const { can } = useAuth(); const branches = useBranches();
  const [editing, setEditing] = useState<Branch | 'new' | null>(null); const [form] = Form.useForm();
  const save = useMutation({ onError: fail,
    mutationFn: (v: Record<string, unknown>) => editing === 'new' ? api('/api/branches', { method: 'POST', json: v }) : api(`/api/branches/${(editing as Branch).id}`, { method: 'PUT', json: v }),
    onSuccess: () => { setEditing(null); void message.success('Đã lưu chi nhánh'); void qc.invalidateQueries({ queryKey: ['branches'] }); } });
  const open = (b: Branch | 'new') => { form.setFieldsValue(b === 'new' ? { code: '', name: '', taxCode: '', parentCode: '', isActive: true } : { ...b, taxCode: b.taxCode ?? '', parentCode: b.parentCode ?? '' }); setEditing(b); };
  useHotkeys({ Insert: () => { if (can('catalog.create') && !editing) open('new'); } });
  const submit = (v: { code: string; name: string; taxCode: string; parentCode: string; isActive: boolean }) =>
    save.mutate({ code: v.code, name: v.name, taxCode: v.taxCode?.trim() || null, parentCode: v.parentCode?.trim() || null, isActive: v.isActive });
  return (
    <>
      {can('catalog.create') && <Button type="primary" style={{ marginBottom: 12 }} onClick={() => open('new')}>Thêm chi nhánh (Insert)</Button>}
      <Table<Branch> rowKey="id" size="small" loading={branches.isLoading} dataSource={branches.data?.rows ?? []} pagination={false}
        locale={{ emptyText: 'Chưa có chi nhánh: mọi chứng từ thuộc trụ sở chính' }}
        onRow={(r) => ({ onDoubleClick: () => { if (can('catalog.update')) open(r); } })} columns={[
          { title: 'Mã', dataIndex: 'code', width: 120 }, { title: 'Tên chi nhánh', dataIndex: 'name' },
          { title: 'MST đơn vị trực thuộc', dataIndex: 'taxCode', width: 180 }, { title: 'Đơn vị cấp trên', dataIndex: 'parentCode', width: 140, render: (c: string | null) => c ?? HO_LABEL },
          { title: 'Trạng thái', dataIndex: 'isActive', width: 110, render: (a: boolean) => (a ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng</Tag>) },
          { title: '', width: 80, render: (_, r) => can('catalog.update') && <Button size="small" onClick={() => open(r)} aria-label={`Sửa ${r.code}`}>Sửa</Button> }]} />
      <Modal title={editing === 'new' ? 'Thêm chi nhánh' : 'Sửa chi nhánh'} open={!!editing} okText="Lưu (Ctrl+S)" cancelText="Hủy" confirmLoading={save.isPending} destroyOnHidden onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={submit} onKeyDown={(e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); form.submit(); } }}>
          <Form.Item label="Mã chi nhánh" name="code" rules={[{ required: true, whitespace: true, message: 'Nhập mã chi nhánh' }]}><Input maxLength={50} autoFocus /></Form.Item>
          <Form.Item label="Tên chi nhánh" name="name" rules={[{ required: true, whitespace: true, message: 'Nhập tên chi nhánh' }]}><Input maxLength={500} /></Form.Item>
          <Form.Item label="MST đơn vị trực thuộc" name="taxCode" extra="Để trống nếu chi nhánh không có mã số thuế riêng" rules={[{ pattern: /^(\d{10}(-\d{3})?)?$/, message: 'MST gồm 10 chữ số, hoặc 10 chữ số, dấu gạch, 3 chữ số' }]}><Input maxLength={14} /></Form.Item>
          <Form.Item label="Đơn vị cấp trên (mã bộ phận/chi nhánh)" name="parentCode" extra="Để trống: trực thuộc trụ sở chính"><Input maxLength={50} /></Form.Item>
          <Form.Item label="Đang dùng" name="isActive" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// Chi nhánh làm việc: chứng từ mới lập ở mọi phân hệ thuộc chi nhánh này.
function WorkingBranch() {
  const qc = useQueryClient(); const branches = useBranches();
  const me = useQuery({ queryKey: ['me-branch'], queryFn: () => api<{ scope: ('HO' | number)[] | null; working: 'HO' | number }>('/api/me/branch') });
  const set = useMutation({ mutationFn: (branch: string) => api('/api/me/branch', { method: 'PUT', json: { branch: branch === 'HO' ? 'HO' : Number(branch) } }), onError: fail,
    onSuccess: () => { void message.success('Đã đổi chi nhánh làm việc'); void qc.invalidateQueries({ queryKey: ['me-branch'] }); } });
  if (!me.data) return null;
  return (
    <Space direction="vertical">
      <Alert type="info" showIcon message="Chứng từ mới (phiếu thu, phiếu chi, hóa đơn, phiếu kho, phiếu kế toán…) thuộc chi nhánh làm việc. Chứng từ đảo giữ chi nhánh của chứng từ gốc; chứng từ kết chuyển thuộc trụ sở chính." />
      <Space>
        <span>Chi nhánh làm việc</span>
        <Select aria-label="Chi nhánh làm việc" style={{ width: 280 }} value={String(me.data.working)} loading={set.isPending} onChange={(v) => set.mutate(v)} options={unitOptions(branches.data)} />
      </Space>
      {me.data.scope && <span>Phạm vi được phân quyền: {me.data.scope.map((x) => (x === 'HO' ? HO_LABEL : branches.data?.rows.find((b) => b.id === x)?.code ?? x)).join(', ')}</span>}
    </Space>
  );
}

interface ConsRow { lineCode: string; label: string; parentLineCode: string | null; isBold: boolean; negate: boolean; formula: string | null; byUnit: string[]; total: string; elimination: string; consolidated: string }
interface Cons { name: string; units: { id: number; code: string; name: string }[]; rows: ConsRow[]; internalPrefixes: string[]; internalNet: string }

// BCTC tổng hợp: từng đơn vị, cộng, loại trừ tài khoản nội bộ, tổng hợp.
function Consolidated() {
  const qc = useQueryClient(); const { can } = useAuth();
  const [code, setCode] = useState<'B01' | 'B02'>('B02');
  const [range, setRange] = useState({ from: dayjs().startOf('year').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD') });
  const [prefixes, setPrefixes] = useState<string | null>(null);
  const r = useQuery({ queryKey: ['consolidated', code, range], retry: false, queryFn: () => api<Cons>(`/api/reports/consolidated/${code}?${new URLSearchParams(range).toString()}`) });
  const savePrefixes = useMutation({ onError: fail, mutationFn: (v: string[]) => api('/api/branch-consolidation/settings', { method: 'PUT', json: { internalPrefixes: v } }),
    onSuccess: () => { setPrefixes(null); void message.success('Đã lưu tài khoản nội bộ'); void qc.invalidateQueries({ queryKey: ['consolidated'] }); } });
  const d = r.data;
  const depth = (row: ConsRow) => { let n = 0; for (let p = row.parentLineCode; p && n < 10; p = d?.rows.find((x) => x.lineCode === p)?.parentLineCode ?? null) n++; return n; };
  const cell = (pick: (x: ConsRow) => string) => (_: unknown, x: ConsRow) => (x.formula ? money(pick(x), x.negate) : '');
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Radio.Group optionType="button" value={code} onChange={(e) => setCode(e.target.value as 'B01' | 'B02')} options={[{ value: 'B01', label: 'B01 Tình hình tài chính' }, { value: 'B02', label: 'B02 Kết quả kinh doanh' }]} />
        <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(range.from), dayjs(range.to)]} onChange={(v) => v?.[0] && v[1] && setRange({ from: v[0].format('YYYY-MM-DD'), to: v[1].format('YYYY-MM-DD') })} />
        {d && <span>Tài khoản nội bộ loại trừ: <b>{d.internalPrefixes.join(', ')}</b></span>}
        {d && can('setting.update') && <Button size="small" onClick={() => setPrefixes(d.internalPrefixes.join(', '))}>Khai báo tài khoản nội bộ</Button>}
      </Space>
      {r.error && <Alert type="error" showIcon message={(r.error as Error).message} />}
      {d && d.internalNet !== '0' && <Alert type="warning" showIcon message={`Phải thu và phải trả nội bộ chưa khớp: dư ròng các tài khoản nội bộ là ${money(d.internalNet)} (Nợ trừ Có). Đối chiếu nội bộ trước khi dùng số tổng hợp.`} />}
      {d && <Table<ConsRow> rowKey="lineCode" size="small" bordered pagination={false} scroll={{ x: true }} dataSource={d.rows} columns={[
        { title: 'Chỉ tiêu', key: 'label', fixed: 'left', render: (_, x) => <span style={{ paddingLeft: depth(x) * 16, fontWeight: x.isBold ? 600 : undefined }}>{x.label}</span> },
        { title: 'Mã số', dataIndex: 'lineCode', width: 70, align: 'center' },
        ...d.units.map((u, i) => ({ title: u.code === 'HO' ? HO_LABEL : u.code, key: `u${u.id}`, align: 'right' as const, width: 130, render: cell((x) => x.byUnit[i]!) })),
        { title: 'Cộng', key: 'total', align: 'right', width: 140, render: cell((x) => x.total) },
        { title: 'Loại trừ nội bộ', key: 'elim', align: 'right', width: 140, render: cell((x) => x.elimination) },
        { title: 'Tổng hợp', key: 'cons', align: 'right', width: 140, render: (_, x) => <b>{cell((y) => y.consolidated)(_, x)}</b> }]} />}
      <Modal title="Tài khoản nội bộ giữa các đơn vị" open={prefixes !== null} okText="Lưu" cancelText="Hủy" confirmLoading={savePrefixes.isPending} onCancel={() => setPrefixes(null)}
        onOk={() => savePrefixes.mutate((prefixes ?? '').split(/[\s,;]+/).filter(Boolean))}>
        <p>Số hiệu tài khoản (tiền tố) cách nhau dấu phẩy. Mặc định 136, 336 (Phải thu nội bộ, Phải trả nội bộ). Thêm tài khoản chi tiết dùng riêng cho doanh thu, chi phí nội bộ nếu có.</p>
        <Input aria-label="Tài khoản nội bộ" value={prefixes ?? ''} onChange={(e) => setPrefixes(e.target.value)} />
      </Modal>
    </Space>
  );
}

export default function BranchesPage() {
  const { can } = useAuth();
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <h2 style={{ margin: 0 }}>Chi nhánh</h2>
      <Tabs items={[
        { key: 'catalog', label: 'Danh mục chi nhánh', children: <BranchCatalog /> },
        { key: 'working', label: 'Chi nhánh làm việc', children: <WorkingBranch /> },
        ...(can('report.view') ? [{ key: 'consolidated', label: 'BCTC tổng hợp', children: <Consolidated /> }] : []),
        { key: 'group', label: 'Hợp nhất (TT 202/2014)', children: <Alert type="warning" showIcon message="Chưa có báo cáo tài chính hợp nhất nhiều pháp nhân"
          description="Hợp nhất theo Thông tư 202/2014/TT-BTC (loại trừ khoản đầu tư và vốn, lợi ích cổ đông không kiểm soát) chờ văn bản gốc và Thông tư 43/2026/TT-BTC sửa đổi để nhập đúng mẫu B01-DN/HN, B02-DN/HN. BCTC tổng hợp ở thẻ bên chỉ cộng các chi nhánh của cùng một công ty." /> },
      ]} />
    </Space>
  );
}

// Màn Người dùng: phạm vi chi nhánh của một người dùng (rỗng = toàn công ty).
export function BranchScopeButton({ userId, self }: { userId: string; self: boolean }) {
  const qc = useQueryClient(); const branches = useBranches(); const [open, setOpen] = useState(false);
  const scope = useQuery({ queryKey: ['branch-scope', userId], queryFn: () => api<{ branches: ('HO' | number)[] }>(`/api/users/${userId}/branch-scope`) });
  const [value, setValue] = useState<string[] | null>(null);
  const save = useMutation({ onError: fail, mutationFn: (v: string[]) => api(`/api/users/${userId}/branch-scope`, { method: 'PUT', json: { branches: v.map((x) => (x === 'HO' ? 'HO' : Number(x))) } }),
    onSuccess: () => { setOpen(false); void message.success('Đã lưu phạm vi chi nhánh'); void qc.invalidateQueries({ queryKey: ['branch-scope', userId] }); } });
  const cur = (scope.data?.branches ?? []).map(String);
  const all = [{ value: 'HO', label: HO_LABEL }, ...(branches.data?.rows ?? []).map((b) => ({ value: String(b.id), label: `${b.code} – ${b.name}` }))];
  const label = cur.length ? cur.map((x) => all.find((o) => o.value === x)?.label.split(' – ')[0] ?? x).join(', ') : 'Toàn công ty';
  return (
    <>
      <Button size="small" disabled={self} title={self ? 'Không tự đặt phạm vi cho chính mình' : undefined} onClick={() => { setValue(cur); setOpen(true); }} aria-label={`Phạm vi chi nhánh ${userId}`}>{label}</Button>
      <Modal title="Phạm vi chi nhánh" open={open} okText="Lưu" cancelText="Hủy" confirmLoading={save.isPending} onCancel={() => setOpen(false)} onOk={() => save.mutate(value ?? [])}>
        <p>Người dùng chỉ đọc và ghi chứng từ, sổ sách, báo cáo tài chính của các đơn vị được chọn; để trống là toàn công ty. Khi bị giới hạn, các phân hệ tổng hợp cả công ty (công nợ, kho, tài sản, thuế, cuối kỳ, quản trị) bị tắt.</p>
        <Select mode="multiple" aria-label="Đơn vị được phép" style={{ width: '100%' }} value={value ?? []} onChange={setValue} options={all} placeholder="Toàn công ty" />
      </Modal>
    </>
  );
}
