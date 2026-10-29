import { useState } from 'react';
import { Alert, Button, DatePicker, Select, Space, Table, Tabs, message, theme } from 'antd';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { COLOR, KeyboardGrid, PageHeader, Section, Toolbar, VnNumberInput } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { regimeFor } from '../lookups.js';
import { fetchVoucherNos } from './settleCommon.js';

interface FiscalYear { fiscalYear: number; regime: string; dateFrom: string; dateTo: string; periods: { periodNo: number; dateFrom: string; dateTo: string; status: string }[] }
interface FxRun { id: number; kind: 'outflow' | 'revaluation'; fiscalYear: number; periodNo: number; runDate: string; voucherIds: string[]; voucherNos: string[]; reversedVoucherIds: string[]; reversedVoucherNos: string[]; createdAt: string }
interface OutflowResult { runId: number; voucherIds: string[]; reversedVoucherIds: string[]; unchanged: boolean; stalePeriods: number[]; staleRevaluations: string[] }
interface RevalLine { kind: string; accountCode: string; bankAccountNo: string | null; partyCode: string | null; openItemId: number | null; docNo: string | null; currency: string; balanceCurrency: string; balance: string; rateType: string; rate: string; revalued: string; difference: string }
interface RevalRate { currency: string; rateType: string; rate: string; rateDate: string | null }
interface RevalPreview { dryRun: true; date: string; fiscalYear: number; periodNo: number; unchanged: boolean; totals: { gain: string; loss: string; net: string }; rates: RevalRate[]; warnings: string[]; lines: RevalLine[] }
interface RevalResult { runId: number; voucherIds: string[]; unchanged: boolean; staleRevaluations: string[]; rates: RevalRate[]; warnings: string[] }
interface Currency { code: string; name: string; is_active?: boolean }
interface Settings { fx_reval_rate_asset: string | null; fx_reval_rate_liability: string | null }
interface Done { ids: string[]; nos: string[]; unchanged: boolean; stale: string[] }
interface RevalDone extends Done { rates: RevalRate[]; warnings: string[] }

const RATE_TYPE_LABEL: Record<string, string> = { transfer_avg: 'Chuyển khoản trung bình', buy: 'Mua', sell: 'Bán', input: 'Nhập tay' };
const DEFAULT_RATE = 'default';
const RATE_OPTIONS = [{ value: DEFAULT_RATE, label: 'Theo quy định của chế độ' }, { value: 'transfer_avg', label: 'Tỷ giá chuyển khoản trung bình' }, { value: 'buy', label: 'Tỷ giá mua' }, { value: 'sell', label: 'Tỷ giá bán' }];
const money = (v: unknown) => (typeof v === 'string' ? formatVnNumber(v, D(v).decimalPlaces()) : '');
const shortDate = (iso: string) => formatVnDate(iso).slice(0, 5);
// Bảng tỷ giá máy chủ đã áp dụng (kèm ngày tỷ giá) và cảnh báo: dùng cho cả bản xem trước và kết quả chạy. Một loại tiền có thể có hai dòng (tài sản và nợ phải trả khác loại tỷ giá).
const warningAlerts = (warnings: string[]) => warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} />);
const AppliedRates = ({ rates }: { rates: RevalRate[] }) => (
  <Table size="small" rowKey={(r) => `${r.currency}|${r.rateType}`} pagination={false} dataSource={rates} columns={[
    { title: 'Tỷ giá áp dụng', dataIndex: 'currency', width: 160 }, { title: 'Loại tỷ giá', dataIndex: 'rateType', render: (v: string) => RATE_TYPE_LABEL[v] ?? v },
    { title: 'Tỷ giá', dataIndex: 'rate', align: 'right', render: money }, { title: 'Ngày tỷ giá', dataIndex: 'rateDate', render: (v: string | null) => (v ? formatVnDate(v) : '') }]} />);

const voucherLinks = (type: string, ids: string[], nos: string[]) => ids.map((id, i) => (
  <span key={id}>{i > 0 && ', '}<a href={`/chung-tu/${type}/${id}`} target="_blank" rel="noopener noreferrer">{nos[i] ?? id}</a></span>));

