import { useEffect } from 'react';
import { Button, Form, Input, Select, Switch, Table, Tabs, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PageHeader, Section } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Company { code: string; name: string; taxCode: string | null; address: string | null; legalRep: string | null; chiefAccountant: string | null; phone: string | null; email: string | null }
interface Settings { book_form: string; costing_method: string; base_currency: string; fx_rate_type: string; cash_negative: 'warn' | 'block'; fx_outflow_method: 'moving_average' | 'specific'; vat_period: 'month' | 'quarter'; fa_proration: 'day' | 'month'; payroll_standard_hours_per_day: string | null; payroll_standard_days_per_month: string | null; hidden_modules: string[]; tax_code_lookup: 'off' | 'vietqr'; costing_enabled: boolean; extra_dims: { key: string; label: string }[] }

interface BackupFile { name: string; bytes: number; mtime: string }

const NULLABLE = ['taxCode', 'address', 'legalRep', 'chiefAccountant', 'phone', 'email'] as const;
const fmtBytes = (n: number) => (n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function BackupTab() {
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ['backups'], queryFn: () => api<BackupFile[]>('/api/backup') });
  useEffect(() => { if (files.error) void message.error((files.error as Error).message); }, [files.error]);
  const run = useMutation({
    mutationFn: () => api('/api/backup/run', { method: 'POST' }),
    onError: (e) => { void message.error((e as Error).message); },
    onSuccess: () => { void message.success('Đã đưa vào hàng đợi, bản sao lưu xuất hiện sau ít phút'); void qc.invalidateQueries({ queryKey: ['backups'] }); },
  });
  return (
    <Section>
      <Button type="primary" loading={run.isPending} onClick={() => run.mutate()} style={{ marginBottom: 12 }}>Sao lưu ngay</Button>
      <Table<BackupFile> rowKey="name" size="small" pagination={false} loading={files.isLoading} dataSource={files.data ?? []} columns={[
        { title: 'Tên file', dataIndex: 'name' },
        { title: 'Dung lượng', dataIndex: 'bytes', align: 'right', render: fmtBytes },
        { title: 'Thời gian', dataIndex: 'mtime', render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm:ss') },
      ]} />
    </Section>
  );
}

