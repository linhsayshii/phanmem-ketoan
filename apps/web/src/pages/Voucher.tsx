import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Popconfirm, Row, Space, Tag, Upload, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { formatVnNumber, isBalanced, parseVnNumber, sum } from '@kt/domain';
import { KeyboardGrid, LookupSelect } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import { STATE_LABEL } from './VoucherList.js';

// Các trường *Name chỉ để hiển thị; còn lại (employeeCode, dueDate, extraDims...) được giữ nguyên khi lưu lại để không mất dữ liệu chứng từ lập từ nơi khác.
export interface Line { lineNo?: number; accountCode: string; accountName?: string; partyName?: string | null; description: string | null; debit: string; credit: string; partyCode: string | null; departmentCode: string | null; projectCode: string | null; costItemCode: string | null }
interface Voucher { id: string; voucherType: string; voucherNo: string | null; postingDate: string; documentDate: string; state: string; description: string | null; partyCode: string | null; currencyCode: string; fxRate: string | null; version: number; totalDebit: string; lines: Line[] }
export const emptyLine = (): Line => ({ accountCode: '', description: null, debit: '0', credit: '0', partyCode: null, departmentCode: null, projectCode: null, costItemCode: null });
export const totals = (lines: Line[]) => ({ debit: sum(lines.map((l) => l.debit || '0')).toString(), credit: sum(lines.map((l) => l.credit || '0')).toString() });
export const cleanLines = (lines: Line[]) => lines.filter((l) => l.accountCode.trim() !== '')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .map(({ accountName, partyName, lineNo, ...rest }) => ({ ...rest, debit: rest.debit || '0', credit: rest.credit || '0' }));

// Chứng từ đã ghi sổ chỉ sửa được diễn giải và các chiều phân tích của dòng (không đổi số tiền, tài khoản, số dòng).
const META_COLS = ['description', 'departmentCode', 'projectCode', 'costItemCode'];
const LOOKUP_CATALOG: Record<string, string> = { accountCode: 'account', partyCode: 'party', departmentCode: 'department', projectCode: 'project', costItemCode: 'cost_item' };
const quickAdd = [{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }];
const iso = (d: Dayjs) => d.format('YYYY-MM-DD');
// Chỉ nhận số nguyên không âm (tiền VND); chữ khác giữ nguyên giá trị cũ thay vì âm thầm thành 0.
const numCol = (field: 'debit' | 'credit', headerName: string): ColDef<Line> => ({ field, headerName, width: 150, cellClass: 'ag-right-aligned-cell',
  valueFormatter: (p) => formatVnNumber((p.value as string) || '0'),
  valueParser: (p) => { const n = parseVnNumber(String(p.newValue ?? '')); return n !== null && /^\d{1,20}$/.test(n) ? n : (p.oldValue as string | undefined) ?? '0'; } });

export default function VoucherPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <VoucherEditor key={id} id={id} />; // đổi chứng từ (kể cả moi -> id sau khi lưu) thì dựng lại toàn bộ trạng thái nhập
}