// Lịch sử các lần chạy (bảng fx_run) của một loại, mới nhất trước; số chứng từ lấy từ máy chủ.
function RunHistory({ kind }: { kind: FxRun['kind'] }) {
  const runs = useQuery({ queryKey: ['fx-runs', kind], retry: false, queryFn: () => api<FxRun[]>(`/api/fx/runs?kind=${kind}`) });
  const type = kind === 'outflow' ? 'XQ' : 'DG';
  if (runs.error) return <Alert type="error" showIcon message={(runs.error as Error).message} />;
  return (
    <Table<FxRun> size="small" rowKey="id" loading={runs.isLoading} dataSource={runs.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa có lần chạy nào' }} columns={[
      { title: kind === 'outflow' ? 'Ngày điều chỉnh' : 'Ngày đánh giá lại', dataIndex: 'runDate', width: 150, render: (v: string) => formatVnDate(v) },
      { title: 'Kỳ', width: 100, render: (_, r) => `${r.periodNo}/${r.fiscalYear}` },
      { title: 'Chứng từ', render: (_, r) => (r.voucherIds.length ? voucherLinks(type, r.voucherIds, r.voucherNos) : 'Không có chênh lệch') },
      { title: 'Chứng từ đã đảo', render: (_, r) => r.reversedVoucherNos.join(', ') },
      { title: 'Chạy lúc', dataIndex: 'createdAt', width: 160, render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm') },
    ]} />
  );
}

function useOutflow() {
  const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const [yearSel, setYearSel] = useState<number | null>(null);
  const [periodNo, setPeriodNo] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<(Done & { stalePeriods: number[]; label: string }) | null>(null);
  const today = todayVn(); const list = years.data ?? [];
  const year = list.find((y) => y.fiscalYear === yearSel) ?? list.find((y) => y.dateFrom <= today && today <= y.dateTo) ?? list.at(-1);
  const run = useMutation({
    mutationFn: () => api<OutflowResult>('/api/fx/outflow-adjust', { method: 'POST', json: { fiscalYear: year!.fiscalYear, periodNo: periodNo! } }),
    onMutate: () => { setError(null); setOut(null); },
    onError: (e) => { setError((e as Error).message); },
    onSuccess: async (r) => {
      const nos = await fetchVoucherNos(r.voucherIds);
      setOut({ ids: r.voucherIds, nos, unchanged: r.unchanged, stale: r.staleRevaluations, stalePeriods: r.stalePeriods, label: `kỳ ${periodNo}/${year!.fiscalYear}` });
      void qc.invalidateQueries({ queryKey: ['fx-runs'] });
    },
  });
  return { year, list, setYearSel, periodNo, setPeriodNo, error, out, run };
}

function OutflowContent({ outflow }: { outflow: ReturnType<typeof useOutflow> }) {
  const { error, out } = outflow;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ fontSize: 13, color: COLOR.textSecondary }}>
        Tính lại tỷ giá ghi Có các tài khoản tiền ngoại tệ theo bình quân di động trong kỳ; chênh lệch ghi bằng chứng từ XQ. Chạy lại cùng kỳ thì chứng từ cũ được đảo và sinh chứng từ mới.
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {out && <>
        {out.unchanged || out.ids.length === 0
          ? <Alert type="info" showIcon message={`Không có chênh lệch cần điều chỉnh ở ${out.label}`} />
          : <Alert type="success" showIcon message={`Đã điều chỉnh tỷ giá xuất quỹ ${out.label}`} description={<span>Chứng từ: {voucherLinks('XQ', out.ids, out.nos)}</span>} />}
        {out.stalePeriods.length > 0 && <Alert type="warning" showIcon message={`Các kỳ sau đã chạy điều chỉnh tỷ giá xuất quỹ, cần chạy lại theo thứ tự: ${out.stalePeriods.map((n) => `kỳ ${n}`).join(', ')}`} />}
        {out.stale.length > 0 && <Alert type="warning" showIcon message={`Đánh giá lại ngoại tệ ngày ${out.stale.map(formatVnDate).join(', ')} đã chạy trước điều chỉnh này, cần chạy lại`} />}
      </>}
      <Section title="Các lần đã chạy" bodyPadding={0}>
        <RunHistory kind="outflow" />
      </Section>
    </Space>
  );
}

