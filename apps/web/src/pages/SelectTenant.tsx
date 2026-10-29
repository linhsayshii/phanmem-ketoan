import { Button, List } from 'antd';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AuthCard } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export default function SelectTenantPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <AuthCard title="Chọn công ty" width={480}>
      <List dataSource={me?.tenants ?? []} renderItem={(t) => (
        <List.Item onClick={async () => { await api('/api/auth/select-tenant', { method: 'POST', json: { tenantId: t.id } }); qc.clear(); await refresh(); void navigate({ to: '/' }); }} style={{ cursor: 'pointer' }}>
          <List.Item.Meta title={t.name} description={t.code} />
        </List.Item>)} />
      <Button type="link" style={{ paddingLeft: 0, marginTop: 8 }} onClick={() => void navigate({ to: '/he-thong/tao-cong-ty' })}>Tạo công ty mới</Button>
    </AuthCard>
  );
}
