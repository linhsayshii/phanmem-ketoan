import { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, DatePicker, Form, Input, Modal, Select, Space, Switch, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

type Severity = 'error' | 'warning';
// Hàng của GET /api/catalogs/data_check_rule (snake_case). Cột sql chỉ để xem: chỉ hệ thống cung cấp quy tắc.
interface Rule { id: number; code: string; name: string; severity: Severity; sql: string; message: string; fix_hint: string | null; is_system: boolean; is_enabled: boolean }
interface CheckResult { ruleCode: string; ruleName: string; severity: Severity; message: string; fixHint: string | null; voucherId: string | null; voucherNo: string | null; ref: string | null; detail: string | null }
interface RuleForm { name: string; severity: Severity; message: string; fix_hint: string | null }

const SEVERITY = { error: { color: 'red', label: 'Lỗi' }, warning: { color: 'orange', label: 'Cảnh báo' } } as const;
const options = Object.entries(SEVERITY).map(([value, v]) => ({ value, label: v.label }));

export default function DataCheckPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().startOf('year'), dayjs().endOf('month')]);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [form] = Form.useForm<RuleForm>();
  const canView = can('catalog.view');
  const rules = useQuery({ queryKey: ['data-check-rules'], enabled: canView, queryFn: () => api<{ rows: Rule[] }>('/api/catalogs/data_check_rule?size=1000') });
  useEffect(() => { if (rules.error) void message.error((rules.error as Error).message); }, [rules.error]);
  // Hộp chọn chỉ quyết định quy tắc nào chạy ở lần này; bật/tắt vĩnh viễn là công tắc ở cột "Bật".
  useEffect(() => { if (rules.data) setSelected(rules.data.rows.filter((r) => r.is_enabled).map((r) => r.code)); }, [rules.data]);
  const onError = (e: unknown) => { void message.error((e as Error).message); };
  const update = useMutation({ mutationFn: ({ id, json }: { id: number; json: object }) => api(`/api/catalogs/data_check_rule/${id}`, { method: 'PUT', json }), onError,
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: ['data-check-rules'] }); void message.success('Đã lưu'); } });
  const check = useMutation({
    mutationFn: () => api<{ results: CheckResult[]; ran: number; truncated: string[] }>('/api/data-check/run', { method: 'POST', json: { from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD'), ...(canView ? { codes: selected } : {}) } }),
    onError });

  const groups = new Map<string, CheckResult[]>();
  for (const r of check.data?.results ?? []) groups.set(r.ruleCode, [...(groups.get(r.ruleCode) ?? []), r]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="Soát lỗi dữ liệu">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message="Quy tắc tùy chỉnh bằng SQL chưa hỗ trợ vì lý do an toàn dữ liệu" description="Quy tắc do hệ thống cung cấp; bạn có thể bật/tắt từng quy tắc hoặc sửa tên, mức, thông điệp và hướng dẫn sửa." />
          <Space wrap>
            <span>Khoảng ngày ghi sổ</span>
            <DatePicker.RangePicker allowClear={false} format="DD/MM/YYYY" value={range} onChange={(v) => { if (v?.[0] && v[1]) setRange([v[0], v[1]]); }} />
            <Button type="primary" loading={check.isPending} disabled={canView && selected.length === 0} onClick={() => check.mutate()}>Soát lỗi</Button>
          </Space>
          {canView && (
            <Table<Rule> rowKey="code" size="small" pagination={false} loading={rules.isFetching} dataSource={rules.data?.rows ?? []}
              rowSelection={{ selectedRowKeys: selected, getCheckboxProps: (r) => ({ disabled: !r.is_enabled }), onChange: (keys) => setSelected(keys as string[]) }}
              expandable={{ expandedRowRender: (r) => <div><b>Câu SQL (chỉ xem; tham số $1 từ ngày, $2 đến ngày)</b><pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.sql}</pre></div> }}
              columns={[
                { title: 'Mã', dataIndex: 'code', width: 240 },
                { title: 'Tên quy tắc', dataIndex: 'name' },
                { title: 'Mức', dataIndex: 'severity', width: 100, render: (s: Severity) => <Tag color={SEVERITY[s].color}>{SEVERITY[s].label}</Tag> },
                { title: 'Thông điệp', dataIndex: 'message' },
                { title: 'Hướng dẫn sửa', dataIndex: 'fix_hint' },
                { title: 'Bật', dataIndex: 'is_enabled', width: 80, render: (on: boolean, r) => <Switch size="small" checked={on} disabled={!can('data_check.manage') || update.isPending} onChange={(v) => update.mutate({ id: r.id, json: { is_enabled: v } })} /> },
                { title: '', key: 'act', width: 70, render: (_, r) => can('data_check.manage') && <Button size="small" onClick={() => { setEditing(r); form.setFieldsValue({ name: r.name, severity: r.severity, message: r.message, fix_hint: r.fix_hint }); }}>Sửa</Button> },
              ]} />)}
        </Space>
      </Card>

      {check.data && (check.data.results.length === 0
        ? <Alert type="success" showIcon message={`Đã chạy ${check.data.ran} quy tắc, không phát hiện vấn đề`} />
        : <Card title={`Kết quả: ${check.data.results.length} dòng từ ${groups.size} quy tắc (đã chạy ${check.data.ran} quy tắc)`}>
          <Collapse defaultActiveKey={[...groups.keys()]} items={[...groups].map(([code, rows]) => ({ key: code,
            label: <Space><Tag color={SEVERITY[rows[0]!.severity].color}>{SEVERITY[rows[0]!.severity].label}</Tag><b>{rows[0]!.ruleName}</b><span>({rows.length})</span></Space>,
            children: (<>
              <p style={{ marginTop: 0 }}>{rows[0]!.message}</p>
              {check.data.truncated.includes(code) && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="Chỉ hiển thị 1000 kết quả đầu" />}
              <Table<CheckResult & { key: number }> size="small" pagination={rows.length > 50 ? { pageSize: 50 } : false} dataSource={rows.map((r, key) => ({ ...r, key }))} columns={[
                { title: 'Chứng từ', dataIndex: 'voucherNo', width: 140 },
                { title: 'Tham chiếu', dataIndex: 'ref', width: 220 },
                { title: 'Chi tiết', dataIndex: 'detail' },
                { title: 'Hướng dẫn sửa', dataIndex: 'fixHint' },
                { title: '', key: 'fix', width: 120, render: (_, r) => r.voucherId && <Link to="/chung-tu/$type/$id" params={{ type: 'PKT', id: r.voucherId }}>Sửa chứng từ</Link> },
              ]} /></>) }))} />
        </Card>)}

      <Modal open={!!editing} title={`Sửa quy tắc ${editing?.code ?? ''}`} okText="Lưu" cancelText="Hủy" confirmLoading={update.isPending} destroyOnHidden onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form<RuleForm> form={form} layout="vertical" onFinish={(v) => update.mutate({ id: editing!.id, json: { ...v, fix_hint: v.fix_hint || null } })}>
          <Form.Item name="name" label="Tên quy tắc" rules={[{ required: true, message: 'Nhập tên' }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="severity" label="Mức" rules={[{ required: true }]}><Select options={options} /></Form.Item>
          <Form.Item name="message" label="Thông điệp" rules={[{ required: true, message: 'Nhập thông điệp' }]}><Input maxLength={500} /></Form.Item>
          <Form.Item name="fix_hint" label="Hướng dẫn sửa"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          <Form.Item label="Câu SQL (chỉ xem)"><Input.TextArea rows={5} readOnly value={editing?.sql ?? ''} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