const previewColumns: ColDef<RevalLine>[] = ([
  { field: 'accountCode', headerName: 'Tài khoản', width: 100 },
  { headerName: 'Đối tượng / TK ngân hàng', width: 190, valueGetter: (p) => p.data?.partyCode ?? p.data?.bankAccountNo ?? '' },
  { headerName: 'Số chứng từ', width: 140, valueGetter: (p) => p.data?.docNo ?? '' },
  { field: 'currency', headerName: 'Loại tiền', width: 95 },
  { field: 'balanceCurrency', headerName: 'Số dư nguyên tệ', width: 150, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => money(p.value) },
  { field: 'balance', headerName: 'Số dư VND', width: 140, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => money(p.value) },
  { field: 'rate', headerName: 'Tỷ giá', width: 110, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => money(p.value) },
  { field: 'revalued', headerName: 'Giá trị đánh giá lại', width: 160, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => money(p.value) },
  { field: 'difference', headerName: 'Chênh lệch', width: 130, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => money(p.value) },
] as ColDef<RevalLine>[]).map((c) => ({ ...c, editable: false }));

function useReval() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [date, setDate] = useState(todayVn());
  const [manual, setManual] = useState<Record<string, string>>({}); // tỷ giá người dùng sửa; loại tiền không sửa thì máy chủ tự lấy theo loại tỷ giá đã chọn
  const [pv, setPv] = useState<{ key: string; data: RevalPreview } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RevalDone | null>(null);

  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const catalog = useQuery({ queryKey: ['currency-catalog'], queryFn: () => api<{ rows: Currency[] }>('/api/catalogs/currency?size=100') });
  const foreign = (catalog.data?.rows ?? []).filter((c) => c.code !== 'VND' && c.is_active !== false);
  // Điền sẵn theo loại tỷ giá tài sản của công ty (cài đặt bên dưới).
  // shortcut: không có cài đặt thì lấy transfer_avg, là mặc định của cả TT133, TT99 và TT200 trong fx-rules.json; chưa có API lộ mặc định theo chế độ, khi quy tắc khác nhau giữa các chế độ thì lộ qua API.
  const assetType = settings.data?.fx_reval_rate_asset ?? 'transfer_avg';
  const prefill = useQueries({ queries: foreign.map((c) => ({ queryKey: ['fx-rate', c.code, date, assetType], retry: false, enabled: !settings.isLoading,
    queryFn: () => api<{ rate: string; rateDate: string }>(`/api/fx/rate?${new URLSearchParams({ currency: c.code, date, type: assetType })}`) })) });
  const prefillOf = (code: string) => prefill[foreign.findIndex((c) => c.code === code)];

  // VnNumberInput chỉ phát giá trị khi người dùng gõ, nên mọi giá trị trong `manual` đều là tỷ giá nhập tay (kể cả khi bằng số điền sẵn).
  const body = { date, ...(Object.keys(manual).length ? { rates: manual } : {}) };
  const key = JSON.stringify(body);
  const previewed = pv?.key === key ? pv.data : null; // đổi ngày hoặc tỷ giá thì bản xem trước cũ hết hiệu lực

  const doPreview = async () => {
    setBusy('preview'); setError(null); setDone(null);
    try { setPv({ key, data: await api<RevalPreview>('/api/fx/revaluation?dryRun=true', { method: 'POST', json: body }) }); } catch (e) { setPv(null); setError((e as Error).message); } finally { setBusy(null); }
  };
  const doRun = async () => {
    setBusy('run'); setError(null);
    try {
      const r = await api<RevalResult>('/api/fx/revaluation', { method: 'POST', json: body });
      setDone({ ids: r.voucherIds, nos: await fetchVoucherNos(r.voucherIds), unchanged: r.unchanged, stale: r.staleRevaluations, rates: r.rates, warnings: r.warnings });
      setPv(null); void qc.invalidateQueries({ queryKey: ['fx-runs'] });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const save = useMutation({ mutationFn: (v: Partial<Settings>) => api('/api/settings', { method: 'PUT', json: v }), onError: (e) => { void message.error((e as Error).message); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); } });
  const rateSetting = (field: keyof Settings, label: string) => (
    <Space>{label}
      <Select aria-label={label} style={{ width: 260 }} disabled={!can('setting.update') || !settings.data} value={settings.data?.[field] ?? DEFAULT_RATE} options={RATE_OPTIONS}
        onChange={(v: string) => { setPv(null); save.mutate({ [field]: v === DEFAULT_RATE ? null : v }); }} /></Space>);
  // shortcut: chế độ TT200 gắn cứng ở đây vì chưa có API nào lộ trạng thái đối chiếu của fx-rules; làm thành dữ liệu khi quy tắc đánh giá lại TT200 được đối chiếu văn bản gốc.
  const tt200 = regimeFor(years.data ?? [], date) === 'TT200';

  return { date, setDate, manual, setManual, previewed, busy, error, done, foreign, catalog, prefillOf, doPreview, doRun, save, rateSetting, tt200 };
}

