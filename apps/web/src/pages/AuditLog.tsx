import { useEffect, useState } from 'react';
import { DatePicker, Input, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Row { id: number; ts: string; username: string | null; action: string; entity: string; entityId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; ip: string | null }
interface LoginRow { ts: string; username: string; success: boolean; ip: string | null }
const ACTION: Record<string, string> = { insert: 'Thêm', update: 'Sửa', delete: 'Xóa', post: 'Ghi sổ', unpost: 'Bỏ ghi sổ', reverse: 'Đảo', discard: 'Hủy', lock: 'Khóa kỳ', unlock: 'Bỏ khóa', reset_password: 'Đặt lại mật khẩu' };
const SIZE = 50;
// Postgres trả timestamptz dạng '2026-10-20 12:00:00+00': Safari không đọc được, nên đưa về ISO 8601 trước khi định dạng.
const fmtTs = (v: string) => dayjs(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).format('DD/MM/YYYY HH:mm:ss');

export function diffJson(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { key: string; before: unknown; after: unknown }[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])).map((k) => ({ key: k, before: before?.[k], after: after?.[k] }));
}

export default function AuditLogPage() {
  const { me } = useAuth();
  const [f, setF] = useRememberedFilter('audit', { entity: '', action: '', from: '', to: '' }, `${me?.tenantId ?? ''}:${me?.userId ?? ''}`);
  const [page, setPage] = useState(1);
  const [loginPage, setLoginPage] = useState(1);
  const [entityText, setEntityText] = useState(f.entity);
  useEffect(() => setEntityText(f.entity), [f.entity]); // bộ lọc nhớ nạp muộn từ máy chủ thì ô nhập theo kịp
  const filter = (v: typeof f) => { setF(v); setPage(1); };
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), page: String(page), size: String(SIZE) }).toString();
  const events = useQuery({ queryKey: ['audit', qs], queryFn: () => api<{ rows: Row[]; total: number }>(`/api/audit?${qs}`) });
  const logins = useQuery({ queryKey: ['audit-logins', loginPage], queryFn: () => api<{ rows: LoginRow[]; total: number }>(`/api/audit/logins?page=${loginPage}&size=${SIZE}`) });
  useEffect(() => { if (events.error) void message.error((events.error as Error).message); }, [events.error]);
  useEffect(() => { if (logins.error) void message.error((logins.error as Error).message); }, [logins.error]);
  return (
    <Tabs items={[
      { key: 'events', label: 'Nhật ký thay đổi', children: (<>
        <Space style={{ marginBottom: 12 }}>
          <Input placeholder="Thực thể (party, voucher…)" value={entityText} onChange={(e) => setEntityText(e.target.value)} onPressEnter={() => filter({ ...f, entity: entityText.trim() })} />
          <Select allowClear placeholder="Hành động" style={{ width: 160 }} value={f.action || undefined} options={Object.entries(ACTION).map(([value, label]) => ({ value, label }))} onChange={(v?: string) => filter({ ...f, action: v ?? '' })} />
          <DatePicker.RangePicker format="DD/MM/YYYY" value={f.from && f.to ? [dayjs(f.from), dayjs(f.to)] : null}
            onChange={(r) => filter({ ...f, from: r?.[0]?.format('YYYY-MM-DD') ?? '', to: r?.[1]?.format('YYYY-MM-DD') ?? '' })} />
        </Space>
        <Table rowKey="id" size="small" loading={events.isFetching} dataSource={events.data?.rows ?? []} pagination={{ current: page, total: events.data?.total ?? 0, pageSize: SIZE, showSizeChanger: false, onChange: setPage }}
          columns={[{ title: 'Thời gian', dataIndex: 'ts', render: fmtTs, width: 170 }, { title: 'Người dùng', dataIndex: 'username', width: 140 },
            { title: 'Hành động', dataIndex: 'action', width: 110, render: (a: string) => <Tag>{ACTION[a] ?? a}</Tag> }, { title: 'Thực thể', dataIndex: 'entity', width: 140 }, { title: 'ID', dataIndex: 'entityId', width: 120, ellipsis: true },
            { title: 'Thay đổi', render: (_, r) => <ul style={{ margin: 0, paddingLeft: 16 }}>{diffJson(r.before, r.after).map((d) => <li key={d.key}><b>{d.key}</b>: {JSON.stringify(d.before)} → {JSON.stringify(d.after)}</li>)}</ul> },
            { title: 'IP', dataIndex: 'ip', width: 120 }]} /></>) },
      { key: 'logins', label: 'Nhật ký đăng nhập', children: (
        <Table rowKey={(r) => r.ts + r.username} size="small" loading={logins.isFetching} dataSource={logins.data?.rows ?? []} pagination={{ current: loginPage, total: logins.data?.total ?? 0, pageSize: SIZE, showSizeChanger: false, onChange: setLoginPage }} columns={[
          { title: 'Thời gian', dataIndex: 'ts', render: fmtTs }, { title: 'Người dùng', dataIndex: 'username' },
          { title: 'Kết quả', dataIndex: 'success', render: (s: boolean) => (s ? <Tag color="green">Thành công</Tag> : <Tag color="red">Thất bại</Tag>) }, { title: 'IP', dataIndex: 'ip' }]} />) },
    ]} />
  );
}
