import { useState } from 'react';
import { Button, Card, DatePicker, Form, Input, InputNumber, Modal, Select, Steps, message } from 'antd';
import dayjs from 'dayjs';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { RegimeNotice } from './Regimes.js';

export const REGIMES = [
  { value: 'TT99', label: 'TT99' },
  { value: 'TT133', label: 'TT 133/2016/TT-BTC (DNNVV)' },
  { value: 'TT200', label: 'TT 200/2014/TT-BTC (dữ liệu 2025 trở về trước)' },
  { value: 'TT58', label: 'TT 58/2026/TT-BTC (doanh nghiệp siêu nhỏ) - chờ văn bản gốc' },
  { value: 'TT152', label: 'TT 152/2025/TT-BTC (hộ kinh doanh) - chờ văn bản gốc' },
];

export default function CompanyWizard() {
  const [step, setStep] = useState(0); const [regime, setRegime] = useState('TT133');
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
          onFinish={async (v) => {
            const send = async (confirmRegimeOverride: boolean) => {
              await api('/api/fiscal-years', { method: 'POST', json: { ...v, dateFrom: (v.dateFrom as dayjs.Dayjs).format('YYYY-MM-DD'), ...(confirmRegimeOverride && { confirmRegimeOverride: true }) } });
              void message.success('Đã tạo năm tài chính'); void navigate({ to: '/' });
            };
            try { await send(false); } catch (e) {
              // Chế độ chưa đối chiếu hoặc ngoài hiệu lực (REGIME_NOT_READY, REGIME_NOT_EFFECTIVE): hỏi xác nhận rõ, ghi nhật ký; chế độ chưa có dữ liệu (COA_TEMPLATE_PENDING) không xác nhận được.
              if (e instanceof ApiError && (e.code === 'REGIME_NOT_READY' || e.code === 'REGIME_NOT_EFFECTIVE'))
                Modal.confirm({ title: 'Tạo năm tài chính theo chế độ này?', width: 520, content: e.message, okText: 'Vẫn tạo', cancelText: 'Chọn lại', onOk: async () => { try { await send(true); } catch (e2) { void message.error((e2 as Error).message); } } });
              else void message.error((e as Error).message);
            }
          }}>
          <Form.Item label="Năm tài chính" name="fiscalYear" rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item>
          <Form.Item label="Ngày bắt đầu" name="dateFrom" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabledDate={(d) => d.date() !== 1} /></Form.Item>
          <Form.Item label="Số tháng (năm đầu tối đa 15)" name="months" rules={[{ required: true }]}><InputNumber min={1} max={15} /></Form.Item>
          <Form.Item label="Chế độ kế toán" name="regime" rules={[{ required: true }]}><Select options={REGIMES} onChange={setRegime} /></Form.Item>
          <RegimeNotice regime={regime} />
          <Button type="primary" htmlType="submit">Hoàn tất</Button>
        </Form>
      )}
    </Card>
  );
}
