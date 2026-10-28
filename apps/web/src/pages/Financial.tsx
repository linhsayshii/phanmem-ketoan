import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Drawer, Input, Modal, Select, Space, Switch, Table, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { D, formatVnDate, formatVnNumber, type PrintLang } from '@kt/domain';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { PrintLangSelect } from './PrintLangSelect.js';
import { BranchFilter } from './branchCommon.js';

interface FiscalYear { fiscalYear: number; regime: string; dateFrom: string; dateTo: string }
interface Row { lineCode: string; label: string; parentLineCode: string | null; isBold: boolean; negate: boolean; noteRef: string | null; source: string; formula: string | null; current: string; previous: string | null }
interface Report { reportCode: string; name: string; formNo: string; issuedBy: string; regime: string; period: { from: string; to: string }; previousNote?: 'REGIME_CHANGED'; rows: Row[] }
interface DrillRow { kind?: 'reval_net'; accountCode: string; accountName: string; counterAccountCode?: string; partyCode: string | null; amount: string }
interface LedgerRow { postingDate: string; voucherId: string; voucherNo: string; description: string | null; counterAccountCode: string; debit: string; credit: string }
interface EditLine { key: number; lineCode: string; label: string; parentLineCode: string | null; source: string; side: string; formula: string | null; isBold: boolean; negate: boolean; noteRef: string | null }

const REPORTS = [{ value: 'B01', label: 'B01 - Báo cáo tình hình tài chính' }, { value: 'B02', label: 'B02 - Kết quả hoạt động kinh doanh' }, { value: 'B03', label: 'B03 - Lưu chuyển tiền tệ' }];
const SOURCES = [{ value: 'balance', label: 'Số dư' }, { value: 'movement', label: 'Phát sinh' }, { value: 'pair', label: 'Đối ứng' }, { value: 'lines', label: 'Cộng dòng' }];
const SIDES = [{ value: 'debit', label: 'Dư/PS Nợ' }, { value: 'credit', label: 'Dư/PS Có' }, { value: 'net_debit', label: 'Nợ - Có' }, { value: 'net_credit', label: 'Có - Nợ' }];
const query = (o: Record<string, string>) => new URLSearchParams(o).toString();
// Số âm trong ngoặc; dòng negate (khoản chi) hiện trong ngoặc như số âm.
const show = (v: string | null, negate = false) => { if (v === null) return ''; const x = negate ? D(v).neg() : D(v); return !x.isZero() && x.isNegative() ? `(${formatVnNumber(x.neg())})` : formatVnNumber(x.abs()); };
const num = (v: string) => (v === '0' ? '' : formatVnNumber(v));
const REGIME_NOTE = 'Năm trước dùng chế độ kế toán khác; cần chuyển đổi số dư'; // cột so sánh để trống khi ngày so sánh thuộc kỳ của chế độ khác
const LINK = { padding: 0, height: 'auto' } as const; // nút dạng liên kết: nhận phím Tab/Enter, khác thẻ <a> không có href

