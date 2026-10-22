import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Select, Space, Table, Upload, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import { formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, sum } from '@kt/domain';
import { KeyboardGrid, LookupSelect, useHotkeys } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { parseAmount } from './VoucherForm.js';

// warehouseName, itemName, uomCode chỉ để hiển thị; máy chủ không nhận. Số lượng luôn theo ĐVT cơ sở của hàng.
type Row = { warehouseCode: string; warehouseName: string | null; itemCode: string; itemName: string | null; uomCode: string | null; quantity: string; value: string | null; lotNo: string; expiryDate: string | null; badDate?: string };
interface FiscalYear { fiscalYear: number; regime: string }
interface ImportResult { total: number; inserted: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }
const emptyRow = (): Row => ({ warehouseCode: '', warehouseName: null, itemCode: '', itemName: null, uomCode: null, quantity: '0', value: '0', lotNo: '', expiryDate: null });
const LOOKUP: Record<string, string> = { warehouseCode: 'warehouse', itemCode: 'item' };
const NAME_FIELD = { warehouseCode: 'warehouseName', itemCode: 'itemName' } as const;
const DATE_ERROR = 'Ngày không hợp lệ, nhập dạng dd/mm/yyyy';

const qtyParser = (newValue: unknown, oldValue: unknown): string => {
  const t = String(newValue ?? '').trim(); if (t === '') return '0';
  const n = parseVnNumber(t); return n !== null && /^\d{1,16}(\.\d{1,4})?$/.test(n) ? n : (oldValue as string | undefined) ?? '0';
};
const codeCol = (field: keyof typeof NAME_FIELD, headerName: string, width: number, after?: (d: Row) => void): ColDef<Row> => ({ field, headerName, width,
  valueSetter: (p) => { const d = p.data as unknown as Record<string, string | null>; if (d[field] === p.newValue) return false;
    d[field] = (p.newValue as string) || ''; d[NAME_FIELD[field]] = null; after?.(p.data); return true; } });

