import { useState } from 'react';
import { Button, Checkbox, Form, Input, Modal, Select, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SENSITIVE_FLAGS } from '@kt/domain';
import { api } from '../api/client.js';

interface UserRow { id: string; username: string; fullName: string; roleCode: string; sensitiveFlags: string[]; isActive: boolean }
interface Role { id: string; code: string; name: string }
const FLAG_LABEL: Record<string, string> = { view_cost: 'Xem giá vốn', view_receivable: 'Xem công nợ phải thu', view_payable: 'Xem công nợ phải trả', view_salary: 'Xem lương' };

export function UsersTable({ users, roles, onCreate }: { users: UserRow[]; roles: Role[]; onCreate: (v: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)} style={{ marginBottom: 12 }}>Thêm người dùng</Button>
      <Table rowKey="id" dataSource={users} pagination={false} columns={[
        { title: 'Tên đăng nhập', dataIndex: 'username' }, { title: 'Họ tên', dataIndex: 'fullName' },
        { title: 'Vai trò', dataIndex: 'roleCode', render: (c: string) => roles.find((r) => r.code === c)?.name ?? c },
        { title: 'Dữ liệu nhạy cảm', dataIndex: 'sensitiveFlags', render: (f: string[]) => f.map((x) => <Tag key={x}>{FLAG_LABEL[x] ?? x}</Tag>) },
        { title: 'Trạng thái', dataIndex: 'isActive', render: (a: boolean) => (a ? 'Đang dùng' : 'Khóa') }]} />
      <Modal title="Thêm người dùng" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={async (v) => { await onCreate(v); setOpen(false); form.resetFields(); }}>
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
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/api/roles') });
  const create = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/users', { method: 'POST', json: v }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); void message.success('Đã thêm người dùng'); },
    onError: (e) => void message.error((e as Error).message) });
  return <UsersTable users={users.data ?? []} roles={roles.data ?? []} onCreate={(v) => create.mutateAsync(v).then(() => undefined)} />;
}
