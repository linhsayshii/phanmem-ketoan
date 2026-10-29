import { useEffect, useState } from 'react';
import { Alert, Button, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { PageHeader, Section, Toolbar, useHotkeys } from '@kt/ui';
import { NoFiscalYearNotice } from './NoFiscalYearNotice.js';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

type Status = 'done' | 'rerun' | 'pending' | 'skipped_empty';
interface Step { failed: boolean; key: string; name: string; permission: string; optional: boolean; masked: boolean; status: Status; lastRunAt: string | null; reason: string | null; lastUser: string | null;
  vouchers: { id: string; voucherNo: string | null; voucherType: string | null }[] }
interface CloseState { steps: Step[]; nextStep: string | null }

const TAG: Record<Status, { color: string; label: string }> = {
  done: { color: 'green', label: 'Đã chạy' }, rerun: { color: 'orange', label: 'Cần chạy lại' }, pending: { color: 'default', label: 'Chưa chạy' }, skipped_empty: { color: 'blue', label: 'Đã bỏ qua' } };
const periodLabel = (no: number) => `Tháng ${no}`;

export default function PeriodClosePage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number }[]>('/api/fiscal-years') });
  const noYear = years.isSuccess && years.data.length === 0; // công ty chưa có năm tài chính: không có kỳ để chọn
  const [pickedYear, setYear] = useState<number>();
  const [period, setPeriod] = useState<number>(() => dayjs().month() + 1);
  const year = pickedYear ?? years.data?.at(-1)?.fiscalYear;
  const state = useQuery({ queryKey: ['period-close', year, period], enabled: year !== undefined, queryFn: () => api<CloseState>(`/api/period-close/${year}/${period}`) });
  useEffect(() => { if (state.error) void message.error((state.error as Error).message); }, [state.error]);

  const run = useMutation({
    mutationFn: (a: { step: string; skip?: boolean }) => api<CloseState>('/api/period-close/run', { method: 'POST', json: { fiscalYear: year, periodNo: period, ...a } }),
    onError: (e) => { void message.error((e as Error).message); },
    // Làm mới cả khi lỗi: chạy có thể đã ghi nhật ký một phần.
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['period-close'] }); },
    onSuccess: (r, a) => {
      const s = r.steps.find((x) => x.key === a.step);
      if (!a.skip && s?.failed) void message.warning(`Bước chạy chưa hoàn tất: ${s.reason}`); // lần chạy lỗi không được tính là xong
      else void message.success(a.skip ? 'Đã bỏ qua bước' : 'Đã chạy bước');
    },
  });
  const steps = state.data?.steps ?? [];
  const next = steps.find((s) => s.key === state.data?.nextStep);
  const mayRun = (s: Step) => can(s.permission);
  const runNext = () => { if (next && mayRun(next) && !run.isPending) run.mutate({ step: next.key }); };
  useHotkeys({ F9: runNext });
  const rerunCount = steps.filter((s) => s.status === 'rerun').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Quy trình cuối kỳ"
        description="Thực hiện lần lượt các bước tính toán và xử lý số liệu cuối kỳ theo trình tự"
        extra={
          <Button type="primary" disabled={!next || !mayRun(next)} loading={run.isPending} onClick={runNext}>
            {next ? `Chạy bước tiếp theo (F9): ${next.name}` : 'Đã xong quy trình'}
          </Button>
        }
      >
        <Toolbar>
          <span>Năm tài chính</span>
          <Select aria-label="Năm tài chính" style={{ width: 110 }} value={year} loading={years.isLoading} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: y.fiscalYear }))} onChange={setYear} />
          <span>Kỳ</span>
          <Select aria-label="Chọn kỳ" virtual={false} style={{ width: 120 }} value={period} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: periodLabel(i + 1) }))} onChange={setPeriod} />
        </Toolbar>
      </PageHeader>
      {noYear ? <NoFiscalYearNotice purpose="chạy quy trình khóa kỳ" /> : (<>
      {rerunCount > 0 && <Alert type="warning" showIcon message={`${rerunCount} bước cần chạy lại vì số liệu hoặc bước đứng trước đã thay đổi.`} />}
      <Section bodyPadding={0}>
        <Table<Step> rowKey="key" size="small" pagination={false} loading={state.isFetching} dataSource={steps} data-testid="close-steps" columns={[
          { title: 'Thứ tự', width: 70, render: (_, __, i) => i + 1 },
          { title: 'Bước', render: (_, s) => <span>{s.name}{s.optional && <Tag style={{ marginLeft: 8 }}>Tùy chọn</Tag>}</span> },
          { title: 'Trạng thái', width: 260, render: (_, s) => (
            <span><Tag color={TAG[s.status].color}>{TAG[s.status].label}</Tag>{s.reason && <Typography.Text type="secondary">{s.reason}</Typography.Text>}
              {s.masked && <Typography.Text type="secondary"> ({s.key === 'payroll' ? 'chi tiết lương cần quyền xem lương' : 'chi tiết giá thành cần quyền xem giá vốn'})</Typography.Text>}</span>) },
          { title: 'Lần chạy cuối', width: 190, render: (_, s) => (s.lastRunAt ? `${dayjs(s.lastRunAt).format('DD/MM/YYYY HH:mm')}${s.lastUser ? ` - ${s.lastUser}` : ''}` : '') },
          { title: 'Chứng từ', render: (_, s) => s.vouchers.map((v, i) => (
            <span key={v.id}>{i > 0 && ', '}{v.voucherType ? <Link to="/chung-tu/$type/$id" params={{ type: v.voucherType, id: v.id }}>{v.voucherNo ?? 'Xem'}</Link> : (v.voucherNo ?? '')}</span>)) },
          { title: '', width: 190, render: (_, s) => (
            <Space size={4}>
              <Button size="small" disabled={!mayRun(s) || run.isPending} onClick={() => run.mutate({ step: s.key })}>{s.status === 'pending' ? 'Chạy' : 'Chạy lại'}</Button>
              {s.optional && s.status === 'pending' && (
                <Popconfirm title="Bỏ qua bước này?" okText="Bỏ qua" cancelText="Hủy" onConfirm={() => run.mutate({ step: s.key, skip: true })}>
                  <Button size="small" disabled={!mayRun(s) || run.isPending}>Bỏ qua</Button>
                </Popconfirm>)}
            </Space>) },
        ]} />
      </Section>
      </>)}
    </div>
  );
}
