import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Select, Space, Table, Upload, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import { formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, sum } from '@kt/domain';
import { KeyboardGrid, useHotkeys } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { parseAmount } from './VoucherForm.js';

type Row = { code: string; name: string; categoryCode: string; useDate: string | null; depreciationStartDate: string | null; openingCost: string; openingAccumulated: string; openingRemainingUnits: string; badDate?: string };
interface FiscalYear { fiscalYear: number; regime: string }
interface Issue { code: string; message: string; accountCode?: string }
interface ImportResult { total: number; inserted: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }
const emptyRow = (): Row => ({ code: '', name: '', categoryCode: '', useDate: null, depreciationStartDate: null, openingCost: '0', openingAccumulated: '0', openingRemainingUnits: '' });
const DATE_ERROR = 'Ngày không hợp lệ, nhập dạng dd/mm/yyyy';
const text = (p: { newValue?: unknown }) => String(p.newValue ?? '').trim();
const unitsParser = (p: { newValue?: unknown; oldValue?: unknown }): string => {
  const t = text(p); if (t === '') return '';
  const n = parseVnNumber(t); return n !== null && /^\d{1,12}(\.\d{1,12})?$/.test(n) ? n : (p.oldValue as string | undefined) ?? '';
};
const dateCol = (field: 'useDate' | 'depreciationStartDate', headerName: string): ColDef<Row> => ({ field, headerName, width: 130,
  valueFormatter: (p) => (p.data?.badDate && p.colDef.field === field ? p.data.badDate : p.value ? formatVnDate(p.value as string) : ''),
  valueSetter: (p) => { const t = String(p.newValue ?? '').trim(); const iso = t === '' ? null : parseVnDate(t);
    if (t !== '' && iso === null) p.data.badDate = t; else { p.data[field] = iso; delete p.data.badDate; } return true; },
  tooltipValueGetter: (p) => (p.data?.badDate ? DATE_ERROR : undefined), cellEditorParams: { useFormatter: true } });
const money = (field: 'openingCost' | 'openingAccumulated', headerName: string): ColDef<Row> => ({ field, headerName, width: 150, cellClass: 'ag-right-aligned-cell',
  valueParser: (p) => parseAmount(p.newValue, p.oldValue), valueFormatter: (p) => formatVnNumber((p.value as string) || '0', 0), cellEditorParams: { useFormatter: true } });

