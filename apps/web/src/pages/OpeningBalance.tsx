import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Select, Space, Table, Tag, Upload, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef } from 'ag-grid-community';
import { D, formatVnNumber, parseVnNumber, sum } from '@kt/domain';
import { KeyboardGrid, LookupSelect } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor } from '../lookups.js';
import { parseAmount } from './Voucher.js';

// accountName, partyName và id chỉ để hiển thị; máy chủ không nhận.
type Row = { accountCode: string; accountName: string; partyCode: string | null; partyName: string | null; currencyCode: string; debit: string; credit: string; debitCurrency: string; creditCurrency: string };
interface Issue { code: string; message: string; accountCode?: string; partyCode?: string | null }
interface FiscalYear { fiscalYear: number; regime: string; dateFrom: string }
interface ImportResult { total: number; inserted: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }
const emptyRow = (): Row => ({ accountCode: '', accountName: '', partyCode: null, partyName: null, currencyCode: 'VND', debit: '0', credit: '0', debitCurrency: '0', creditCurrency: '0' });
const LOOKUP_CATALOG: Record<string, string> = { accountCode: 'account', partyCode: 'party' };
const quickAdd = [{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }];

// Ô nguyên tệ: tối đa 4 số lẻ, không âm; để trống là 0, chữ sai thì giữ giá trị cũ (như parseAmount của phiếu kế toán).
const parseForeign = (newValue: unknown, oldValue: unknown): string => {
  const text = String(newValue ?? '').trim();
  if (text === '') return '0';
  const n = parseVnNumber(text);
  return n !== null && /^\d{1,16}(\.\d{1,4})?$/.test(n) ? n : (oldValue as string | undefined) ?? '0';
};
const numCol = (field: keyof Row, headerName: string, foreign: boolean): ColDef<Row> => ({ field, headerName, width: 140, cellClass: 'ag-right-aligned-cell',
  valueFormatter: (p) => { const v = (p.value as string) || '0'; return formatVnNumber(v, foreign ? D(v).decimalPlaces() : 0); },
  valueParser: (p) => (foreign ? parseForeign(p.newValue, p.oldValue) : parseAmount(p.newValue, p.oldValue)),
  cellEditorParams: { useFormatter: true } }); // ô sửa hiện số dạng 1.500.000 để parseVnNumber đọc lại được
// Đổi mã thì xóa tên cũ (tên đúng chỉ có sau khi lưu hoặc chọn từ danh mục), không để tên của mã trước lại bên cạnh mã mới.
const codeCol = (field: 'accountCode' | 'partyCode', nameField: 'accountName' | 'partyName', headerName: string, width: number): ColDef<Row> => ({ field, headerName, width,
  valueSetter: (p) => {
    const d = p.data as Record<string, string | null>; const empty = field === 'partyCode' ? null : ''; // mã đối tượng trống là null, mã tài khoản trống là ''
    if (d[field] === p.newValue) return false;
    d[field] = (p.newValue as string) || empty; d[nameField] = empty; return true;
  } });

// Lỗi 400 của máy chủ chỉ nêu chỉ số dòng gửi lên (đã bỏ dòng trống): đổi sang số dòng trên lưới.
function explain(e: unknown, gridRow: number[]): string {
  if (!(e instanceof ApiError)) return String(e);
  if (e.code === 'DUPLICATE') return 'Có dòng trùng (cùng tài khoản, đối tượng và loại tiền)';
  if (e.code === 'VALIDATION' && Array.isArray(e.details))
    return (e.details as { path: (string | number)[]; message: string }[]).slice(0, 3).map((d) => `Dòng ${(gridRow[Number(d.path[1])] ?? 0) + 1}: ${d.message}`).join('; ');
  return `${e.message} (${e.code})`;
}