// Sổ Cái (cấp 2): các dòng chứng từ tạo nên số của một tài khoản/đối tượng, mở chứng từ gốc.
function LedgerDrawer({ target, range, onClose }: { target: { accountCode: string; partyCode: string | null } | null; range: { from: string; to: string }; onClose(): void }) {
  const q = useQuery({ queryKey: ['fin-ledger', target, range], enabled: !!target, retry: false,
    queryFn: () => api<{ rows: LedgerRow[] }>(`/api/reports/ledgers/${target!.partyCode ? 'detail' : 'account'}?${query({ ...range, accountCode: target!.accountCode, ...(target!.partyCode ? { partyCode: target!.partyCode } : { mode: 'voucher' }) })}`) });
  return (
    <Drawer open={!!target} onClose={onClose} width={760} title={target ? `Sổ ${target.accountCode}${target.partyCode ? ` - ${target.partyCode}` : ''}` : ''}>
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      <Table<LedgerRow> size="small" rowKey={(r) => `${r.voucherId}|${r.counterAccountCode}|${r.debit}|${r.credit}`} loading={q.isFetching} pagination={{ pageSize: 50, hideOnSinglePage: true }} dataSource={q.data?.rows ?? []} columns={[
        { title: 'Ngày', dataIndex: 'postingDate', width: 100, render: formatVnDate },
        { title: 'Chứng từ', key: 'v', width: 120, render: (_, r) => <Link to="/chung-tu/$type/$id" params={{ type: 'PKT', id: r.voucherId }}>{r.voucherNo}</Link> },
        { title: 'Diễn giải', dataIndex: 'description' }, { title: 'TK đối ứng', dataIndex: 'counterAccountCode', width: 90 },
        { title: 'Nợ', dataIndex: 'debit', align: 'right', width: 110, render: num }, { title: 'Có', dataIndex: 'credit', align: 'right', width: 110, render: num }]} />
    </Drawer>
  );
}

// Truy ngược cấp 1: chỉ tiêu gồm những tài khoản/đối tượng nào; nhấn tài khoản để xem sổ (cấp 2).
function DrillDrawer({ reportCode, row, range, onClose }: { reportCode: string; row: Row | null; range: { from: string; to: string }; onClose(): void }) {
  const [ledger, setLedger] = useState<{ accountCode: string; partyCode: string | null } | null>(null);
  const q = useQuery({ queryKey: ['fin-drill', reportCode, row?.lineCode, range], enabled: !!row, retry: false,
    queryFn: () => api<{ accounts: DrillRow[] }>(`/api/reports/financial/${reportCode}/lines/${encodeURIComponent(row!.lineCode)}?${query(range)}`) });
  return (
    <Drawer open={!!row} onClose={onClose} width={640} title={row ? `Chỉ tiêu ${row.lineCode} - ${row.label}` : ''}>
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      <Table<DrillRow> size="small" rowKey={(r) => `${r.kind ?? ''}|${r.accountCode}|${r.partyCode}|${r.counterAccountCode}`} loading={q.isFetching} pagination={false} dataSource={q.data?.accounts ?? []}
        locale={{ emptyText: 'Không có tài khoản trực tiếp (chỉ tiêu cộng từ các dòng khác hoặc số liệu bằng 0)' }} columns={[
          { title: 'Tài khoản', key: 'a', width: 110, render: (_, r) => r.kind === 'reval_net' ? r.accountCode : <Button type="link" size="small" style={LINK} onClick={() => setLedger({ accountCode: r.accountCode, partyCode: r.partyCode })}>{r.accountCode}</Button> },
          { title: 'Tên tài khoản', dataIndex: 'accountName' }, { title: 'Đối tượng', dataIndex: 'partyCode', width: 100 }, { title: 'TK đối ứng', dataIndex: 'counterAccountCode', width: 90 },
          { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 130, render: (v: string) => show(v) }]} />
      <LedgerDrawer target={ledger} range={range} onClose={() => setLedger(null)} />
    </Drawer>
  );
}

