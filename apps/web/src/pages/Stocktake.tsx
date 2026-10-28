import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Input, Popconfirm, Space, Table, Tag, theme, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, parseVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, PageHeader, Toolbar, Section } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { PickDialog, quickAdd } from './voucherCommon.js';
import { QTY_RE } from './stockCalc.js';

// Kiểm kê kho: tồn sổ lấy theo (hàng, lô) cuối ngày kiểm kê; nhập số đếm, lưu, rồi điều chỉnh (lập và ghi sổ PNK cho hàng thừa, PXK cho hàng thiếu).
interface Line { itemCode: string; itemName: string; uomCode: string; lotNo: string | null; bookQty: string; countedQty: string | null; diffQty: string | null; reason: string | null }
interface Doc { id: string; no: number; docDate: string; warehouseCode: string; warehouseName: string; status: 'draft' | 'adjusted' | 'cancelled'; note: string | null; adjustVouchers: { id: string; voucherNo: string | null; voucherType: string }[]; lines: Line[] }
interface Row { itemCode: string; itemName: string; uomCode: string; lotNo: string; bookQty: string; countedQty: string; reason: string }

const STATUS: Record<Doc['status'], { label: string; color: string }> = { draft: { label: 'Nháp', color: 'default' }, adjusted: { label: 'Đã điều chỉnh', color: 'success' }, cancelled: { label: 'Đã hủy', color: 'error' } };
const REASON_LABEL: Record<string, string> = { '': 'Chưa rõ', unknown: 'Chưa rõ nguyên nhân', income: 'Thừa: ghi thu nhập khác (711)', cogs: 'Thiếu: trong định mức (632)', loss: 'Thiếu: mất mát (811)' };
const blank = (): Row => ({ itemCode: '', itemName: '', uomCode: '', lotNo: '', bookQty: '0', countedQty: '', reason: '' });
const qtyText = (s: string | null) => (s === null || s === '' ? '' : formatVnNumber(s, D(s).decimalPlaces()));
const toRows = (d: Doc): Row[] => d.lines.map((l) => ({ itemCode: l.itemCode, itemName: l.itemName, uomCode: l.uomCode, lotNo: l.lotNo ?? '', bookQty: l.bookQty, countedQty: l.countedQty === null ? '' : D(l.countedQty).toFixed(), reason: l.reason ?? '' }));
const diffOf = (r: Row) => (r.countedQty === '' ? null : D(r.countedQty).minus(r.bookQty));

