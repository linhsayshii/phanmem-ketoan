import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Col, Row, Select, Space, Statistic, Table } from 'antd';
import { formatVnNumber } from '@kt/domain';
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
const vnd = (v: string | null) => (v === null ? 'Không có quyền xem' : formatVnNumber(v));

export default function AnalyticsPage() {
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number }[]>('/api/fiscal-years') });
  const [year, setYear] = useState<number>(); const [month, setMonth] = useState(12);
  useEffect(() => { if (year === undefined && years.data?.length) setYear(years.data[0]!.fiscalYear); }, [years.data, year]);
  const q = useQuery({ queryKey: ['analytics', year, month], enabled: year !== undefined, retry: false, queryFn: () => api<Overview>(`/api/analytics/overview?year=${year}&month=${month}`) });
  const d = q.data; const labels = d?.months.map((m) => `T${m.month}`) ?? [];
  return (<>
    <Space style={{ marginBottom: 12 }} wrap>
      <h2 style={{ margin: 0 }}>Phân tích tài chính</h2>
      <Select aria-label="Năm tài chính" value={year} onChange={setYear} style={{ width: 120 }} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }))} />
      <Select aria-label="Đến tháng" value={month} onChange={setMonth} style={{ width: 130 }} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Đến tháng ${i + 1}` }))} />
    </Space>
    {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
    {d && d.hidden.length > 0 && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`Một số số liệu bị ẩn do thiếu quyền xem: ${d.hidden.map((h) => HIDDEN_LABEL[h] ?? h).join(', ')}.`} />}
    {d && (<>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {([['Doanh thu lũy kế', d.summary.revenue], ['Chi phí lũy kế', d.summary.expense], ['Lợi nhuận lũy kế', d.summary.profit], ['Tiền cuối tháng', d.summary.cash], ['Phải thu cuối tháng', d.summary.receivable], ['Phải trả cuối tháng', d.summary.payable]] as const).map(([t, v]) => (
          <Col key={t} xs={12} md={8} xl={4}><Card size="small"><Statistic title={t} value={vnd(v)} valueStyle={{ fontSize: 18 }} /></Card></Col>))}
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}><Card size="small"><Chart testId="chart-pl" kind="bar" title="Doanh thu, chi phí, lợi nhuận theo tháng (đồng)" labels={labels} series={[
          { name: 'Doanh thu', values: d.months.map((m) => n(m.revenue)) }, { name: 'Chi phí', values: d.months.map((m) => n(m.expense)) }, { name: 'Lợi nhuận', values: d.months.map((m) => n(m.profit)) }]} /></Card></Col>
        <Col xs={24} xl={12}><Card size="small"><Chart testId="chart-cash" kind="line" title="Số dư tiền, phải thu, phải trả cuối tháng (đồng)" labels={labels} series={[
          { name: 'Tiền', values: d.months.map((m) => n(m.cash)) }, { name: 'Phải thu', values: d.months.map((m) => n(m.receivable)) }, { name: 'Phải trả', values: d.months.map((m) => n(m.payable)) }]} /></Card></Col>
        {d.budget && <Col xs={24} xl={12}><Card size="small"><Chart testId="chart-budget" kind="bar" title={`Chi phí: thực tế so với ngân sách ${d.budget.name} v${d.budget.version} (đồng)`} labels={labels} series={[
          { name: 'Thực tế', values: d.budget.expense.map((m) => Number(m.actual)) }, { name: 'Ngân sách', values: d.budget.expense.map((m) => Number(m.budget)) }]} />
          {d.budget.hiddenLines > 0 && <p style={{ fontSize: 12, margin: '4px 0 0' }}>Đã ẩn {d.budget.hiddenLines} dòng ngân sách do thiếu quyền xem.</p>}</Card></Col>}
        {d.budget && <Col xs={24} xl={12}><Card size="small"><Chart testId="chart-budget-rev" kind="bar" title="Doanh thu: thực tế so với ngân sách (đồng)" labels={labels} series={[
          { name: 'Thực tế', values: d.budget.revenue.map((m) => Number(m.actual)) }, { name: 'Ngân sách', values: d.budget.revenue.map((m) => Number(m.budget)) }]} /></Card></Col>}
        <Col xs={24}><Card size="small" title="Hệ số tài chính (số cuối kỳ, từ B01 và B02 của công ty)">
          {d.ratios === null ? <Alert type="info" showIcon message="Cần đủ quyền xem giá vốn, công nợ phải thu và phải trả để tính hệ số tài chính." />
            : d.ratios.length === 0 ? <Alert type="info" showIcon message="Báo cáo tài chính của chế độ kế toán này chưa có đủ chỉ tiêu để tính hệ số (ví dụ không tách ngắn hạn, dài hạn)." />
            : <Table<Ratio> size="small" rowKey="code" pagination={false} dataSource={d.ratios} columns={[{ title: 'Hệ số', dataIndex: 'name' }, { title: 'Giá trị', align: 'right', width: 160, render: (_: unknown, r) => (r.unit === 'percent' ? `${r.value.replace('.', ',')}%` : `${r.value.replace('.', ',')} lần`) }]} />}
        </Card></Col>
      </Row>
    </>)}
  </>);
}
