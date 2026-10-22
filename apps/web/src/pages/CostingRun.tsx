import { useState } from 'react';
import { Alert, Button, Select, Space, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { LookupSelect, useHotkeys } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { fetchVoucherNos } from './settleCommon.js';

interface FiscalYear { fiscalYear: number; dateFrom: string; dateTo: string; periods: { periodNo: number; dateFrom: string; dateTo: string }[] }
interface CostingError { moveId: string; code: string; detail: string }
interface RunResult { runId: string; voucherIds: string[]; unchanged: boolean; summary: { items: number; moves: number; delta: string | null; errors: CostingError[] } }
interface RunRow { id: string; periodFrom: string; periodTo: string; method: string; warehouseCode: string | null; itemCode: string | null; createdAt: string; createdBy: string | null;
  voucherNos: string[]; items: number; moves: number; errors: number; unchanged: boolean; delta: string | null }
interface Assignment { moveId: number; postingDate: string; voucherId: string; voucherType: string; voucherNo: string | null; itemCode: string; itemName: string; warehouseCode: string;
  direction: string; quantity: string; unitCost: string; amount: string; booked: string; delta: string; gvNo: string | null; isCurrent: boolean }
interface StaleRow { itemCode: string; itemName: string; warehouseCode: string; warehouseName: string; staleFrom: string }

export const METHOD_LABEL: Record<string, string> = { warehouse: 'Theo kho', avg_period: 'Bình quân cuối kỳ', avg_moving: 'Bình quân tức thời', fifo: 'Nhập trước, xuất trước', specific: 'Đích danh' };
const money = (s: string | null) => (s === null ? '' : formatVnNumber(s, 0));
const ERROR_LABEL: Record<string, string> = { COSTING_NEGATIVE_STOCK: 'Xuất quá tồn', COSTING_RECEIPT_PRICE_MISSING: 'Nhập thành phẩm chưa có giá' };

export default function CostingRunPage() {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const seeCost = !!me?.sensitive.includes('view_cost');
  const today = todayVn();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const runs = useQuery({ queryKey: ['costing-runs'], queryFn: () => api<RunRow[]>('/api/inventory/costing-runs') });
  const stale = useQuery({ queryKey: ['costing-status'], queryFn: () => api<StaleRow[]>('/api/inventory/costing-status') });
  const fy = years.data ?? [];
  const cur = fy.find((y) => y.dateFrom <= today && today <= y.dateTo) ?? fy.at(-1);

  const [yearNo, setYearNo] = useState<number | null>(null);
  const year = fy.find((y) => y.fiscalYear === yearNo) ?? cur;
  const periods = (year?.periods ?? []).filter((p) => p.periodNo > 0);
  const curNo = periods.find((p) => p.dateFrom <= today && today <= p.dateTo)?.periodNo ?? periods[0]?.periodNo ?? null;
  const [fromNo, setFromNo] = useState<number | null>(null); const [toNo, setToNo] = useState<number | null>(null);
  const pFrom = periods.find((p) => p.periodNo === (fromNo ?? curNo)); const pTo = periods.find((p) => p.periodNo === (toNo ?? fromNo ?? curNo));
  const [warehouseCode, setWarehouseCode] = useState<string | null>(null); const [itemCode, setItemCode] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('warehouse');
  const [selected, setSelected] = useState<string | null>(null);
  const [out, setOut] = useState<{ r: RunResult; nos: string[] } | null>(null); const [err, setErr] = useState<string | null>(null);

  const ready = !!pFrom && !!pTo && pFrom.dateFrom <= pTo.dateTo;
  const run = useMutation({
    mutationFn: () => api<RunResult>('/api/inventory/costing-runs', { method: 'POST', json: { periodFrom: pFrom!.dateFrom, periodTo: pTo!.dateTo,
      ...(warehouseCode ? { warehouseCode } : {}), ...(itemCode ? { itemCode } : {}), ...(method !== 'warehouse' ? { method } : {}) } }),
    onMutate: () => { setErr(null); setOut(null); },
    onError: (e) => setErr((e as Error).message),
    onSuccess: async (r) => {
      setOut({ r, nos: await fetchVoucherNos(r.voucherIds) }); if (!r.unchanged) setSelected(r.runId); // không đổi: giữ bảng gán giá đang hiện hành
      void qc.invalidateQueries({ queryKey: ['costing-runs'] }); void qc.invalidateQueries({ queryKey: ['costing-status'] });
    },
  });
  const start = () => { if (ready && !run.isPending && can('costing.run')) run.mutate(); };
  useHotkeys({ F9: start });

  const shownId = selected ?? (runs.data?.find((r) => !r.unchanged) ?? runs.data?.[0])?.id ?? null;
  const detail = useQuery({ queryKey: ['costing-run', shownId], enabled: !!shownId && seeCost,
    queryFn: () => api<{ assignments: Assignment[] }>(`/api/inventory/costing-runs/${shownId}`) });
  const shownRun = runs.data?.find((r) => r.id === shownId);
  const periodOpt = periods.map((p) => ({ value: p.periodNo, label: `Kỳ ${p.periodNo} (${formatVnDate(p.dateFrom).slice(0, 5)} - ${formatVnDate(p.dateTo).slice(0, 5)})` }));
  const staleFrom = stale.data?.[0]?.staleFrom;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <h2 style={{ margin: 0 }}>Tính giá vốn</h2>
      <span>Tính giá xuất kho thực tế theo phương pháp của từng kho (bình quân cuối kỳ, bình quân tức thời, nhập trước xuất trước, đích danh). Phần chênh so với giá tạm tính đã ghi ở phiếu xuất được ghi bằng một Chứng từ giá vốn (GV) ngày cuối kỳ; tính lại thì đảo chứng từ cũ và sinh chứng từ mới.</span>
      {staleFrom && (
        <Alert type="warning" showIcon message={`Giá vốn chưa cập nhật từ ngày ${formatVnDate(staleFrom)}`}
          description={<span>{stale.data!.slice(0, 8).map((s) => `${s.itemCode} – kho ${s.warehouseCode} (từ ${formatVnDate(s.staleFrom)})`).join('; ')}{stale.data!.length > 8 ? `; và ${stale.data!.length - 8} cặp hàng – kho khác` : ''}. Hãy tính lại giá vốn từ kỳ đó.</span>} />
      )}
      {can('costing.run') && (
        <Space wrap align="end">
          <Select<number> aria-label="Năm tài chính" style={{ width: 130 }} value={year?.fiscalYear ?? null} options={fy.map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }))}
            onChange={(v) => { setYearNo(v); setFromNo(null); setToNo(null); }} />
          <Select<number> aria-label="Từ kỳ" style={{ width: 190 }} virtual={false} value={pFrom?.periodNo ?? null} options={periodOpt} onChange={(v) => { setFromNo(v); if ((toNo ?? 0) < v) setToNo(v); }} />
          <Select<number> aria-label="Đến kỳ" style={{ width: 190 }} virtual={false} value={pTo?.periodNo ?? null} options={periodOpt.filter((o) => o.value >= (pFrom?.periodNo ?? 0))} onChange={setToNo} />
          <div style={{ width: 200 }}><LookupSelect catalog="warehouse" includeInactive value={warehouseCode} onChange={(c) => setWarehouseCode(c || null)} allowClear placeholder="Tất cả kho" aria-label="Kho" /></div>
          <div style={{ width: 220 }}><LookupSelect catalog="item" includeInactive value={itemCode} onChange={(c) => setItemCode(c || null)} allowClear placeholder="Tất cả hàng" aria-label="Hàng" /></div>
          <Select<string> aria-label="Phương pháp" style={{ width: 240 }} value={method} onChange={setMethod}
            options={Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label: value === 'warehouse' ? 'Theo phương pháp của kho' : label }))} />
          <Button type="primary" disabled={!ready} loading={run.isPending} onClick={start}>Tính giá vốn (F9)</Button>
        </Space>
      )}
      {err && <Alert type="error" showIcon message={err} />}
      {out && (out.r.unchanged
        ? <Alert type="info" showIcon message={`Giá vốn không đổi (${out.r.summary.items} cặp hàng – kho, ${out.r.summary.moves} phát sinh): không sinh chứng từ`} />
        : <Alert type="success" showIcon message={`Đã tính giá vốn ${out.r.summary.items} cặp hàng – kho, ${out.r.summary.moves} phát sinh${out.r.summary.delta !== null ? `, chênh lệch ${money(out.r.summary.delta)}` : ''}`}
          description={out.r.voucherIds.length ? <span>Chứng từ giá vốn: {out.r.voucherIds.map((id, i) => <span key={id}>{i > 0 && ', '}<a href={`/chung-tu/GV/${id}`} target="_blank" rel="noopener noreferrer">{out.nos[i] ?? id}</a></span>)}</span> : 'Giá thực tế bằng giá tạm tính: không cần chứng từ giá vốn'} />)}
      {!!out?.r.summary.errors.length && <Alert type="warning" showIcon message={`${out.r.summary.errors.length} cảnh báo khi tính giá vốn`}
        description={<ul style={{ margin: 0, paddingLeft: 18 }}>{out.r.summary.errors.slice(0, 20).map((e) => <li key={`${e.code}${e.moveId}`}>{ERROR_LABEL[e.code] ?? e.code}: {e.detail}</li>)}</ul>} />}

      <b>Kết quả gán giá{shownRun ? ` – lần chạy ${formatVnDate(shownRun.periodFrom)} – ${formatVnDate(shownRun.periodTo)}` : ''}</b>
      {!seeCost ? <Alert type="info" showIcon message="Không có quyền xem giá vốn: không xem được kết quả gán giá" />
        : <Table<Assignment> size="small" rowKey="moveId" loading={detail.isLoading} dataSource={detail.data?.assignments ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: shownId ? 'Lần chạy này không gán giá mới' : 'Chưa tính giá vốn lần nào' }} scroll={{ x: 1340 }}
          columns={[
            { title: 'Ngày', dataIndex: 'postingDate', width: 100, render: formatVnDate },
            { title: 'Chứng từ', width: 130, render: (_, a) => <a href={`/chung-tu/${a.voucherType}/${a.voucherId}`} target="_blank" rel="noopener noreferrer">{a.voucherNo ?? a.voucherType}</a> },
            { title: 'Hàng', width: 240, render: (_, a) => `${a.itemCode} – ${a.itemName}`, ellipsis: true },
            { title: 'Kho', dataIndex: 'warehouseCode', width: 100 },
            { title: 'Chiều', width: 70, render: (_, a) => (a.direction === 'out' ? 'Xuất' : 'Nhập') },
            { title: 'Số lượng', dataIndex: 'quantity', align: 'right', width: 110, render: (v: string) => formatVnNumber(v, 4) },
            { title: 'Đơn giá vốn', dataIndex: 'unitCost', align: 'right', width: 120, render: (v: string) => formatVnNumber(v, 4) },
            { title: 'Giá tạm tính', dataIndex: 'booked', align: 'right', width: 130, render: money },
            { title: 'Giá vốn', dataIndex: 'amount', align: 'right', width: 130, render: money },
            { title: 'Chênh lệch', dataIndex: 'delta', align: 'right', width: 120, render: money },
            { title: 'Chứng từ GV', dataIndex: 'gvNo', width: 120, render: (v: string | null, a) => (v ?? '') + (a.isCurrent ? '' : ' (đã thay)') },
          ]} />}

      <b>Nhật ký lần chạy</b>
      {runs.error && <Alert type="error" showIcon message={(runs.error as Error).message} />}
      <Table<RunRow> size="small" rowKey="id" loading={runs.isLoading} dataSource={runs.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa tính giá vốn lần nào' }}
        scroll={{ x: 1000 }} onRow={(r) => ({ onClick: () => setSelected(r.id), style: { cursor: 'pointer', ...(r.id === shownId ? { background: 'var(--ant-color-primary-bg, #e6f4ff)' } : {}) } })}
        columns={[
          { title: 'Lúc chạy', dataIndex: 'createdAt', width: 150, render: (v: string) => new Date(v).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) },
          { title: 'Kỳ', width: 210, render: (_, r) => `${formatVnDate(r.periodFrom)} – ${formatVnDate(r.periodTo)}` },
          { title: 'Kho', dataIndex: 'warehouseCode', width: 100, render: (v: string | null) => v ?? 'Tất cả' },
          { title: 'Hàng', dataIndex: 'itemCode', width: 110, render: (v: string | null) => v ?? 'Tất cả' },
          { title: 'Phương pháp', dataIndex: 'method', width: 160, render: (v: string) => METHOD_LABEL[v] ?? v },
          { title: 'Cặp hàng – kho', dataIndex: 'items', align: 'right', width: 110 },
          { title: 'Chênh lệch', dataIndex: 'delta', align: 'right', width: 120, render: money },
          { title: 'Chứng từ GV', dataIndex: 'voucherNos', render: (v: string[]) => v.join(', ') },
          { title: 'Kết quả', width: 140, render: (_, r) => <Space size={4}>{r.unchanged ? <Tag>Không đổi</Tag> : <Tag color="green">Đã điều chỉnh</Tag>}{r.errors > 0 && <Tag color="orange">{r.errors} cảnh báo</Tag>}</Space> },
          { title: 'Người chạy', dataIndex: 'createdBy', width: 140, render: (v: string | null) => v ?? '' },
        ]} />
    </Space>
  );
}
