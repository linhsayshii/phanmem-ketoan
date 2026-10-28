import { useState } from 'react';
import { Alert, Button, Select, Table, Upload, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, Section, Toolbar } from '@kt/ui';
import { api } from '../api/client.js';

interface Def { name: string; label: string }
interface Result { total: number; inserted: number; errors: { row: number; column: string; message: string }[]; errorCount?: number }

export default function ImportExcelPage() {
  const defs = useQuery({ queryKey: ['catalog-defs'], queryFn: () => api<Def[]>('/api/catalogs') });
  const [name, setName] = useState<string>('party');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<string | null>(null); // lỗi cả tệp (thiếu cột, sai mẫu, quá nhiều dòng...) khác lỗi từng dòng
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    setFailure(null);
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/catalogs/${name}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    // Chỉ lỗi IMPORT_ERRORS mới có danh sách dòng lỗi; lỗi khác (quyền, trùng mã trong CSDL...) chỉ báo thông điệp, không hiện kết quả "hợp lệ".
    if (!res.ok) { setResult(body.error?.code === 'IMPORT_ERRORS' ? { total: 0, inserted: 0, errors: body.error.details ?? [] } : null); if (body.error?.code !== 'IMPORT_ERRORS') setFailure(body.error?.message ?? 'Không nhập được tệp'); else void message.error(body.error.message); return; }
    setResult(body as Result); if (mode === 'commit') void message.success(`Đã nhập ${(body as Result).inserted} dòng`);
  };
  return (
    <>
      <PageHeader
        title="Nhập danh mục từ Excel"
        description="Tải mẫu, điền dữ liệu, kiểm tra rồi nhập. Có lỗi thì chưa nhập dòng nào."
      >
        <Toolbar>
          <Select
            aria-label="Danh mục"
            style={{ width: 280 }}
            value={name}
            onChange={setName}
            options={(defs.data ?? []).map((d) => ({ value: d.name, label: d.label }))}
          />
          <Button href={`/api/catalogs/${name}/template.xlsx`}>Tải mẫu</Button>
          <Upload
            beforeUpload={(f) => {
              setFile(f);
              setResult(null);
              setFailure(null);
              return false;
            }}
            maxCount={1}
            accept=".xlsx"
          >
            <Button>Chọn tệp</Button>
          </Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>
            Kiểm tra
          </Button>
          <Button
            type="primary"
            onClick={() => void send('commit')}
            disabled={!file || !result || result.errors.length > 0}
          >
            Nhập
          </Button>
        </Toolbar>
      </PageHeader>

      {(failure || result) && (
        <Section title="Kết quả kiểm tra">
          {failure && <Alert type="error" showIcon message={failure} style={{ marginBottom: 12 }} />}
          {result && result.errors.length === 0 && (
            <Alert
              type="success"
              showIcon
              message={`${result.total} dòng hợp lệ${result.inserted ? `, đã nhập ${result.inserted}` : ''}`}
            />
          )}
          {result && result.errors.length > 0 && (
            <>
              <Alert
                type="error"
                showIcon
                message={`${result.errorCount ?? result.errors.length} lỗi, chưa nhập dòng nào${(result.errorCount ?? 0) > result.errors.length ? ` (hiển thị ${result.errors.length} lỗi đầu)` : ''}`}
                style={{ marginBottom: 12 }}
              />
              <Table
                size="small"
                rowKey={(r) => `${r.row}-${r.column}`}
                dataSource={result.errors}
                pagination={{ pageSize: 20 }}
                columns={[
                  { title: 'Dòng', dataIndex: 'row', width: 80 },
                  { title: 'Cột', dataIndex: 'column', width: 180 },
                  { title: 'Lỗi', dataIndex: 'message' },
                ]}
              />
            </>
          )}
        </Section>
      )}
    </>
  );
}
