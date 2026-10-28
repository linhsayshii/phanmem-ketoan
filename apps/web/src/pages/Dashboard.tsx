import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Col, Dropdown, Row, Select } from 'antd';
import { DownOutlined, FileAddOutlined } from '@ant-design/icons';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { COLOR, EmptyState, PageHeader, Section, StatStrip, Toolbar } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { Chart } from './charts.js';

interface FiscalYear {
  fiscalYear: number;
}

interface MonthData {
  month: number;
  dateTo: string;
  revenue: string | null;
  expense: string | null;
  profit: string | null;
  cash: string;
  receivable: string | null;
  payable: string | null;
}

interface OverviewData {
  fiscalYear: number;
  month: number;
  regime: string;
  hidden: string[];
  months: MonthData[];
  summary: {
    revenue: string | null;
    expense: string | null;
    profit: string | null;
    cash: string;
    receivable: string | null;
    payable: string | null;
  };
}

interface VoucherRow {
  id: string;
  voucherType: string;
  voucherNo: string | null;
  postingDate: string;
  state: string;
  description: string | null;
  partyName: string | null;
  totalDebit: string | null;
}

// Chuyển chuỗi số sang number: chỉ để vẽ biểu đồ, không dùng để cộng trừ tiền
const toChartNumber = (v: string | null) => (v === null ? null : Number(v));
const money = (v: string | null) => (v === null ? null : `${formatVnNumber(v)} đ`);

