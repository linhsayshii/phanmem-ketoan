import { useState } from 'react';
import { Button, Form, Input, Steps, message } from 'antd';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader, Section } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { FiscalYearForm, nextFiscalYearDefaults } from './FiscalYearForm.js';

export default function CompanyWizard() {
  const [step, setStep] = useState(0);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <PageHeader
        title="Tạo công ty mới"
        description="Khai báo thông tin pháp lý và thiết lập năm tài chính đầu tiên"
      />
      <Section>
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
        {step === 1 && <FiscalYearForm initial={nextFiscalYearDefaults(undefined)} submitText="Hoàn tất" onCreated={() => void navigate({ to: '/' })} />}
      </Section>
    </div>
  );
}
