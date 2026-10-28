import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatVnNumber } from '@kt/domain';
import { COLOR, PageHeader, Section, Toolbar } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export interface Acc { id: number; code: string; name: string; parentId: number | null; isGroup: boolean; normalBalance: string; trackCurrency: boolean; subledgerKind: string | null; isActive: boolean; children?: Acc[] | undefined }
const NB: Record<string, string> = { debit: 'Dư Nợ', credit: 'Dư Có', both: 'Lưỡng tính' };
const SK: Record<string, string> = { receivable: 'Phải thu', payable: 'Phải trả', inventory: 'Vật tư', fixed_asset: 'TSCĐ', bank: 'Ngân hàng', cash: 'Tiền mặt' };

export function buildTree(rows: Acc[]): Acc[] {
  const by = new Map<number, Acc>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Acc[] = [];
  for (const a of by.values()) { if (a.parentId && by.has(a.parentId)) by.get(a.parentId)!.children!.push(a); else roots.push(a); }
  const strip = (xs: Acc[]): Acc[] => xs.map((x) => (x.children!.length ? { ...x, children: strip(x.children!) } : { ...x, children: undefined }));
  return strip(roots);
}

export function stripDiacritics(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function filterTree(tree: Acc[], q: string): { filtered: Acc[]; expandedKeys: number[] } {
  const norm = stripDiacritics(q.trim());
  if (!norm) return { filtered: tree, expandedKeys: [] };

  const expandedKeys: number[] = [];

  function matchNode(a: Acc): boolean {
    return a.code.toLowerCase().startsWith(norm) || stripDiacritics(a.name).includes(norm);
  }

  function walk(nodes: Acc[]): Acc[] {
    const result: Acc[] = [];
    for (const node of nodes) {
      const selfMatch = matchNode(node);
      const sub = node.children ? walk(node.children) : [];
      if (selfMatch || sub.length > 0) {
        const keptChildren = sub.length > 0 ? sub : (selfMatch ? node.children : undefined);
        result.push({
          ...node,
          children: keptChildren && keptChildren.length > 0 ? keptChildren : undefined,
        });
      }
    }
    return result;
  }

  const filtered = walk(tree);

  function collectExpanded(nodes: Acc[]) {
    for (const n of nodes) {
      if (n.children && n.children.length > 0) {
        expandedKeys.push(n.id);
        collectExpanded(n.children);
      }
    }
  }
  collectExpanded(filtered);

  return { filtered, expandedKeys };
}

export function countTreeAccounts(nodes: Acc[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + (node.children ? countTreeAccounts(node.children) : 0);
  }
  return count;
}

export default function AccountsPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; regime: string }[]>('/api/fiscal-years') });
  const [regime, setRegime] = useState<string | undefined>();
  const current = regime ?? years.data?.at(-1)?.regime;
  const accounts = useQuery({ queryKey: ['accounts', current], queryFn: () => api<Acc[]>(`/api/accounts?regime=${current}`), enabled: !!current });
  const tree = useMemo(() => buildTree(accounts.data ?? []), [accounts.data]);
  const [search, setSearch] = useState('');
  const [userExpandedKeys, setUserExpandedKeys] = useState<React.Key[]>([]);
  const [searchExpandedKeys, setSearchExpandedKeys] = useState<React.Key[]>([]);

  const isSearching = search.trim().length > 0;
  const { filtered: filteredTree, expandedKeys } = useMemo(
    () => filterTree(tree, search),
    [tree, search],
  );

  useEffect(() => {
    if (isSearching) {
      setSearchExpandedKeys(expandedKeys);
    }
  }, [isSearching, expandedKeys]);

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
      <PageHeader
        title="Hệ thống tài khoản"
        description="Thêm tiểu khoản, đổi số hiệu, ghép tài khoản theo chế độ kế toán"
      >
        <Toolbar>
          <span>Chế độ kế toán</span>
          <Select
            aria-label="Chế độ kế toán"
            style={{ width: 120 }}
            value={current}
            onChange={setRegime}
            options={[...new Set((years.data ?? []).map((y) => y.regime))].map((r) => ({ value: r, label: r }))}
          />
          <Input.Search
            placeholder="Tìm số hiệu, tên…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={setSearch}
            style={{ width: 260 }}
            allowClear
          />
          {accounts.data && (
            <span style={{ marginLeft: 'auto', color: COLOR.textSecondary, fontSize: 13 }}>
              {formatVnNumber(String(countTreeAccounts(filteredTree)))} tài khoản
            </span>
          )}
        </Toolbar>
      </PageHeader>
      <Section bodyPadding={0}>
        <Table<Acc>
          rowKey="id"
          dataSource={filteredTree}
          pagination={false}
          size="small"
          sticky
          scroll={{ y: 'calc(100vh - 230px)' }}
          expandable={{
            defaultExpandAllRows: false,
            expandedRowKeys: isSearching ? searchExpandedKeys : userExpandedKeys,
            onExpandedRowsChange: (keys) => {
              if (isSearching) {
                setSearchExpandedKeys([...keys]);
              } else {
                setUserExpandedKeys([...keys]);
              }
            },
          }}
          columns={[
            { title: 'Số hiệu', dataIndex: 'code', width: 140, className: 'kt-num' },
            { title: 'Tên tài khoản', dataIndex: 'name' },
            { title: 'Loại dư', dataIndex: 'normalBalance', width: 110, render: (v: string) => NB[v] },
            {
              title: 'Theo dõi',
              width: 200,
              render: (_, a) => (
                <>
                  {a.subledgerKind && <Tag>{SK[a.subledgerKind]}</Tag>}
                  {a.trackCurrency && <Tag>Ngoại tệ</Tag>}
                  {a.isGroup && <Tag color="blue">Tổng hợp</Tag>}
                </>
              ),
            },
            {
              title: '',
              width: 300,
              render: (_, a) => (
                <Space size={0}>
                  {can('account.create') && <Button type="link" size="small" onClick={() => setModal({ kind: 'sub', code: a.code })}>Thêm tiểu khoản</Button>}
                  {can('account.update') && <Button type="link" size="small" onClick={() => setModal({ kind: 'rename', code: a.code })}>Đổi số hiệu</Button>}
                  {can('account.update') && !a.isGroup && <Button type="link" size="small" onClick={() => setModal({ kind: 'merge', code: a.code })}>Ghép</Button>}
                </Space>
              ),
            },
          ]}
        />
      </Section>
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
