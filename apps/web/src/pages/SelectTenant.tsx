import { Card, List } from 'antd';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export default function SelectTenantPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <Card title="Chọn công ty" style={{ maxWidth: 480, margin: '80px auto' }}>
      <List dataSource={me?.tenants ?? []} renderItem={(t) => (
        <List.Item onClick={async () => { await api('/api/auth/select-tenant', { method: 'POST', json: { tenantId: t.id } }); qc.clear(); await refresh(); void navigate({ to: '/' }); }} style={{ cursor: 'pointer' }}>
          <List.Item.Meta title={t.name} description={t.code} />
        </List.Item>)} />
    </Card>
  );
}
