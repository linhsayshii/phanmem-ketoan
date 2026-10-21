import { useState } from 'react';
import { Alert, Button, Card, Checkbox, Select, Space, Table, Upload, message } from 'antd';
import { useAuth } from '../auth.js';

const KINDS = [
  { value: 'thu-chi', label: 'Phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ' },
  { value: 'bang-ke-mua', label: 'Bảng kê hóa đơn mua vào' },
  { value: 'bang-ke-ban', label: 'Bảng kê hóa đơn bán ra' },
];
interface Report { total: number; rows: number; created: number; existing: number; posted: number; errors: { row: number; column: string; message: string }[]; errorCount: number }

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
  const reset = () => { setReport(null); setChecked(false); setFailure(null); };

  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    setBusy(true); setFailure(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(`/api/import/vouchers/${kind}?mode=${mode}&autoPost=${autoPost && can('voucher.post')}`, { method: 'POST', body: fd, credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setReport(null); setChecked(false); setFailure(body.error?.message ?? 'Không nhập được tệp'); return; }
      const r = body as Report; setReport(r); setChecked(mode === 'validate');
      if (mode === 'commit' && !r.errorCount) void message.success(`Đã tạo ${r.created} chứng từ`);
    } finally { setBusy(false); }
  };
  const bad = (report?.errorCount ?? 0) > 0;
  return (
    <Card title="Nhập chứng từ từ Excel">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Select aria-label="Loại tệp nhập" style={{ width: 360 }} value={kind} onChange={(v) => { setKind(v); reset(); }} options={KINDS} />
          <Button href={`/api/import/vouchers/${kind}/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); reset(); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          {can('voucher.post') && <Checkbox checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)}>Ghi sổ ngay</Checkbox>}
          <Button onClick={() => void send('validate')} disabled={!file || busy}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || busy || !checked || bad}>Nhập</Button>
        </Space>
        {failure && <Alert type="error" showIcon message={failure} />}
        {report && !bad && (
          <Alert type="success" showIcon message={checked
            ? `Hợp lệ: ${report.rows} dòng, ${report.total} ${kind === 'thu-chi' ? 'chứng từ' : 'hóa đơn'}; sẽ tạo mới ${report.created}, đã nhập trước đó ${report.existing}`
            : `Đã tạo ${report.created} chứng từ${report.posted ? `, ghi sổ ${report.posted}` : ' (bản nháp)'}; đã nhập trước đó ${report.existing}`} />
        )}
        {report && bad && (<>
          <Alert type="error" showIcon message={`${report.errorCount} lỗi, chưa tạo chứng từ nào${report.errorCount > report.errors.length ? ` (hiển thị ${report.errors.length} lỗi đầu)` : ''}`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}`} dataSource={report.errors} pagination={{ pageSize: 20 }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 80 }, { title: 'Cột', dataIndex: 'column', width: 180 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Card>
  );
}
