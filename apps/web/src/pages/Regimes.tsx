import { useQuery } from '@tanstack/react-query';
import { Alert, Card, List, Space, Table, Tag } from 'antd';
import { api } from '../api/client.js';

// Chế độ kế toán và cổng dữ liệu pháp lý (GET /api/regimes). TT58 và TT152 chưa có văn bản gốc: chỉ hiện khung và danh sách văn bản cần cung cấp.
export interface RegimeInfo {
  code: string; label: string; ready: boolean; kind: 'accounts' | 'books'; missing: string[]; note: string;
  gates: { coa: boolean; books: boolean; reports: boolean } | null; effectiveFrom?: string | null; effectiveTo?: string | null; replaces?: string;
  booksSecondary?: { code: string; name: string | null }[]; reportsSecondary?: { code: string; name: string }[];
  sources?: { url: string; fetched: string; kind: string; used: string }[];
}
export const useRegimes = () => useQuery({ queryKey: ['regimes'], queryFn: () => api<RegimeInfo[]>('/api/regimes'), staleTime: 300_000 });

export function RegimeNotice({ regime }: { regime: string }) {
  const r = useRegimes().data?.find((x) => x.code === regime);
  if (!r || r.ready) return null;
  if (r.kind === 'accounts') return <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Dữ liệu chế độ này chưa đối chiếu văn bản gốc"
    description={`${r.label}: hệ thống tài khoản hoặc báo cáo còn phần chưa đối chiếu${r.effectiveTo ? `, và chế độ chỉ áp dụng đến ${r.effectiveTo}` : ''}. Tạo năm tài chính sẽ hỏi xác nhận; nên chọn chế độ khác nếu không cần xem lại dữ liệu cũ.`} />;
  return <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Chưa có văn bản gốc, chưa dùng cho kế toán thật"
    description={`Chế độ ${r.label} chưa có hệ thống tài khoản, sổ và báo cáo nhập từ văn bản gốc nên chưa tạo được năm tài chính. Xem danh sách văn bản cần cung cấp ở Hệ thống > Chế độ kế toán.`} />;
}

const yes = (ok: boolean) => <Tag color={ok ? 'green' : 'orange'}>{ok ? 'Đã nhập' : 'Chờ văn bản gốc'}</Tag>;

export default function RegimesPage() {
  const q = useRegimes();
  const rows = q.data ?? [];
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Chế độ kế toán</h2>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Chế độ kế toán gắn với năm tài chính. Dữ liệu pháp lý (tài khoản, sổ, báo cáo) chỉ nhập từ văn bản gốc; phần nào chưa có thì ghi rõ chờ văn bản." />
      <Table<RegimeInfo> rowKey="code" size="small" loading={q.isLoading} dataSource={rows} pagination={false}
        columns={[
          { title: 'Mã', dataIndex: 'code', width: 90 },
          { title: 'Chế độ', dataIndex: 'label' },
          { title: 'Hiệu lực', width: 150, render: (_: unknown, r: RegimeInfo) => (r.effectiveFrom || r.effectiveTo ? `${r.effectiveFrom ?? ''}${r.effectiveTo ? ` đến ${r.effectiveTo}` : ' trở đi'}` : '–') },
          { title: 'Trạng thái', dataIndex: 'ready', width: 200, render: (ok: boolean) => <Tag color={ok ? 'green' : 'orange'}>{ok ? 'Dùng được' : 'Chưa dùng cho kế toán thật'}</Tag> },
        ]}
        expandable={{ rowExpandable: (r) => r.kind === 'books' || !r.ready, expandedRowRender: (r) => r.kind === 'accounts' ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="warning" showIcon message="Còn dữ liệu chưa đối chiếu văn bản gốc" description={r.note} />
            <Card size="small" title="Văn bản cần cung cấp"><List size="small" dataSource={r.missing} renderItem={(m) => <List.Item>{m}</List.Item>} /></Card>
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="warning" showIcon message="Chưa có văn bản gốc, chưa dùng cho kế toán thật" description={r.note} />
            <Space wrap>Hệ thống tài khoản {yes(!!r.gates?.coa)} Mẫu sổ {yes(!!r.gates?.books)} Báo cáo tài chính {yes(!!r.gates?.reports)}</Space>
            <Card size="small" title="Văn bản cần cung cấp"><List size="small" dataSource={r.missing} renderItem={(m) => <List.Item>{m}</List.Item>} /></Card>
            {!!r.booksSecondary?.length && <Card size="small" title="Danh mục sổ theo nguồn thứ cấp (chưa đối chiếu văn bản gốc)"><Space size={[4, 4]} wrap>{r.booksSecondary.map((b) => <Tag key={b.code}>{b.code}{b.name ? `: ${b.name}` : ''}</Tag>)}</Space></Card>}
            {!!r.sources?.length && <div>Nguồn đã tham khảo: {r.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.kind}, tải {s.fetched}</a>)}</div>}
          </Space>
        ) }} />
    </div>
  );
}
