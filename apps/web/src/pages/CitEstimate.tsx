import { useState, type KeyboardEvent } from 'react';
import { Alert, Button, Input, InputNumber, Select, Space, Table, Typography, message } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { formatVnNumber } from '@kt/domain';
import { VnNumberInput, useHotkeys, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Tạm tính thuế TNDN quý: lợi nhuận lũy kế lấy từ B02, thuế suất theo doanh thu năm trước (legal_param cit_rate, cit_exempt_revenue), trừ số đã tạm nộp (Nợ 3334 đối ứng tiền).
// Ô nhập chỉ áp dụng khi bấm Tính (F9): gõ từng phím không gọi máy chủ.
interface Estimate {
  year: number; quarter: number; regime: string; period: { from: string; to: string }; ytdProfit: string; revenueYtd: string; profitSource: string;
  prevRevenue: string | null; prevRevenueSource: 'manual' | 'ledger' | null; prevRevenueNote: string | null; rate: string | null; rateBasis: string | null; exempt: boolean;
  adjustments: string; lossCarried: string; paidYtd: string; paidWindow: { from: string; to: string } | null; taxableIncome: string | null; taxYtd: string | null; payable: string | null; accruedYtd: string; expenseToAccrue: string | null;
  accounts: { expense: string; payable: string }; warnings: string[];
}
interface Inputs { prevRevenue: string | null; rate: string; adjustments: string | null; lossCarried: string | null; paidYtd: string | null }
interface Voucher { id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string }
const EMPTY: Inputs = { prevRevenue: null, rate: '', adjustments: null, lossCarried: null, paidYtd: null };

const money = (v: string | null | undefined) => (v === null || v === undefined ? '' : formatVnNumber(v));
const vnDate = (d: string) => dayjs(d).format('DD/MM/YYYY');

export default function CitEstimatePage() {
  const { me, can } = useAuth();
  const now = dayjs();
  const [f, setF] = useRememberedFilter('cit-estimate', { year: now.year(), quarter: Math.floor(now.month() / 3) + 1 }, `${me?.tenantId}:${me?.userId}`);
  const [draft, setDraft] = useState<Inputs>(EMPTY);
  const [applied, setApplied] = useState<Inputs>(EMPTY);
  const [created, setCreated] = useState<Voucher | null>(null);
  const qs = new URLSearchParams({ year: String(f.year), quarter: String(f.quarter) });
  if (applied.prevRevenue) qs.set('prevRevenue', applied.prevRevenue);
  if (applied.rate.trim()) qs.set('rate', applied.rate.trim());
  if (applied.adjustments) qs.set('adjustments', applied.adjustments);
  if (applied.lossCarried) qs.set('lossCarried', applied.lossCarried);
  if (applied.paidYtd) qs.set('paidYtd', applied.paidYtd);
  const est = useQuery({ queryKey: ['cit-estimate', qs.toString()], queryFn: () => api<Estimate>(`/api/cit/estimate?${qs}`), retry: false });
  const e = est.data;

  const apply = () => { setCreated(null); setApplied(draft); };
  const setPeriod = (next: Partial<typeof f>) => { setCreated(null); setF({ ...f, ...next }); };
  useHotkeys({ F9: apply });
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!(ev.target instanceof HTMLInputElement)) return;
    if (ev.key === 'F9') { ev.preventDefault(); apply(); }
    else if (ev.key === 'Enter' && ev.target.dataset.citEdit) { // Enter sang ô kế tiếp; ô cuối thì tính
      const inputs = [...document.querySelectorAll<HTMLInputElement>('input[data-cit-edit]')]; const i = inputs.indexOf(ev.target);
      ev.preventDefault(); if (i >= 0 && i < inputs.length - 1) inputs[i + 1]!.focus(); else apply();
    }
  };

  const voucher = useMutation({ mutationFn: () => api<Voucher>('/api/cit/estimate/voucher', { method: 'POST', json: { year: f.year, quarter: f.quarter, amount: e!.expenseToAccrue } }),
    onError: (err) => { void message.error((err as Error).message); }, onSuccess: (v) => { setCreated(v); void message.success('Đã lập chứng từ nghiệp vụ khác (nháp)'); } });

  const rows: { key: string; label: string; value: string; note?: string; strong?: boolean }[] = e ? [
    { key: 'profit', label: 'Lợi nhuận kế toán trước thuế lũy kế', value: money(e.ytdProfit), note: e.profitSource },
    { key: 'adj', label: 'Điều chỉnh tăng (+) / giảm (−) lợi nhuận', value: money(e.adjustments) },
    { key: 'loss', label: 'Lỗ được chuyển', value: money(e.lossCarried) },
    { key: 'taxable', label: 'Thu nhập tính thuế lũy kế', value: money(e.taxableIncome) },
    { key: 'prev', label: 'Doanh thu năm trước', value: e.prevRevenue === null ? 'Chưa có' : money(e.prevRevenue), note: e.prevRevenueSource === 'manual' ? 'Nhập tay' : (e.prevRevenueNote ?? '') },
    { key: 'rate', label: 'Thuế suất (%)', value: e.rate === null ? 'Chưa xác định' : e.rate, note: e.exempt ? `Miễn thuế. ${e.rateBasis ?? ''}` : (e.rateBasis ?? '') },
    { key: 'tax', label: 'Thuế TNDN lũy kế', value: money(e.taxYtd) },
    { key: 'paid', label: 'Đã tạm nộp các quý trước', value: money(e.paidYtd), note: applied.paidYtd ? 'Nhập tay' : e.paidWindow ? `Nợ TK ${e.accounts.payable} đối ứng tiền, ${vnDate(e.paidWindow.from)} – ${vnDate(e.paidWindow.to)}` : 'Quý 1: chưa có khoản tạm nộp của năm' },
    { key: 'payable', label: `Số tạm nộp quý ${e.quarter}`, value: money(e.payable), strong: true },
    { key: 'accrued', label: 'Chi phí thuế TNDN đã hạch toán từ đầu năm', value: money(e.accruedYtd), note: `B02 chỉ tiêu 51 (TK ${e.accounts.expense})` },
    { key: 'accrue', label: 'Chi phí thuế TNDN cần ghi thêm', value: money(e.expenseToAccrue), note: 'Thuế TNDN lũy kế trừ chi phí thuế đã hạch toán', strong: true },
  ] : [];
  const canVoucher = !!e?.expenseToAccrue && e.expenseToAccrue !== '0' && can('cit.create') && can('voucher.create');

  return (
    <div onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 960 }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Tạm tính thuế TNDN quý</h2>
        <InputNumber aria-label="Năm" min={2000} max={2100} precision={0} value={f.year} onChange={(v) => v && setPeriod({ year: v })} style={{ width: 90 }} />
        <Select aria-label="Quý" style={{ width: 100 }} value={f.quarter} onChange={(v) => setPeriod({ quarter: v })} options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Quý ${q}` }))} />
      </Space>

      <Space wrap align="end">
        <label>Doanh thu năm trước<br /><VnNumberInput aria-label="Doanh thu năm trước" data-cit-edit="1" placeholder="Theo sổ" style={{ width: 170 }} value={draft.prevRevenue} onChange={(v) => setDraft({ ...draft, prevRevenue: v })} /></label>
        <label>Thuế suất (%)<br /><Input aria-label="Thuế suất" data-cit-edit="1" placeholder="Theo luật" style={{ width: 110, textAlign: 'right' }} inputMode="decimal" value={draft.rate} onChange={(ev) => setDraft({ ...draft, rate: ev.target.value })} /></label>
        <label>Điều chỉnh<br /><VnNumberInput aria-label="Điều chỉnh" data-cit-edit="1" style={{ width: 170 }} value={draft.adjustments} onChange={(v) => setDraft({ ...draft, adjustments: v })} /></label>
        <label>Lỗ được chuyển<br /><VnNumberInput aria-label="Lỗ được chuyển" data-cit-edit="1" style={{ width: 170 }} value={draft.lossCarried} onChange={(v) => setDraft({ ...draft, lossCarried: v })} /></label>
        <label>Đã tạm nộp<br /><VnNumberInput aria-label="Đã tạm nộp" data-cit-edit="1" placeholder="Theo sổ" style={{ width: 170 }} value={draft.paidYtd} onChange={(v) => setDraft({ ...draft, paidYtd: v })} /></label>
        <Button type="primary" loading={est.isFetching} onClick={apply}>Tính (F9)</Button>
      </Space>

      {est.error && <Alert type="error" showIcon message={(est.error as Error).message} />}
      {e && e.warnings.length > 0 && <Alert type="warning" showIcon message="Lưu ý" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{e.warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />}

      {e && (
        <Table size="small" bordered pagination={false} rowKey="key" dataSource={rows} columns={[
          { title: 'Chỉ tiêu', render: (_: unknown, r) => (r.strong ? <b>{r.label}</b> : r.label) },
          { title: 'Số tiền (VND)', width: 200, align: 'right', render: (_: unknown, r) => <span data-testid={`cit-${r.key}`} style={{ fontVariantNumeric: 'tabular-nums', fontWeight: r.strong ? 600 : undefined }}>{r.value}</span> },
          { title: 'Nguồn', render: (_: unknown, r) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.note}</Typography.Text> },
        ]} />)}

      {e && (
        <Space wrap>
          {can('cit.create') && <Button disabled={!canVoucher} loading={voucher.isPending} onClick={() => voucher.mutate()}>Lập chứng từ chi phí thuế TNDN</Button>}
          <Typography.Text type="secondary">Nợ TK {e.accounts.expense} / Có TK {e.accounts.payable}, ngày {vnDate(e.period.to)}, chứng từ nháp để kiểm tra trước khi ghi sổ.</Typography.Text>
        </Space>)}
      {created && <Alert type="success" showIcon message={<span>Đã lập phiếu kế toán nháp <Link to="/chung-tu/$type/$id" params={{ type: created.voucherType, id: created.id }}>{created.voucherNo ?? 'mở chứng từ'}</Link> ngày {vnDate(created.postingDate)}.</span>} />}
    </div>
  );
}
