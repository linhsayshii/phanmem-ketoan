import { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { useNavigate } from '@tanstack/react-router';
import { AuthCard } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export interface LoginInput { username: string; password: string }

export function LoginForm({ onLogin }: { onLogin: (v: LoginInput) => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Đăng nhập">
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Form layout="vertical" onFinish={async (v: LoginInput) => { setBusy(true); setError(null); try { await onLogin(v); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
        <Form.Item label="Tên đăng nhập" name="username" rules={[{ required: true, message: 'Nhập tên đăng nhập' }]}><Input autoFocus /></Form.Item>
        <Form.Item label="Mật khẩu" name="password" rules={[{ required: true, message: 'Nhập mật khẩu' }]}><Input.Password /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} block>Đăng nhập</Button>
      </Form>
    </AuthCard>
  );
}

export default function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return <LoginForm onLogin={async (v) => {
    const r = await api<{ tenantId: string | null }>('/api/auth/login', { method: 'POST', json: v });
    await refresh();
    void navigate({ to: r.tenantId ? '/' : '/chon-cong-ty' });
  }} />;
}
