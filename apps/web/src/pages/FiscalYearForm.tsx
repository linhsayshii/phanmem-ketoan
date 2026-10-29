import { useState } from 'react';
import { Button, DatePicker, Form, InputNumber, Modal, Select, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../api/client.js';
import { RegimeNotice } from './Regimes.js';

export const REGIMES = [
  { value: 'TT99', label: 'TT99' },
  { value: 'TT133', label: 'TT 133/2016/TT-BTC (DNNVV)' },
  { value: 'TT200', label: 'TT 200/2014/TT-BTC (dữ liệu 2025 trở về trước)' },
  { value: 'TT58', label: 'TT 58/2026/TT-BTC (doanh nghiệp siêu nhỏ), ghi sổ theo nhóm thuế' },
  { value: 'TT152', label: 'TT 152/2025/TT-BTC (hộ kinh doanh), ghi sổ theo nhóm thuế' },
];

export interface FiscalYearDefaults { fiscalYear: number; dateFrom: Dayjs; months: number; regime: string }

/** Năm tài chính kế tiếp: bắt đầu ngay sau năm cuối cùng, cùng chế độ; chưa có năm nào thì 01/01 năm hiện tại, chế độ TT133. */
export function nextFiscalYearDefaults(years: { fiscalYear: number; regime: string; dateTo: string }[] | undefined): FiscalYearDefaults {
  const last = years?.at(-1);
  if (!last?.dateTo) return { fiscalYear: dayjs().year(), dateFrom: dayjs().startOf('year'), months: 12, regime: 'TT133' };
  return { fiscalYear: last.fiscalYear + 1, dateFrom: dayjs(last.dateTo).add(1, 'day'), months: 12, regime: last.regime };
}

// Biểu mẫu tạo năm tài chính (POST /api/fiscal-years), dùng ở trình thiết lập công ty và ở Kỳ kế toán. Chế độ chưa đối chiếu hoặc ngoài hiệu lực
// (REGIME_NOT_READY, REGIME_NOT_EFFECTIVE) hỏi xác nhận rõ và ghi nhật ký; chế độ chưa có dữ liệu (COA_TEMPLATE_PENDING) không xác nhận được.
export function FiscalYearForm({ initial, submitText, onCreated }: { initial: FiscalYearDefaults; submitText: string; onCreated: () => void }) {
  const [regime, setRegime] = useState(initial.regime);
  const failText = (e: unknown) => void message.error((e as Error).message);
  return (
    <Form layout="vertical" initialValues={initial}
      onFinish={async (v) => {
        const send = async (confirmRegimeOverride: boolean) => {
          await api('/api/fiscal-years', { method: 'POST', json: { ...v, dateFrom: (v.dateFrom as Dayjs).format('YYYY-MM-DD'), ...(confirmRegimeOverride && { confirmRegimeOverride: true }) } });
          void message.success('Đã tạo năm tài chính'); onCreated();
        };
        try { await send(false); } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'REGIME_NOT_READY' || code === 'REGIME_NOT_EFFECTIVE')
            Modal.confirm({ title: 'Tạo năm tài chính theo chế độ này?', width: 520, content: (e as Error).message, okText: 'Vẫn tạo', cancelText: 'Chọn lại', onOk: async () => { try { await send(true); } catch (e2) { failText(e2); } } });
          else failText(e);
        }
      }}>
      <Form.Item label="Năm tài chính" name="fiscalYear" rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item>
      <Form.Item label="Ngày bắt đầu" name="dateFrom" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabledDate={(d) => d.date() !== 1} /></Form.Item>
      <Form.Item label="Số tháng (năm đầu tối đa 15)" name="months" rules={[{ required: true }]}><InputNumber min={1} max={15} /></Form.Item>
      <Form.Item label="Chế độ kế toán" name="regime" rules={[{ required: true }]}><Select options={REGIMES} onChange={setRegime} /></Form.Item>
      <RegimeNotice regime={regime} />
      <Button type="primary" htmlType="submit">{submitText}</Button>
    </Form>
  );
}
