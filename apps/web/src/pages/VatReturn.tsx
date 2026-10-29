import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Alert, Button, DatePicker, InputNumber, List, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { InfoCircleOutlined, LockOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { D, formatVnNumber } from '@kt/domain';
import { PageHeader, Section, Toolbar, VnNumberInput, useHotkeys, useRememberedFilter, useUnsavedChanges } from '@kt/ui';
import { ApiError, api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { downloadSignedVatReturn, signDocumentConfirmed } from '../signing/signXml.js';

// Tờ khai thuế GTGT 01/GTGT: bảng chỉ tiêu dựng từ mẫu dữ liệu của máy chủ (/api/tax/vat-template), không viết cứng danh sách chỉ tiêu.
// Chỉ tiêu nhập tay (manual, carry) và chỉ tiêu cho ghi đè (overridable) sửa được khi còn nháp; chỉ tiêu tính (hóa đơn, công thức) chỉ đọc. Đã chốt thì khóa toàn bộ.
type Kind = 'month' | 'quarter';
export interface TemplateLine { code: string; label: string; section: string; kind: 'flag' | 'carry' | 'invoice' | 'formula' | 'manual'; invoice?: { direction: 'purchase' | 'sale'; groups: string[]; field: 'base' | 'tax'; importOnly?: boolean };
  formula?: string; clamp?: string; overridable?: boolean; note?: string }
interface Template { version: string; validFrom: string; source: string; lines: TemplateLine[] }
export interface TaxReturn { id: number; formCode: string; templateVersion: string; periodKind: Kind; year: number; period: number; revision: number; status: 'draft' | 'final'; values: Record<string, string>; overrides: Record<string, string>; createdAt: string; finalizedAt: string | null; acknowledgedGates?: string[];
  discovery?: { year: number; periodKind: Kind; period: number } | null } // discovery: kỳ phát hiện sai sót của tờ khai bổ sung đã chốt, do máy chủ tính
interface Preview { hints: Record<string, string>; warnings: string[]; carryLocked: boolean; changed: Changed[] }
interface Changed { code: string; stored: string | null; fresh: string | null }
interface OffsetResult { date: string; amount: string; laterOffsetDates: string[]; warnings: string[]; unchanged: boolean; voucherId: string | null }

const kindName = (k: Kind) => (k === 'month' ? 'Tháng' : 'Quý');
export const periodLabel = (r: { periodKind: Kind; period: number; year: number }) => `${kindName(r.periodKind)} ${r.period}/${r.year}`;
const revisionLabel = (n: number) => (n === 0 ? 'Lần đầu' : `Bổ sung lần ${n}`);
// Ngày cuối kỳ (mặc định cho khấu trừ thuế cuối kỳ).
export const periodEnd = (kind: Kind, year: number, period: number): string => dayjs(`${year}-${String(kind === 'month' ? period : period * 3).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
export interface SupplementNote { ret: TaxReturn; delta: string; foundIn: { year: number; period: number; kind: Kind }; foundFinal: TaxReturn | null }
// Mỗi tờ khai bổ sung đã chốt: chênh lệch [43] so với lần khai liền trước và kỳ phát hiện sai sót (kỳ chứa ngày chốt, máy chủ trả trong danh sách). Kỳ đó đã có tờ khai chốt thì nhắc không khai điều chỉnh hai lần.
export function supplementNotes(all: TaxReturn[]): SupplementNote[] {
  const same = (a: TaxReturn, b: TaxReturn) => a.year === b.year && a.period === b.period && a.periodKind === b.periodKind;
  return all.filter((r) => r.revision > 0 && r.status === 'final' && r.discovery).map((ret) => {
    const prev = all.find((x) => same(x, ret) && x.revision === ret.revision - 1);
    const at = ret.discovery!;
    const foundFinal = all.find((x) => x.revision === 0 && x.status === 'final' && x.periodKind === at.periodKind && x.year === at.year && x.period === at.period) ?? null;
    return { ret, delta: D(ret.values['43'] ?? 0).minus(prev?.values['43'] ?? 0).toFixed(0), foundIn: { year: at.year, period: at.period, kind: at.periodKind }, foundFinal };
  });
}

const money = (v: string | undefined) => (v === undefined || v === '' ? '' : formatVnNumber(v));
const registerHref = (l: TemplateLine, r: TaxReturn) => `/thue/bang-ke-hoa-don?${new URLSearchParams({ direction: l.invoice!.direction, year: String(r.year), period: String(r.period), periodKind: r.periodKind, group: l.invoice!.groups.join(','), field: l.invoice!.field, ...(l.invoice!.importOnly ? { importOnly: '1' } : {}) })}`;

export default function VatReturnPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<{ vat_period?: Kind }>('/api/settings'), retry: false });
  const kind: Kind = settings.data?.vat_period ?? 'month';
  const now = dayjs();
  const [f, setF] = useRememberedFilter('vat-return', { year: now.year(), period: now.month() + 1 }, `${me?.tenantId}:${me?.userId}`);
  const period = Math.min(f.period, kind === 'month' ? 12 : 4);
  const [selId, setSelId] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [ovr, setOvr] = useState<Record<string, string | null>>({});
  const [stale, setStale] = useState<Changed[] | null>(null);
  const [offsetOpen, setOffsetOpen] = useState(false);
  const [offsetDate, setOffsetDate] = useState<string>('');
  const [offsetRes, setOffsetRes] = useState<OffsetResult | null>(null);
  const dirty = Object.keys(edits).length + Object.keys(ovr).length > 0;
  const guard = useUnsavedChanges(dirty);

  const all = useQuery({ queryKey: ['vat-returns'], queryFn: () => api<TaxReturn[]>('/api/tax/vat-returns'), retry: false });
  const tpl = useQuery({ queryKey: ['vat-template', f.year, kind, period], queryFn: () => api<Template>(`/api/tax/vat-template?${new URLSearchParams({ year: String(f.year), periodKind: kind, period: String(period) })}`), retry: false });
  const rows = useMemo(() => (all.data ?? []).filter((r) => r.year === f.year && r.periodKind === kind && r.period === period), [all.data, f.year, kind, period]);
  const cur = rows.find((r) => r.id === selId) ?? rows[0];
  const isDraft = cur?.status === 'draft';
  const prev = useQuery({ queryKey: ['vat-hints', cur?.id, cur?.values], enabled: !!cur && isDraft, queryFn: () => api<Preview>(`/api/tax/vat-returns/${cur!.id}/hints`), retry: false,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === cur?.id ? prev : undefined) }); // giữ cờ khóa [22] khi tải lại sau lưu
  const xmlFormats = useQuery({ queryKey: ['xml-formats'], enabled: can('tax.view'), queryFn: () => api<{ id: string; verified: boolean }[]>('/api/tax/xml-formats'), retry: false });
  const xmlUnverified = xmlFormats.data?.find((x) => x.id === 'htkk-01gtgt')?.verified !== true; // chưa tải được danh sách thì cũng cảnh báo (như 03/TNDN)
  const hints = prev.data?.hints ?? {}; const warnings = prev.data?.warnings ?? [];
  const carryLocked = prev.data?.carryLocked === true; // kỳ trước đã có tờ khai lần đầu đã chốt: máy chủ bỏ [22] nhập tay
  const reset = () => { setEdits({}); setOvr({}); setStale(null); };
  useEffect(reset, [cur?.id]);

  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['vat-returns'] }); await qc.invalidateQueries({ queryKey: ['vat-hints'] }); };
  const fail = (e: unknown) => { void message.error((e as Error).message); };
  const manualCodes = useMemo(() => new Set((tpl.data?.lines ?? []).filter((l) => l.kind === 'manual' || l.kind === 'carry').map((l) => l.code)), [tpl.data]);
  // Gửi toàn bộ chỉ tiêu nhập tay hiện có (đã lưu cộng phần sửa) và toàn bộ ghi đè: máy chủ thay thế phần tương ứng.
  const payload = () => {
    const manual: Record<string, string> = {};
    for (const c of manualCodes) { const carryFixed = carryLocked && !(c in edits) && tpl.data?.lines.find((l) => l.code === c)?.kind === 'carry'; const v = carryFixed ? undefined : c in edits ? edits[c] : cur?.values[c]; if (v !== null && v !== undefined && v !== '') manual[c] = v; }
    const overrides: Record<string, string> = { ...(cur?.overrides ?? {}) };
    for (const [c, v] of Object.entries(ovr)) { if (v === null) delete overrides[c]; else overrides[c] = v; }
    return { manual, overrides };
  };
  const save = useMutation({ mutationFn: () => api<TaxReturn>(`/api/tax/vat-returns/${cur!.id}`, { method: 'PUT', json: payload() }), onError: fail, onSuccess: async () => { reset(); await refresh(); void message.success('Đã lưu và tính lại tờ khai'); } });
  const create = useMutation({ mutationFn: (revision?: number) => api<TaxReturn>('/api/tax/vat-returns', { method: 'POST', json: { year: f.year, periodKind: kind, period, ...(revision !== undefined ? { revision } : {}) } }),
    onError: async (e) => { if (e instanceof ApiError && e.code === 'TAX_RETURN_DRAFT_EXISTS') { await refresh(); setSelId((e.details as { id?: number } | undefined)?.id ?? null); } fail(e); },
    onSuccess: async (r) => { await refresh(); setSelId(r.id); } });
  const finalize = useMutation({ mutationFn: async (acknowledge: string[] = []) => { if (dirty) await api(`/api/tax/vat-returns/${cur!.id}`, { method: 'PUT', json: payload() }); return api<TaxReturn>(`/api/tax/vat-returns/${cur!.id}/finalize`, { method: 'POST', json: { acknowledge } }); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'TAX_RETURN_STALE') { setStale((e.details as { changed: Changed[] }).changed); void refresh(); }
      else if (e instanceof ApiError && e.code === 'VAT_RATE8_UNVERIFIED') Modal.confirm({ title: 'Hóa đơn bán ra 8% chưa có chỉ tiêu trong mẫu', width: 560,
        content: 'Mẫu 01/GTGT TT 89/2026 không có dòng 8% và văn bản chưa nói khai ở chỉ tiêu nào: phần mềm tạm gộp vào [32]/[33] (thuế suất 10%). Hãy lập kèm Mẫu số 01 Phụ lục II NĐ 174/2025/NĐ-CP. Xác nhận bạn đã xử lý cách khai này để chốt; xác nhận được ghi nhật ký.',
        okText: 'Xác nhận và chốt', cancelText: 'Hủy', onOk: () => finalize.mutateAsync(['rate8_unverified']).catch(() => undefined) });
      else fail(e);
    },
    onSuccess: async () => { reset(); await refresh(); void message.success('Đã chốt tờ khai'); } });
  const del = useMutation({ mutationFn: () => api(`/api/tax/vat-returns/${cur!.id}`, { method: 'DELETE' }), onError: fail, onSuccess: async () => { reset(); setSelId(null); await refresh(); void message.success('Đã xóa tờ khai nháp'); } });
  const offset = useMutation({ mutationFn: () => api<OffsetResult>('/api/tax/vat-offset', { method: 'POST', json: { date: offsetDate } }), onError: fail, onSuccess: (r) => { setOffsetRes(r); void qc.invalidateQueries({ queryKey: ['vat-hints'] }); } });

  const recalc = () => { if (cur && isDraft && !save.isPending && can('tax_return.update')) save.mutate(); };
  const confirmFinalize = () => Modal.confirm({ title: 'Chốt tờ khai?', content: `${dirty ? 'Các thay đổi chưa lưu sẽ được lưu và tính lại trước khi chốt. ' : ''}Tờ khai đã chốt khóa số liệu; muốn sửa phải lập tờ khai bổ sung.`, okText: 'Chốt', cancelText: 'Hủy', onOk: () => finalize.mutateAsync([]).catch(() => undefined) });
  useHotkeys({ 'Ctrl+s': recalc, F9: recalc });
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target; if (!(t instanceof HTMLInputElement)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); recalc(); }
    else if (e.key === 'F9') { e.preventDefault(); recalc(); }
    else if (e.key === 'Enter') { // Enter sang ô nhập kế tiếp của bảng
      const inputs = [...document.querySelectorAll<HTMLInputElement>('input[data-vat-edit]')]; const i = inputs.indexOf(t);
      if (i >= 0) { e.preventDefault(); inputs[i + 1]?.focus(); }
    }
  };

  const valueOf = (c: string) => (c in edits ? edits[c] ?? '' : cur?.values[c] ?? '');
  const cell = (l: TemplateLine) => {
    if (!cur) return null;
    const lockedHere = !isDraft || !can('tax_return.update');
    if (l.kind === 'flag') return <span style={{ fontWeight: 600 }}>{cur.values[l.code] === 'X' ? '[X] Có' : '[ ] Không'}</span>;
    const editable = !lockedHere && (l.kind === 'manual' || (l.kind === 'carry' && !carryLocked) || l.overridable);
    if (!editable) return <span className="vat-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{money(cur.values[l.code]) || (isDraft ? '' : '0')}</span>;
    const isOvr = !!l.overridable;
    const shown = isOvr ? (l.code in ovr ? ovr[l.code] ?? cur.values[l.code] : cur.values[l.code]) : valueOf(l.code);
    return <VnNumberInput aria-label={`Chỉ tiêu ${l.code}`} data-vat-edit="1" style={{ width: 170 }} value={shown ?? null}
      onChange={(v) => { if (isOvr) { if (v === null) setOvr((o) => ({ ...o, [l.code]: null })); else setOvr((o) => ({ ...o, [l.code]: v })); } else setEdits((s) => ({ ...s, [l.code]: v })); }} />;
  };
  const source = (l: TemplateLine) => {
    const hasOvr = l.code in ovr ? ovr[l.code] !== null : cur?.overrides[l.code] !== undefined;
    if (hasOvr) return <Space size={4}><Tag color="orange">Ghi đè</Tag>{isDraft && can('tax_return.update') && <Button size="small" type="link" onClick={() => setOvr((o) => ({ ...o, [l.code]: null }))}>Bỏ ghi đè</Button>}</Space>;
    if (l.kind === 'invoice' && cur) return <a href={registerHref(l, cur)} target="_blank" rel="noopener noreferrer">Hóa đơn {l.invoice!.direction === 'sale' ? 'bán ra' : 'mua vào'} ({l.invoice!.groups.join(', ')})</a>;
    if (l.kind === 'formula') return <Tag>Tự tính</Tag>;
    if (l.kind === 'carry') return <Tag color="blue">{carryLocked ? 'Lấy từ tờ khai kỳ trước đã chốt' : 'Kỳ trước chuyển sang'}</Tag>;
    if (l.kind === 'manual') return <Tag color="geekblue">Nhập tay</Tag>;
    return null;
  };

  const columns: ColumnsType<TemplateLine> = [
    { title: 'Mục', dataIndex: 'section', width: 90, render: (s: string) => <Typography.Text type="secondary">{s}</Typography.Text> },
    { title: 'Chỉ tiêu', dataIndex: 'code', width: 90, render: (c: string) => <b>[{c}]</b> },
    { title: 'Nội dung', render: (_: unknown, l) => (
      <div>
        <span>{l.label}</span>
        {(l.note || l.formula) && <Tooltip title={<>{l.formula && <div>Công thức: {l.formula}</div>}{l.note && <div>{l.note}</div>}</>}><InfoCircleOutlined style={{ marginLeft: 6, opacity: 0.55 }} aria-label={`Ghi chú chỉ tiêu ${l.code}`} /></Tooltip>}
        {hints[l.code] && isDraft && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{hints[l.code]}</Typography.Text></div>}
      </div>) },
    { title: 'Giá trị (VND)', width: 200, align: 'right', render: (_: unknown, l) => cell(l) },
    { title: 'Nguồn', width: 220, render: (_: unknown, l) => source(l) },
  ];

  const supp = useMemo(() => supplementNotes(all.data ?? []), [all.data]);
  const changed = (stale ?? prev.data?.changed ?? []);
  const tplError = tpl.error as Error | null;
  const latest = rows[0];

  const exportXml = async () => {
    if (!cur) return;
    const res = await fetch(`/api/tax/vat-returns/${cur.id}/xml?format=htkk-01gtgt`, { credentials: 'include' });
    if (!res.ok) { let m = 'Không xuất được XML'; try { m = ((await res.json()) as { error?: { message?: string } }).error?.message ?? m; } catch { /* không có thân JSON */ } void message.error(m); return; }
    const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = name ? decodeURIComponent(name) : 'to-khai-01-gtgt.xml'; a.click(); URL.revokeObjectURL(url);
  };
  const [signing, setSigning] = useState('');
  const signXml = async () => {
    if (!cur) return;
    try { const sid = await signDocumentConfirmed({ docKind: 'vat_return', docRef: String(cur.id) }, setSigning); await downloadSignedVatReturn(cur.id, sid); void message.success('Đã ký số và tải XML'); }
    catch (e) { void message.error((e as Error).message); } finally { setSigning(''); }
  };
  const setPeriod = (next: { year?: number; period?: number }) => guard(() => { setSelId(null); setF({ ...f, ...next }); });

  return (
    <div onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <PageHeader
        title="Tờ khai thuế GTGT"
        tags={cur && (cur.status === 'final' ? <Tag color="green" icon={<LockOutlined />}>Đã chốt</Tag> : <Tag color="gold">Nháp</Tag>)}
        description="Lập, kiểm tra, chốt tờ khai thuế GTGT, khấu trừ thuế cuối kỳ và xuất XML"
        extra={!tplError && tpl.data && (
          <Space wrap>
            {!cur && can('tax_return.create') && <Button type="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>Tính tờ khai</Button>}
            {cur && isDraft && can('tax_return.update') && <Button type="primary" loading={save.isPending} onClick={recalc}>Tính lại (F9)</Button>}
            {cur && isDraft && can('tax_return.finalize') && <Button loading={finalize.isPending} onClick={confirmFinalize}>Chốt</Button>}
            {latest && latest.status === 'final' && can('tax_return.create') && <Button loading={create.isPending} onClick={() => create.mutate(latest.revision + 1)}>Lập bổ sung</Button>}
            {cur && isDraft && can('tax_return.delete') && <Popconfirm title="Xóa tờ khai nháp này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate()}><Button danger loading={del.isPending}>Xóa nháp</Button></Popconfirm>}
            {can('tax.offset') && <Button onClick={() => { setOffsetRes(null); setOffsetDate(periodEnd(kind, f.year, period)); setOffsetOpen(true); }}>Khấu trừ thuế cuối kỳ</Button>}
            {cur && can('tax.view') && <Tooltip title={cur.status === 'final' ? (xmlUnverified ? 'XML chưa kiểm chứng với HTKK' : '') : 'Chốt tờ khai trước khi xuất XML'}><Button disabled={cur.status !== 'final'} onClick={() => void exportXml()}>Xuất XML</Button></Tooltip>}
            {cur && can('tax.view') && can('signing.use') && <Tooltip title={signing || (cur.status === 'final' ? '' : 'Chốt tờ khai trước khi ký')}><Button disabled={cur.status !== 'final'} loading={!!signing} onClick={() => void signXml()}>Ký và tải XML</Button></Tooltip>}
            {cur && can('report.print') && <Button onClick={() => window.open(`/api/tax/vat-returns/${cur.id}/print?format=pdf`, '_blank')}>In</Button>}
            {dirty && <Typography.Text type="warning">Có thay đổi chưa lưu (Ctrl+S)</Typography.Text>}
          </Space>
        )}
      >
        <Toolbar>
          <InputNumber aria-label="Năm" min={2000} max={2100} precision={0} value={f.year} onChange={(v) => v && setPeriod({ year: v })} style={{ width: 90 }} />
          <Select aria-label="Kỳ" style={{ width: 120 }} value={period} onChange={(v) => setPeriod({ period: v })} options={Array.from({ length: kind === 'month' ? 12 : 4 }, (_, i) => ({ value: i + 1, label: `${kindName(kind)} ${i + 1}` }))} />
          {rows.length > 0 && <Select aria-label="Lần khai" style={{ width: 170 }} value={cur?.id ?? null} onChange={(id: number) => guard(() => setSelId(id))} options={rows.map((r) => ({ value: r.id, label: `${revisionLabel(r.revision)}${r.status === 'final' ? ' (đã chốt)' : ' (nháp)'}` }))} />}
        </Toolbar>
      </PageHeader>

      {tplError && <Alert type="error" showIcon message={tplError.message} />}
      {!tplError && all.error && <Alert type="error" showIcon message={(all.error as Error).message} />}

      {cur?.status === 'final' && can('tax.view') && xmlUnverified && <Alert type="warning" showIcon message="XML chưa kiểm chứng với HTKK" description="Tên thẻ, mã mẫu và phiên bản trong tệp là giả định tạm của phần mềm (chưa có XSD hoặc tệp mẫu của HTKK). Nạp thử vào HTKK và đối chiếu số liệu trước khi nộp." />}
      {changed.length > 0 && isDraft && (
        <Alert type="error" showIcon message="Số liệu sổ đã thay đổi kể từ lần tính trước: lưu lại nháp để tính lại và kiểm tra trước khi chốt" action={can('tax_return.update') ? <Button size="small" loading={save.isPending} onClick={recalc}>Lưu lại nháp</Button> : undefined}
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{changed.map((c) => <li key={c.code}>[{c.code}]: đã lưu {money(c.stored ?? '') || '(trống)'} → theo sổ hiện tại {money(c.fresh ?? '') || '(trống)'}</li>)}</ul>} />)}
      {warnings.length > 0 && isDraft && <Alert type="warning" showIcon message="Cảnh báo" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />}

      {!tplError && tpl.data && (cur
        ? <Section bodyPadding={0}><Table<TemplateLine> size="small" bordered pagination={false} rowKey="code" dataSource={tpl.data.lines} columns={columns} loading={all.isLoading} sticky /></Section>
        : !all.isLoading && <Alert type="info" showIcon message={`Chưa có tờ khai ${periodLabel({ periodKind: kind, period, year: f.year }).toLowerCase()}. Bấm Tính tờ khai để lập bản nháp theo mẫu ${tpl.data.version}.`} />)}

      {supp.length > 0 && (
        <Section title="Tờ khai bổ sung đã chốt" style={{ marginTop: 12 }}>
          <List size="small" bordered={false} dataSource={supp} renderItem={(s) => (
            <List.Item key={s.ret.id} actions={[<Button key="open" type="link" size="small" onClick={() => guard(() => { setF({ ...f, year: s.ret.year, period: s.ret.period }); setSelId(s.ret.id); })}>Mở</Button>]}>
              <div>
                <b>{periodLabel(s.ret)} – {revisionLabel(s.ret.revision)}</b>: thuế còn được khấu trừ chuyển kỳ sau {D(s.delta).gte(0) ? 'tăng' : 'giảm'} {formatVnNumber(D(s.delta).abs().toFixed(0))} so với lần khai trước.
                <div style={{ fontSize: 12 }}>
                  <Typography.Text type="secondary">Kỳ phát hiện (kỳ chứa ngày chốt) là {periodLabel({ periodKind: s.foundIn.kind, period: s.foundIn.period, year: s.foundIn.year })}. </Typography.Text>
                  {s.foundFinal
                    ? <Typography.Text type="danger">Tờ khai kỳ đó đã chốt: nếu đã khai [37]/[38] cho chênh lệch này thì không khai lại lần nữa.</Typography.Text>
                    : <Typography.Text type="secondary">Gợi ý [37]/[38] hiện ở tờ khai nháp của kỳ đó.</Typography.Text>}
                </div>
              </div>
            </List.Item>)} />
        </Section>)}

      <Modal title="Khấu trừ thuế GTGT cuối kỳ" open={offsetOpen} onCancel={() => setOffsetOpen(false)} footer={<Space><Button onClick={() => setOffsetOpen(false)}>Đóng</Button><Button type="primary" loading={offset.isPending} onClick={() => offset.mutate()}>Chạy khấu trừ</Button></Space>}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <span>Khấu trừ thuế đầu vào (TK 133) với thuế đầu ra (TK 33311) đến ngày:</span>
          <DatePicker format="DD/MM/YYYY" allowClear={false} aria-label="Ngày khấu trừ" value={offsetDate ? dayjs(offsetDate) : null} onChange={(d) => d && setOffsetDate(d.format('YYYY-MM-DD'))} />
          {offsetRes && <Alert type={offsetRes.unchanged ? 'info' : 'success'} showIcon message={offsetRes.unchanged ? 'Kết quả không đổi, không ghi thêm chứng từ' : `Đã khấu trừ ${formatVnNumber(offsetRes.amount)} VND`} />}
          {offsetRes && offsetRes.laterOffsetDates.length > 0 && <Alert type="warning" showIcon message="Đã có khấu trừ các ngày sau tính trên số dư cũ" description={offsetRes.warnings.join(' ') || `Chạy lại khấu trừ theo thứ tự các ngày: ${offsetRes.laterOffsetDates.join(', ')}`} />}
        </Space>
      </Modal>
    </div>
  );
}