function VoucherEditor({ id }: { id: string }) {
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const [form] = Form.useForm();
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const linesRef = useRef(lines); // bản mới nhất, đọc đồng bộ khi lưu (state có thể chưa kịp render sau khi ô vừa chốt giá trị)
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const lookupBox = useRef<HTMLDivElement>(null); // hộp thoại chọn danh mục: đưa con trỏ vào ô tìm ngay khi mở (antd Modal tự giữ tiêu điểm ở khung)
  const [idempotencyKey] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`); // (randomUUID cần HTTPS) bấm lưu hai lần liền khi tạo mới không sinh hai chứng từ
  const v = useQuery({ queryKey: ['voucher', id], queryFn: () => api<Voucher>(`/api/vouchers/${id}`), enabled: !isNew });
  const state = v.data?.state ?? 'draft';
  const editable = state === 'draft'; const metaOnly = state === 'posted'; const locked = !editable && !metaOnly;
  const setAllLines = useCallback((rows: Line[]) => { linesRef.current = rows; setLines(rows); }, []);
  useEffect(() => {
    if (!v.data) return;
    form.setFieldsValue({ ...v.data, postingDate: dayjs(v.data.postingDate), documentDate: dayjs(v.data.documentDate) });
    setAllLines(v.data.state === 'draft' ? [...v.data.lines, emptyLine()] : v.data.lines);
  }, [v.data, form, setAllLines]);
  const postingDate = Form.useWatch('postingDate', form) as Dayjs | undefined;
  const postingIso = postingDate?.isValid() ? iso(postingDate) : undefined;
  const accountFetcher = useMemo(() => accountFetcherFor(postingIso), [postingIso]);
  const t = totals(lines); const balanced = isBalanced(cleanLines(lines).map((l) => ({ debit: l.debit, credit: l.credit })));

  const invalidate = (voucherId = id) => { void qc.invalidateQueries({ queryKey: ['voucher', voucherId] }); void qc.invalidateQueries({ queryKey: ['vouchers'] }); };
  const onErr = (e: unknown) => void message.error(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
  // Ô đang gõ dở chưa vào state: rời ô để lưới chốt giá trị trước khi lấy dòng (Ctrl+S/F9 khi con trỏ còn trong ô).
  const flushEditing = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); };
  const body = (f: { postingDate: Dayjs; documentDate: Dayjs; description?: string | null; partyCode?: string | null }) => ({
    voucherType: 'PKT', postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), description: f.description ?? null, partyCode: f.partyCode ?? null,
    currencyCode: v.data?.currencyCode ?? 'VND', ...(v.data?.fxRate ? { fxRate: v.data.fxRate } : {}), lines: cleanLines(linesRef.current) });
  // Lưu bản đang nhập; ghi sổ (F9) lưu trước rồi mới ghi để không ghi sổ bản cũ trên máy chủ.
  const persist = async (postAfter: boolean): Promise<Voucher> => {
    await flushEditing();
    const f = await form.validateFields();
    if (isNew) return api<Voucher>('/api/vouchers', { method: 'POST', json: { ...body(f), idempotencyKey, ...(postAfter ? { autoPost: true } : {}) } });
    // sửa chứng từ đã ghi sổ: định vị dòng theo lineNo của máy chủ, không theo vị trí trên lưới
    const meta = linesRef.current.filter((l) => l.lineNo !== undefined).map((l) => ({ lineNo: l.lineNo!, description: l.description, departmentCode: l.departmentCode, projectCode: l.projectCode, costItemCode: l.costItemCode }));
    const saved = await api<Voucher>(`/api/vouchers/${id}`, { method: 'PUT', json: editable ? { ...body(f), version: v.data!.version } : { version: v.data!.version, description: f.description ?? null, lines: meta } });
    if (!postAfter) return saved;
    // đã lưu mà ghi sổ lỗi (chứng từ lệch, kỳ khóa...): tải lại để version khớp với bản vừa lưu, lần Ctrl+S sau không bị VERSION_CONFLICT
    return api<Voucher>(`/api/vouchers/${id}/post`, { method: 'POST', json: {} }).catch((e: unknown) => { invalidate(); throw e; });
  };
  const save = useMutation({ mutationFn: (postAfter: boolean) => persist(postAfter), onError: onErr,
    onSuccess: (r, postAfter) => {
      void message.success(postAfter ? 'Đã ghi sổ' : 'Đã lưu');
      invalidate(r.id); // luôn tải lại: một lần tải đang chạy từ trước khi ghi sổ không được ghi đè trạng thái mới
      if (isNew) void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: r.id } });
    } });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<Voucher>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }), onError: onErr,
    onSuccess: (r, p) => { void message.success({ unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy', duplicate: 'Đã nhân bản' }[p.act] ?? 'Xong');
      if (p.act === 'reverse' || p.act === 'duplicate') void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: r.id } }); else invalidate(); } });

  const canPost = (isNew || editable) && can('voucher.post');
  const canSave = !locked && (isNew ? can('voucher.create') : can('voucher.update'));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (canSave && !save.isPending) save.mutate(false); }
      if (e.key === 'F9') { e.preventDefault(); if (canPost && canSave && !save.isPending) save.mutate(true); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [save, canSave, canPost]);

  const columns = useMemo<ColDef<Line>[]>(() => ([
    { field: 'accountCode', headerName: 'TK (F4)', width: 110 }, { field: 'description', headerName: 'Diễn giải', flex: 1 },
    numCol('debit', 'Nợ'), numCol('credit', 'Có'),
    { field: 'partyCode', headerName: 'Đối tượng (F4)', width: 130 }, { field: 'departmentCode', headerName: 'Bộ phận', width: 100 },
    { field: 'projectCode', headerName: 'Vụ việc', width: 100 }, { field: 'costItemCode', headerName: 'Khoản mục', width: 110 },
  ] satisfies ColDef<Line>[]).map((c) => ({ ...c, editable: editable || (metaOnly && META_COLS.includes(c.field as string)) })), [editable, metaOnly]);
  // Chứng từ đã ghi sổ: không thêm/xóa dòng (lineNo của máy chủ phải khớp).
  const onRowsChange = useCallback((rows: Line[]) => { if (editable || rows.length === linesRef.current.length) setAllLines(rows); }, [editable, setAllLines]);
  const onLookup = useCallback((col: string, row: number) => { if (col in LOOKUP_CATALOG && (editable || (metaOnly && META_COLS.includes(col)))) setLookup({ col, row }); }, [editable, metaOnly]);

  return (
    <Card title={<Space><span>Phiếu kế toán {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
        {canSave && <Button onClick={() => save.mutate(false)} type="primary" loading={save.isPending}>Lưu (Ctrl+S)</Button>}
        {canPost && canSave && <Button onClick={() => save.mutate(true)} disabled={!balanced || save.isPending}>Ghi sổ (F9)</Button>}
        {!isNew && state === 'posted' && can('voucher.unpost') && can('voucher.edit_posted') && <Button onClick={() => action.mutate({ act: 'unpost' })}>Bỏ ghi sổ</Button>}
        {!isNew && state === 'posted' && can('voucher.post') && <Button onClick={() => Modal.confirm({ title: 'Lập chứng từ đảo?', content: 'Chứng từ đảo ghi sổ ngay với ngày hôm nay.', onOk: () => action.mutate({ act: 'reverse', body: { postingDate: dayjs().format('YYYY-MM-DD') } }) })}>Đảo</Button>}
        {!isNew && editable && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy chứng từ?', content: 'Số chứng từ (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
        {!isNew && can('voucher.create') && <Button onClick={() => action.mutate({ act: 'duplicate', body: { postingDate: dayjs().format('YYYY-MM-DD') } })}>Nhân bản</Button>}
        {!isNew && can('voucher.print') && <Button href={`/api/vouchers/${id}/print?format=pdf`} target="_blank">In</Button>}
      </Space>}>
      {v.error && <Alert type="error" showIcon message={(v.error as Error).message} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" initialValues={{ postingDate: dayjs(), documentDate: dayjs() }}>
        <Row gutter={12}>
          <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabled={!editable} /></Form.Item></Col>
          <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabled={!editable} /></Form.Item></Col>
          <Col span={6}><Form.Item label="Đối tượng" name="partyCode"><LookupSelect catalog="party" disabled={!editable} quickAddFields={quickAdd} /></Form.Item></Col>
          <Col span={10}><Form.Item label="Diễn giải" name="description"><Input disabled={locked} /></Form.Item></Col>
        </Row>
      </Form>
      <KeyboardGrid<Line> rows={lines} columns={columns} readOnly={locked} onRowsChange={onRowsChange} addRowTemplate={emptyLine} onLookup={onLookup} height={360} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng Nợ: {formatVnNumber(t.debit)}</b><b>Tổng Có: {formatVnNumber(t.credit)}</b>
        {!balanced && <Tag color="red">Chênh lệch {formatVnNumber(sum([t.debit, `-${t.credit}`]).toString())}</Tag>}
      </div>
      {!isNew && <Attachments voucherId={id} canEdit={can('voucher.update')} />}
      <Modal open={!!lookup} onCancel={() => setLookup(null)} footer={null} title="Chọn từ danh mục" destroyOnHidden afterOpenChange={(o) => { if (o) lookupBox.current?.querySelector('input')?.focus(); }}>
        {lookup && <div ref={lookupBox}><LookupSelect catalog={LOOKUP_CATALOG[lookup.col]!} style={{ width: '100%' }} {...(lookup.col === 'accountCode' ? { fetcher: accountFetcher } : { quickAddFields: quickAdd })}
          onChange={(code) => { if (code !== null) { const copy = [...linesRef.current]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code }; setAllLines(copy); } setLookup(null); }} /></div>}
      </Modal>
    </Card>
  );
}

function Attachments({ voucherId, canEdit }: { voucherId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['attachments', voucherId];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ id: string; fileName: string; bytes: number }[]>(`/api/vouchers/${voucherId}/attachments`) });
  const remove = (attId: string) => api(`/api/attachments/${attId}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: key })).catch((e: unknown) => void message.error((e as Error).message));
  return (
    <div style={{ marginTop: 16 }}>
      <Space wrap>
        <b>Đính kèm:</b>
        {(list.data ?? []).map((a) => <span key={a.id}><a href={`/api/attachments/${a.id}`}>{a.fileName}</a> ({Math.ceil(a.bytes / 1024)} KB)
          {canEdit && <Popconfirm title="Xóa tệp đính kèm?" okText="Xóa" cancelText="Không" onConfirm={() => remove(a.id)}><Button type="link" size="small" danger aria-label={`Xóa ${a.fileName}`}>✕</Button></Popconfirm>}</span>)}
        {canEdit && <Upload showUploadList={false} customRequest={async ({ file, onSuccess, onError }) => {
          const fd = new FormData(); fd.append('file', file as File);
          const r = await fetch(`/api/vouchers/${voucherId}/attachments`, { method: 'POST', body: fd, credentials: 'include' });
          if (r.ok) { onSuccess?.(await r.json()); void qc.invalidateQueries({ queryKey: key }); }
          else { const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null; const msg = e?.error?.message ?? `Lỗi tải lên (${r.status})`; void message.error(msg); onError?.(new Error(msg)); } }}><Button size="small">Thêm tệp</Button></Upload>}
      </Space>
    </div>
  );
}
