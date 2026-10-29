import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Col, Row, Select, Table } from 'antd';
import { formatVnNumber } from '@kt/domain';
import { PageHeader, Section, StatStrip, Toolbar } from '@kt/ui';
import { api } from '../api/client.js';
import { Chart } from './charts.js';

interface Month { month: number; dateTo: string; revenue: string; expense: string | null; profit: string | null; cash: string; receivable: string | null; payable: string | null }
interface Ratio { code: string; name: string; unit: 'lan' | 'percent'; value: string }
interface BudgetSide { month: number; budget: string; actual: string }
interface Overview {
  fiscalYear: number; month: number; regime: string; hidden: string[]; months: Month[];
  summary: { revenue: string | null; expense: string | null; profit: string | null; cash: string; receivable: string | null; payable: string | null };
  ratios: Ratio[] | null; budget: { id: number; name: string; version: number; hiddenLines: number; expense: BudgetSide[]; revenue: BudgetSide[] } | null;
}
const HIDDEN_LABEL: Record<string, string> = { view_cost: 'giá vốn và chi phí', view_receivable: 'công nợ phải thu', view_payable: 'công nợ phải trả' };
const n = (v: string | null) => (v === null ? null : Number(v));
const vnd = (v: string | null) => (v === null ? null : formatVnNumber(v));

export default function AnalyticsPage() {
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number }[]>('/api/fiscal-years') });
  const [year, setYear] = useState<number>(); const [month, setMonth] = useState(12);
  useEffect(() => { if (year === undefined && years.data?.length) setYear(years.data[0]!.fiscalYear); }, [years.data, year]);
  const q = useQuery({ queryKey: ['analytics', year, month], enabled: year !== undefined, retry: false, queryFn: () => api<Overview>(`/api/analytics/overview?year=${year}&month=${month}`) });
  const d = q.data; const labels = d?.months.map((m) => `T${m.month}`) ?? [];
  return (<>
    <PageHeader title="Phân tích tài chính">
      <Toolbar>
        <Select aria-label="Năm tài chính" value={year} onChange={setYear} style={{ width: 120 }} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }))} />
        <Select aria-label="Đến tháng" value={month} onChange={setMonth} style={{ width: 130 }} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Đến tháng ${i + 1}` }))} />
      </Toolbar>
    </PageHeader>
    {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
    {d && d.hidden.length > 0 && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`Một số số liệu bị ẩn do thiếu quyền xem: ${d.hidden.map((h) => HIDDEN_LABEL[h] ?? h).join(', ')}.`} />}
    {d && (<>
      <StatStrip items={[{ label: 'Doanh thu lũy kế', value: vnd(d.summary.revenue) }, { label: 'Chi phí lũy kế', value: vnd(d.summary.expense) }, { label: 'Lợi nhuận lũy kế', value: vnd(d.summary.profit) },
        { label: 'Tiền cuối tháng', value: vnd(d.summary.cash) }, { label: 'Phải thu cuối tháng', value: vnd(d.summary.receivable) }, { label: 'Phải trả cuối tháng', value: vnd(d.summary.payable) }]} />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}><Section><Chart testId="chart-pl" kind="bar" title="Doanh thu, chi phí, lợi nhuận theo tháng (đồng)" labels={labels} series={[
          { name: 'Doanh thu', values: d.months.map((m) => n(m.revenue)) }, { name: 'Chi phí', values: d.months.map((m) => n(m.expense)) }, { name: 'Lợi nhuận', values: d.months.map((m) => n(m.profit)) }]} /></Section></Col>
        <Col xs={24} xl={12}><Section><Chart testId="chart-cash" kind="line" title="Số dư tiền, phải thu, phải trả cuối tháng (đồng)" labels={labels} series={[
          { name: 'Tiền', values: d.months.map((m) => n(m.cash)) }, { name: 'Phải thu', values: d.months.map((m) => n(m.receivable)) }, { name: 'Phải trả', values: d.months.map((m) => n(m.payable)) }]} /></Section></Col>
        {d.budget && <Col xs={24} xl={12}><Section><Chart testId="chart-budget" kind="bar" title={`Chi phí: thực tế so với ngân sách ${d.budget.name} v${d.budget.version} (đồng)`} labels={labels} series={[
          { name: 'Thực tế', values: d.budget.expense.map((m) => Number(m.actual)) }, { name: 'Ngân sách', values: d.budget.expense.map((m) => Number(m.budget)) }]} />
          {d.budget.hiddenLines > 0 && <p style={{ fontSize: 12, margin: '4px 0 0' }}>Đã ẩn {d.budget.hiddenLines} dòng ngân sách do thiếu quyền xem.</p>}</Section></Col>}
        {d.budget && <Col xs={24} xl={12}><Section><Chart testId="chart-budget-rev" kind="bar" title="Doanh thu: thực tế so với ngân sách (đồng)" labels={labels} series={[
          { name: 'Thực tế', values: d.budget.revenue.map((m) => Number(m.actual)) }, { name: 'Ngân sách', values: d.budget.revenue.map((m) => Number(m.budget)) }]} /></Section></Col>}
        <Col xs={24}><Section title="Hệ số tài chính (số cuối kỳ, từ B01 và B02 của công ty)">
          {d.ratios === null ? <Alert type="info" showIcon message="Cần đủ quyền xem giá vốn, công nợ phải thu và phải trả để tính hệ số tài chính." />
            : d.ratios.length === 0 ? <Alert type="info" showIcon message="Báo cáo tài chính của chế độ kế toán này chưa có đủ chỉ tiêu để tính hệ số (ví dụ không tách ngắn hạn, dài hạn)." />
            : <Table<Ratio> size="small" rowKey="code" pagination={false} dataSource={d.ratios} columns={[{ title: 'Hệ số', dataIndex: 'name' }, { title: 'Giá trị', align: 'right', width: 160, render: (_: unknown, r) => (r.unit === 'percent' ? `${r.value.replace('.', ',')}%` : `${r.value.replace('.', ',')} lần`) }]} />}
        </Section></Col>
      </Row>
    </>)}
  </>);
}
