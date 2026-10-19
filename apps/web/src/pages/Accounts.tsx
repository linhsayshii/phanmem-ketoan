import { useMemo, useState } from 'react';
import { Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Acc { id: number; code: string; name: string; parentId: number | null; isGroup: boolean; normalBalance: string; trackCurrency: boolean; subledgerKind: string | null; isActive: boolean; children?: Acc[] | undefined }
const NB: Record<string, string> = { debit: 'Dư Nợ', credit: 'Dư Có', both: 'Lưỡng tính' };
const SK: Record<string, string> = { receivable: 'Phải thu', payable: 'Phải trả', inventory: 'Vật tư', fixed_asset: 'TSCĐ', bank: 'Ngân hàng', cash: 'Tiền mặt' };

export function buildTree(rows: Acc[]): Acc[] {
  const by = new Map<number, Acc>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Acc[] = [];
  for (const a of by.values()) { if (a.parentId && by.has(a.parentId)) by.get(a.parentId)!.children!.push(a); else roots.push(a); }
  const strip = (xs: Acc[]): Acc[] => xs.map((x) => (x.children!.length ? { ...x, children: strip(x.children!) } : { ...x, children: undefined }));
  return strip(roots);
}

export default function AccountsPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; regime: string }[]>('/api/fiscal-years') });
  const [regime, setRegime] = useState<string | undefined>();
  const current = regime ?? years.data?.at(-1)?.regime;
  const accounts = useQuery({ queryKey: ['accounts', current], queryFn: () => api<Acc[]>(`/api/accounts?regime=${current}`), enabled: !!current });
  const tree = useMemo(() => buildTree(accounts.data ?? []), [accounts.data]);
  const [modal, setModal] = useState<{ kind: 'sub' | 'rename' | 'merge'; code: string } | null>(null);
  const [form] = Form.useForm();
  const run = useMutation({
    mutationFn: (v: Record<string, unknown>) => modal!.kind === 'sub' ? api('/api/accounts', { method: 'POST', json: { regime: current, parentCode: modal!.code, ...v } })
      : modal!.kind === 'rename' ? api('/api/accounts/rename', { method: 'POST', json: { regime: current, oldCode: modal!.code, newCode: v.newCode } })
      : api('/api/accounts/merge', { method: 'POST', json: { regime: current, sourceCode: modal!.code, targetCode: v.targetCode } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['accounts'] }); setModal(null); form.resetFields(); void message.success('Đã lưu'); },
    onError: (e) => void message.error((e as Error).message) });
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <span>Chế độ kế toán</span>
        <Select style={{ width: 120 }} value={current} onChange={setRegime} options={[...new Set((years.data ?? []).map((y) => y.regime))].map((r) => ({ value: r, label: r }))} />
      </Space>
      <Table<Acc> rowKey="id" dataSource={tree} pagination={false} size="small" expandable={{ defaultExpandAllRows: false }} columns={[
        { title: 'Số hiệu', dataIndex: 'code', width: 140 }, { title: 'Tên tài khoản', dataIndex: 'name' },
        { title: 'Loại dư', dataIndex: 'normalBalance', width: 110, render: (v: string) => NB[v] },
        { title: 'Theo dõi', width: 200, render: (_, a) => <>{a.subledgerKind && <Tag>{SK[a.subledgerKind]}</Tag>}{a.trackCurrency && <Tag>Ngoại tệ</Tag>}{a.isGroup && <Tag color="blue">Tổng hợp</Tag>}</> },
        { title: '', width: 260, render: (_, a) => can('account.update') && (<Space>
          <a onClick={() => setModal({ kind: 'sub', code: a.code })}>Thêm tiểu khoản</a>
          <a onClick={() => setModal({ kind: 'rename', code: a.code })}>Đổi số hiệu</a>
          {!a.isGroup && <a onClick={() => setModal({ kind: 'merge', code: a.code })}>Ghép</a>}</Space>) }]} />
      <Modal open={!!modal} onCancel={() => setModal(null)} onOk={() => form.submit()} destroyOnHidden
        title={modal?.kind === 'sub' ? `Thêm tiểu khoản của ${modal.code}` : modal?.kind === 'rename' ? `Đổi số hiệu ${modal.code}` : `Ghép ${modal?.code} vào tài khoản khác`}>
        <Form form={form} layout="vertical" onFinish={(v) => run.mutate(v)}>
          {modal?.kind === 'sub' && (<>
            <Form.Item label="Số hiệu" name="code" rules={[{ required: true, pattern: /^\d{1,8}$/ }]}><Input /></Form.Item>
            <Form.Item label="Tên tài khoản" name="name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item label="Loại dư" name="normalBalance"><Select allowClear options={Object.entries(NB).map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item label="Theo dõi chi tiết" name="subledgerKind"><Select allowClear options={Object.entries(SK).map(([value, label]) => ({ value, label }))} /></Form.Item></>)}
          {modal?.kind === 'rename' && <Form.Item label="Số hiệu mới" name="newCode" rules={[{ required: true, pattern: /^\d{1,8}$/ }]}><Input /></Form.Item>}
          {modal?.kind === 'merge' && <Form.Item label="Ghép vào tài khoản" name="targetCode" rules={[{ required: true }]}><Input /></Form.Item>}
        </Form>
      </Modal>
    </>
  );
}
