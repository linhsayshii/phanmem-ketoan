import { useEffect, useRef, useState } from 'react';
import { Alert, Form, Modal, Select, Space, Table } from 'antd';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { D } from '@kt/domain';
import { LookupSelect } from '@kt/ui';
import { api } from '../api/client.js';
import { bankAccountFetcher } from '../lookups.js';
import { PayrollErrorAlert } from './payrollUi.js';
import { money } from './payrollCommon.js';

// Xuất tệp chi lương theo lô (Task 8) từ bảng lương đã hạch toán: chọn mẫu tệp, xuất, tải tệp, xem cảnh báo người không vào tệp và các lần xuất trước.
interface Format { id: number; name: string; fileType: string }
interface Warn { code: string; employeeCode: string; employeeName: string; amount: string; message: string }
interface Result { batchId: number; fileName: string; total: string; count: number; payableTotal: string; voucherNo: string | null; warnings: Warn[] }
interface Batch { id: number; fileName: string; total: string; count: number; createdAt: string; formatName: string; voucherNo: string | null }
export const batchUrl = (id: number) => `/api/payroll/payment-batches/${id}/file`;

export function PaymentFileDialog({ runId, open, onClose }: { runId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ formatId: number; bankAccountNo: string | null }>();
  const bankId = useRef<number | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [res, setRes] = useState<Result | null>(null);
  const formats = useQuery({ queryKey: ['payroll-payment-formats'], enabled: open, queryFn: () => api<Format[]>('/api/payroll/payment-formats') });
  const batches = useQuery({ queryKey: ['payroll-payment-batches', runId], enabled: open, queryFn: () => api<Batch[]>(`/api/payroll/runs/${runId}/payment-batches`) });
  useEffect(() => { if (open) { setErr(null); setRes(null); bankId.current = null; form.resetFields(); } }, [open, form]);
  useEffect(() => { if (open && formats.data?.length && !form.getFieldValue('formatId')) form.setFieldValue('formatId', formats.data[0]!.id); }, [open, formats.data, form]);
  const submit = () => {
    void form.validateFields().then(async (v) => {
      setBusy(true); setErr(null); setRes(null);
      try {
        setRes(await api<Result>(`/api/payroll/runs/${runId}/payment-file`, { method: 'POST', json: { formatId: v.formatId, ...(bankId.current ? { bankAccountId: bankId.current } : {}) } }));
        void qc.invalidateQueries({ queryKey: ['payroll-payment-batches', runId] });
      } catch (e) { setErr(e); } finally { setBusy(false); }
    }, () => undefined);
  };
  return (
    <Modal open={open} title="Xuất tệp chi lương" onCancel={onClose} onOk={submit} okText="Xuất tệp" cancelText="Đóng" confirmLoading={busy} destroyOnHidden forceRender width={760}>
      <Form form={form} name="payroll-payment-file" layout="vertical">
        <Space align="start" wrap>
          <Form.Item label="Mẫu tệp" name="formatId" rules={[{ required: true, message: 'Chọn mẫu tệp' }]}>
            <Select aria-label="Mẫu tệp" style={{ width: 260 }} loading={formats.isLoading} options={(formats.data ?? []).map((f) => ({ value: f.id, label: `${f.name} (${f.fileType === 'xlsx' ? 'Excel' : 'CSV'})` }))} />
          </Form.Item>
          <Form.Item label="Tài khoản ngân hàng chi (F4, không bắt buộc)" name="bankAccountNo">
            <LookupSelect catalog="bank_account" fetcher={bankAccountFetcher} allowClear aria-label="Tài khoản ngân hàng chi" style={{ width: 300 }}
              onChange={(no, row) => { bankId.current = row ? Number(row.id) : null; form.setFieldValue('bankAccountNo', no); }} />
          </Form.Item>
        </Space>
        <div style={{ marginBottom: 8 }}>Nhân viên chưa có số tài khoản nhận hoặc trả bằng tiền mặt được liệt kê ở cảnh báo và không đưa vào tệp. Nếu đã lập phiếu chi lương, tổng cần chi phải khớp phiếu.
          Mẫu tệp cấu hình ở <Link to="/luong/mau-chi-luong">Mẫu tệp chi lương</Link>.</div>
        <PayrollErrorAlert error={err} />
      </Form>
      {res && (
        <div data-testid="payment-result" style={{ marginBottom: 12 }}>
          <Alert type="success" showIcon message={`Đã xuất ${res.count} người, tổng ${money(res.total)} đồng${res.voucherNo ? `, khớp phiếu chi lương ${res.voucherNo}` : ''}`}
            description={<a href={batchUrl(res.batchId)} download={res.fileName} data-testid="payment-download">Tải tệp {res.fileName}</a>} />
          {res.warnings.length > 0 && <Alert style={{ marginTop: 8 }} type="warning" showIcon data-testid="payment-warnings" message={`${res.warnings.length} nhân viên không đưa vào tệp (${money(res.warnings.reduce((s, w) => s.plus(w.amount), D(0)).toFixed(0))} đồng)`}
            description={<ul style={{ margin: 0, paddingLeft: 18 }}>{res.warnings.map((w) => <li key={w.employeeCode}>{w.message}</li>)}</ul>} />}
        </div>)}
      {!!batches.data?.length && <Table<Batch> size="small" rowKey="id" pagination={false} dataSource={batches.data} title={() => 'Các lần xuất trước'} data-testid="payment-batches" scroll={{ y: 160 }}
        columns={[
          { title: 'Lúc', dataIndex: 'createdAt', width: 140, render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm') }, { title: 'Mẫu', dataIndex: 'formatName' },
          { title: 'Số người', dataIndex: 'count', width: 90, align: 'right' }, { title: 'Tổng tiền', dataIndex: 'total', width: 140, align: 'right', render: (v: string) => money(v) },
          { title: '', width: 90, render: (_, b) => <a href={batchUrl(b.id)} download={b.fileName}>Tải lại</a> },
        ]} />}
    </Modal>);
}