function RevalContent({ reval }: { reval: ReturnType<typeof useReval> }) {
  const { token } = theme.useToken();
  const { tt200, foreign, catalog, manual, setManual, prefillOf, previewed, error, done } = reval;

  const rateColumns = [
    { title: 'Loại tiền', render: (_: unknown, c: Currency) => `${c.code} - ${c.name}`, width: 220 },
    { title: 'Tỷ giá', width: 200, render: (_: unknown, c: Currency) => (
      <VnNumberInput aria-label={`Tỷ giá ${c.code}`} scale={4} value={manual[c.code] ?? prefillOf(c.code)?.data?.rate ?? null}
        onChange={(v) => { setManual((m) => { const rest = Object.fromEntries(Object.entries(m).filter(([k]) => k !== c.code)); return v === null ? rest : { ...rest, [c.code]: v }; }); }} />) },
    { title: 'Ngày tỷ giá', render: (_: unknown, c: Currency) => { const q = prefillOf(c.code); return q?.data ? formatVnDate(q.data.rateDate) : q?.error ? <span style={{ color: token.colorError }}>{(q.error as Error).message}</span> : ''; } },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {tt200 && <Alert type="info" showIcon message="Quy tắc đánh giá lại ngoại tệ theo TT200 chưa được đối chiếu với văn bản gốc; kiểm tra kết quả trước khi ghi sổ" />}
      <Section
        title="Tỷ giá theo loại tiền"
        bodyPadding={0}
      >
        <Table size="small" rowKey="code" pagination={false} dataSource={foreign} columns={rateColumns} loading={catalog.isLoading} locale={{ emptyText: 'Chưa có loại tiền ngoại tệ' }} />
      </Section>
      <div style={{ fontSize: 13, color: COLOR.textSecondary }}>
        Tỷ giá điền sẵn theo loại tỷ giá tài sản đã chọn ở trên và chỉ dùng khi bạn sửa; loại tiền không sửa lấy theo loại tỷ giá của từng khoản (tài sản, nợ phải trả). Bấm Xem trước để biết tỷ giá máy chủ áp dụng.
      </div>
      {previewed && warningAlerts(previewed.warnings)}
      {error && <Alert type="error" showIcon message={error} />}
      {previewed && (
        <Section
          title="Kết quả xem trước"
          extra={
            <span style={{ fontSize: 13, color: COLOR.textSecondary }}>
              Lãi chênh lệch tỷ giá: <b style={{ color: 'inherit' }}>{money(previewed.totals.gain)}</b> · Lỗ chênh lệch tỷ giá: <b style={{ color: 'inherit' }}>{money(previewed.totals.loss)}</b> · Tổng chênh lệch: <b style={{ color: 'inherit' }}>{money(previewed.totals.net)}</b> (kỳ {previewed.periodNo}/{previewed.fiscalYear})
            </span>
          }
          bodyPadding={0}
        >
          {previewed.unchanged && <Alert type="info" showIcon message="Kết quả không đổi so với lần chạy trước của ngày này; chạy lại không sinh thêm chứng từ" style={{ margin: 8 }} />}
          <AppliedRates rates={previewed.rates} />
          <KeyboardGrid<RevalLine> rows={previewed.lines} columns={previewColumns} onRowsChange={() => undefined} addRowTemplate={() => ({} as RevalLine)} readOnly height={Math.min(420, 90 + 32 * previewed.lines.length)} />
        </Section>
      )}
      {done && (done.unchanged || done.ids.length === 0
        ? <Alert type="info" showIcon message="Không có chênh lệch cần ghi sổ, không sinh chứng từ mới" />
        : <Alert type="success" showIcon message="Đã đánh giá lại ngoại tệ" description={<span>Chứng từ: {voucherLinks('DG', done.ids, done.nos)}</span>} />)}
      {done && <>{warningAlerts(done.warnings)}<AppliedRates rates={done.rates} /></>}
      {done && done.stale.length > 0 && <Alert type="warning" showIcon message={`Đánh giá lại ngoại tệ ngày ${done.stale.map(formatVnDate).join(', ')} đã chạy sau ngày này, cần chạy lại`} />}
      <Section title="Các lần đã chạy" bodyPadding={0}>
        <RunHistory kind="revaluation" />
      </Section>
    </Space>
  );
}

