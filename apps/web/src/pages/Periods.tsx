import { useEffect, useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { NoFiscalYear, PageHeader, Section, Toolbar } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NumberingBranchPanel } from './NumberingBranch.js';
import { FiscalYearForm, nextFiscalYearDefaults } from './FiscalYearForm.js';

interface PeriodRow {
  fiscalYear: number; periodNo: number; dateFrom: string; dateTo: string; regime: string; status: 'open' | 'soft_locked' | 'hard_locked';
  lockedModules: string[]; hashTail: string | null; lockedAt: string | null; draftCount: number;
}
// voucherId null: dòng so hash cuối chuỗi với hash_tail của kỳ (chứng từ bị xóa)
interface Mismatch { voucherId: string | null; voucherNo: string | null; stored: string | null; computed: string }
const STATUS = { open: { color: 'green', label: 'Mở' }, soft_locked: { color: 'orange', label: 'Khóa sổ' }, hard_locked: { color: 'red', label: 'Khóa cứng' } } as const;
const MODULES = [{ value: 'general', label: 'Tổng hợp' }, { value: 'cash', label: 'Tiền mặt' }, { value: 'bank', label: 'Ngân hàng' }, { value: 'inventory', label: 'Kho' },
  { value: 'arap', label: 'Công nợ' }, { value: 'assets', label: 'Tài sản cố định' }, { value: 'payroll', label: 'Lương' }];
const periodLabel = (no: number) => (no === 0 ? 'Số dư đầu kỳ' : `Kỳ ${no}`);
const fmtDate = (d: string) => dayjs(d).format('DD/MM/YYYY');

// Loại chứng từ: GET /api/voucher-types trả nguyên cột (snake_case).
interface VoucherTypeRow { code: string; name: string; prefix: string; suffix: string; pad_length: number }
interface TypeForm { name: string; prefix: string; suffix: string; padLength: number }
const NextNo = ({ row, year }: { row: VoucherTypeRow; year: number | undefined }) => {
  const q = useQuery({ queryKey: ['next-no', row.code, year, row.prefix, row.suffix, row.pad_length], enabled: year !== undefined, queryFn: () => api<{ preview: string }>(`/api/voucher-types/${row.code}/next-no?year=${year}`) });
  return <code>{q.data?.preview ?? ''}</code>;
};