export default function AssetOpeningPage() {
  const { can } = useAuth(); const qc = useQueryClient(); const mayEdit = can('opening_balance.update');
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const [picked, setPicked] = useState<number>();
  const fy = years.data?.find((y) => y.fiscalYear === picked) ?? years.data?.[0]; const year = fy?.fiscalYear;
  const saved = useQuery({ queryKey: ['opening-assets', year], queryFn: () => api<Row[]>(`/api/opening-assets/${year}`), enabled: year !== undefined });
  const [rows, setRows] = useState<Row[]>([emptyRow()]); const rowsRef = useRef(rows);
  const setAll = useCallback((r: Row[]) => { rowsRef.current = r; setRows(r); }, []);
  useEffect(() => { setAll([emptyRow()]); }, [year, setAll]);
  useEffect(() => { if (saved.data) setAll([...saved.data.map((r) => ({ ...r, openingRemainingUnits: r.openingRemainingUnits ?? '' })), emptyRow()]); }, [saved.data, setAll]);
  const ready = saved.isSuccess && !saved.isFetching;
  const [busy, setBusy] = useState(false); const [importing, setImporting] = useState(false); const [issues, setIssues] = useState<Issue[] | null>(null);

  const live = rows.filter((r) => r.code.trim() !== '');
  const totalCost = sum(live.map((r) => r.openingCost || '0')); const totalAcc = sum(live.map((r) => r.openingAccumulated || '0'));

  const save = async () => {
    setBusy(true);
    try {
      (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0));
      const keep = rowsRef.current.filter((r) => r.code.trim() !== '' || r.name.trim() !== '');
      const bad = keep.findIndex((r) => r.badDate); if (bad >= 0) throw new Error(`Dòng ${bad + 1}: ${DATE_ERROR}`);
      const body = keep.map((r) => ({ code: r.code.trim(), name: r.name.trim(), categoryCode: r.categoryCode.trim(), useDate: r.useDate || null, depreciationStartDate: r.depreciationStartDate || null,
        openingCost: r.openingCost || '0', openingAccumulated: r.openingAccumulated || '0', openingRemainingUnits: r.openingRemainingUnits.trim() || null }));
      try { await api(`/api/opening-assets/${year}`, { method: 'PUT', json: { rows: body } }); }
      catch (e) {
        if (e instanceof ApiError && e.code === 'VALIDATION' && Array.isArray(e.details)) throw new Error((e.details as { path: (string | number)[]; message: string }[]).slice(0, 3).map((d) => `Dòng ${Number(d.path[1]) + 1}: ${d.message}`).join('; '));
        throw e;
      }
      await qc.invalidateQueries({ queryKey: ['opening-assets', year] }); void message.success('Đã lưu thẻ tài sản đầu kỳ');
    } catch (e) { void message.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const check = async () => {
    try { setIssues((await api<Issue[]>(`/api/opening-balance/${year}/check`)).filter((i) => i.code.startsWith('ASSET_') || i.code === 'SUBLEDGER_MODULE_REQUIRED')); }
    catch (e) { void message.error(e instanceof Error ? e.message : String(e)); }
  };

  useHotkeys({ 'Ctrl+s': () => { if (mayEdit && ready && !busy) void save(); } });

  const columns = useMemo<ColDef<Row>[]>(() => [
    { field: 'code', headerName: 'Mã thẻ', width: 120, valueParser: text }, { field: 'name', headerName: 'Tên thẻ', flex: 1, valueParser: text },
    { field: 'categoryCode', headerName: 'Mã loại tài sản', width: 150, valueParser: text },
    dateCol('useDate', 'Ngày sử dụng'), dateCol('depreciationStartDate', 'Bắt đầu KH/PB'),
    money('openingCost', 'Nguyên giá / còn lại'), money('openingAccumulated', 'Hao mòn lũy kế'),
    { field: 'openingRemainingUnits', headerName: 'Số tháng còn lại', width: 140, cellClass: 'ag-right-aligned-cell', valueParser: unitsParser },
  ], []);

  return (
    <Card title="Số dư đầu kỳ tài sản" extra={<Space wrap>
      <Select style={{ width: 200 }} value={year} onChange={setPicked} loading={years.isLoading} placeholder="Chọn năm" options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear} (${y.regime})` }))} />
      {mayEdit && <Button type="primary" onClick={() => void save()} loading={busy} disabled={!ready} title="Ctrl+S">Lưu</Button>}
      <Button onClick={() => void check()} disabled={!ready}>Kiểm tra</Button>
      <Button href="/api/opening-assets/template">Tải mẫu Excel</Button>
      {mayEdit && <Button onClick={() => setImporting(true)} disabled={!ready}>Nhập Excel</Button>}
    </Space>}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Mỗi thẻ một dòng: tài sản cố định nhập nguyên giá, hao mòn lũy kế và số tháng còn lại; công cụ dụng cụ, chi phí trả trước nhập giá trị còn lại (cột Nguyên giá) và số kỳ phân bổ còn lại. Tổng thẻ theo tài khoản phải khớp số dư ở màn hình Số dư đầu kỳ. Sửa thẻ khi số dư đầu kỳ đã ghi sổ thì bỏ ghi sổ trước." />
      {saved.error && <Alert type="error" showIcon message={(saved.error as Error).message} style={{ marginBottom: 12 }} />}
      {issues && (issues.length === 0 ? <Alert type="success" showIcon style={{ marginBottom: 12 }} message="Thẻ tài sản khớp số dư tài khoản" />
        : <Alert type="error" showIcon style={{ marginBottom: 12 }} message={<ul style={{ margin: 0, paddingLeft: 18 }}>{issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>} />)}
      <KeyboardGrid<Row> rows={rows} columns={columns} readOnly={!mayEdit} onRowsChange={setAll} addRowTemplate={emptyRow} height={420} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng nguyên giá: {formatVnNumber(totalCost.toString())}</b><b>Tổng hao mòn: {formatVnNumber(totalAcc.toString())}</b>
      </div>
      {importing && year !== undefined && <ImportModal year={year} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void qc.invalidateQueries({ queryKey: ['opening-assets', year] }); }} />}
    </Card>
  );
}

function ImportModal({ year, onClose, onDone }: { year: number; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [result, setResult] = useState<ImportResult | null>(null);
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/opening-assets/${year}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = (await res.json().catch(() => ({}))) as Partial<ImportResult> & { error?: { message?: string } };
    if (!res.ok) { setResult(null); void message.error(body.error?.message ?? `Lỗi (${res.status})`); return; }
    const r = body as ImportResult; setResult(r);
    if (mode === 'commit' && r.errors.length === 0) { void message.success(`Đã nhập ${r.inserted} thẻ`); onDone(); }
  };
  return (
    <Modal open title={`Nhập thẻ tài sản đầu kỳ năm ${year} từ Excel`} onCancel={onClose} footer={null} width={720}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="Nhập Excel thay thế toàn bộ thẻ tài sản đầu kỳ đã lưu của năm này." />
        <Space>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !result || result.errors.length > 0}>Nhập</Button>
        </Space>
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errorCount ?? result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}`} dataSource={result.errors} pagination={{ pageSize: 10 }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 80 }, { title: 'Cột', dataIndex: 'column', width: 180 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Modal>
  );
}