export default function FxToolsPage() {
  const [tab, setTab] = useState<'outflow' | 'reval'>('outflow');
  const outflow = useOutflow();
  const reval = useReval();

  return (
    <>
      <PageHeader
        title="Công cụ tỷ giá"
        description="Điều chỉnh tỷ giá xuất quỹ và đánh giá lại số dư ngoại tệ cuối kỳ"
        extra={
          tab === 'outflow' ? (
            <Button
              type="primary"
              disabled={outflow.periodNo === null || !outflow.year}
              loading={outflow.run.isPending}
              onClick={() => outflow.run.mutate()}
            >
              Chạy điều chỉnh tỷ giá xuất quỹ
            </Button>
          ) : (
            <Space>
              <Button loading={reval.busy === 'preview'} disabled={reval.save.isPending} onClick={() => { void reval.doPreview(); }}>
                Xem trước
              </Button>
              <Button
                type="primary"
                disabled={!reval.previewed || reval.busy !== null || reval.save.isPending}
                loading={reval.busy === 'run'}
                onClick={() => { void reval.doRun(); }}
              >
                Chạy đánh giá lại
              </Button>
            </Space>
          )
        }
      >
        {tab === 'outflow' ? (
          <Toolbar>
            <Select<number>
              aria-label="Năm tài chính"
              style={{ width: 150 }}
              value={outflow.year?.fiscalYear ?? null}
              onChange={(v) => { outflow.setYearSel(v); outflow.setPeriodNo(null); }}
              options={outflow.list.map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear}` }))}
            />
            <Select<number>
              aria-label="Kỳ kế toán"
              placeholder="Chọn kỳ"
              virtual={false}
              style={{ width: 220 }}
              value={outflow.periodNo}
              onChange={outflow.setPeriodNo}
              options={(outflow.year?.periods ?? []).filter((p) => p.periodNo > 0).map((p) => ({ value: p.periodNo, label: `Kỳ ${p.periodNo} (${shortDate(p.dateFrom)} - ${shortDate(p.dateTo)})` }))}
            />
          </Toolbar>
        ) : (
          <Toolbar>
            <Space>
              <span>Ngày đánh giá lại</span>
              <DatePicker
                aria-label="Ngày đánh giá lại"
                format="DD/MM/YYYY"
                allowClear={false}
                value={dayjs(reval.date)}
                onChange={(d) => { if (d) { reval.setDate(d.format('YYYY-MM-DD')); reval.setManual({}); } }}
              />
            </Space>
            {reval.rateSetting('fx_reval_rate_asset', 'Tỷ giá đánh giá lại tài sản')}
            {reval.rateSetting('fx_reval_rate_liability', 'Tỷ giá đánh giá lại nợ phải trả')}
          </Toolbar>
        )}
      </PageHeader>
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'outflow' | 'reval')}
        style={{ marginBottom: 12 }}
        items={[
          { key: 'outflow', label: 'Tỷ giá xuất quỹ', children: <OutflowContent outflow={outflow} /> },
          { key: 'reval', label: 'Đánh giá lại ngoại tệ', children: <RevalContent reval={reval} /> },
        ]}
      />
    </>
  );
}
