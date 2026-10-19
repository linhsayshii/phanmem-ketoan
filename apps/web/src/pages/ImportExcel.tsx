import { useState } from 'react';
import { Alert, Button, Card, Select, Space, Table, Upload, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface Def { name: string; label: string }
interface Result { total: number; inserted: number; errors: { row: number; column: string; message: string }[] }

export default function ImportExcelPage() {
  const defs = useQuery({ queryKey: ['catalog-defs'], queryFn: () => api<Def[]>('/api/catalogs') });
  const [name, setName] = useState<string>('party');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/catalogs/${name}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    // Chỉ lỗi IMPORT_ERRORS mới có danh sách dòng lỗi; lỗi khác (quyền, trùng mã trong CSDL...) chỉ báo thông điệp, không hiện kết quả "hợp lệ".
    if (!res.ok) { setResult(body.error?.code === 'IMPORT_ERRORS' ? { total: 0, inserted: 0, errors: body.error.details ?? [] } : null); void message.error(body.error?.message ?? 'Lỗi'); return; }
    setResult(body as Result); if (mode === 'commit') void message.success(`Đã nhập ${(body as Result).inserted} dòng`);
  };
  return (
    <Card title="Nhập danh mục từ Excel">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space>
          <Select style={{ width: 280 }} value={name} onChange={setName} options={(defs.data ?? []).map((d) => ({ value: d.name, label: d.label }))} />
          <Button href={`/api/catalogs/${name}/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !result || result.errors.length > 0}>Nhập</Button>
        </Space>
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ${result.inserted ? `, đã nhập ${result.inserted}` : ''}`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}`} dataSource={result.errors} pagination={{ pageSize: 20 }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 80 }, { title: 'Cột', dataIndex: 'column', width: 180 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Card>
  );
}