export default function OpeningBalancePage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const [picked, setPicked] = useState<number>();
  const fy = years.data?.find((y) => y.fiscalYear === picked) ?? years.data?.[0]; // mặc định năm đầu tiên: số dư đầu kỳ chỉ nhập cho năm đầu
  const year = fy?.fiscalYear;
  const saved = useQuery({ queryKey: ['opening', year], queryFn: () => api<Row[]>(`/api/opening-balance/${year}`), enabled: year !== undefined });
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const rowsRef = useRef(rows); // bản mới nhất, đọc đồng bộ khi lưu (ô vừa chốt giá trị có thể chưa kịp render)
  const setAll = useCallback((r: Row[]) => { rowsRef.current = r; setRows(r); }, []);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [posted, setPosted] = useState<{ voucherNo: string | null; postingDate: string } | null>(null);
  // Đổi năm: bỏ dòng và kết quả của năm cũ ngay (không để dòng năm cũ nằm đó trong lúc tải, rồi bị lưu đè lên năm mới); effect này đứng trước effect nạp dữ liệu.
  useEffect(() => { setAll([emptyRow()]); setIssues(null); setPosted(null); }, [year, setAll]);
  useEffect(() => { if (saved.data) setAll([...saved.data, emptyRow()]); }, [saved.data, setAll]);
  const ready = saved.isSuccess && !saved.isFetching; // lưới đã khớp dữ liệu máy chủ của năm đang chọn
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const lookupBox = useRef<HTMLDivElement>(null);
  // Kỳ 0 nằm ngoài các tháng của năm nên tra hệ tài khoản theo ngày đầu năm (hệ tài khoản gắn với năm tài chính).
  const accountFetcher = useMemo(() => accountFetcherFor(fy?.dateFrom), [fy?.dateFrom]);
  const mayEdit = can('opening_balance.update');

  const live = rows.filter((r) => r.accountCode.trim() !== '');
  const td = sum(live.map((r) => r.debit || '0')); const tc = sum(live.map((r) => r.credit || '0'));

  // Ô đang gõ dở chưa vào state: rời ô để lưới chốt giá trị trước khi lấy dòng.
  const flushEditing = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); };
  const persist = async () => {
    await flushEditing();
    const keep = rowsRef.current.map((r, i) => [r, i] as const).filter(([r]) => r.accountCode.trim() !== '');
    const body = keep.map(([r]) => ({ accountCode: r.accountCode.trim(), partyCode: r.partyCode || null, currencyCode: r.currencyCode || 'VND',
      debit: r.debit || '0', credit: r.credit || '0', debitCurrency: r.debitCurrency || '0', creditCurrency: r.creditCurrency || '0' }));
    try { await api(`/api/opening-balance/${year}`, { method: 'PUT', json: { rows: body } }); }
    catch (e) { throw new Error(explain(e, keep.map(([, i]) => i))); }
    await qc.invalidateQueries({ queryKey: ['opening', year] });
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { void message.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const save = () => run(async () => { await persist(); setPosted(null); void message.success('Đã lưu'); });
  // Người chỉ xem không lưu được (403): kiểm tra thẳng bản đã lưu.
  const check = () => run(async () => { if (mayEdit) await persist(); setPosted(null); setIssues(await api<Issue[]>(`/api/opening-balance/${year}/check`)); });
  // Ghi sổ lưu trước rồi mới ghi, để không ghi sổ bản cũ trên máy chủ.
  const post = () => run(async () => {
    await persist(); setPosted(null);
    try {
      const v = await api<{ voucherNo: string | null; postingDate: string }>(`/api/opening-balance/${year}/post`, { method: 'POST', json: {} });
      setIssues(null); setPosted(v); void message.success(`Đã ghi sổ chứng từ ${v.voucherNo}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OPENING_INVALID') { setIssues(e.details as Issue[]); throw new Error('Số dư đầu kỳ chưa hợp lệ, xem danh sách lỗi'); }
      throw e;
    }
  });

  const columns = useMemo<ColDef<Row>[]>(() => [
    codeCol('accountCode', 'accountName', 'TK (F4)', 110), { field: 'accountName', headerName: 'Tên tài khoản', flex: 1, editable: false },
    codeCol('partyCode', 'partyName', 'Đối tượng (F4)', 130), { field: 'currencyCode', headerName: 'Loại tiền', width: 90, valueParser: (p) => String(p.newValue ?? '').trim().toUpperCase() },
    numCol('debit', 'Dư Nợ', false), numCol('credit', 'Dư Có', false), numCol('debitCurrency', 'Dư Nợ NT', true), numCol('creditCurrency', 'Dư Có NT', true),
  ], []);
  const onLookup = useCallback((col: string, row: number) => { if (col in LOOKUP_CATALOG && mayEdit) setLookup({ col, row }); }, [mayEdit]);

  return (
    <Card title="Số dư đầu kỳ" extra={<Space wrap>
      <Select style={{ width: 200 }} value={year} onChange={setPicked} loading={years.isLoading} placeholder="Chọn năm"
        options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear} (${y.regime})` }))} />
      {mayEdit && <Button type="primary" onClick={() => void save()} loading={busy} disabled={!ready}>Lưu</Button>}
      <Button onClick={() => void check()} disabled={busy || !ready}>Kiểm tra</Button>
      {mayEdit && <Button onClick={() => void post()} disabled={busy || !ready}>Ghi sổ số dư đầu kỳ</Button>}
      <Button href="/api/opening-balance/template.xlsx">Tải mẫu Excel</Button>
      {mayEdit && <Button onClick={() => setImporting(true)} disabled={!ready}>Nhập Excel</Button>}
    </Space>}>
      {saved.error && <Alert type="error" showIcon message={(saved.error as Error).message} style={{ marginBottom: 12 }} />}
      {posted && <Alert type="success" showIcon style={{ marginBottom: 12 }} message={`Đã ghi sổ chứng từ số dư đầu kỳ ${posted.voucherNo ?? ''} (loại DK, ngày ${posted.postingDate.split('-').reverse().join('/')})`} />}
      {issues && (issues.length === 0
        ? <Alert type="success" showIcon message="Số dư đầu kỳ hợp lệ" style={{ marginBottom: 12 }} />
        : <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`${issues.length} lỗi, chưa ghi sổ được`} description={<ul style={{ margin: 0, paddingLeft: 20 }}>{issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>} />)}
      <KeyboardGrid<Row> rows={rows} columns={columns} readOnly={!mayEdit} onRowsChange={setAll} addRowTemplate={emptyRow} onLookup={onLookup} height={420} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng dư Nợ: {formatVnNumber(td.toString())}</b><b>Tổng dư Có: {formatVnNumber(tc.toString())}</b>
        {!td.equals(tc) && <Tag color="red">Chênh lệch {formatVnNumber(td.minus(tc).toString())}</Tag>}
      </div>
      <Modal open={!!lookup} onCancel={() => setLookup(null)} footer={null} title="Chọn từ danh mục" destroyOnHidden afterOpenChange={(o) => { if (o) lookupBox.current?.querySelector('input')?.focus(); }}>
        {lookup && <div ref={lookupBox}><LookupSelect catalog={LOOKUP_CATALOG[lookup.col]!} style={{ width: '100%' }} {...(lookup.col === 'accountCode' ? { fetcher: accountFetcher } : { quickAddFields: quickAdd })}
          onChange={(code, picked) => {
            if (code !== null) {
              const copy = [...rowsRef.current]; const nameField = lookup.col === 'accountCode' ? 'accountName' : 'partyName';
              copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code, [nameField]: picked?.name ?? null }; setAll(copy);
            }
            setLookup(null);
          }} /></div>}
      </Modal>
      {importing && year !== undefined && <ImportModal year={year} onClose={() => setImporting(false)} onDone={() => { setImporting(false); setIssues(null); setPosted(null); void qc.invalidateQueries({ queryKey: ['opening', year] }); }} />}
    </Card>
  );
}

// Chọn tệp → Kiểm tra → Nhập (như trang Nhập danh mục từ Excel). Nhập thay toàn bộ số dư đã lưu của năm.
function ImportModal({ year, onClose, onDone }: { year: number; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/opening-balance/${year}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = (await res.json().catch(() => ({}))) as Partial<ImportResult> & { error?: { message?: string } };
    if (!res.ok) { setResult(null); void message.error(body.error?.message ?? `Lỗi (${res.status})`); return; }
    const r = body as ImportResult; setResult(r);
    if (mode === 'commit' && r.errors.length === 0) { void message.success(`Đã nhập ${r.inserted} dòng`); onDone(); }
  };
  return (
    <Modal open title={`Nhập số dư đầu kỳ năm ${year} từ Excel`} onCancel={onClose} footer={null} width={720}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="Nhập Excel thay thế toàn bộ số dư đã lưu của năm này." />
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
