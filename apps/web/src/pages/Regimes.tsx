import { useQuery } from '@tanstack/react-query';
import { Alert, Card, List, Space, Table, Tag } from 'antd';
import { Link } from '@tanstack/react-router';
import { api } from '../api/client.js';

// Chế độ kế toán và cổng dữ liệu pháp lý (GET /api/regimes). TT58 và TT152 đã nhập từ văn bản gốc: ghi sổ theo nhóm thuế, không có hệ thống tài khoản; `limits` nêu phần còn thiếu.
export interface RegimeInfo {
  code: string; label: string; ready: boolean; kind: 'accounts' | 'books'; missing: string[]; note: string; limits: string[]; reportsReady: boolean;
  gates: { coa: boolean; books: boolean; reports: boolean } | null; applicable: { coa: boolean; reports: boolean } | null; effectiveFrom?: string | null; effectiveTo?: string | null; replaces?: string; primaryTextObtained?: boolean;
  sources?: { url: string; fetched: string; kind: string; used: string }[];
}
export const useRegimes = () => useQuery({ queryKey: ['regimes'], queryFn: () => api<RegimeInfo[]>('/api/regimes'), staleTime: 300_000 });

export function RegimeNotice({ regime }: { regime: string }) {
  const r = useRegimes().data?.find((x) => x.code === regime);
  if (!r) return null;
  if (r.kind === 'accounts') {
    if (r.ready) return null;
    return <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Dữ liệu chế độ này chưa đối chiếu văn bản gốc"
      description={`${r.label}: hệ thống tài khoản hoặc báo cáo còn phần chưa đối chiếu${r.effectiveTo ? `, và chế độ chỉ áp dụng đến ${r.effectiveTo}` : ''}. Tạo năm tài chính sẽ hỏi xác nhận; nên chọn chế độ khác nếu không cần xem lại dữ liệu cũ.`} />;
  }
  if (!r.ready) return <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Chưa đủ dữ liệu pháp lý, chưa dùng cho kế toán thật"
    description={`Chế độ ${r.label} chưa nhập đủ sổ từ văn bản gốc nên chưa tạo được năm tài chính. Xem Hệ thống > Chế độ kế toán.`} />;
  return <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Chế độ ghi sổ theo nhóm thuế, không có hệ thống tài khoản"
    description={<div>Chế độ {r.label} ghi sổ đơn (menu Sổ HKD, siêu nhỏ), không dùng chứng từ ghi sổ bút toán kép. Phần chưa có: <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{r.limits.map((l) => <li key={l}>{l}</li>)}</ul></div>} />;
}

const yes = (ok: boolean, na: boolean) => (na ? <Tag>Thông tư không có</Tag> : <Tag color={ok ? 'green' : 'orange'}>{ok ? 'Đã nhập, đối chiếu văn bản gốc' : 'Chưa đủ'}</Tag>);

export default function RegimesPage() {
  const q = useRegimes();
  const rows = q.data ?? [];
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Chế độ kế toán</h2>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Chế độ kế toán gắn với năm tài chính. Dữ liệu pháp lý (tài khoản, sổ, báo cáo) chỉ nhập từ văn bản gốc; phần nào chưa có thì ghi rõ." />
      <Table<RegimeInfo> rowKey="code" size="small" loading={q.isLoading} dataSource={rows} pagination={false}
        columns={[
          { title: 'Mã', dataIndex: 'code', width: 90 },
          { title: 'Chế độ', dataIndex: 'label' },
          { title: 'Hiệu lực', width: 150, render: (_: unknown, r: RegimeInfo) => (r.effectiveFrom || r.effectiveTo ? `${r.effectiveFrom ?? ''}${r.effectiveTo ? ` đến ${r.effectiveTo}` : ' trở đi'}` : '–') },
          { title: 'Trạng thái', dataIndex: 'ready', width: 260, render: (ok: boolean, r) => (r.kind === 'books' && ok && r.limits.length ? <Tag color="gold">Dùng được, còn giới hạn</Tag> : <Tag color={ok ? 'green' : 'orange'}>{ok ? 'Dùng được' : 'Chưa dùng cho kế toán thật'}</Tag>) },
        ]}
        expandable={{ rowExpandable: (r) => r.kind === 'books' || !r.ready, expandedRowRender: (r) => r.kind === 'accounts' ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="warning" showIcon message="Còn dữ liệu chưa đối chiếu văn bản gốc" description={r.note} />
            <Card size="small" title="Văn bản cần cung cấp"><List size="small" dataSource={r.missing} renderItem={(m) => <List.Item>{m}</List.Item>} /></Card>
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type={r.ready ? 'info' : 'warning'} showIcon message={r.ready ? 'Đã nhập từ văn bản gốc' : 'Chưa đủ dữ liệu pháp lý'} description={r.note} />
            <Space wrap>Hệ thống tài khoản {yes(!!r.gates?.coa, r.applicable?.coa === false)} Mẫu sổ {yes(!!r.gates?.books, false)} Báo cáo tài chính {yes(!!r.gates?.reports, r.applicable?.reports === false)}</Space>
            {r.ready && <Link to="/so-hkd">Mở Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ</Link>}
            {!!r.limits.length && <Card size="small" title="Giới hạn hiện tại"><List size="small" dataSource={r.limits} renderItem={(m) => <List.Item>{m}</List.Item>} /></Card>}
            {!!r.missing.length && <Card size="small" title="Văn bản và việc còn thiếu"><List size="small" dataSource={r.missing} renderItem={(m) => <List.Item>{m}</List.Item>} /></Card>}
            {!!r.sources?.length && <div>Nguồn: {r.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.kind}, tải {s.fetched}</a>)}</div>}
          </Space>
        ) }} />
    </div>
  );
}