function VoucherTypesTab({ year }: { year: number | undefined }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const types = useQuery({ queryKey: ['voucher-types'], queryFn: () => api<VoucherTypeRow[]>('/api/voucher-types') });
  const [editing, setEditing] = useState<VoucherTypeRow | null>(null);
  const [form] = Form.useForm<TypeForm>();
  useEffect(() => { if (types.error) void message.error((types.error as Error).message); }, [types.error]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['voucher-types'] }); void qc.invalidateQueries({ queryKey: ['next-no'] }); };
  const onError = (e: unknown) => { void message.error((e as Error).message); };
  const save = useMutation({ mutationFn: (v: TypeForm) => api(`/api/voucher-types/${editing!.code}`, { method: 'PUT', json: v }), onError,
    onSuccess: () => { setEditing(null); refresh(); void message.success('Đã lưu cấu hình đánh số'); } });
  const renumber = useMutation({ mutationFn: (code: string) => api<{ count: number }>('/api/vouchers/renumber', { method: 'POST', json: { voucherType: code, fiscalYear: year } }), onError,
    onSuccess: (r) => { refresh(); void message.success(`Đã đánh lại số ${r.count} chứng từ`); } });
  const confirmRenumber = (r: VoucherTypeRow) => Modal.confirm({ title: `Đánh lại số ${r.code} năm ${year} theo ngày?`, okText: 'Đánh lại số', cancelText: 'Hủy',
    content: 'Số chứng từ được cấp lại liền nhau theo ngày ghi sổ. Chỉ chạy được khi mọi kỳ của năm còn mở; có kỳ đã khóa thì bị từ chối.', onOk: () => renumber.mutateAsync(r.code).catch(() => undefined) });
  return (
    <>
      <NumberingBranchPanel />
      <Section bodyPadding={0} style={{ marginTop: 12 }}>
        <Table<VoucherTypeRow> rowKey="code" size="small" pagination={false} loading={types.isFetching || renumber.isPending} dataSource={types.data ?? []} columns={[
          { title: 'Mã', dataIndex: 'code', width: 90 },
          { title: 'Tên', dataIndex: 'name' },
          { title: 'Tiền tố', dataIndex: 'prefix', width: 130 },
          { title: 'Hậu tố', dataIndex: 'suffix', width: 130 },
          { title: 'Độ dài số', dataIndex: 'pad_length', width: 100, align: 'right' },
          { title: `Số tiếp theo (${year ?? ''})`, key: 'next', width: 180, render: (_, r) => <NextNo row={r} year={year} /> },
          { title: '', key: 'act', width: 260, render: (_, r) => (
            <Space>
              {can('setting.update') && <Button size="small" onClick={() => setEditing(r)}>Sửa</Button>}
              {can('voucher.renumber') && <Button size="small" disabled={year === undefined} onClick={() => confirmRenumber(r)}>Đánh lại số theo ngày</Button>}
            </Space>) },
        ]} />
      </Section>
      <Modal open={!!editing} title={`Cấu hình đánh số - ${editing?.code ?? ''}`} okText="Lưu" cancelText="Hủy" confirmLoading={save.isPending} destroyOnHidden onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form<TypeForm> form={form} layout="vertical" initialValues={{ name: editing?.name ?? '', prefix: editing?.prefix ?? '', suffix: editing?.suffix ?? '', padLength: editing?.pad_length ?? 5 }} onFinish={(v) => save.mutate(v)}>
          <Form.Item name="name" label="Tên" rules={[{ required: true, message: 'Nhập tên' }]}><Input /></Form.Item>
          <Form.Item name="prefix" label="Tiền tố" extra="Dùng {YY} hoặc {YYYY} để chèn năm tài chính"><Input maxLength={20} /></Form.Item>
          <Form.Item name="suffix" label="Hậu tố"><Input maxLength={20} /></Form.Item>
          <Form.Item name="padLength" label="Độ dài số (đệm số 0)" rules={[{ required: true, message: 'Nhập độ dài từ 1 đến 10' }]}><InputNumber min={1} max={10} precision={0} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function PeriodsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; regime: string; dateTo: string }[]>('/api/fiscal-years') });
  const [addingYear, setAddingYear] = useState(false);
  const [picked, setPicked] = useState<number>();
  const year = picked ?? years.data?.at(-1)?.fiscalYear;
  const periods = useQuery({ queryKey: ['periods', year], enabled: year !== undefined, queryFn: () => api<PeriodRow[]>(`/api/periods?year=${year}`) });
  const [bad, setBad] = useState<{ periodNo: number; rows: Mismatch[] } | null>(null);
  useEffect(() => { if (years.error) void message.error((years.error as Error).message); }, [years.error]);
  useEffect(() => { if (periods.error) void message.error((periods.error as Error).message); }, [periods.error]);
  // Lỗi từ máy chủ (kỳ trước chưa khóa cứng, còn nháp...) hiện nguyên văn; làm mới cả khi lỗi để ô chọn phần hành quay về giá trị thật.
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onError: (e) => { void message.error((e as Error).message); }, onSettled: () => { void qc.invalidateQueries({ queryKey: ['periods'] }); } });
  const url = (no: number, tail: string) => `/api/periods/${year}/${no}/${tail}`;
  const verify = async (no: number) => {
    const r = await api<{ total: number; mismatched: Mismatch[] }>(url(no, 'verify-hash'));
    if (r.mismatched.length) setBad({ periodNo: no, rows: r.mismatched }); else void message.success(`Toàn bộ ${r.total} chứng từ khớp`);
  };
  const hardLock = (r: PeriodRow) => Modal.confirm({ title: `Khóa cứng ${periodLabel(r.periodNo).toLowerCase()}?`, okText: 'Khóa cứng', cancelText: 'Hủy',
    content: 'Khóa cứng tính chuỗi hash, không sửa được chứng từ trong kỳ; chỉ bỏ khóa được với quyền riêng',
    onOk: () => run.mutate(() => api(url(r.periodNo, 'lock'), { method: 'POST', json: { level: 'hard' } })) });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Kỳ kế toán"
        description="Mở, khóa sổ kỳ kế toán và cấu hình quy tắc đánh số chứng từ"
      >
        <Toolbar>
          <span>Năm tài chính</span>
          <Select aria-label="Năm tài chính" style={{ width: 120 }} value={year} loading={years.isLoading} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: y.fiscalYear }))} onChange={setPicked} />
          {can('period.create') && <Button onClick={() => setAddingYear(true)}>Thêm năm tài chính</Button>}
        </Toolbar>
      </PageHeader>
      <Tabs items={[
        { key: 'periods', label: 'Kỳ kế toán', children: years.isSuccess && years.data.length === 0
        ? <NoFiscalYear inPeriods canCreate={can('period.create')} onCreate={() => setAddingYear(true)} purpose="mở, khóa sổ các kỳ kế toán" />
        : (
        <>
          <Section bodyPadding={0}>
            <Table<PeriodRow> rowKey="periodNo" size="small" pagination={false} loading={periods.isFetching || run.isPending} dataSource={periods.data ?? []} columns={[
              { title: 'Kỳ', dataIndex: 'periodNo', width: 120, render: periodLabel },
              { title: 'Từ ngày', dataIndex: 'dateFrom', width: 110, render: fmtDate },
              { title: 'Đến ngày', dataIndex: 'dateTo', width: 110, render: fmtDate },
              { title: 'Trạng thái', dataIndex: 'status', width: 110, render: (s: PeriodRow['status']) => <Tag color={STATUS[s].color}>{STATUS[s].label}</Tag> },
              { title: 'Phần hành khóa', dataIndex: 'lockedModules', render: (m: string[], r) => (
                <Select mode="multiple" allowClear style={{ minWidth: 220 }} placeholder="Không khóa" value={m} options={MODULES} disabled={!can('period.lock') || r.status === 'hard_locked'}
                  onChange={(v: string[]) => run.mutate(() => api(url(r.periodNo, 'modules'), { method: 'PUT', json: { modules: v } }))} />) },
              { title: 'Chứng từ nháp', dataIndex: 'draftCount', width: 120, align: 'right' },
              { title: 'Hash', dataIndex: 'hashTail', width: 100, render: (h: string | null) => (h ? <span title={h}>{h.slice(0, 8)}</span> : '') },
              { title: '', key: 'act', width: 300, render: (_, r) => (
                <Space>
                  {r.status === 'open' && can('period.lock') && <Button size="small" onClick={() => run.mutate(() => api(url(r.periodNo, 'lock'), { method: 'POST', json: { level: 'soft' } }))}>Khóa sổ</Button>}
                  {r.status !== 'hard_locked' && can('period.lock') && <Button size="small" danger onClick={() => hardLock(r)}>Khóa cứng</Button>}
                  {r.status !== 'open' && can('period.unlock') && (r.status !== 'hard_locked' || can('period.unlock_hard')) && <Button size="small" onClick={() => run.mutate(() => api(url(r.periodNo, 'unlock'), { method: 'POST' }))}>Bỏ khóa</Button>}
                  {r.status === 'hard_locked' && <Button size="small" onClick={() => run.mutate(() => verify(r.periodNo))}>Kiểm tra hash</Button>}
                </Space>) },
            ]} />
          </Section>
          <Modal open={!!bad} title={`Chứng từ lệch hash - ${bad ? periodLabel(bad.periodNo) : ''}`} width={900} footer={null} onCancel={() => setBad(null)}>
            <Table<Mismatch> rowKey={(r) => r.voucherId ?? 'hash_tail'} size="small" pagination={false} dataSource={bad?.rows ?? []} columns={[
              { title: 'Số chứng từ', dataIndex: 'voucherNo', width: 130, render: (n: string | null) => n ?? '(chưa số)' },
              { title: 'Hash lưu', dataIndex: 'stored', render: (h: string | null) => <code>{h?.slice(0, 16) ?? '(trống)'}</code> },
              { title: 'Hash tính lại', dataIndex: 'computed', render: (h: string) => <code>{h.slice(0, 16)}</code> }]} />
          </Modal>
        </>) },
        { key: 'numbering', label: 'Loại chứng từ và đánh số', children: <VoucherTypesTab year={year} /> },
      ]} />
      <Modal open={addingYear} title="Thêm năm tài chính" footer={null} destroyOnHidden onCancel={() => setAddingYear(false)}>
        <FiscalYearForm initial={nextFiscalYearDefaults(years.data)} submitText="Tạo năm tài chính"
          onCreated={() => { setAddingYear(false); setPicked(undefined); void qc.invalidateQueries({ queryKey: ['fiscal-years'] }); void qc.invalidateQueries({ queryKey: ['periods'] }); }} />
      </Modal>
    </div>
  );
}
