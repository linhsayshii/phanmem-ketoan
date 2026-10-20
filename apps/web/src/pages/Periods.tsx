import { useEffect, useState } from 'react';
import { Button, Modal, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

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

export default function PeriodsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number }[]>('/api/fiscal-years') });
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
    <>
      <Space style={{ marginBottom: 12 }}>
        <span>Năm tài chính</span>
        <Select style={{ width: 120 }} value={year} loading={years.isLoading} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: y.fiscalYear }))} onChange={setPicked} />
      </Space>
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
      <Modal open={!!bad} title={`Chứng từ lệch hash - ${bad ? periodLabel(bad.periodNo) : ''}`} width={900} footer={null} onCancel={() => setBad(null)}>
        <Table<Mismatch> rowKey={(r) => r.voucherId ?? 'hash_tail'} size="small" pagination={false} dataSource={bad?.rows ?? []} columns={[
          { title: 'Số chứng từ', dataIndex: 'voucherNo', width: 130, render: (n: string | null) => n ?? '(chưa số)' },
          { title: 'Hash lưu', dataIndex: 'stored', render: (h: string | null) => <code>{h?.slice(0, 16) ?? '(trống)'}</code> },
          { title: 'Hash tính lại', dataIndex: 'computed', render: (h: string) => <code>{h.slice(0, 16)}</code> }]} />
      </Modal>
    </>
  );
}
