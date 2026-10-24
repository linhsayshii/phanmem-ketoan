import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Table, Upload, message } from 'antd';

// Nhập số liệu ô nhập tay của bảng lương từ Excel (Task 7): mẫu theo cột nhập tay của cấu trúc; hai lượt Kiểm tra và Nhập; có lỗi dòng nào thì không nhập dòng nào.
interface ImportResult { total: number; employees: number; cells: number; changedCells?: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }

export function RunImportDialog({ runId, open, onClose, onDone }: { runId: number; open: boolean; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [result, setResult] = useState<ImportResult | null>(null); const [failure, setFailure] = useState<string | null>(null); const [valid, setValid] = useState(false);
  useEffect(() => { if (open) { setFile(null); setResult(null); setFailure(null); setValid(false); } }, [open]);
  const base = `/api/payroll/runs/${runId}/import`;
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    setFailure(null);
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`${base}?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setValid(false); setResult(body.error?.code === 'IMPORT_ERRORS' ? { total: 0, employees: 0, cells: 0, errors: body.error.details ?? [] } : null);
      if (body.error?.code !== 'IMPORT_ERRORS') setFailure(body.error?.message ?? 'Không nhập được tệp');
      return;
    }
    const r = body as ImportResult; setResult(r); setValid(mode === 'validate' && r.errors.length === 0);
    if (mode === 'commit') { void message.success(`Đã nhập ${r.changedCells ?? 0} ô cho ${r.employees} nhân viên: bấm Tính lại (F9) để cập nhật số liệu`); onDone(); onClose(); }
  };
  return (
    <Modal open={open} title="Nhập bảng lương từ Excel" onCancel={onClose} width={720} footer={null} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Button href={`${base}/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); setFailure(null); setValid(false); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !valid}>Nhập</Button>
        </Space>
        <div>Mỗi dòng một nhân viên của bảng lương, cột là các cột nhập tay của cấu trúc (thưởng, tạm ứng…). Ô có số thì thay giá trị nhập tay, ô trống giữ nguyên. Có lỗi ở dòng nào thì không nhập dòng nào.</div>
        {failure && <Alert type="error" showIcon message={failure} />}
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ (${result.employees} nhân viên, ${result.cells} ô)`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errorCount ?? result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}-${r.message}`} dataSource={result.errors} pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 70 }, { title: 'Cột', dataIndex: 'column', width: 130 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Modal>);
}