export default function CompanyPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const company = useQuery({ queryKey: ['company'], queryFn: () => api<Company>('/api/company') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const onError = (e: unknown) => { void message.error((e as Error).message); };
  // ô nhập để trống gửi chuỗi rỗng: API từ chối (mã số thuế, email) hoặc lưu '' thay vì xóa trường
  const saveCompany = useMutation({ mutationFn: (v: Partial<Company>) => api('/api/company', { method: 'PUT', json: { ...v, ...Object.fromEntries(NULLABLE.map((k) => [k, v[k] === '' ? null : v[k]])) } }), onError, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['company'] }); void message.success('Đã lưu'); } });
  const saveSettings = useMutation({ mutationFn: (v: Partial<Settings>) => api('/api/settings', { method: 'PUT', json: { ...v, payroll_standard_hours_per_day: v.payroll_standard_hours_per_day?.trim() || null, payroll_standard_days_per_month: v.payroll_standard_days_per_month?.trim() || null } }), onError, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); void message.success('Đã lưu'); } });
  return (
    <>
      <PageHeader
        title="Thông tin công ty"
        description="Thông tin pháp lý, tùy chọn hệ thống và sao lưu dữ liệu"
      />
      {(!company.data || !settings.data) ? null : (
        <Tabs items={[
          { key: 'phaply', label: 'Thông tin pháp lý', children: (
            <Section><Form layout="vertical" initialValues={company.data} onFinish={(v) => saveCompany.mutate(v)}>
              <Form.Item label="Mã" name="code"><Input disabled /></Form.Item>
              <Form.Item label="Tên công ty" name="name" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item label="Mã số thuế" name="taxCode"><Input /></Form.Item>
              <Form.Item label="Địa chỉ" name="address"><Input /></Form.Item>
              <Form.Item label="Người đại diện pháp luật" name="legalRep"><Input /></Form.Item>
              <Form.Item label="Kế toán trưởng" name="chiefAccountant"><Input /></Form.Item>
              <Form.Item label="Điện thoại" name="phone"><Input /></Form.Item>
              <Form.Item label="Email" name="email"><Input /></Form.Item>
              <Button type="primary" htmlType="submit">Lưu</Button></Form></Section>) },
          { key: 'tuychon', label: 'Tùy chọn hệ thống', children: (
            <Section><Form layout="vertical" initialValues={settings.data} onFinish={(v) => saveSettings.mutate(v)}>
              <Form.Item label="Hình thức sổ" name="book_form"><Select options={[{ value: 'NKC', label: 'Nhật ký chung' }]} /></Form.Item>
              <Form.Item label="Phương pháp giá vốn mặc định" name="costing_method"><Select options={[
                { value: 'avg_period', label: 'Bình quân cuối kỳ' }, { value: 'avg_moving', label: 'Bình quân tức thời' }, { value: 'fifo', label: 'Nhập trước xuất trước' }, { value: 'specific', label: 'Đích danh' }]} /></Form.Item>
              <Form.Item label="Loại tỷ giá ghi sổ" name="fx_rate_type"><Select options={[
                { value: 'transfer_avg', label: 'Mua bán chuyển khoản trung bình' }, { value: 'buy', label: 'Tỷ giá mua' }, { value: 'sell', label: 'Tỷ giá bán' }]} /></Form.Item>
              <Form.Item label="Tỷ giá xuất quỹ ngoại tệ" name="fx_outflow_method"><Select options={[
                { value: 'moving_average', label: 'Bình quân gia quyền di động (tính lại cuối kỳ)' }, { value: 'specific', label: 'Đích danh (tự nhập tỷ giá)' }]} /></Form.Item>
              <Form.Item label="Kỳ khai thuế GTGT" name="vat_period"><Select options={[
                { value: 'month', label: 'Theo tháng' }, { value: 'quarter', label: 'Theo quý' }]} /></Form.Item>
              <Form.Item label="Cách tính khấu hao tháng đầu, tháng cuối" name="fa_proration" extra="Chỉ đổi được trước lần chạy khấu hao TSCĐ đầu tiên"><Select options={[
                { value: 'day', label: 'Theo số ngày thực tế' }, { value: 'month', label: 'Tròn tháng' }]} /></Form.Item>
              <Form.Item label="Khi ghi sổ làm tồn quỹ hoặc số dư tiền gửi âm" name="cash_negative"><Select options={[
                { value: 'warn', label: 'Cảnh báo nhưng vẫn ghi sổ' }, { value: 'block', label: 'Không cho ghi sổ' }]} /></Form.Item>
              <Form.Item label="Tra cứu MST người bán khi nhận hóa đơn đầu vào" name="tax_code_lookup" valuePropName="checked" getValueProps={(v: string) => ({ checked: v === 'vietqr' })} getValueFromEvent={(c: boolean) => (c ? 'vietqr' : 'off')}
                extra="Bật thì mã số thuế người bán được gửi tới dịch vụ tra cứu bên thứ ba (VietQR) để lấy tên, địa chỉ. Mặc định tắt."><Switch /></Form.Item>
              <Form.Item label="Tập hợp chi phí theo đối tượng (giá thành)" name="costing_enabled" valuePropName="checked"
                extra="Bật thì lưới chứng từ luôn có cột Đối tượng THCP; tắt thì cột chỉ hiện ở dòng TK 621, 622, 627, 154."><Switch /></Form.Item>
              <Form.Item label="Số giờ làm việc chuẩn mỗi ngày" name="payroll_standard_hours_per_day" extra="Để trống nếu chưa khai: chấm công theo giờ sẽ báo lỗi. Quy đổi giờ làm việc ra ngày công."><Input style={{ width: 120 }} inputMode="decimal" /></Form.Item>
              <Form.Item label="Số ngày công chuẩn của tháng" name="payroll_standard_days_per_month" extra="Để trống nếu chưa khai: bảng lương báo lỗi khi cần tới."><Input style={{ width: 120 }} inputMode="decimal" /></Form.Item>
              <Form.Item label="Ẩn phân hệ" name="hidden_modules"><Select mode="multiple" options={['inventory', 'assets', 'payroll', 'costing'].map((m) => ({ value: m, label: m }))} /></Form.Item>
              <Form.List name="extra_dims">{(fields, { add, remove }) => (<>
                <div style={{ marginBottom: 8 }}>Trường mở rộng (chiều phân tích thêm)</div>
                {fields.map((f) => (<div key={f.key} style={{ display: 'flex', gap: 8 }}>
                  <Form.Item name={[f.name, 'key']} rules={[{ required: true, pattern: /^[a-z_]+$/ }]}><Input placeholder="ma_thong_ke" /></Form.Item>
                  <Form.Item name={[f.name, 'label']} rules={[{ required: true }]}><Input placeholder="Mã thống kê" /></Form.Item>
                  <Button onClick={() => remove(f.name)}>Xóa</Button></div>))}
                <Button onClick={() => add()}>Thêm trường</Button></>)}</Form.List>
              <div style={{ marginTop: 16 }}><Button type="primary" htmlType="submit">Lưu</Button></div></Form></Section>) },
          ...(can('backup.run') ? [{ key: 'saoluu', label: 'Sao lưu', children: <BackupTab /> }] : []),
        ]} />
      )}
    </>
  );
}
