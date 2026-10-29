import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Select, Space, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatVnNumber, todayVn } from '@kt/domain';
import { COLOR, LookupSelect, PageHeader, Section, Toolbar, useHotkeys, VnNumberInput } from '@kt/ui';
import { api, type ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';

// Tính giá thành theo kỳ tháng (GĐ6 Task 11a): API /api/costing/runs (quyền cost_run.*, cờ view_cost).
// Tham số gửi lên chỉ gồm phần người dùng sửa; ô để trống lấy mặc định của máy chủ (phương pháp của đối tượng, sản lượng = nhập kho thành phẩm trong tháng).
type B = { material: string; labor: string; overhead: string };
interface Output { lineNo: number; itemCode: string | null; itemName: string | null; qty: string; wipQty: string; coefficient: string | null; standardUnitCost: B | null; total: string; unitCost: string }
interface Obj { objectId: number; code: string; name: string; kind: string; method: string; wipMethod: string; completion: B | null; completed: boolean | null; overheadBasis: string; allocatedOverhead: string;
  opening: B; incurred: B; closing: B; cost: B; total: string; unitCost: string | null; outputs: Output[] }
interface OutCfg { itemCode?: string | undefined; qty?: string | undefined; wipQty?: string | undefined; coefficient?: string | undefined; standardUnitCost?: B | undefined }
interface ObjCfg { objectCode: string; method?: string; wip?: string; completion?: { material?: string; labor: string; overhead: string }; completed?: boolean; basis?: string; outputs?: OutCfg[] }
interface Params { overheadBasis: string; objects: ObjCfg[] }
interface Blocker { objectCode: string | null; accountCode: string; costItemCode: string | null; costItemName: string | null; amount: string }
interface Result { objects: Obj[]; warnings: string[]; status?: string; stale?: boolean; voucherId?: string | null; voucherNo?: string | null; unchanged?: boolean; regime?: string;
  sharedOverhead?: string; blockers?: { unclassified: Blocker[]; unassigned: Blocker[] }; params?: Params }
interface RunRow { month: number; status: string; stale: boolean; voucherId: string | null; voucherNo: string | null; runAt: string; runBy: string | null; closing: string; cost: string; objectCount: number }
interface FiscalYear { fiscalYear: number; dateFrom: string; dateTo: string }

const METHOD: Record<string, string> = { simple: 'Giản đơn', coefficient: 'Hệ số', ratio: 'Tỷ lệ', project: 'Vụ việc, công trình', order: 'Đơn hàng' };
const WIP: Record<string, string> = { none: 'Không đánh giá', direct_material: 'Theo NVL trực tiếp', equivalent_units: 'Theo sản lượng tương đương' };
const BASIS: Record<string, string> = { direct_labor: 'Nhân công trực tiếp', direct_material: 'NVL trực tiếp', machine_hours: 'Giờ máy', revenue: 'Doanh thu', manual: 'Nhập tay' };
const money = (s: string | null | undefined) => (s == null ? '' : formatVnNumber(s, 0));
const sum3 = (b: B) => String(BigInt(b.material) + BigInt(b.labor) + BigInt(b.overhead));
const lump = (m: string) => m === 'project' || m === 'order';

export default function CostRunsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const today = todayVn();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const cur = (years.data ?? []).find((y) => y.dateFrom <= today && today <= y.dateTo) ?? years.data?.at(-1);
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number>(Number(today.slice(5, 7)));
  const y = year ?? cur?.fiscalYear ?? null;
  const [params, setParams] = useState<Params>({ overheadBasis: 'direct_labor', objects: [] });
  const [shown, setShown] = useState<Result | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const runs = useQuery({ queryKey: ['cost-runs', y], enabled: !!y, queryFn: () => api<RunRow[]>(`/api/costing/runs?year=${y}`) });
  const preview = useMutation({ mutationFn: (p: Params) => api<Result>('/api/costing/runs/preview', { method: 'POST', json: { year: y, month, params: p } }),
    onMutate: () => setErr(null), onSuccess: (r) => setShown((s) => ({ ...r, ...(s?.status && { status: s.status, stale: s.stale, voucherId: s.voucherId, voucherNo: s.voucherNo }) })), onError: (e) => setErr(e as ApiError) });
  // Đổi kỳ: nạp lần chạy đã lưu (tham số + kết quả); chưa chạy thì xem trước với mặc định.
  useEffect(() => {
    if (!y) return;
    let alive = true;
    setShown(null); setNote(null); setErr(null);
    api<Result>(`/api/costing/runs/${y}/${month}`).then((r) => { if (!alive) return; setParams(r.params!); setShown(r); preview.mutate(r.params!); })
      .catch((e: ApiError) => { if (!alive) return; const p = { overheadBasis: 'direct_labor', objects: [] }; setParams(p); if (e.status === 404) preview.mutate(p); else setErr(e); });
    return () => { alive = false; };
  }, [y, month]); // preview ổn định theo kỳ: chỉ nạp lại khi đổi năm/kỳ

  const run = useMutation({ mutationFn: () => api<Result>('/api/costing/runs', { method: 'POST', json: { year: y, month, params } }),
    onMutate: () => { setErr(null); setNote(null); },
    onSuccess: (r) => { setShown(r); setNote(r.unchanged ? 'Giá thành không đổi: giữ nguyên kết quả và chứng từ' : 'Đã tính giá thành kỳ'); void qc.invalidateQueries({ queryKey: ['cost-runs'] }); },
    onError: (e) => setErr(e as ApiError) });
  const start = () => { if (y && can('cost_run.run') && !run.isPending) run.mutate(); };
  useHotkeys({ F9: start });

  const objs = shown?.objects ?? [];
  const cfgOf = (code: string) => params.objects.find((o) => o.objectCode === code);
  const setCfg = (o: Obj, patch: Partial<ObjCfg>) => setParams((p) => {
    const old = p.objects.find((x) => x.objectCode === o.code) ?? { objectCode: o.code };
    return { ...p, objects: [...p.objects.filter((x) => x.objectCode !== o.code), { ...old, ...patch }] };
  });
  // Sửa một đầu ra: chép danh sách đầu ra hiện hành (không chép sản lượng chưa sửa để vẫn lấy theo nhập kho), rồi đổi ô.
  const outsOf = (o: Obj): OutCfg[] => cfgOf(o.code)?.outputs ?? o.outputs.map((x) => ({ itemCode: x.itemCode ?? undefined, wipQty: x.wipQty, coefficient: x.coefficient ?? undefined, standardUnitCost: x.standardUnitCost ?? undefined }));
  const setOut = (o: Obj, i: number, patch: OutCfg) => setCfg(o, { outputs: outsOf(o).map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const methodOf = (o: Obj) => cfgOf(o.code)?.method ?? o.method;
  const wipOf = (o: Obj) => cfgOf(o.code)?.wip ?? o.wipMethod;
  const blockers = [...(shown?.blockers?.unclassified ?? []).map((b) => ({ ...b, why: 'Chưa phân loại yếu tố' })), ...(shown?.blockers?.unassigned ?? []).map((b) => ({ ...b, why: 'Chưa gắn đối tượng' }))];
  const details = (err?.details as { lines?: Blocker[] } | undefined)?.lines;

  return (
    <>
      <PageHeader
        title="Tính giá thành"
        tags={shown?.status ? (
          <Space size={6} align="center">
            {shown.stale ? <Tag color="orange" style={{ marginRight: 0 }}>Cần chạy lại</Tag> : <Tag color="green" style={{ marginRight: 0 }}>Đã tính</Tag>}
            {shown.voucherId && (
              <span style={{ fontSize: 13, color: COLOR.textSecondary }}>
                Chứng từ giá thành: <a href={`/chung-tu/GT/${shown.voucherId}`} target="_blank" rel="noopener noreferrer">{shown.voucherNo ?? 'GT'}</a>
              </span>
            )}
          </Space>
        ) : undefined}
        description="Tập hợp chi phí sản xuất theo đối tượng, phân bổ chi phí sản xuất chung chưa gắn đối tượng theo tiêu thức, đánh giá dở dang cuối kỳ và tính giá thành theo phương pháp của từng đối tượng. Theo TT 99 chi phí 621, 622, 627 được kết chuyển sang 154 bằng một Chứng từ giá thành (GT) ngày cuối tháng; theo TT 133 chi phí đã ghi thẳng 154 nên không sinh chứng từ. Chạy lại thì đảo chứng từ cũ và sinh chứng từ mới."
        extra={<>
          <Button onClick={() => preview.mutate(params)} loading={preview.isPending} disabled={!y}>Xem trước</Button>
          {can('cost_run.run') && <Button type="primary" onClick={start} loading={run.isPending} disabled={!y}>Chạy (F9)</Button>}
        </>}
      >
        <Toolbar>
          <Select<number> aria-label="Năm tài chính" style={{ width: 130 }} value={y} options={(years.data ?? []).map((f) => ({ value: f.fiscalYear, label: `Năm ${f.fiscalYear}` }))} onChange={setYear} />
          <Select<number> aria-label="Kỳ" style={{ width: 120 }} value={month} virtual={false} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Tháng ${i + 1}` }))} onChange={setMonth} />
          <Select<string> aria-label="Tiêu thức phân bổ chi phí sản xuất chung" style={{ width: 260 }} value={params.overheadBasis}
            options={Object.entries(BASIS).map(([value, label]) => ({ value, label: `Phân bổ SXC theo ${label.toLowerCase()}` }))} onChange={(v) => setParams((p) => ({ ...p, overheadBasis: v }))} />
        </Toolbar>
      </PageHeader>

      {note && <Alert type="success" showIcon message={note} style={{ marginBottom: 12 }} />}
      {err && <Alert type="error" showIcon message={err.message} style={{ marginBottom: 12 }} description={details?.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{details.map((d, i) => <li key={i}>{d.objectCode ?? 'Chưa gắn đối tượng'} · TK {d.accountCode}{d.costItemCode ? ` · khoản mục ${d.costItemCode} ${d.costItemName ?? ''}` : ''}: {money(d.amount)}</li>)}</ul> : undefined} />}
      {!!blockers.length && !err && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Chưa chạy được giá thành: còn chi phí cần xử lý"
        description={<ul style={{ margin: 0, paddingLeft: 18 }}>{blockers.map((d, i) => <li key={i}>{d.why}: {d.objectCode ?? '—'} · TK {d.accountCode}{d.costItemCode ? ` · khoản mục ${d.costItemCode}` : ''}: {money(d.amount)}</li>)}</ul>} />}
      {!!shown?.warnings.length && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Lưu ý" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{shown.warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />}

      <Section
        title={`Chi phí sản xuất theo đối tượng${y ? ` – tháng ${month}/${y}` : ''}`}
        extra={shown?.sharedOverhead && shown.sharedOverhead !== '0' ? (
          <span style={{ fontSize: 13, color: COLOR.textSecondary }}>
            Chi phí sản xuất chung chưa gắn đối tượng: <b className="kt-num">{money(shown.sharedOverhead)}</b> (phân bổ theo {BASIS[params.overheadBasis]?.toLowerCase()})
          </span>
        ) : undefined}
        bodyPadding={0}
      >
        <Table<Obj> size="small" rowKey="code" dataSource={objs} loading={preview.isPending || run.isPending} pagination={false} scroll={{ x: 1700 }} data-testid="cost-run-objects"
          locale={{ emptyText: 'Kỳ này không có chi phí sản xuất hay dở dang đầu kỳ' }}
          expandable={{ rowExpandable: () => true, expandedRowRender: (o) => (
            <Table<Output> size="small" rowKey="lineNo" dataSource={o.outputs} pagination={false} columns={[
              { title: 'Sản phẩm', width: 240, render: (_v, x) => (methodOf(o) === 'coefficient' || methodOf(o) === 'ratio'
                ? <LookupSelect catalog="item" aria-label={`Sản phẩm ${x.lineNo} của ${o.code}`} value={outsOf(o)[x.lineNo - 1]?.itemCode ?? null} onChange={(c) => setOut(o, x.lineNo - 1, { itemCode: c || undefined })} />
                : `${x.itemCode ?? ''} ${x.itemName ?? ''}`) },
              { title: 'SL hoàn thành', width: 130, render: (_v, x) => <VnNumberInput scale={6} aria-label={`SL hoàn thành ${x.lineNo} của ${o.code}`} value={x.qty} onChange={(v) => setOut(o, x.lineNo - 1, { qty: v ?? undefined })} /> },
              { title: 'SL dở dang', width: 130, render: (_v, x) => <VnNumberInput scale={6} aria-label={`SL dở dang ${x.lineNo} của ${o.code}`} value={x.wipQty} onChange={(v) => setOut(o, x.lineNo - 1, { wipQty: v ?? undefined })} /> },
              ...(methodOf(o) === 'coefficient' ? [{ title: 'Hệ số', width: 110, render: (_v: unknown, x: Output) => <VnNumberInput scale={6} aria-label={`Hệ số ${x.lineNo} của ${o.code}`} value={outsOf(o)[x.lineNo - 1]?.coefficient ?? null} onChange={(v) => setOut(o, x.lineNo - 1, { coefficient: v ?? undefined })} /> }] : []),
              ...(methodOf(o) === 'ratio' ? (['material', 'labor', 'overhead'] as const).map((e) => ({ title: `Định mức ${e === 'material' ? 'NVL' : e === 'labor' ? 'NC' : 'SXC'}`, width: 120,
                render: (_v: unknown, x: Output) => { const s = outsOf(o)[x.lineNo - 1]?.standardUnitCost ?? { material: '0', labor: '0', overhead: '0' };
                  return <VnNumberInput scale={4} aria-label={`Định mức ${e} ${x.lineNo} của ${o.code}`} value={s[e]} onChange={(v) => setOut(o, x.lineNo - 1, { standardUnitCost: { ...s, [e]: v ?? '0' } })} />; } })) : []),
              { title: 'Tổng giá thành', dataIndex: 'total', align: 'right', width: 140, render: money },
              { title: 'Giá thành đơn vị', dataIndex: 'unitCost', align: 'right', width: 140, render: (v: string) => formatVnNumber(v, 4) },
              { title: '', width: 70, render: (_v, x) => (o.outputs.length > 1 ? <Button type="link" size="small" onClick={() => setCfg(o, { outputs: outsOf(o).filter((_z, k) => k !== x.lineNo - 1) })}>Bỏ</Button> : null) },
            ]} footer={() => (methodOf(o) === 'coefficient' || methodOf(o) === 'ratio') && <Button size="small" onClick={() => setCfg(o, { outputs: [...outsOf(o), { coefficient: '1' }] })}>Thêm sản phẩm</Button>} />
          ) }}
          columns={[
            { title: 'Đối tượng', fixed: 'left', width: 200, render: (_v, o) => <span title={o.name}><b>{o.code}</b> {o.name}</span> },
            { title: 'Phương pháp', width: 170, render: (_v, o) => <Select aria-label={`Phương pháp ${o.code}`} style={{ width: '100%' }} value={methodOf(o)} onChange={(v: string) => setCfg(o, { method: v })}
              options={Object.entries(METHOD).map(([value, label]) => ({ value, label }))} /> },
            { title: 'Dở dang cuối kỳ', width: 220, render: (_v, o) => (lump(methodOf(o))
              ? <Checkbox checked={cfgOf(o.code)?.completed ?? o.completed ?? false} onChange={(e) => setCfg(o, { completed: e.target.checked })}>Đã hoàn thành</Checkbox>
              : <Select aria-label={`Đánh giá dở dang ${o.code}`} style={{ width: '100%' }} value={wipOf(o)} onChange={(v: string) => setCfg(o, { wip: v })} options={Object.entries(WIP).map(([value, label]) => ({ value, label }))} />) },
            { title: '% hoàn thành NC / SXC', width: 170, render: (_v, o) => {
              if (wipOf(o) !== 'equivalent_units' || lump(methodOf(o))) return null;
              const c = cfgOf(o.code)?.completion ?? o.completion ?? { labor: '50', overhead: '50' };
              return <Space size={4}><VnNumberInput scale={4} style={{ width: 70 }} aria-label={`% hoàn thành nhân công ${o.code}`} value={c.labor} onChange={(v) => setCfg(o, { completion: { ...c, labor: v ?? '0' } })} />
                <VnNumberInput scale={4} style={{ width: 70 }} aria-label={`% hoàn thành sản xuất chung ${o.code}`} value={c.overhead} onChange={(v) => setCfg(o, { completion: { ...c, overhead: v ?? '0' } })} /></Space>;
            } },
            { title: 'SL hoàn thành', width: 120, render: (_v, o) => (o.outputs.length === 1 && !lump(methodOf(o))
              ? <VnNumberInput scale={6} aria-label={`SL hoàn thành ${o.code}`} value={o.outputs[0]!.qty} onChange={(v) => setOut(o, 0, { qty: v ?? undefined })} /> : null) },
            { title: 'SL dở dang', width: 120, render: (_v, o) => (o.outputs.length === 1 && !lump(methodOf(o))
              ? <VnNumberInput scale={6} aria-label={`SL dở dang ${o.code}`} value={o.outputs[0]!.wipQty} onChange={(v) => setOut(o, 0, { wipQty: v ?? undefined })} /> : null) },
            { title: 'Tiêu thức SXC', width: 130, render: (_v, o) => (params.overheadBasis === 'direct_labor' || params.overheadBasis === 'direct_material' ? <span style={{ float: 'right' }}>{money(o.overheadBasis)}</span>
              : <VnNumberInput scale={4} aria-label={`Tiêu thức ${o.code}`} value={cfgOf(o.code)?.basis ?? o.overheadBasis} onChange={(v) => setCfg(o, { basis: v ?? '0' })} />) },
            { title: 'Dở dang đầu kỳ', align: 'right', width: 130, render: (_v, o) => money(sum3(o.opening)) },
            { title: 'Phát sinh', align: 'right', width: 130, render: (_v, o) => money(sum3(o.incurred)) },
            { title: 'Trong đó SXC phân bổ', dataIndex: 'allocatedOverhead', align: 'right', width: 130, render: money },
            { title: 'Dở dang cuối kỳ', align: 'right', width: 130, render: (_v, o) => money(sum3(o.closing)) },
            { title: 'Tổng giá thành', dataIndex: 'total', align: 'right', width: 140, render: money },
            { title: 'Giá thành đơn vị', dataIndex: 'unitCost', align: 'right', width: 130, render: (v: string | null) => (v ? formatVnNumber(v, 4) : '') },
          ]} />
      </Section>

      <Section title={`Các kỳ đã tính giá thành năm ${y ?? ''}`} style={{ marginTop: 16 }} bodyPadding={0}>
        <Table<RunRow> size="small" rowKey="month" dataSource={runs.data ?? []} loading={runs.isLoading} pagination={false} locale={{ emptyText: 'Chưa tính giá thành kỳ nào' }} data-testid="cost-runs"
          onRow={(r) => ({ onClick: () => setMonth(r.month), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Kỳ', dataIndex: 'month', width: 90, render: (m: number) => `Tháng ${m}` },
            { title: 'Trạng thái', width: 150, render: (_v, r) => (r.stale ? <Tag color="orange">Cần chạy lại</Tag> : <Tag color="green">Đã tính</Tag>) },
            { title: 'Chứng từ GT', dataIndex: 'voucherNo', width: 130, render: (v: string | null) => v ?? '' },
            { title: 'Số đối tượng', dataIndex: 'objectCount', align: 'right', width: 110 },
            { title: 'Tổng giá thành', dataIndex: 'cost', align: 'right', width: 150, render: money },
            { title: 'Dở dang cuối kỳ', dataIndex: 'closing', align: 'right', width: 150, render: money },
            { title: 'Lúc chạy', dataIndex: 'runAt', width: 150, render: (v: string) => new Date(v).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) },
            { title: 'Người chạy', dataIndex: 'runBy', render: (v: string | null) => v ?? '' },
          ]} />
      </Section>
    </>
  );
}
