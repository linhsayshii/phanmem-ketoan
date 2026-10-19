import { Button, Card, Form, Input, Select, Tabs, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface Company { code: string; name: string; taxCode: string | null; address: string | null; legalRep: string | null; chiefAccountant: string | null; phone: string | null; email: string | null }
interface Settings { book_form: string; costing_method: string; base_currency: string; fx_rate_type: string; hidden_modules: string[]; extra_dims: { key: string; label: string }[] }

export default function CompanyPage() {
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ['company'], queryFn: () => api<Company>('/api/company') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const saveCompany = useMutation({ mutationFn: (v: Partial<Company>) => api('/api/company', { method: 'PUT', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['company'] }); void message.success('Đã lưu'); } });
  const saveSettings = useMutation({ mutationFn: (v: Partial<Settings>) => api('/api/settings', { method: 'PUT', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); void message.success('Đã lưu'); } });
  if (!company.data || !settings.data) return null;
  return (
    <Tabs items={[
      { key: 'phaply', label: 'Thông tin pháp lý', children: (
        <Card><Form layout="vertical" initialValues={company.data} onFinish={(v) => saveCompany.mutate(v)}>
          <Form.Item label="Mã" name="code"><Input disabled /></Form.Item>
          <Form.Item label="Tên công ty" name="name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Mã số thuế" name="taxCode"><Input /></Form.Item>
          <Form.Item label="Địa chỉ" name="address"><Input /></Form.Item>
          <Form.Item label="Người đại diện pháp luật" name="legalRep"><Input /></Form.Item>
          <Form.Item label="Kế toán trưởng" name="chiefAccountant"><Input /></Form.Item>
          <Form.Item label="Điện thoại" name="phone"><Input /></Form.Item>
          <Form.Item label="Email" name="email"><Input /></Form.Item>
          <Button type="primary" htmlType="submit">Lưu</Button></Form></Card>) },
      { key: 'tuychon', label: 'Tùy chọn hệ thống', children: (
        <Card><Form layout="vertical" initialValues={settings.data} onFinish={(v) => saveSettings.mutate(v)}>
          <Form.Item label="Hình thức sổ" name="book_form"><Select options={[{ value: 'NKC', label: 'Nhật ký chung' }]} /></Form.Item>
          <Form.Item label="Phương pháp giá vốn mặc định" name="costing_method"><Select options={[
            { value: 'avg_period', label: 'Bình quân cuối kỳ' }, { value: 'avg_moving', label: 'Bình quân tức thời' }, { value: 'fifo', label: 'Nhập trước xuất trước' }, { value: 'specific', label: 'Đích danh' }]} /></Form.Item>
          <Form.Item label="Loại tỷ giá ghi sổ" name="fx_rate_type"><Select options={[
            { value: 'transfer_avg', label: 'Mua bán chuyển khoản trung bình' }, { value: 'buy', label: 'Tỷ giá mua' }, { value: 'sell', label: 'Tỷ giá bán' }]} /></Form.Item>
          <Form.Item label="Ẩn phân hệ" name="hidden_modules"><Select mode="multiple" options={['inventory', 'assets', 'payroll', 'costing'].map((m) => ({ value: m, label: m }))} /></Form.Item>
          <Form.List name="extra_dims">{(fields, { add, remove }) => (<>
            <div style={{ marginBottom: 8 }}>Trường mở rộng (chiều phân tích thêm)</div>
            {fields.map((f) => (<div key={f.key} style={{ display: 'flex', gap: 8 }}>
              <Form.Item name={[f.name, 'key']} rules={[{ required: true, pattern: /^[a-z_]+$/ }]}><Input placeholder="ma_thong_ke" /></Form.Item>
              <Form.Item name={[f.name, 'label']} rules={[{ required: true }]}><Input placeholder="Mã thống kê" /></Form.Item>
              <Button onClick={() => remove(f.name)}>Xóa</Button></div>))}
            <Button onClick={() => add()}>Thêm trường</Button></>)}</Form.List>
          <div style={{ marginTop: 16 }}><Button type="primary" htmlType="submit">Lưu</Button></div></Form></Card>) },
    ]} />
  );
}