// Sửa công thức: toàn bộ dòng của một báo cáo; máy chủ kiểm tra công thức, vòng lặp, dòng cha trước khi lưu.
function FormulaEditor({ reportCode, regime, onClose, onSaved }: { reportCode: string; regime: string; onClose(): void; onSaved(): void }) {
  const [lines, setLines] = useState<EditLine[]>([]);
  const [seq, setSeq] = useState(0);
  const load = useQuery({ queryKey: ['report-def', reportCode, regime], retry: false, gcTime: 0, queryFn: () => api<{ lines: Omit<EditLine, 'key'>[] }>(`/api/report-defs/${reportCode}?${query({ regime })}`) });
  useEffect(() => { if (load.data) { setLines(load.data.lines.map((l, i) => ({ ...l, key: i }))); setSeq(load.data.lines.length); } }, [load.data]);
  const save = useMutation({ mutationFn: () => api('/api/report-defs/' + reportCode, { method: 'PUT', json: { regime, lines: lines.map((l) => ({ lineCode: l.lineCode, label: l.label, parentLineCode: l.parentLineCode?.trim() || null, source: l.source, side: l.side, formula: l.formula?.trim() || null, isBold: l.isBold, negate: l.negate, noteRef: l.noteRef?.trim() || null })) } }),
    onError: (e) => { void message.error((e as Error).message); }, onSuccess: () => { void message.success('Đã lưu công thức'); onSaved(); onClose(); } });
  const set = (key: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const text = (field: 'lineCode' | 'label' | 'parentLineCode' | 'formula' | 'noteRef', width?: number) => (_: unknown, l: EditLine) => <Input size="small" style={{ width }} value={l[field] ?? ''} onChange={(e) => set(l.key, { [field]: e.target.value })} />;
  return (
    <Modal open onCancel={onClose} width={1280} title={`Sửa công thức ${reportCode} (${regime})`} okText="Lưu" cancelText="Đóng" confirmLoading={save.isPending} onOk={() => save.mutate()}>
      {load.error && <Alert type="error" showIcon message={(load.error as Error).message} />}
      <p>Công thức: cộng/trừ các hạng tử. <code>111+112</code> tiền tố tài khoản, <code>131(1312)</code> trừ tiền tố con, <code>[100]</code> dòng khác, <code>N911/C632</code> đối ứng Nợ/Có, <code>0</code> số. Chỉ với nguồn Phát sinh: <code>515!REVAL</code> bỏ phần chênh lệch đánh giá lại ngoại tệ khỏi tài khoản; <code>REVAL_GAIN</code> / <code>REVAL_LOSS</code> là lãi / lỗ thuần đánh giá lại. Chỉ với nguồn Số dư: <code>LT(131)</code> phần dài hạn (hạn trên 12 tháng kể từ ngày báo cáo) của số dư, ví dụ <code>131-LT(131)</code> là phần ngắn hạn. Luồng tiền: <code>CF(01)</code> dòng tiền gắn mã 01 (thu dương, chi âm); <code>N111/C511!CF</code> bỏ các cặp đã gắn mã luồng tiền.</p>
      <p>Cột &quot;Âm&quot; chỉ đổi cách hiển thị (số trong ngoặc), không đổi giá trị: dòng tổng phải trừ rõ ràng bằng dấu <code>-</code> trong công thức.</p>
      <Table<EditLine> size="small" rowKey="key" pagination={false} scroll={{ y: 420 }} loading={load.isFetching} dataSource={lines} columns={[
        { title: 'Mã dòng', key: 'lineCode', width: 80, render: text('lineCode') }, { title: 'Chỉ tiêu', key: 'label', render: text('label') }, { title: 'Dòng cha', key: 'parent', width: 80, render: text('parentLineCode') },
        { title: 'Nguồn', key: 'source', width: 110, render: (_, l) => <Select size="small" style={{ width: 100 }} options={SOURCES} value={l.source} onChange={(source) => set(l.key, { source })} /> },
        { title: 'Phía', key: 'side', width: 110, render: (_, l) => <Select size="small" style={{ width: 100 }} options={SIDES} value={l.side} onChange={(side) => set(l.key, { side })} /> },
        { title: 'Công thức', key: 'formula', width: 280, render: text('formula') }, { title: 'TM', key: 'note', width: 70, render: text('noteRef') },
        { title: 'Đậm', key: 'b', width: 55, render: (_, l) => <Checkbox checked={l.isBold} onChange={(e) => set(l.key, { isBold: e.target.checked })} /> },
        { title: 'Âm', key: 'n', width: 55, render: (_, l) => <Checkbox checked={l.negate} onChange={(e) => set(l.key, { negate: e.target.checked })} /> },
        { title: '', key: 'x', width: 60, render: (_, l) => <Button size="small" danger onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Bỏ</Button> }]} />
      <Button style={{ marginTop: 8 }} onClick={() => { setLines((ls) => [...ls, { key: seq, lineCode: '', label: '', parentLineCode: null, source: 'balance', side: 'net_debit', formula: null, isBold: false, negate: false, noteRef: null }]); setSeq(seq + 1); }}>Thêm dòng</Button>
    </Modal>
  );
}

export default function FinancialPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [yearNo, setYearNo] = useState<number | undefined>();
  const [code, setCode] = useState('B01');
  const [custom, setCustom] = useState<{ year: number; from: string; to: string } | null>(null);
  const [compare, setCompare] = useState(false); const [printLang, setPrintLang] = useState<PrintLang>('vi');
  const [branch, setBranch] = useState('');
  const [drill, setDrill] = useState<Row | null>(null);
  const [editing, setEditing] = useState(false);
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYear[]>('/api/fiscal-years') });
  const fy = years.data?.find((y) => y.fiscalYear === yearNo) ?? years.data?.at(-1);
  const mine = fy && custom?.year === fy.fiscalYear ? custom : null; // khoảng ngày tự chọn chỉ có hiệu lực trong năm đã chọn nó
  const range = fy ? { from: mine?.from ?? fy.dateFrom, to: mine?.to ?? fy.dateTo, ...(branch && { branch }) } : null;
  const isB01 = code === 'B01'; // B01 là số dư tại một ngày: chỉ chọn "đến ngày", số đầu năm tính theo năm tài chính
  const report = useQuery({ queryKey: ['financial', code, range, compare], enabled: !!range, retry: false,
    queryFn: () => api<Report>(`/api/reports/financial/${code}?${query({ ...range!, comparePrevYear: String(compare && !isB01) })}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['financial'] }); void qc.invalidateQueries({ queryKey: ['fin-drill'] }); };
  const reload = useMutation({ mutationFn: () => api<{ lines: number }>(`/api/report-defs/${code}/reload`, { method: 'POST', json: { regime: fy!.regime } }), onError: (e) => { void message.error((e as Error).message); },
    onSuccess: (r) => { void (r.lines ? message.success(`Đã nạp lại ${r.lines} dòng từ mẫu`) : message.info('Chưa có mẫu hệ thống cho báo cáo này (chờ văn bản), định nghĩa hiện có được giữ nguyên')); refresh(); } });

  const rows = report.data?.rows ?? [];
  const depthOf = (r: Row) => { let d = 0; let p = r.parentLineCode; while (p && d < 10) { p = rows.find((x) => x.lineCode === p)?.parentLineCode ?? null; d++; } return d; };
  const missing = report.error instanceof ApiError && report.error.code === 'REPORT_NOT_FOUND';
  const amount = (field: 'current' | 'previous') => (_: unknown, r: Row) => {
    if (field === 'previous' && report.data?.previousNote) return r.formula ? '—' : '';
    const v = r[field]; if (v === null || !r.formula) return '';
    const text = show(v, r.negate);
    return field === 'current' ? <Button type="link" size="small" style={LINK} title="Truy ngược" onClick={() => setDrill(r)}>{text}</Button> : text;
  };
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <h2 style={{ margin: 0 }}>Báo cáo tài chính</h2>
        <Select style={{ width: 130 }} value={fy?.fiscalYear} placeholder="Năm" onChange={setYearNo} options={(years.data ?? []).map((y) => ({ value: y.fiscalYear, label: `Năm ${y.fiscalYear} (${y.regime})` }))} />
        <Select style={{ width: 280 }} value={code} onChange={setCode} options={REPORTS} />
        {range && fy && (isB01
          ? <><span>Đến ngày</span><DatePicker format="DD/MM/YYYY" allowClear={false} value={dayjs(range.to)} onChange={(d) => d && setCustom({ year: fy.fiscalYear, from: fy.dateFrom, to: d.format('YYYY-MM-DD') })} /></>
          : <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(range.from), dayjs(range.to)]} onChange={(r) => r?.[0] && r[1] && setCustom({ year: fy.fiscalYear, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />)}
        <BranchFilter value={branch} onChange={setBranch} />
        {!isB01 && <span><Switch checked={compare} onChange={setCompare} /> So sánh năm trước</span>}
        {can('report.print') && range && <>
          <PrintLangSelect value={printLang} onChange={setPrintLang} />
          <Button disabled={!report.data} onClick={() => { window.open(`/api/reports/financial/${code}?${query({ ...range, format: 'pdf', lang: printLang })}`, '_blank'); }}>In PDF</Button>
          <Button disabled={!report.data} onClick={() => { window.open(`/api/reports/financial/${code}?${query({ ...range, format: 'xlsx', lang: printLang })}`, '_blank'); }}>Xuất Excel</Button></>}
        {can('report_def.update') && fy && <>
          <Button onClick={() => setEditing(true)}>Sửa công thức</Button>
          <Button loading={reload.isPending} onClick={() => Modal.confirm({ title: `Nạp lại mẫu ${code}?`, content: 'Báo cáo này được thay bằng mẫu hệ thống; các báo cáo khác của công ty giữ nguyên.', okText: 'Nạp lại mẫu', cancelText: 'Hủy', onOk: () => reload.mutateAsync().catch(() => undefined) })}>Nạp lại mẫu</Button></>}
      </Space>
      {years.data && !years.data.length && <Alert type="info" showIcon message="Chưa có năm tài chính nào. Tạo năm tài chính trước khi xem báo cáo." />}
      {report.data && <div><b>{report.data.name}</b> - Mẫu số {report.data.formNo}<div style={{ color: '#888' }}>{report.data.issuedBy}</div></div>}
      {missing && <Alert type="info" showIcon message={`Chưa có định nghĩa ${code} cho ${fy?.regime}. ${can('report_def.update') ? 'Bấm "Sửa công thức" để định nghĩa các chỉ tiêu.' : 'Liên hệ người quản trị để định nghĩa.'}`} />}
      {report.data?.previousNote && <Alert type="warning" showIcon message={REGIME_NOTE} />}
      {report.error && !missing && <Alert type="error" showIcon message={(report.error as Error).message} />}
      {report.data && (
        <Table<Row> size="small" bordered rowKey="lineCode" pagination={false} loading={report.isFetching} dataSource={rows} scroll={{ y: 'calc(100vh - 360px)' }} columns={[
          { title: 'Chỉ tiêu', key: 'label', render: (_, r) => <span style={{ paddingLeft: depthOf(r) * 16, fontWeight: r.isBold ? 700 : 400 }}>{r.label}</span> },
          { title: 'Mã số', dataIndex: 'lineCode', width: 80, align: 'center' }, { title: 'Thuyết minh', dataIndex: 'noteRef', width: 100, align: 'center' },
          { title: isB01 ? 'Số cuối kỳ' : 'Kỳ này', key: 'current', width: 160, align: 'right', onCell: (r) => ({ style: { fontWeight: r.isBold ? 700 : 400 } }), render: amount('current') },
          ...(report.data.previousNote || report.data.rows.some((r) => r.previous !== null) ? [{ title: isB01 ? 'Số đầu năm' : 'Năm trước', key: 'previous', width: 160, align: 'right' as const, onCell: (r: Row) => ({ style: { fontWeight: r.isBold ? 700 : 400 } }), render: amount('previous') }] : []),
        ]} />)}
      {range && <DrillDrawer reportCode={code} row={drill} range={range} onClose={() => setDrill(null)} />}
      {fy && editing && <FormulaEditor reportCode={code} regime={fy.regime} onClose={() => setEditing(false)} onSaved={refresh} />}
    </Space>
  );
}
