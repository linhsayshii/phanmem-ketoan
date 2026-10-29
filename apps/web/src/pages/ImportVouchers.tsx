import { useState } from 'react';
import { Alert, Button, Checkbox, Select, Table, Upload, message } from 'antd';
import { COLOR, PageHeader, Section, Toolbar } from '@kt/ui';
import { useAuth } from '../auth.js';

const KINDS = [
  { value: 'thu-chi', label: 'Phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ' },
  { value: 'bang-ke-mua', label: 'Bảng kê hóa đơn mua vào' },
  { value: 'bang-ke-ban', label: 'Bảng kê hóa đơn bán ra' },
];
interface Issue { row: number; column: string; columnLabel?: string; message: string }
interface Report { total: number; rows: number; created: number; existing: number; posted: number; errors: Issue[]; warnings?: Issue[]; errorCount: number }

// Nhập chứng từ và bảng kê từ Excel: Kiểm tra (không ghi gì) rồi Nhập; có lỗi thì không chứng từ nào được tạo.
export default function ImportVouchersPage() {
  const { can } = useAuth();
  const [kind, setKind] = useState('thu-chi');
  const [file, setFile] = useState<File | null>(null);
  const [autoPost, setAutoPost] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [checked, setChecked] = useState(false); // báo cáo hiện tại là của lần Kiểm tra (chưa ghi)
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'validate' | 'commit'>('validate');
  const reset = () => { setReport(null); setChecked(false); setFailure(null); };

  const send = async (m: 'validate' | 'commit') => {
    if (!file) return;
    setMode(m); setBusy(true); setFailure(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(`/api/import/vouchers/${kind}?mode=${m}&autoPost=${autoPost && can('voucher.post')}`, { method: 'POST', body: fd, credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setReport(null); setChecked(false); setFailure(body.error?.message ?? 'Không nhập được tệp'); return; }
      const r = body as Report; setReport(r); setChecked(m === 'validate');
      if (m === 'commit' && !r.errorCount) void message.success(`Đã tạo ${r.created} chứng từ`);
    } finally { setBusy(false); }
  };
  const bad = (report?.errorCount ?? 0) > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Nhập chứng từ từ Excel"
        description="Kiểm tra (không ghi gì) rồi Nhập; có lỗi thì không chứng từ nào được tạo"
      >
        <Toolbar>
          <Select aria-label="Loại tệp nhập" style={{ width: 360 }} value={kind} onChange={(v) => { setKind(v); reset(); }} options={KINDS} />
          <Button href={`/api/import/vouchers/${kind}/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); reset(); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          {can('voucher.post') && <Checkbox checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)}>Ghi sổ ngay</Checkbox>}
          <Button onClick={() => void send('validate')} loading={busy && mode === 'validate'} disabled={!file || busy}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} loading={busy && mode === 'commit'} disabled={!file || busy || !checked || bad}>Nhập</Button>
        </Toolbar>
      </PageHeader>
      <Alert type="info" showIcon message="Tối đa 2.000 chứng từ (hoặc hóa đơn) và 20.000 dòng mỗi tệp; tệp lớn hơn thì chia nhỏ. Chứng từ tạo ra ở trạng thái nháp, trừ khi chọn Ghi sổ ngay. Nhập lại cùng tệp không tạo trùng; nhóm đã sửa nội dung được nhập như chứng từ mới, hãy hủy chứng từ cũ." />
      {failure && <Alert type="error" showIcon message={failure} />}
      {report && !bad && (
        <Alert type="success" showIcon message={checked
          ? `Hợp lệ: ${report.rows} dòng, ${report.total} ${kind === 'thu-chi' ? 'chứng từ' : 'hóa đơn'}; sẽ tạo mới ${report.created}, đã nhập trước đó ${report.existing}`
          : `Đã tạo ${report.created} chứng từ${report.posted ? `, ghi sổ ${report.posted}` : ' (bản nháp)'}; đã nhập trước đó ${report.existing}`} />
      )}
      {!!report?.warnings?.length && (
        <Alert type="warning" showIcon message={`${report.warnings.length} cảnh báo`} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{report.warnings.slice(0, 20).map((w, i) => <li key={i}>Dòng {w.row}: {w.message}</li>)}</ul>} />
      )}
      {report && bad && (
        <Section title="Chi tiết lỗi" bodyPadding={0}>
          <Alert type="error" showIcon message={`${report.errorCount} lỗi, chưa tạo chứng từ nào${report.errorCount > report.errors.length ? ` (hiển thị ${report.errors.length} lỗi đầu)` : ''}`} style={{ border: 'none', borderBottom: `1px solid ${COLOR.border}`, borderRadius: 0 }} />
          <Table size="small" rowKey={(r, i) => `${r.row}-${r.column}-${i}`} dataSource={report.errors} pagination={{ pageSize: 20 }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 80 }, { title: 'Cột', width: 200, render: (_: unknown, r: Issue) => r.columnLabel ?? r.column }, { title: 'Lỗi', dataIndex: 'message' }]} />
        </Section>
      )}
    </div>
  );
}
