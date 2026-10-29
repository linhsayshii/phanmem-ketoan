import { useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Modal, Select, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SENSITIVE_FLAGS } from '@kt/domain';
import { PageHeader, Section } from '@kt/ui';
import { api, type ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { BranchScopeButton } from './Branches.js';

interface UserRow { id: string; username: string; fullName: string; roleCode: string; sensitiveFlags: string[]; isActive: boolean }
interface Role { id: string; code: string; name: string }
const FLAG_LABEL: Record<string, string> = { view_cost: 'Xem giá vốn', view_receivable: 'Xem công nợ phải thu', view_payable: 'Xem công nợ phải trả', view_salary: 'Xem lương' };

export function UsersTable({ users, roles, onCreate, loading = false, canCreate = true, branchScope }: { users: UserRow[]; roles: Role[]; onCreate: (v: Record<string, unknown>) => Promise<void>; loading?: boolean; canCreate?: boolean; branchScope?: ((u: UserRow) => React.ReactNode) | undefined }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return (
    <>
      <PageHeader title="Người dùng" extra={canCreate && <Button type="primary" onClick={() => setOpen(true)}>Thêm người dùng</Button>} />
      <Section bodyPadding={0}>
        <Table rowKey="id" dataSource={users} loading={loading} pagination={false} columns={[
          { title: 'Tên đăng nhập', dataIndex: 'username' }, { title: 'Họ tên', dataIndex: 'fullName' },
          { title: 'Vai trò', dataIndex: 'roleCode', render: (c: string) => roles.find((r) => r.code === c)?.name ?? c },
          { title: 'Dữ liệu nhạy cảm', dataIndex: 'sensitiveFlags', render: (f: string[]) => f.map((x) => <Tag key={x}>{FLAG_LABEL[x] ?? x}</Tag>) },
          { title: 'Trạng thái', dataIndex: 'isActive', render: (a: boolean) => (a ? 'Đang dùng' : 'Khóa') },
          ...(branchScope ? [{ title: 'Phạm vi chi nhánh', key: 'branch', render: (_: unknown, u: UserRow) => branchScope(u) }] : [])]} />
      </Section>
      <Modal title="Thêm người dùng" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={async (v) => { try { await onCreate(v); setOpen(false); form.resetFields(); } catch { /* lỗi đã hiển thị qua onError */ } }}>
          <Form.Item label="Tên đăng nhập" name="username" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Họ tên" name="fullName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Mật khẩu" name="password" rules={[{ required: true, min: 8 }]}><Input.Password /></Form.Item>
          <Form.Item label="Vai trò" name="roleCode" rules={[{ required: true }]}><Select options={roles.map((r) => ({ value: r.code, label: r.name }))} /></Form.Item>
          <Form.Item label="Dữ liệu nhạy cảm" name="sensitiveFlags" initialValue={[]}><Checkbox.Group options={SENSITIVE_FLAGS.map((f) => ({ value: f, label: FLAG_LABEL[f] }))} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/api/roles') });
  const create = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/users', { method: 'POST', json: v }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); void message.success('Đã thêm người dùng'); },
    onError: (e) => void message.error((e as Error).message) });
  return (
    <>
      {users.isError && <Alert type="error" message={(users.error as ApiError).message} style={{ marginBottom: 12 }} />}
      {roles.isError && <Alert type="error" message={(roles.error as ApiError).message} style={{ marginBottom: 12 }} />}
      <UsersTable users={users.data ?? []} roles={roles.data ?? []} loading={users.isLoading} canCreate={can('user.create')} onCreate={(v) => create.mutateAsync(v).then(() => undefined)}
        branchScope={can('user.update') ? (u) => <BranchScopeButton userId={u.id} self={u.id === me?.userId} /> : undefined} />
    </>
  );
}
