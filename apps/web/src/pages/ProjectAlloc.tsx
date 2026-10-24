import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Segmented, Select, Space, Table, Tabs, Tag } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatVnNumber, todayVn } from '@kt/domain';
import { LookupSelect, useHotkeys, VnNumberInput } from '@kt/ui';
import { api, type ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { contractFetcher } from '../lookups.js';

// Phân bổ chi phí vào vụ việc (GĐ6 Task 13c): API /api/projects/alloc (quyền contract_track.view/run, cờ view_cost).
// alloc: chi phí bán hàng, quản lý chưa gắn vụ việc → các vụ việc theo tiêu thức (chứng từ PB); cogs: kết chuyển giá vốn vụ việc/hợp đồng hoàn thành 154 → 632 (chứng từ GT).
type Kind = 'alloc' | 'cogs';
interface AllocParams { basis: 'revenue' | 'direct_cost' | 'manual'; includeProduction: boolean; manual: { projectCode: string; weight: string }[] }
interface CogsParams { projectCodes: string[]; contractCodes: string[] }
interface AllocRow { projectCode: string; projectName: string; basis: string; ratio: string; amounts: Record<string, string>; total: string }
interface CogsRow { dim: 'project' | 'contract'; code: string; name: string; amount: string }
interface Result { accounts: { code: string; name: string; pool: string }[]; result: (AllocRow | CogsRow)[]; warnings: string[]; lines?: unknown[]; params?: AllocParams | CogsParams;
  status?: string; stale?: boolean; voucherId?: string | null; voucherNo?: string | null; unchanged?: boolean }
interface FiscalYear { fiscalYear: number; dateFrom: string; dateTo: string }

const money = (s: string | null | undefined) => (s == null ? '' : formatVnNumber(s, 0));
const BASIS = [{ value: 'revenue', label: 'Doanh thu thuần' }, { value: 'direct_cost', label: 'Chi phí trực tiếp' }, { value: 'manual', label: 'Nhập tay' }];
const DEFAULTS: { alloc: AllocParams; cogs: CogsParams } = { alloc: { basis: 'revenue', includeProduction: false, manual: [] }, cogs: { projectCodes: [], contractCodes: [] } };

export default function ProjectAllocPage() {
  const { can } = useAuth();
  const today = todayVn();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const cur = (years.data ?? []).find((y) => y.dateFrom <= today && today <= y.dateTo) ?? years.data?.at(-1);
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number>(Number(today.slice(5, 7)));
  const [kind, setKind] = useState<Kind>('alloc');
  const y = year ?? cur?.fiscalYear ?? null;
  const [alloc, setAlloc] = useState<AllocParams>(DEFAULTS.alloc);
  const [cogs, setCogs] = useState<CogsParams>(DEFAULTS.cogs);
  const [shown, setShown] = useState<Result | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const params = kind === 'alloc' ? alloc : cogs;
  // Dòng tiêu thức chưa chọn vụ việc thì bỏ, không gửi mã rỗng.
  const body = (p: AllocParams | CogsParams = params) => ({ kind, year: y, month, params: 'manual' in p ? { ...p, manual: p.manual.filter((m) => m.projectCode) } : p });

  const preview = useMutation({ mutationFn: (p: AllocParams | CogsParams) => api<Result>('/api/projects/alloc/preview', { method: 'POST', json: body(p) }),
    onMutate: () => setErr(null), onSuccess: (r) => setShown((s) => ({ ...r, ...(s?.status && { status: s.status, stale: s.stale, voucherId: s.voucherId, voucherNo: s.voucherNo }) })),
    onError: (e) => { setShown(null); setErr(e as ApiError); } });
  // Đổi kỳ/loại: nạp lần chạy đã lưu (tham số + kết quả); chưa chạy thì xem trước với mặc định (kết chuyển cần chọn vụ việc trước).
  useEffect(() => {
    if (!y) return;
    let alive = true;
    setShown(null); setNote(null); setErr(null);
    api<Result>(`/api/projects/alloc/${kind}/${y}/${month}`).then((r) => {
      if (!alive) return;
      if (kind === 'alloc') setAlloc(r.params as AllocParams); else setCogs(r.params as CogsParams);
      setShown(r); preview.mutate(r.params!);
    }).catch((e: ApiError) => {
      if (!alive) return;
      if (kind === 'alloc') setAlloc(DEFAULTS.alloc); else setCogs(DEFAULTS.cogs);
      if (e.status !== 404) setErr(e); else if (kind === 'alloc') preview.mutate(DEFAULTS.alloc);
    });
    return () => { alive = false; };
  }, [y, month, kind]); // nạp lại khi đổi năm/kỳ/loại

  const run = useMutation({ mutationFn: () => api<Result>('/api/projects/alloc', { method: 'POST', json: body() }),
    onMutate: () => { setErr(null); setNote(null); },
    onSuccess: (r) => { setShown(r); setNote(r.unchanged ? 'Số liệu không đổi: giữ nguyên chứng từ đã ghi' : r.voucherId ? `Đã ghi sổ chứng từ ${r.voucherNo ?? ''}` : 'Không có số liệu để ghi trong kỳ'); },
    onError: (e) => setErr(e as ApiError) });
  const start = () => { if (y && can('contract_track.run') && !run.isPending) run.mutate(); };
  useHotkeys({ F9: start });

  const accounts = shown?.accounts ?? [];
  const allocRows = kind === 'alloc' ? (shown?.result ?? []) as AllocRow[] : [];
  const cogsRows = kind === 'cogs' ? (shown?.result ?? []) as CogsRow[] : [];
  const tag = !shown?.status ? <Tag>Chưa chạy</Tag> : shown.stale ? <Tag color="orange">Cần chạy lại</Tag> : shown.status === 'posted' ? <Tag color="green">Đã hạch toán</Tag> : <Tag>Không có số liệu</Tag>;
  const setManual = (i: number, patch: Partial<AllocParams['manual'][number]>) => setAlloc((p) => ({ ...p, manual: p.manual.map((m, k) => (k === i ? { ...m, ...patch } : m)) }));

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <h2 style={{ margin: 0 }}>Phân bổ chi phí vào vụ việc</h2>
      <Tabs activeKey={kind} onChange={(k) => setKind(k as Kind)} items={[{ key: 'alloc', label: 'Phân bổ chi phí chung' }, { key: 'cogs', label: 'Kết chuyển giá vốn vụ việc' }]} />
      <span>{kind === 'alloc'
        ? 'Chi phí bán hàng, chi phí quản lý doanh nghiệp chưa gắn vụ việc trong tháng được phân bổ cho các vụ việc theo tiêu thức bằng một Chứng từ phân bổ (PB): Nợ tài khoản chi phí có vụ việc / Có cùng tài khoản. Tổng chi phí công ty không đổi; phần lẻ do làm tròn dồn vào vụ việc cuối. Chạy lại thì đảo chứng từ cũ và sinh chứng từ mới.'
        : 'Vụ việc, hợp đồng đã hoàn thành: toàn bộ chi phí sản xuất kinh doanh dở dang (154) đến cuối tháng được kết chuyển sang giá vốn hàng bán (632) bằng một Chứng từ giá thành (GT), giữ vụ việc, hợp đồng, đối tượng tập hợp chi phí.'}</span>
      <Space wrap align="end">
        <Select<number> aria-label="Năm tài chính" style={{ width: 130 }} value={y} options={(years.data ?? []).map((f) => ({ value: f.fiscalYear, label: `Năm ${f.fiscalYear}` }))} onChange={setYear} />
        <Select<number> aria-label="Kỳ" style={{ width: 120 }} value={month} virtual={false} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }))} onChange={setMonth} />
        {kind === 'alloc' && <>
          <Segmented aria-label="Tiêu thức phân bổ" value={alloc.basis} options={BASIS} onChange={(v) => setAlloc((p) => ({ ...p, basis: v as AllocParams['basis'] }))} />
          {alloc.basis === 'direct_cost' && <Checkbox checked={alloc.includeProduction} onChange={(e) => setAlloc((p) => ({ ...p, includeProduction: e.target.checked }))}>Cộng chi phí sản xuất</Checkbox>}
        </>}
        <Button onClick={() => preview.mutate(params)} loading={preview.isPending} disabled={!y}>Xem trước</Button>
        {can('contract_track.run') && <Button type="primary" onClick={start} loading={run.isPending} disabled={!y}>Chạy (F9)</Button>}
        <Space size={4}>{tag}
          {shown?.voucherId && <span>Chứng từ: <a href={`/chung-tu/${kind === 'alloc' ? 'PB' : 'GT'}/${shown.voucherId}`} target="_blank" rel="noopener noreferrer">{shown.voucherNo ?? (kind === 'alloc' ? 'PB' : 'GT')}</a></span>}
        </Space>
      </Space>

      {kind === 'alloc' && alloc.basis === 'manual' && (
        <Table size="small" rowKey={(_r, i) => String(i)} dataSource={alloc.manual} pagination={false} style={{ maxWidth: 560 }} locale={{ emptyText: 'Chưa có vụ việc nhận phân bổ' }}
          columns={[
            { title: 'Vụ việc', render: (_v, m, i) => <LookupSelect catalog="project" aria-label={`Vụ việc ${i + 1}`} value={m.projectCode || null} onChange={(c) => setManual(i, { projectCode: c ?? '' })} /> },
            { title: 'Tiêu thức', width: 160, render: (_v, m, i) => <VnNumberInput scale={4} aria-label={`Tiêu thức ${i + 1}`} value={m.weight} onChange={(v) => setManual(i, { weight: v ?? '0' })} /> },
            { title: '', width: 60, render: (_v, _m, i) => <Button type="link" size="small" onClick={() => setAlloc((p) => ({ ...p, manual: p.manual.filter((_x, k) => k !== i) }))}>Bỏ</Button> },
          ]} footer={() => <Button size="small" onClick={() => setAlloc((p) => ({ ...p, manual: [...p.manual, { projectCode: '', weight: '1' }] }))}>Thêm vụ việc</Button>} />)}

      {kind === 'cogs' && <Space direction="vertical">
        <Space wrap><span style={{ width: 170, display: 'inline-block' }}>Vụ việc đã hoàn thành:</span>
          {cogs.projectCodes.map((c) => <Tag key={c} closable onClose={() => setCogs((p) => ({ ...p, projectCodes: p.projectCodes.filter((x) => x !== c) }))}>{c}</Tag>)}
          <LookupSelect catalog="project" aria-label="Thêm vụ việc hoàn thành" placeholder="Thêm vụ việc (F4)" style={{ width: 240 }} value={null}
            onChange={(c) => c && setCogs((p) => (p.projectCodes.includes(c) ? p : { ...p, projectCodes: [...p.projectCodes, c] }))} /></Space>
        <Space wrap><span style={{ width: 170, display: 'inline-block' }}>Hợp đồng đã hoàn thành:</span>
          {cogs.contractCodes.map((c) => <Tag key={c} closable onClose={() => setCogs((p) => ({ ...p, contractCodes: p.contractCodes.filter((x) => x !== c) }))}>{c}</Tag>)}
          <LookupSelect catalog="contract" fetcher={contractFetcher()} aria-label="Thêm hợp đồng hoàn thành" placeholder="Thêm hợp đồng (F4)" style={{ width: 240 }} value={null}
            onChange={(c) => c && setCogs((p) => (p.contractCodes.includes(c) ? p : { ...p, contractCodes: [...p.contractCodes, c] }))} /></Space>
      </Space>}

      {note && <Alert type="success" showIcon message={note} />}
      {err && <Alert type="error" showIcon message={err.message} />}
      {!!shown?.warnings.length && <Alert type="info" showIcon message="Lưu ý" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{shown.warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />}

      {kind === 'alloc' && shown && <>
        <span data-testid="alloc-pool">Chi phí chung chưa phân bổ: {accounts.length ? accounts.map((a) => <span key={a.code} style={{ marginRight: 16 }}>TK {a.code}: <b>{money(a.pool)}</b></span>) : <b>không có</b>}</span>
        <Table<AllocRow> size="small" rowKey="projectCode" dataSource={allocRows} pagination={false} data-testid="alloc-result" scroll={{ x: 800 }} loading={preview.isPending || run.isPending}
          locale={{ emptyText: 'Không có vụ việc nhận phân bổ' }}
          columns={[{ title: 'Mã vụ việc', dataIndex: 'projectCode', width: 120 }, { title: 'Tên vụ việc', dataIndex: 'projectName' },
            { title: 'Tiêu thức', dataIndex: 'basis', align: 'right', width: 150, render: (v: string) => formatVnNumber(v, 4) },
            { title: 'Tỷ lệ (%)', dataIndex: 'ratio', align: 'right', width: 100, render: (v: string) => formatVnNumber(v, 2) },
            ...accounts.filter((a) => Number(a.pool) > 0).map((a) => ({ title: `TK ${a.code}`, align: 'right' as const, width: 140, render: (_v: unknown, r: AllocRow) => money(r.amounts[a.code] ?? '0') })),
            { title: 'Cộng', dataIndex: 'total', align: 'right', width: 140, render: money }]} />
      </>}
      {kind === 'cogs' && shown && <Table<CogsRow> size="small" rowKey={(r) => `${r.dim}-${r.code}`} dataSource={cogsRows} pagination={false} data-testid="cogs-result" style={{ maxWidth: 760 }}
        columns={[{ title: 'Loại', dataIndex: 'dim', width: 100, render: (v: string) => (v === 'project' ? 'Vụ việc' : 'Hợp đồng') }, { title: 'Mã', dataIndex: 'code', width: 120 }, { title: 'Tên', dataIndex: 'name' },
          { title: 'Giá vốn kết chuyển', dataIndex: 'amount', align: 'right', width: 160, render: money }]} />}
    </Space>);
}