export default function DashboardPage() {
  const navigate = useNavigate();
  const { can } = useAuth();

  const currentYear = dayjs().year();
  const currentMonth = dayjs().month() + 1;

  const years = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => api<FiscalYear[]>('/api/fiscal-years'),
  });

  const [year, setYear] = useState<number>();
  const [month, setMonth] = useState<number>(() => currentMonth);

  // Năm mặc định: năm trùng năm hiện tại nếu có, không thì năm lớn nhất
  const defaultYear = useMemo(() => {
    if (!years.data?.length) return undefined;
    const match = years.data.find((y) => y.fiscalYear === currentYear);
    if (match) return match.fiscalYear;
    return Math.max(...years.data.map((y) => y.fiscalYear));
  }, [years.data, currentYear]);

  useEffect(() => {
    if (year === undefined && defaultYear !== undefined) {
      setYear(defaultYear);
      setMonth(defaultYear === currentYear ? currentMonth : 12);
    }
  }, [defaultYear, year, currentYear, currentMonth]);

  const handleYearChange = (newYear: number) => {
    setYear(newYear);
    setMonth(newYear === currentYear ? currentMonth : 12);
  };

  const hasReportPermission = can('report.view');
  const canCreateVoucher = can('voucher.create');
  const canApprove = can('approval_request.approve');
  const canViewVoucher = can('voucher.view');

  // Dữ liệu phân tích tổng quan
  const overview = useQuery({
    queryKey: ['analytics', year, month],
    enabled: hasReportPermission && year !== undefined,
    retry: false,
    queryFn: () => api<OverviewData>(`/api/analytics/overview?year=${year}&month=${month}`),
  });

  // Số lượng đề nghị chờ duyệt
  const approvalsCount = useQuery({
    queryKey: ['approvals', 'count'],
    queryFn: () => api<{ count: number }>('/api/approvals/inbox/count'),
    enabled: canApprove,
    refetchInterval: 60_000,
  });

  // Chứng từ nháp trong tháng đang chọn
  const monthStr = String(month).padStart(2, '0');
  const fromDate = year !== undefined ? dayjs(`${year}-${monthStr}-01`).startOf('month').format('YYYY-MM-DD') : '';
  const toDate = year !== undefined ? dayjs(`${year}-${monthStr}-01`).endOf('month').format('YYYY-MM-DD') : '';

  const drafts = useQuery({
    queryKey: ['dashboard-drafts', fromDate, toDate],
    enabled: canViewVoucher && !!fromDate && !!toDate,
    queryFn: () =>
      api<{ rows: VoucherRow[]; total: number }>(
        `/api/vouchers?state=draft&from=${fromDate}&to=${toDate}&size=5`,
      ),
  });

  // Danh mục menu Lập chứng từ nhanh
  const voucherCreateItems = [
    { key: 'PT', label: 'Phiếu thu', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'PT', id: 'moi' } }) },
    { key: 'PC', label: 'Phiếu chi', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'PC', id: 'moi' } }) },
    { key: 'BC', label: 'Giấy báo Có', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'BC', id: 'moi' } }) },
    { key: 'BN', label: 'Giấy báo Nợ', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'BN', id: 'moi' } }) },
    { key: 'PKT', label: 'Phiếu kế toán', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'PKT', id: 'moi' } }) },
    { key: 'BH', label: 'Bán hàng hóa', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'BH', id: 'moi' } }) },
    { key: 'MH', label: 'Mua hàng hóa', onClick: () => void navigate({ to: '/chung-tu/$type/$id', params: { type: 'MH', id: 'moi' } }) },
  ];

  const chartLabels = overview.data?.months.map((m) => `T${m.month}`) ?? [];

  const statItems = useMemo(() => {
    if (!overview.data) return [];
    const s = overview.data.summary;
    return [
      { label: 'Tiền cuối tháng', value: money(s.cash), testId: 'stat-cash' },
      { label: 'Phải thu', value: money(s.receivable), testId: 'stat-receivable' },
      { label: 'Phải trả', value: money(s.payable), testId: 'stat-payable' },
      { label: 'Doanh thu lũy kế', value: money(s.revenue), testId: 'stat-revenue' },
      { label: 'Lợi nhuận lũy kế', value: money(s.profit), testId: 'stat-profit' },
    ];
  }, [overview.data]);

  const hasFiscalYears = !!years.data?.length;

  return (
    <div>
      <PageHeader
        title="Tổng quan"
        description={year !== undefined ? `Năm tài chính ${year} · số liệu đến hết tháng ${month}` : undefined}
        extra={
          canCreateVoucher ? (
            <Dropdown menu={{ items: voucherCreateItems }} placement="bottomRight">
              <Button type="primary" icon={<FileAddOutlined />}>
                Lập chứng từ <DownOutlined style={{ fontSize: 10 }} />
              </Button>
            </Dropdown>
          ) : undefined
        }
      >
        <Toolbar>
          <Select
            aria-label="Năm tài chính"
            value={year ?? null}
            onChange={handleYearChange}
            style={{ width: 130 }}
            options={(years.data ?? []).map((y) => ({
              value: y.fiscalYear,
              label: `Năm ${y.fiscalYear}`,
            }))}
          />
          <Select
            aria-label="Đến tháng"
            value={month}
            onChange={setMonth}
            style={{ width: 130 }}
            options={Array.from({ length: 12 }, (_, i) => ({
              value: i + 1,
              label: `Đến tháng ${i + 1}`,
            }))}
          />
        </Toolbar>
      </PageHeader>

      {years.error && (
        <Alert type="error" showIcon message={(years.error as Error).message} style={{ marginBottom: 16 }} />
      )}
      {overview.error && (
        <Alert type="error" showIcon message={(overview.error as Error).message} style={{ marginBottom: 16 }} />
      )}

      {!hasFiscalYears && !years.isLoading ? (
        <Section testId="empty-fiscal-year">
          <EmptyState
            title="Chưa có năm tài chính"
            description="Vui lòng thiết lập năm tài chính để bắt đầu ghi sổ kế toán và xem số liệu tổng quan."
            action={
              <Button type="primary" onClick={() => void navigate({ to: '/so-cai/ky-ke-toan' })}>
                Tạo năm tài chính
              </Button>
            }
          />
        </Section>
      ) : (
        <>
          {/* Hàng số liệu nhanh */}
          {hasReportPermission && statItems.length > 0 && <StatStrip items={statItems} />}

          {/* Lưới 3 cột: biểu đồ 2 cột (theo quyền report.view), việc cần làm 1 cột */}
          <Row gutter={[16, 16]}>
            {hasReportPermission && (
              <Col xs={24} xl={16}>
                <Section title="Doanh thu, chi phí theo tháng" loading={overview.isLoading}>
                  {overview.data && (
                    <Chart
                      testId="chart-dashboard"
                      kind="bar"
                      title="Doanh thu, chi phí theo tháng (đồng)"
                      labels={chartLabels}
                      series={[
                        { name: 'Doanh thu', values: overview.data.months.map((m) => toChartNumber(m.revenue)) },
                        { name: 'Chi phí', values: overview.data.months.map((m) => toChartNumber(m.expense)) },
                      ]}
                    />
                  )}
                </Section>
              </Col>
            )}

            <Col xs={24} xl={hasReportPermission ? 8 : 24}>
              <Section
                title="Việc cần làm"
                loading={approvalsCount.isLoading || (canViewVoucher && drafts.isLoading)}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Dòng Chờ duyệt */}
                  {canApprove && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 0',
                        borderBottom: `1px solid ${COLOR.border}`,
                      }}
                    >
                      <span>Chờ duyệt</span>
                      <Link to="/phe-duyet">
                        <strong>{approvalsCount.data?.count ?? 0}</strong>
                      </Link>
                    </div>
                  )}

                  {/* Dòng Chứng từ nháp (chỉ hiện khi có quyền voucher.view) */}
                  {canViewVoucher && (
                    <div>
                      {drafts.error ? (
                        <Alert
                          type="error"
                          showIcon
                          message={(drafts.error as Error).message}
                          style={{ marginTop: 8 }}
                        />
                      ) : (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '6px 0',
                              borderBottom: drafts.data?.rows?.length ? `1px solid ${COLOR.border}` : 'none',
                            }}
                          >
                            <span>Chứng từ nháp trong tháng</span>
                            <strong>{drafts.data?.total ?? 0}</strong>
                          </div>

                          {/* Danh sách tối đa 5 chứng từ nháp */}
                          {drafts.data?.rows && drafts.data.rows.length > 0 ? (
                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {drafts.data.rows.map((v) => (
                                <div
                                  key={v.id}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    fontSize: 12,
                                    padding: '4px 0',
                                  }}
                                >
                                  <div style={{ minWidth: 0, flex: 1, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    <Link
                                      to="/chung-tu/$type/$id"
                                      params={{ type: v.voucherType, id: v.id }}
                                      style={{ fontWeight: 500 }}
                                    >
                                      {v.voucherType} {v.voucherNo ?? '(nháp)'}
                                    </Link>
                                    <span style={{ color: COLOR.textSecondary, marginLeft: 8 }}>
                                      {formatVnDate(v.postingDate)}
                                    </span>
                                    {v.description && (
                                      <span style={{ color: COLOR.textSecondary, marginLeft: 8 }}>
                                        · {v.description}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {(drafts.data?.total ?? 0) > 5 && (
                                <div style={{ fontSize: 12, color: COLOR.textSecondary, marginTop: 4 }}>
                                  Còn {(drafts.data?.total ?? 0) - 5} chứng từ nháp khác
                                </div>
                              )}
                            </div>
                          ) : !drafts.isLoading ? (
                            <div style={{ fontSize: 13, color: COLOR.textSecondary, marginTop: 8 }}>
                              Không có chứng từ nháp trong tháng.
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </Section>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
