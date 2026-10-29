import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Popconfirm, Select, Space, Table, Tag, theme, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, parseVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, Section } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { EventDialog, type DialogAsset, type EventKindName } from './assetDialogs.js';
import { QTY_RE } from './stockCalc.js';

// Kiểm kê TSCĐ, CCDC (05 - TSCĐ): điền số sổ sách tại ngày kiểm kê, nhập số lượng kiểm kê, lưu, hoàn thành, in biên bản.
// Chênh lệch không tự ghi sổ: dòng thiếu gợi ý Ghi giảm, dòng thừa gợi ý Ghi tăng (mở hộp thoại biến động của thẻ).
interface Line { assetId: number; code: string; name: string; uom: string | null; departmentCode: string | null; bookQuantity: string; actualQuantity: string | null; diffQuantity: string | null;
  bookCost: string; bookNbv: string; actualCost: string | null; actualNbv: string | null; diffCost: string | null; diffNbv: string | null; condition: string | null; note: string | null; suggestion: 'decrease' | 'increase' | null }
interface Doc { id: number; kind: 'fixed' | 'tool'; countDate: string; departmentCode: string | null; departmentName: string | null; note: string | null; status: 'draft' | 'done'; lines: Line[]; lineCount?: number }
interface Row { assetId: number; code: string; name: string; bookQuantity: string; actualQuantity: string; bookCost: string; bookNbv: string; condition: string; note: string }
interface Card extends DialogAsset { kind: string }

const KIND = { fixed: 'Tài sản cố định', tool: 'Công cụ dụng cụ' } as const;
const STATUS: Record<Doc['status'], { label: string; color: string }> = { draft: { label: 'Nháp', color: 'default' }, done: { label: 'Đã hoàn thành', color: 'success' } };
const qtyText = (s: string | null) => (s === null || s === '' ? '' : formatVnNumber(s, D(s).decimalPlaces()));
const moneyText = (s: string | null) => (s === null ? '' : formatVnNumber(s, 0));
const toRows = (d: Doc): Row[] => d.lines.map((l) => ({ assetId: l.assetId, code: l.code, name: l.name, bookQuantity: l.bookQuantity, actualQuantity: l.actualQuantity === null ? '' : D(l.actualQuantity).toFixed(), bookCost: l.bookCost, bookNbv: l.bookNbv, condition: l.condition ?? '', note: l.note ?? '' }));
const diffOf = (r: Row) => (r.actualQuantity === '' ? null : D(r.actualQuantity).minus(r.bookQuantity));