export default function StocktakePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [warehouse, setWarehouse] = useState<string | null>(null);
  const [current, setCurrent] = useState<Doc | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState('');
  const [look, setLook] = useState<number | null>(null);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const editable = current?.status === 'draft' && can('stocktake.update');

  const list = useQuery({ queryKey: ['stocktakes'], queryFn: () => api<Doc[]>('/api/stocktakes'), retry: false });
  const open = (d: Doc) => { setCurrent(d); setRows(d.status === 'draft' ? [...toRows(d), blank()] : toRows(d)); setNote(d.note ?? ''); };
  const refresh = () => qc.invalidateQueries({ queryKey: ['stocktakes'] });
  const fail = (e: Error) => { void message.error(e.message); };

  const create = useMutation({
    mutationFn: () => api<Doc>('/api/stocktakes', { method: 'POST', json: { docDate: date, warehouseCode: warehouse } }),
    onSuccess: (d) => { open(d); void refresh(); void message.success(`Đã lập biên bản kiểm kê số ${d.no}: ${d.lines.length} dòng tồn sổ`); }, onError: fail,
  });
  const payload = () => ({ note: note.trim() || null, lines: rowsRef.current.filter((r) => r.itemCode.trim()).map((r) => ({ itemCode: r.itemCode.trim(), lotNo: r.lotNo.trim() || null, countedQty: r.countedQty === '' ? null : r.countedQty, reason: r.reason || null })) });
  const save = useMutation({
    mutationFn: async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); return api<Doc>(`/api/stocktakes/${current!.id}`, { method: 'PUT', json: payload() }); },
    onSuccess: (d) => { open(d); void refresh(); void message.success('Đã lưu số đếm'); }, onError: fail,
  });
  const adjust = useMutation({
    mutationFn: async () => { await save.mutateAsync(); return api<Doc>(`/api/stocktakes/${current!.id}/adjust`, { method: 'POST', json: {} }); },
    onSuccess: (d) => { open(d); void refresh(); void message.success('Đã lập và ghi sổ phiếu điều chỉnh'); }, onError: fail,
  });
  const reopen = useMutation({
    mutationFn: () => api<Doc>(`/api/stocktakes/${current!.id}/reopen`, { method: 'POST', json: {} }),
    onSuccess: (d) => { open(d); void refresh(); void message.success('Đã mở lại biên bản, phiếu điều chỉnh đã được hủy hoặc đảo'); }, onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/stocktakes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setCurrent(null); setRows([]); void refresh(); void message.success('Đã xóa biên bản'); }, onError: fail,
  });

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
      { field: 'itemCode', headerName: 'Mã hàng (F4)', width: 130, editable: (p) => !p.data?.itemName },
      { field: 'itemName', headerName: 'Tên hàng', flex: 1, minWidth: 160, editable: false },
      { field: 'uomCode', headerName: 'ĐVT', width: 80, editable: false },
      { field: 'lotNo', headerName: 'Số lô', width: 100, editable: (p) => !p.data?.itemName },
      { field: 'bookQty', headerName: 'Tồn sổ', width: 120, editable: false, ...right, valueFormatter: (p) => qtyText(p.value as string) },
      { field: 'countedQty', headerName: 'Số đếm', width: 120, ...right, valueFormatter: (p) => qtyText(p.value as string),
        valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && QTY_RE.test(n) ? n : p.oldValue; } },
      { colId: 'diff', headerName: 'Chênh lệch', width: 120, editable: false, ...right, valueGetter: (p) => (p.data ? diffOf(p.data)?.toFixed() ?? '' : ''), valueFormatter: (p) => qtyText(p.value as string),
        cellStyle: (p) => (p.value && D(p.value as string).lt(0) ? { color: token.colorError } : p.value && D(p.value as string).gt(0) ? { color: token.colorWarning } : null) },
      { field: 'reason', headerName: 'Lý do chênh lệch', width: 230, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: Object.keys(REASON_LABEL) }, valueFormatter: (p) => REASON_LABEL[(p.value as string) ?? ''] ?? '' },
    ];
  }, [token.colorError, token.colorWarning]);

  const diffs = rows.map(diffOf).filter((d) => d !== null && !d.isZero());
  const surplus = diffs.filter((d) => d!.gt(0)).length; const shortage = diffs.length - surplus;
  const lookRow = look === null ? null : rows[look];

  return (
    <>
      <PageHeader
        title="Kiểm kê kho"
        tags={current ? <Tag color={STATUS[current.status].color} style={{ marginRight: 0 }}>{STATUS[current.status].label}</Tag> : undefined}
        description={current ? `Biên bản số ${current.no} · Kho ${current.warehouseCode} - ${current.warehouseName} · Ngày ${formatVnDate(current.docDate)}` : 'Đối chiếu tồn sổ với số lượng thực tế tại kho và lập chứng từ xử lý chênh lệch'}
        extra={<>
          {current && <Button onClick={() => { setCurrent(null); setRows([]); }}>Kiểm kê mới</Button>}
          {!current && can('stocktake.create') && (
            <Button type="primary" disabled={!warehouse} loading={create.isPending} onClick={() => create.mutate()}>
              Lập biên bản kiểm kê
            </Button>
          )}
          {current && editable && <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>Lưu (Ctrl+S)</Button>}
          {current && editable && can('stock_voucher.create') && can('stock_voucher.post') && (
            <Popconfirm title="Lập và ghi sổ phiếu nhập/xuất điều chỉnh?" description="Chỉ một lần; phiếu ghi sổ theo giá tạm tính." okText="Điều chỉnh" cancelText="Không" onConfirm={() => adjust.mutate()}>
              <Button loading={adjust.isPending} disabled={!diffs.length}>Điều chỉnh chênh lệch</Button>
            </Popconfirm>
          )}
          {current?.status === 'adjusted' && can('stocktake.update') && can('stock_voucher.create') && can('stock_voucher.post') && (
            <Popconfirm title="Mở lại biên bản?" description="Phiếu điều chỉnh được bỏ ghi sổ và hủy (kỳ đã khóa thì đảo)." okText="Mở lại" cancelText="Không" onConfirm={() => reopen.mutate()}>
              <Button loading={reopen.isPending}>Mở lại</Button>
            </Popconfirm>
          )}
          {current && can('stocktake.view') && <Button onClick={() => window.open(`/api/stocktakes/${current.id}/print?format=pdf`, '_blank')}>In biên bản</Button>}
          {current && editable && can('stocktake.delete') && (
            <Popconfirm title="Xóa biên bản kiểm kê này?" okText="Xóa" cancelText="Không" onConfirm={() => remove.mutate(current.id)}>
              <Button danger>Xóa</Button>
            </Popconfirm>
          )}
        </>}
      >
        {!current && (
          <Toolbar>
            <Space size={6} align="center">
              <label htmlFor="st-date">Ngày kiểm kê</label>
              <DatePicker id="st-date" format="DD/MM/YYYY" allowClear={false} value={dayjs(date)} onChange={(d) => d && setDate(d.format('YYYY-MM-DD'))} />
            </Space>
            <Space size={6} align="center">
              <label htmlFor="st-wh">Kho</label>
              <LookupSelect id="st-wh" catalog="warehouse" quickAddFields={quickAdd} placeholder="Chọn kho (F4)" style={{ width: 260 }} value={warehouse} onChange={setWarehouse} />
            </Space>
          </Toolbar>
        )}
      </PageHeader>
      {current && (
        <>
          {current.status === 'adjusted' && (
            <Alert type="success" showIcon style={{ marginBottom: 12 }} message={<>Đã điều chỉnh bằng: {current.adjustVouchers.map((v) => <Link key={v.id} style={{ marginRight: 8 }} to="/chung-tu/$type/$id" params={{ type: v.voucherType, id: v.id }}>{v.voucherType} {v.voucherNo ?? ''}</Link>)}</>} />
          )}
          <Section title="Số liệu kiểm kê">
            {editable && <Input aria-label="Ghi chú" placeholder="Ý kiến giải quyết số chênh lệch" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 8 }} />}
            <div style={{ marginBottom: 8 }}>
              Chênh lệch: <b data-testid="st-surplus" className="kt-num">{surplus}</b> dòng thừa, <b data-testid="st-shortage" className="kt-num">{shortage}</b> dòng thiếu. Tồn sổ lấy cuối ngày kiểm kê; số đếm theo ĐVT cơ sở; dòng chưa đếm bị bỏ qua.
            </div>
            <KeyboardGrid<Row> rows={rows} columns={columns} onRowsChange={setRows} addRowTemplate={blank} readOnly={!editable} height={Math.min(560, 90 + Math.max(rows.length, 4) * 42)}
              onLookup={(col, row) => { if (editable && col === 'itemCode') setLook(row); }} />
            <PickDialog open={look !== null} catalog="item" fetcher={async (q) => api<{ id: number; code: string; name: string }[]>(`/api/lookups/items?q=${encodeURIComponent(q)}`)}
              onPick={(code) => { if (look !== null && lookRow) setRows(rows.map((r, i) => (i === look ? { ...r, itemCode: code } : r))); }} onClose={() => setLook(null)} />
          </Section>
        </>
      )}
      <Section title="Các biên bản kiểm kê gần đây" style={{ marginTop: 12 }} bodyPadding={0}>
        <Table<Doc> size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }}
          rowClassName={(d) => (d.id === current?.id ? 'ant-table-row-selected' : '')} onRow={(d) => ({ onClick: () => open(d), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Số', dataIndex: 'no', width: 70, className: 'kt-num' }, { title: 'Ngày kiểm kê', dataIndex: 'docDate', width: 130, render: (d: string) => formatVnDate(d) },
            { title: 'Kho', dataIndex: 'warehouseCode', width: 110 }, { title: 'Số dòng', width: 90, align: 'right', render: (_, d) => d.lines.length, className: 'kt-num' },
            { title: 'Trạng thái', render: (_, d) => <Tag color={STATUS[d.status].color}>{STATUS[d.status].label}</Tag> },
          ]} />
      </Section>
    </>
  );
}