export default function OpeningStockPage() {
  const { can, me } = useAuth(); const qc = useQueryClient();
  const seeCost = !!me?.sensitive.includes('view_cost'); const mayEdit = can('opening_balance.update') && seeCost; // sửa tồn đầu kỳ kéo theo giá trị nên cần cờ giá vốn
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const [picked, setPicked] = useState<number>();
  const fy = years.data?.find((y) => y.fiscalYear === picked) ?? years.data?.[0]; const year = fy?.fiscalYear;
  const saved = useQuery({ queryKey: ['opening-stock', year], queryFn: () => api<Row[]>(`/api/opening-stock/${year}`), enabled: year !== undefined });
  const [rows, setRows] = useState<Row[]>([emptyRow()]); const rowsRef = useRef(rows);
  const setAll = useCallback((r: Row[]) => { rowsRef.current = r; setRows(r); }, []);
  useEffect(() => { setAll([emptyRow()]); }, [year, setAll]);
  useEffect(() => { if (saved.data) setAll([...saved.data, emptyRow()]); }, [saved.data, setAll]);
  const ready = saved.isSuccess && !saved.isFetching;
  const [busy, setBusy] = useState(false); const [importing, setImporting] = useState(false);
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null); const lookupBox = useRef<HTMLDivElement>(null);

  const live = rows.filter((r) => r.itemCode.trim() !== '');
  const totalValue = sum(live.map((r) => r.value || '0')); const totalQty = sum(live.map((r) => r.quantity || '0'));

  const save = async () => {
    setBusy(true);
    try {
      (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0));
      const keep = rowsRef.current.filter((r) => r.itemCode.trim() !== '' || r.warehouseCode.trim() !== '');
      const bad = keep.findIndex((r) => r.badDate); if (bad >= 0) throw new Error(`Dòng ${bad + 1}: ${DATE_ERROR}`);
      const body = keep.map((r) => ({ warehouseCode: r.warehouseCode.trim(), itemCode: r.itemCode.trim(), quantity: r.quantity || '0', value: r.value || '0', lotNo: r.lotNo || '', expiryDate: r.expiryDate || null }));
      try { await api(`/api/opening-stock/${year}`, { method: 'PUT', json: { rows: body } }); }
      catch (e) {
        if (e instanceof ApiError && e.code === 'VALIDATION' && Array.isArray(e.details)) throw new Error((e.details as { path: (string | number)[]; message: string }[]).slice(0, 3).map((d) => `Dòng ${Number(d.path[1]) + 1}: ${d.message}`).join('; '));
        throw e;
      }
      await qc.invalidateQueries({ queryKey: ['opening-stock', year] }); void message.success('Đã lưu tồn kho đầu kỳ');
    } catch (e) { void message.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  useHotkeys({ 'Ctrl+s': () => { if (mayEdit && ready && !busy) void save(); } });

  const columns = useMemo<ColDef<Row>[]>(() => [
    codeCol('warehouseCode', 'Kho (F4)', 110), { field: 'warehouseName', headerName: 'Tên kho', width: 150, editable: false },
    codeCol('itemCode', 'Mã hàng (F4)', 130, (d) => { d.uomCode = null; }), { field: 'itemName', headerName: 'Tên hàng', flex: 1, editable: false },
    { field: 'uomCode', headerName: 'ĐVT', width: 80, editable: false },
    { field: 'quantity', headerName: 'Số lượng', width: 120, cellClass: 'ag-right-aligned-cell', valueParser: (p) => qtyParser(p.newValue, p.oldValue),
      valueFormatter: (p) => formatVnNumber((p.value as string) || '0', 4).replace(/,?0+$/, '').replace(/[.,]$/, '') || '0', cellEditorParams: { useFormatter: true } },
    ...(seeCost ? [{ field: 'value', headerName: 'Giá trị', width: 140, cellClass: 'ag-right-aligned-cell', valueParser: (p) => parseAmount(p.newValue, p.oldValue),
      valueFormatter: (p) => formatVnNumber((p.value as string) || '0', 0), cellEditorParams: { useFormatter: true } } as ColDef<Row>] : []),
    { field: 'lotNo', headerName: 'Số lô', width: 110, valueParser: (p) => String(p.newValue ?? '').trim() },
    { field: 'expiryDate', headerName: 'Hạn dùng', width: 120,
      valueFormatter: (p) => p.data?.badDate ?? (p.value ? formatVnDate(p.value as string) : ''),
      valueSetter: (p) => { const t = String(p.newValue ?? '').trim(); const iso = t === '' ? null : parseVnDate(t);
        if (t !== '' && iso === null) p.data.badDate = t; else { p.data.expiryDate = iso; delete p.data.badDate; } return true; },
      cellStyle: (p) => (p.data?.badDate ? { color: '#cf1322', backgroundColor: '#fff1f0' } : { color: '', backgroundColor: '' }), tooltipValueGetter: (p) => (p.data?.badDate ? DATE_ERROR : undefined),
      cellEditorParams: { useFormatter: true } },
  ], [seeCost]);
  const onLookup = useCallback((col: string, row: number) => { if (col in LOOKUP && mayEdit) setLookup({ col, row }); }, [mayEdit]);

  return (
    <Card title="Tồn kho đầu kỳ" extra={<Space wrap>
      <Select style={{ width: 200 }} value={year} onChange={setPicked} loading={years.isLoading} placeholder="Chọn năm" options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear} (${y.regime})` }))} />
      {mayEdit && <Button type="primary" onClick={() => void save()} loading={busy} disabled={!ready} title="Ctrl+S">Lưu</Button>}
      <Button href="/api/opening-stock/template.xlsx">Tải mẫu Excel</Button>
      {mayEdit && <Button onClick={() => setImporting(true)} disabled={!ready}>Nhập Excel</Button>}
    </Space>}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Tồn đầu kỳ theo kho và lô; tổng giá trị theo từng tài khoản kho phải bằng số dư đầu kỳ đã nhập ở màn hình Số dư đầu kỳ. Ghi sổ số dư đầu kỳ sẽ sinh phiếu nhập kho ngày đầu kỳ." />
      {!seeCost && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Bạn không có quyền xem giá vốn nên không xem, sửa được tồn đầu kỳ (có giá trị)." />}
      {saved.error && <Alert type="error" showIcon message={(saved.error as Error).message} style={{ marginBottom: 12 }} />}
      <KeyboardGrid<Row> rows={rows} columns={columns} readOnly={!mayEdit} onRowsChange={setAll} addRowTemplate={emptyRow} onLookup={onLookup} height={420} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng số lượng: {formatVnNumber(totalQty.toString(), 0)}</b>{seeCost && <b>Tổng giá trị: {formatVnNumber(totalValue.toString())}</b>}
      </div>
      <Modal open={!!lookup} onCancel={() => setLookup(null)} footer={null} title="Chọn từ danh mục" destroyOnHidden afterOpenChange={(o) => { if (o) lookupBox.current?.querySelector('input')?.focus(); }}>
        {lookup && <div ref={lookupBox}><LookupSelect catalog={LOOKUP[lookup.col]!} style={{ width: '100%' }}
          onChange={(code, p) => {
            if (code !== null) { const copy = [...rowsRef.current]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code, [NAME_FIELD[lookup.col as keyof typeof NAME_FIELD]]: p?.name ?? null }; setAll(copy); }
            setLookup(null);
          }} /></div>}
      </Modal>
      {importing && year !== undefined && <ImportModal year={year} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void qc.invalidateQueries({ queryKey: ['opening-stock', year] }); }} />}
    </Card>
  );
}

function ImportModal({ year, onClose, onDone }: { year: number; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [result, setResult] = useState<ImportResult | null>(null);
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/opening-stock/${year}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = (await res.json().catch(() => ({}))) as Partial<ImportResult> & { error?: { message?: string } };
    if (!res.ok) { setResult(null); void message.error(body.error?.message ?? `Lỗi (${res.status})`); return; }
    const r = body as ImportResult; setResult(r);
    if (mode === 'commit' && r.errors.length === 0) { void message.success(`Đã nhập ${r.inserted} dòng`); onDone(); }
  };
  return (
    <Modal open title={`Nhập tồn kho đầu kỳ năm ${year} từ Excel`} onCancel={onClose} footer={null} width={720}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="Nhập Excel thay thế toàn bộ tồn kho đầu kỳ đã lưu của năm này." />
        <Space>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !result || result.errors.length > 0}>Nhập</Button>
        </Space>
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errorCount ?? result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}`} dataSource={result.errors} pagination={{ pageSize: 10 }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 80 }, { title: 'Cột', dataIndex: 'column', width: 160 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Modal>
  );
}
