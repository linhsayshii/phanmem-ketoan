import { useState } from 'react';
import { Button, Card, DatePicker, Form, Input, InputNumber, Select, Steps, message } from 'antd';
import dayjs from 'dayjs';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export const REGIMES = [
  { value: 'TT99', label: 'TT99' },
  { value: 'TT133', label: 'TT 133/2016/TT-BTC (DNNVV)' },
  { value: 'TT200', label: 'TT 200/2014/TT-BTC (dữ liệu 2025 trở về trước)' },
];

export default function CompanyWizard() {
  const [step, setStep] = useState(0);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <Card title="Tạo công ty mới" style={{ maxWidth: 640, margin: '0 auto' }}>
      <Steps current={step} items={[{ title: 'Thông tin pháp lý' }, { title: 'Năm tài chính' }]} style={{ marginBottom: 24 }} />
      {step === 0 && (
        <Form layout="vertical" onFinish={async (v) => { try { await api('/api/tenants', { method: 'POST', json: v }); qc.clear(); await refresh(); setStep(1); } catch (e) { void message.error((e as Error).message); } }}>
          <Form.Item label="Mã công ty" name="code" rules={[{ required: true, pattern: /^[A-Z0-9_]+$/, message: 'Chữ in hoa, số, gạch dưới' }]}><Input /></Form.Item>
          <Form.Item label="Tên công ty" name="name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Mã số thuế" name="taxCode" rules={[{ pattern: /^\d{10}(-\d{3})?$/, message: '10 chữ số hoặc 10-3' }]}><Input /></Form.Item>
          <Form.Item label="Địa chỉ" name="address"><Input /></Form.Item>
          <Form.Item label="Người đại diện pháp luật" name="legalRep"><Input /></Form.Item>
          <Form.Item label="Kế toán trưởng" name="chiefAccountant"><Input /></Form.Item>
          <Button type="primary" htmlType="submit">Tiếp tục</Button>
        </Form>
      )}
      {step === 1 && (
        <Form layout="vertical" initialValues={{ fiscalYear: 2026, dateFrom: dayjs('2026-01-01'), months: 12, regime: 'TT133' }}
          onFinish={async (v) => { try {
            await api('/api/fiscal-years', { method: 'POST', json: { ...v, dateFrom: (v.dateFrom as dayjs.Dayjs).format('YYYY-MM-DD') } });
            void message.success('Đã tạo năm tài chính'); void navigate({ to: '/' });
          } catch (e) { void message.error((e as Error).message); } }}>
          <Form.Item label="Năm tài chính" name="fiscalYear" rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item>
          <Form.Item label="Ngày bắt đầu" name="dateFrom" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabledDate={(d) => d.date() !== 1} /></Form.Item>
          <Form.Item label="Số tháng (năm đầu tối đa 15)" name="months" rules={[{ required: true }]}><InputNumber min={1} max={15} /></Form.Item>
          <Form.Item label="Chế độ kế toán" name="regime" rules={[{ required: true }]}><Select options={REGIMES} /></Form.Item>
          <Button type="primary" htmlType="submit">Hoàn tất</Button>
        </Form>
      )}
    </Card>
  );
}
