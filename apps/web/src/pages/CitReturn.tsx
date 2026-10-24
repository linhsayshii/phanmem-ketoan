import { useEffect, useState, type KeyboardEvent } from 'react';
import { Alert, Button, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { InfoCircleOutlined, LockOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { formatVnNumber } from '@kt/domain';
import { VnNumberInput, useHotkeys, useRememberedFilter, useUnsavedChanges } from '@kt/ui';
import { ApiError, api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { downloadSigned, signDocument } from '../signing/signXml.js';

// Tờ khai quyết toán thuế TNDN 03/TNDN (TT 89/2026): lưới chỉ tiêu dựng từ mẫu dữ liệu của máy chủ (/api/cit/template), không viết cứng.
// Chỉ tiêu cho ghi đè (overridable) sửa được khi còn nháp; mọi giá trị nhập lưu ở overrides, máy chủ tính lại công thức. Đã chốt thì khóa toàn bộ.
interface Line { code: string; label: string; section: string; stt: string; kind: 'section' | 'ledger' | 'input' | 'formula' | 'rate' | 'text'; formula?: string; printed?: boolean; clamp?: string; overridable: boolean; note?: string }
interface Template { form: string; version: string; source: string; lines: Line[]; notes: string[] }
interface CitReturn { id: number; formCode: string; templateVersion: string; year: number; revision: number; status: 'draft' | 'final'; values: Record<string, string>; overrides: Record<string, string>; finalizedAt: string | null }
interface Changed { code: string; stored: string | null; fresh: string | null }
interface Preview { hints: Record<string, string>; warnings: string[]; changed: Changed[] }

const revisionLabel = (n: number) => (n === 0 ? 'Lần đầu' : `Bổ sung lần ${n}`);
const show = (l: Line, v: string | undefined) => (v === undefined || v === '' ? '' : l.kind === 'text' || l.kind === 'rate' ? v : formatVnNumber(v));

export default function CitReturnPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useRememberedFilter('cit-return', { year: dayjs().year() - 1 }, `${me?.tenantId}:${me?.userId}`);
  const [selId, setSelId] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<string, string | null>>({}); // null: bỏ ghi đè, về giá trị phần mềm tính
  const [stale, setStale] = useState<Changed[] | null>(null);
  const [signing, setSigning] = useState('');
  const dirty = Object.keys(edits).length > 0;
  const guard = useUnsavedChanges(dirty);

  const tpl = useQuery({ queryKey: ['cit-template', f.year], queryFn: () => api<Template>(`/api/cit/template?year=${f.year}`), retry: false });
  const all = useQuery({ queryKey: ['cit-returns', f.year], queryFn: () => api<CitReturn[]>(`/api/cit/returns?year=${f.year}`), retry: false });
  const rows = all.data ?? [];
  const cur = rows.find((r) => r.id === selId) ?? rows[0];
  const isDraft = cur?.status === 'draft';
  const canEdit = isDraft && can('cit.update');
  const prev = useQuery({ queryKey: ['cit-hints', cur?.id, cur?.values], enabled: !!cur && isDraft, queryFn: () => api<Preview>(`/api/cit/returns/${cur!.id}/hints`), retry: false });
  const xmlFormats = useQuery({ queryKey: ['xml-formats'], enabled: can('tax.view'), queryFn: () => api<{ id: string; verified: boolean }[]>('/api/tax/xml-formats'), retry: false });
  const xmlUnverified = xmlFormats.data?.find((x) => x.id === 'htkk-03tndn')?.verified !== true;
  const hints = prev.data?.hints ?? {}; const warnings = prev.data?.warnings ?? [];
  const reset = () => { setEdits({}); setStale(null); };
  useEffect(reset, [cur?.id]);

  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['cit-returns'] }); await qc.invalidateQueries({ queryKey: ['cit-hints'] }); };
  const fail = (e: unknown) => { void message.error((e as Error).message); };
  const payload = () => {
    const overrides: Record<string, string> = { ...(cur?.overrides ?? {}) };
    for (const [c, v] of Object.entries(edits)) { if (v === null || v === '') delete overrides[c]; else overrides[c] = v; }
    return { overrides };
  };
  const save = useMutation({ mutationFn: () => api<CitReturn>(`/api/cit/returns/${cur!.id}`, { method: 'PUT', json: payload() }), onError: fail, onSuccess: async () => { reset(); await refresh(); void message.success('Đã lưu và tính lại tờ khai'); } });
  const create = useMutation({ mutationFn: (revision?: number) => api<CitReturn>('/api/cit/returns', { method: 'POST', json: { year: f.year, ...(revision !== undefined ? { revision } : {}) } }),
    onError: async (e) => { if (e instanceof ApiError && e.code === 'TAX_RETURN_DRAFT_EXISTS') { await refresh(); setSelId((e.details as { id?: number } | undefined)?.id ?? null); } fail(e); },
    onSuccess: async (r) => { await refresh(); setSelId(r.id); } });
  const finalize = useMutation({ mutationFn: async () => { if (dirty) await api(`/api/cit/returns/${cur!.id}`, { method: 'PUT', json: payload() }); return api<CitReturn>(`/api/cit/returns/${cur!.id}/finalize`, { method: 'POST' }); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'TAX_RETURN_STALE') { setStale((e.details as { changed: Changed[] }).changed); void refresh(); } else { fail(e); void refresh(); } },
    onSuccess: async () => { reset(); await refresh(); void message.success('Đã chốt tờ khai'); } });
  const del = useMutation({ mutationFn: () => api(`/api/cit/returns/${cur!.id}`, { method: 'DELETE' }), onError: fail, onSuccess: async () => { reset(); setSelId(null); await refresh(); void message.success('Đã xóa tờ khai nháp'); } });

  const recalc = () => { if (cur && canEdit && !save.isPending) save.mutate(); };
  const confirmFinalize = () => Modal.confirm({ title: 'Chốt tờ khai 03/TNDN?', content: `${dirty ? 'Các thay đổi chưa lưu sẽ được lưu và tính lại trước khi chốt. ' : ''}Tờ khai đã chốt khóa số liệu; muốn sửa phải lập tờ khai bổ sung.`, okText: 'Chốt', cancelText: 'Hủy', onOk: () => finalize.mutateAsync().catch(() => undefined) });
  useHotkeys({ 'Ctrl+s': recalc, F9: recalc });
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target; if (!(t instanceof HTMLInputElement)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); recalc(); }
    else if (e.key === 'F9') { e.preventDefault(); recalc(); }
    else if (e.key === 'Enter') { // Enter sang ô nhập kế tiếp của lưới
      const inputs = [...document.querySelectorAll<HTMLInputElement>('input[data-cit-edit]')]; const i = inputs.indexOf(t);
      if (i >= 0) { e.preventDefault(); inputs[i + 1]?.focus(); }
    }
  };

  const shownOf = (c: string) => (c in edits ? edits[c] ?? cur?.values[c] ?? '' : cur?.values[c] ?? '');
  const setEdit = (c: string, v: string | null) => setEdits((s) => ({ ...s, [c]: v ?? '' }));
  const cell = (l: Line) => {
    if (!cur || l.kind === 'section') return null;
    if (!canEdit || !l.overridable) return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{show(l, cur.values[l.code]) || (l.kind === 'text' ? '' : '0')}</span>;
    const common = { 'aria-label': `Chỉ tiêu ${l.code}`, 'data-cit-edit': '1' };
    if (l.kind === 'text') return <Input {...common} maxLength={500} style={{ width: 240 }} value={shownOf(l.code)} onChange={(e) => setEdit(l.code, e.target.value)} />;
    if (l.kind === 'rate') return <Input {...common} inputMode="decimal" style={{ width: 90, textAlign: 'right' }} value={shownOf(l.code)} onChange={(e) => setEdit(l.code, e.target.value.trim() || null)} />;
    return <VnNumberInput {...common} style={{ width: 170 }} value={shownOf(l.code) || null} onChange={(v) => setEdit(l.code, v)} />;
  };
  const source = (l: Line) => {
    if (l.kind === 'section') return null;
    const hasOvr = l.code in edits ? !!edits[l.code] : cur?.overrides[l.code] !== undefined;
    if (hasOvr && (l.kind === 'ledger' || l.kind === 'formula')) return <Space size={4}><Tag color="orange">Ghi đè</Tag>{canEdit && <Button size="small" type="link" onClick={() => setEdits((s) => ({ ...s, [l.code]: null }))}>Bỏ ghi đè</Button>}</Space>;
    if (l.kind === 'ledger') return <Tag color="blue">Theo sổ</Tag>;
    if (l.kind === 'formula') return <Tag>{l.printed === false ? 'Gợi ý' : 'Tự tính'}</Tag>;
    return <Tag color="geekblue">Nhập tay</Tag>;
  };

  const columns: ColumnsType<Line> = [
    { title: 'STT', dataIndex: 'stt', width: 60, render: (s: string, l) => (l.kind === 'section' ? <b>{s}</b> : <Typography.Text type="secondary">{s}</Typography.Text>) },
    { title: 'Chỉ tiêu', render: (_: unknown, l) => (
      l.kind === 'section' ? <b>{l.label}</b> : <div>
        <span>{l.label}</span>
        {(l.note || l.formula) && <Tooltip title={<>{l.formula && <div>Công thức: {l.formula}</div>}{l.note && <div>{l.note}</div>}</>}><InfoCircleOutlined style={{ marginLeft: 6, opacity: 0.55 }} aria-label={`Ghi chú chỉ tiêu ${l.code}`} /></Tooltip>}
        {hints[l.code] && isDraft && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{hints[l.code]}</Typography.Text></div>}
      </div>), onCell: (l) => (l.kind === 'section' ? { colSpan: 4 } : {}) },
    { title: 'Mã', dataIndex: 'code', width: 70, render: (c: string) => <b>[{c}]</b>, onCell: (l) => (l.kind === 'section' ? { colSpan: 0 } : {}) },
    { title: 'Số tiền / giá trị', width: 200, align: 'right', render: (_: unknown, l) => cell(l), onCell: (l) => (l.kind === 'section' ? { colSpan: 0 } : {}) },
    { title: 'Nguồn', width: 150, render: (_: unknown, l) => source(l), onCell: (l) => (l.kind === 'section' ? { colSpan: 0 } : {}) },
  ];

  const exportXml = async () => {
    if (!cur) return;
    const res = await fetch(`/api/cit/returns/${cur.id}/xml`, { credentials: 'include' });
    if (!res.ok) { let m = 'Không xuất được XML'; try { m = ((await res.json()) as { error?: { message?: string } }).error?.message ?? m; } catch { /* không có thân JSON */ } void message.error(m); return; }
    const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = name ? decodeURIComponent(name) : 'to-khai-03-tndn.xml'; a.click(); URL.revokeObjectURL(url);
  };
  const signXml = async () => {
    if (!cur) return;
    try { const sid = await signDocument({ docKind: 'cit_return', docRef: String(cur.id) }, setSigning); await downloadSigned(`/api/cit/returns/${cur.id}/xml`, sid, 'to-khai-03-tndn_signed.xml'); void message.success('Đã ký số và tải XML'); }
    catch (e) { void message.error((e as Error).message); } finally { setSigning(''); }
  };

  const tplError = tpl.error as Error | null;
  const latest = rows[0];
  const changed = stale ?? prev.data?.changed ?? [];

  return (
    <div onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Quyết toán thuế TNDN (03/TNDN)</h2>
        <InputNumber aria-label="Năm" min={2000} max={2100} precision={0} value={f.year} onChange={(v) => v && guard(() => { setSelId(null); setF({ year: v }); })} style={{ width: 90 }} />
        {rows.length > 0 && <Select aria-label="Lần khai" style={{ width: 170 }} value={cur?.id ?? null} onChange={(id: number) => guard(() => setSelId(id))} options={rows.map((r) => ({ value: r.id, label: `${revisionLabel(r.revision)}${r.status === 'final' ? ' (đã chốt)' : ' (nháp)'}` }))} />}
        {cur && (cur.status === 'final' ? <Tag color="green" icon={<LockOutlined />}>Đã chốt</Tag> : <Tag color="gold">Nháp</Tag>)}
      </Space>

      {tplError && <Alert type="error" showIcon message={tplError.message} />}
      {!tplError && all.error && <Alert type="error" showIcon message={(all.error as Error).message} />}

      {!tplError && tpl.data && (
        <Space wrap>
          {!cur && can('cit.create') && <Button type="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>Tính tờ khai</Button>}
          {canEdit && <Button type="primary" loading={save.isPending} onClick={recalc}>Tính lại (F9)</Button>}
          {cur && isDraft && can('cit.delete') && <Popconfirm title="Xóa tờ khai nháp này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate()}><Button danger loading={del.isPending}>Xóa nháp</Button></Popconfirm>}
          {cur && canEdit && can('tax_return.finalize') && <Button loading={finalize.isPending} onClick={confirmFinalize}>Chốt</Button>}
          {latest && latest.status === 'final' && can('cit.create') && <Button loading={create.isPending} onClick={() => create.mutate(latest.revision + 1)}>Lập bổ sung</Button>}
          {cur && <Tooltip title={cur.status === 'final' ? (xmlUnverified ? 'XML chưa kiểm chứng với HTKK' : '') : 'Chốt tờ khai trước khi xuất XML'}><Button disabled={cur.status !== 'final'} onClick={() => void exportXml()}>Xuất XML</Button></Tooltip>}
          {cur && can('signing.use') && <Tooltip title={signing || (cur.status === 'final' ? '' : 'Chốt tờ khai trước khi ký')}><Button disabled={cur.status !== 'final'} loading={!!signing} onClick={() => void signXml()}>Ký và tải XML</Button></Tooltip>}
          {dirty && <Typography.Text type="warning">Có thay đổi chưa lưu (Ctrl+S)</Typography.Text>}
        </Space>
      )}

      {cur?.status === 'final' && xmlUnverified && <Alert type="warning" showIcon message="XML chưa kiểm chứng với HTKK" description="Tên thẻ, mã mẫu và phiên bản trong tệp là giả định tạm của phần mềm (chưa có XSD hoặc tệp mẫu 03/TNDN của HTKK). Nạp thử vào HTKK và đối chiếu số liệu trước khi nộp." />}
      {changed.length > 0 && isDraft && (
        <Alert type="error" showIcon message="Số liệu sổ đã thay đổi kể từ lần tính trước: lưu lại nháp để tính lại và kiểm tra trước khi chốt" action={can('cit.update') ? <Button size="small" loading={save.isPending} onClick={recalc}>Lưu lại nháp</Button> : undefined}
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{changed.map((c) => <li key={c.code}>[{c.code}]: đã lưu {c.stored ?? '(trống)'} → theo sổ hiện tại {c.fresh ?? '(trống)'}</li>)}</ul>} />)}
      {warnings.length > 0 && isDraft && <Alert type="warning" showIcon message="Cảnh báo" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />}

      {!tplError && tpl.data && (cur
        ? <Table<Line> size="small" bordered pagination={false} rowKey="code" dataSource={tpl.data.lines} columns={columns} loading={all.isLoading} sticky />
        : !all.isLoading && <Alert type="info" showIcon message={`Chưa có tờ khai quyết toán năm ${f.year}. Bấm Tính tờ khai để lập bản nháp theo mẫu 03/TNDN ${tpl.data.version}.`} />)}
    </div>
  );
}
