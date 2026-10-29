import { useMemo, useState } from 'react';
import { Alert, Button, Select, Tabs, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import { formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, useRememberedFilter } from '@kt/ui';
import { NoFiscalYearNotice } from './NoFiscalYearNotice.js';
import { api, type ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { costObjectPick } from '../lookups.js';

// Báo cáo giá thành (GĐ6 Task 12): thẻ tính giá thành, sổ chi tiết TK 154 theo đối tượng, tổng hợp chi phí sản xuất theo khoản mục, so sánh định mức NVL.
// Số liệu do API /api/costing/reports/* tính (cột kèm theo, quyền cost_run.view và cờ view_cost) và kèm bảng đối chiếu với sổ cái / chứng từ giá thành.
type Row = Record<string, unknown>;
type TabKey = 'card' | 'ledger-154' | 'expense-summary' | 'norm-compare';
interface Col { key: string; label: string; type?: 'text' | 'number' | 'date'; width?: string; scale?: number }
interface Recon { ok: boolean; items: { label: string; report: string; ledger: string; diff: string; info?: boolean }[] }
interface Report { title: string; subtitle: string; columns: Col[]; rows: Row[]; footer?: Row; intro: string[]; reconciliation: Recon; stale?: boolean }
interface FiscalYear { fiscalYear: number; dateFrom: string; dateTo: string }

const TABS: { key: TabKey; label: string }[] = [{ key: 'card', label: 'Thẻ tính giá thành' }, { key: 'ledger-154', label: 'Sổ chi tiết TK 154' },
  { key: 'expense-summary', label: 'Tổng hợp chi phí theo khoản mục' }, { key: 'norm-compare', label: 'So sánh định mức NVL' }];
const fmt = (v: unknown, scale = 0) => (typeof v === 'string' && v !== '' && !/^-?0+(\.0+)?$/.test(v) ? formatVnNumber(v, scale) : '');
const bold: Pick<ColDef<Row>, 'cellStyle'> = { cellStyle: (p) => (p.data?.['isBold'] ? { fontWeight: 600 } : undefined) };
const toColDef = (c: Col): ColDef<Row> => c.type === 'number' ? { field: c.key, headerName: c.label, width: c.scale ? 130 : 140, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header', valueFormatter: (p) => fmt(p.value, c.scale ?? 0), ...bold }
  : c.type === 'date' ? { field: c.key, headerName: c.label, width: 115, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : ''), ...bold }
    : c.key === 'label' || c.key === 'description' ? { field: c.key, headerName: c.label, flex: 1, minWidth: 280, ...bold, cellStyle: (p) => ({ whiteSpace: 'pre', ...(p.data?.['isBold'] ? { fontWeight: 600 } : {}) }) }
      : { field: c.key, headerName: c.label, width: c.key === 'uom' ? 80 : 130, ...bold };

function ReconAlert({ r }: { r: Recon }) {
  if (!r.items.length) return <Alert type="info" showIcon data-testid="recon" message="Chưa có số liệu để đối chiếu với sổ cái hoặc chứng từ giá thành." />;
  return (
    <Alert type={r.ok ? 'success' : 'error'} showIcon data-testid="recon" message={r.ok ? 'Số liệu khớp sổ cái, chứng từ giá thành' : 'Số liệu lệch: kiểm tra chi phí đã đổi sau khi chạy giá thành hoặc chứng từ chưa ghi sổ'}
      description={<ul style={{ margin: 0, paddingLeft: 18 }}>{r.items.map((i) => (
        <li key={i.label}>{i.label}: báo cáo {formatVnNumber(i.report, 0)}, đối chiếu {formatVnNumber(i.ledger, 0)}
          {i.diff !== '0' && <Tag color={i.info ? 'orange' : 'red'} style={{ marginLeft: 6 }}>{i.info ? 'tham khảo, ' : ''}lệch {formatVnNumber(i.diff, 0)}</Tag>}</li>))}</ul>} />
  );
}

export default function CostReportsPage() {
  const { me, can } = useAuth();
  const [tab, setTab] = useState<TabKey>('card');
  const today = todayVn();
  const [f, setF] = useRememberedFilter('cost-reports', { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)), toMonth: 0, objectId: 0 }, `${me?.tenantId}:${me?.userId}`);
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const noYear = years.isSuccess && years.data.length === 0; // công ty chưa có năm tài chính: không có kỳ để chọn
  const url = useMemo(() => {
    const p = new URLSearchParams({ year: String(f.year), month: String(f.month) });
    if (f.objectId) p.set('objectId', String(f.objectId));
    if (tab === 'expense-summary' && f.toMonth && f.toMonth > f.month) p.set('toMonth', String(f.toMonth));
    return `/api/costing/reports/${tab}?${p}`;
  }, [tab, f]);
  const data = useQuery({ queryKey: ['cost-report', url], queryFn: () => api<Report>(url), retry: false });
  const columns = useMemo(() => (data.data?.columns ?? []).map(toColDef), [data.data]);
  const open = (format: 'html' | 'xlsx') => window.open(`${url}&format=${format}`, '_blank');

  const desc = 'Thẻ tính giá thành, sổ chi tiết TK 154 theo đối tượng, tổng hợp chi phí sản xuất theo khoản mục và so sánh định mức nguyên vật liệu';
  if (!me?.sensitive.includes('view_cost')) {
    return (
      <>
        <PageHeader title="Báo cáo giá thành" description={desc} />
        <Alert type="warning" showIcon message="Báo cáo giá thành là dữ liệu giá vốn: tài khoản của bạn chưa được cấp quyền xem giá vốn." />
      </>
    );
  }
  const d = data.data; const err = data.error as ApiError | null;
  const months = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }));
  return (
    <>
      <PageHeader
        title="Báo cáo giá thành"
        description={desc}
        extra={<>
          <Button onClick={() => open('html')} disabled={!d}>In</Button>
          {can('report.print') && <Button onClick={() => open('xlsx')} disabled={!d}>Xuất Excel</Button>}
        </>}
      >
        <Toolbar>
          <Select<number> aria-label="Năm tài chính" style={{ width: 120 }} value={f.year} onChange={(year) => setF({ ...f, year })}
            options={[...new Set([...(years.data ?? []).map((y) => y.fiscalYear), f.year])].sort().map((y) => ({ value: y, label: `Năm ${y}` }))} />
          <Select<number> aria-label="Kỳ" style={{ width: 110 }} value={f.month} virtual={false} onChange={(month) => setF({ ...f, month, toMonth: Math.max(f.toMonth, month) })} options={months} />
          {tab === 'expense-summary' && <Select<number> aria-label="Đến tháng" style={{ width: 130 }} value={f.toMonth > f.month ? f.toMonth : f.month} virtual={false} onChange={(toMonth) => setF({ ...f, toMonth })} options={months.filter((m) => m.value >= f.month)} />}
          <LookupSelect catalog="cost_object" fetcher={costObjectPick} valueField="id" value={f.objectId ? String(f.objectId) : null} style={{ width: 280 }} placeholder="Mọi đối tượng (F4)" aria-label="Đối tượng tập hợp chi phí"
            onChange={(id) => setF({ ...f, objectId: id ? Number(id) : 0 })} />
        </Toolbar>
      </PageHeader>
      {noYear ? <NoFiscalYearNotice purpose="xem báo cáo giá thành" /> : (<>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={TABS.map((t) => ({ key: t.key, label: t.label }))} style={{ marginBottom: 12 }} />
      {err ? <Alert type={err.status === 404 ? 'info' : 'error'} showIcon message={err.status === 404 && tab !== 'ledger-154' ? `Kỳ ${String(f.month).padStart(2, '0')}/${f.year} chưa chạy giá thành: chạy ở màn Tính giá thành trước khi xem báo cáo này.` : err.message} style={{ marginBottom: 12 }} />
        : !d ? <Alert type="info" message="Đang tải…" style={{ marginBottom: 12 }} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tab === 'card' && <Alert type="info" showIcon message="Thẻ tính giá thành theo mẫu nội bộ; chưa in số mẫu S37-DN vì chưa đối chiếu với văn bản gốc." />}
            {d.stale && <Alert type="warning" showIcon message="Lần chạy giá thành của kỳ cần chạy lại" description="Chi phí, dở dang đầu kỳ hoặc phiếu nhập kho đã đổi sau lần chạy; số liệu thẻ là kết quả đã lưu." />}
            {d.intro.map((t) => <Alert key={t} type="warning" showIcon message={t} />)}
            <ReconAlert r={d.reconciliation} />
            <KeyboardGrid<Row> rows={d.rows} columns={columns} onRowsChange={() => undefined} addRowTemplate={() => ({})} readOnly lockRows animateRows={false} height="calc(100vh - 420px)"
              {...(d.footer ? { pinnedBottomRows: [{ ...d.footer, isBold: true }] } : {})} />
          </div>
        )}
      </>)}
    </>
  );
}