export default function AssetCountPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Doc['kind']>('fixed');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [dept, setDept] = useState<string | null>(null);
  const [current, setCurrent] = useState<Doc | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dialog, setDialog] = useState<{ card: Card; kind: EventKindName } | null>(null);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const editable = current?.status === 'draft' && can('asset.update');

  const list = useQuery({ queryKey: ['asset-counts'], queryFn: () => api<Doc[]>('/api/asset-counts'), retry: false });
  const open = (d: Doc) => { setCurrent(d); setRows(toRows(d)); };
  const refresh = () => qc.invalidateQueries({ queryKey: ['asset-counts'] });
  const fail = (e: Error) => { void message.error(e.message); };
  const base = (id: number) => `/api/asset-counts/${id}`;

  const create = useMutation({
    mutationFn: () => api<Doc>('/api/asset-counts', { method: 'POST', json: { kind, countDate: date, departmentCode: dept } }),
    onSuccess: (d) => { open(d); void refresh(); void message.success('Đã lập biên bản kiểm kê; bấm Điền số sổ sách để lấy tài sản tại ngày kiểm kê'); }, onError: fail,
  });
  const fill = useMutation({
    mutationFn: async () => { await saveNow(); return api<Doc>(`${base(current!.id)}/fill`, { method: 'POST' }); },
    onSuccess: (d) => { open(d); void refresh(); void message.success(`Đã điền ${d.lines.length} dòng số sổ sách tại ${formatVnDate(d.countDate)}`); }, onError: fail,
  });
  const saveNow = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0));
    return api<Doc>(base(current!.id), { method: 'PUT', json: { lines: rowsRef.current.map((r) => ({ assetId: r.assetId, actualQuantity: r.actualQuantity === '' ? null : r.actualQuantity, condition: r.condition.trim() || null, note: r.note.trim() || null })) } }); };
  const save = useMutation({ mutationFn: saveNow, onSuccess: (d) => { open(d); void refresh(); void message.success('Đã lưu số kiểm kê'); }, onError: fail });
  const finish = useMutation({
    mutationFn: async () => { await saveNow(); return api<Doc>(`${base(current!.id)}/finish`, { method: 'POST' }); },
    onSuccess: (d) => { open(d); void refresh(); void message.success('Đã hoàn thành biên bản kiểm kê'); }, onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api<void>(base(id), { method: 'DELETE' }),
    onSuccess: () => { setCurrent(null); setRows([]); void refresh(); void message.success('Đã xóa biên bản'); }, onError: fail,
  });
  // Mở hộp thoại biến động của thẻ: cần phân bổ chi phí hiện hành nên đọc lại thẻ.
  const suggest = async (l: Line) => {
    try { const a = await api<Card>(`/api/assets/${l.assetId}`); setDialog({ card: a, kind: l.suggestion === 'decrease' ? (current!.kind === 'fixed' ? 'decrease' : 'decrease-tool') : 'increase' }); } catch (e) { fail(e as Error); }
  };

  const saveRef = useRef(() => {}); saveRef.current = () => { if (editable && !save.isPending) save.mutate(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return;
      saveRef.current();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { token } = theme.useToken();
  const columns = useMemo<ColDef<Row>[]>(() => {
    const right = { cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header' };
    return [
      { field: 'code', headerName: 'Mã', width: 120, editable: false }, { field: 'name', headerName: 'Tên', flex: 1, minWidth: 180, editable: false },
      { field: 'bookQuantity', headerName: 'SL sổ sách', width: 110, editable: false, ...right, valueFormatter: (p) => qtyText(p.value as string) },
      { field: 'bookCost', headerName: 'Nguyên giá sổ', width: 140, editable: false, ...right, valueFormatter: (p) => moneyText(p.value as string) },
      { field: 'bookNbv', headerName: 'Còn lại sổ', width: 140, editable: false, ...right, valueFormatter: (p) => moneyText(p.value as string) },
      { field: 'actualQuantity', headerName: 'SL kiểm kê', width: 110, ...right, valueFormatter: (p) => qtyText(p.value as string),
        valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && QTY_RE.test(n) ? n : p.oldValue; } },
      { colId: 'diff', headerName: 'Chênh lệch SL', width: 120, editable: false, ...right, valueGetter: (p) => (p.data ? diffOf(p.data)?.toFixed() ?? '' : ''), valueFormatter: (p) => qtyText(p.value as string),
        cellStyle: (p) => (p.value && D(p.value as string).lt(0) ? { color: token.colorError } : p.value && D(p.value as string).gt(0) ? { color: token.colorWarning } : null) },
      { field: 'condition', headerName: 'Tình trạng', width: 140 }, { field: 'note', headerName: 'Ghi chú', width: 180 },
    ];
  }, [token.colorError, token.colorWarning]);

  const diffs = rows.map(diffOf).filter((d) => d !== null && !d.isZero());
  const missing = diffs.filter((d) => d!.lt(0)).length; const surplus = diffs.length - missing;
  const suggestions = (current?.lines ?? []).filter((l) => l.suggestion);

  return (
    <>
      <PageHeader
        title="Kiểm kê tài sản"
        description="Điền số sổ sách tại ngày kiểm kê, nhập số lượng kiểm kê, lưu, hoàn thành, in biên bản"
        tags={current ? <Tag color={STATUS[current.status].color} style={{ marginRight: 0 }}>{STATUS[current.status].label}</Tag> : undefined}
        extra={<>
          {current && <Button onClick={() => { setCurrent(null); setRows([]); }}>Kiểm kê mới</Button>}
          {!current && can('asset.create') && (
            <Button type="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Lập biên bản kiểm kê
            </Button>
          )}
          {current && editable && <Button loading={fill.isPending} onClick={() => fill.mutate()}>Điền số sổ sách</Button>}
          {current && editable && <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>Lưu (Ctrl+S)</Button>}
          {current && editable && (
            <Popconfirm title="Hoàn thành biên bản kiểm kê?" description="Sau khi hoàn thành không sửa số kiểm kê được." okText="Hoàn thành" cancelText="Không" onConfirm={() => finish.mutate()}>
              <Button loading={finish.isPending} disabled={!rows.length}>Hoàn thành</Button>
            </Popconfirm>
          )}
          {current && can('asset.view') && <Button onClick={() => window.open(`/api/print/asset-count/${current.id}?format=pdf`, '_blank')}>In biên bản</Button>}
          {current && editable && can('asset.delete') && (
            <Popconfirm title="Xóa biên bản kiểm kê này?" okText="Xóa" cancelText="Không" onConfirm={() => remove.mutate(current.id)}>
              <Button danger>Xóa</Button>
            </Popconfirm>
          )}
        </>}
      >
        {!current && can('asset.create') && (
          <Toolbar>
            <Space size={6} align="center">
              <label htmlFor="ac-kind">Đối tượng kiểm kê</label>
              <Select id="ac-kind" style={{ width: 200 }} value={kind} onChange={(v) => setKind(v)} options={[{ value: 'fixed', label: KIND.fixed }, { value: 'tool', label: KIND.tool }]} />
            </Space>
            <Space size={6} align="center">
              <label htmlFor="ac-date">Ngày kiểm kê</label>
              <DatePicker id="ac-date" format="DD/MM/YYYY" allowClear={false} value={dayjs(date)} onChange={(d) => d && setDate(d.format('YYYY-MM-DD'))} />
            </Space>
            <Space size={6} align="center">
              <label htmlFor="ac-dept">Bộ phận (để trống: toàn đơn vị)</label>
              <LookupSelect id="ac-dept" catalog="department" allowClear placeholder="Bộ phận (F4)" style={{ width: 240 }} value={dept} onChange={(v) => setDept(v ?? null)} />
            </Space>
          </Toolbar>
        )}
      </PageHeader>
      {current && (
        <Section title={<Space size="middle"><b>Biên bản số {current.id}</b><span>{KIND[current.kind]}</span><span>Ngày {formatVnDate(current.countDate)}</span>{current.departmentName && <span>Bộ phận {current.departmentName}</span>}</Space>}>
          <div style={{ marginBottom: 8 }}>
            Chênh lệch: <b data-testid="ac-missing" className="kt-num">{missing}</b> dòng thiếu, <b data-testid="ac-surplus" className="kt-num">{surplus}</b> dòng thừa. Số sổ sách lấy tại ngày kiểm kê; nguyên giá và giá trị còn lại theo kiểm kê tính theo tỷ lệ số lượng.
          </div>
          <KeyboardGrid<Row> rows={rows} columns={columns} onRowsChange={setRows} addRowTemplate={() => ({ assetId: 0, code: '', name: '', bookQuantity: '0', actualQuantity: '', bookCost: '0', bookNbv: '0', condition: '', note: '' })}
            lockRows readOnly={!editable} height={Math.min(560, 90 + Math.max(rows.length, 4) * 42)} />
          {suggestions.length > 0 && (
            <Alert type="warning" showIcon style={{ marginTop: 12 }} message="Xử lý chênh lệch: biên bản không tự ghi sổ; lập biến động cho từng thẻ"
              description={<Table<Line> size="small" rowKey="assetId" pagination={false} dataSource={suggestions} columns={[
                { title: 'Mã', dataIndex: 'code', width: 120 }, { title: 'Tên', dataIndex: 'name' },
                { title: 'Chênh lệch SL', dataIndex: 'diffQuantity', align: 'right', render: qtyText, className: 'kt-num' }, { title: 'Chênh lệch nguyên giá', dataIndex: 'diffCost', align: 'right', render: moneyText, className: 'kt-num' },
                { title: '', width: 120, render: (_, l) => (can('asset.update') ? <Button size="small" onClick={() => void suggest(l)}>{l.suggestion === 'decrease' ? 'Ghi giảm' : 'Ghi tăng'}</Button> : null) }]} />} />)}
          {dialog && <EventDialog asset={dialog.card} kind={dialog.kind} onClose={() => setDialog(null)} onDone={() => void refresh()} />}
        </Section>
      )}
      <Section title="Các biên bản kiểm kê gần đây" style={{ marginTop: 16 }} bodyPadding={0}>
        <Table<Doc> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }}
          rowClassName={(d) => (d.id === current?.id ? 'ant-table-row-selected' : '')} onRow={(d) => ({ onClick: () => { api<Doc>(base(d.id)).then(open, fail); }, style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Số', dataIndex: 'id', width: 70, className: 'kt-num' }, { title: 'Đối tượng', dataIndex: 'kind', render: (k: Doc['kind']) => KIND[k] }, { title: 'Ngày kiểm kê', dataIndex: 'countDate', width: 130, render: (d: string) => formatVnDate(d) },
            { title: 'Số dòng', width: 90, align: 'right', render: (_, d) => d.lineCount ?? d.lines.length, className: 'kt-num' }, { title: 'Trạng thái', render: (_, d) => <Tag color={STATUS[d.status].color}>{STATUS[d.status].label}</Tag> },
          ]} />
      </Section>
    </>
  );
}
