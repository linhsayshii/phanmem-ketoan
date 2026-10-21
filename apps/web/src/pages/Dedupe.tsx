import { useState } from 'react';
import { Alert, Button, Card, DatePicker, Descriptions, Empty, Input, Modal, Popconfirm, Space, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { formatVnDate, formatVnNumber, todayVn } from '@kt/domain';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { STATE_COLOR, STATE_LABEL } from './VoucherList.js';

interface Row { id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; description: string | null; partyName: string | null; totalDebit: string }
interface Pair { a: Row; b: Row; reasons: string[] }
interface Result { pairs: Pair[]; truncated: boolean; hiddenBySensitive: boolean }
const iso = (d: Dayjs) => d.format('YYYY-MM-DD');

export default function DedupePage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().startOf('year'), dayjs().endOf('month')]);
  const [asked, setAsked] = useState<[Dayjs, Dayjs] | null>(null); // khoảng đã bấm Tìm: đổi ô chọn ngày không làm danh sách nhảy theo
  const [reverse, setReverse] = useState<{ row: Row; date: Dayjs; description: string } | null>(null);
  const onError = (e: unknown) => { void message.error((e as Error).message); };
  const key = ['duplicates', asked && iso(asked[0]), asked && iso(asked[1])];
  const list = useQuery({ queryKey: key, enabled: !!asked, queryFn: () => api<Result>(`/api/tools/duplicates?from=${iso(asked![0])}&to=${iso(asked![1])}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['duplicates'] });
  const ignore = useMutation({ mutationFn: (p: Pair) => api('/api/tools/duplicates/ignore', { method: 'POST', json: { a: p.a.id, b: p.b.id } }), onError,
    onSuccess: async () => { void message.success('Đã đánh dấu không trùng'); await refresh(); } });
  const discard = useMutation({ mutationFn: (r: Row) => api(`/api/vouchers/${r.id}/discard`, { method: 'POST', json: {} }), onError,
    onSuccess: async () => { void message.success('Đã hủy chứng từ nháp'); await refresh(); } });
  const doReverse = useMutation({ mutationFn: (p: NonNullable<typeof reverse>) => api<{ voucherNo: string }>(`/api/vouchers/${p.row.id}/reverse`, { method: 'POST', json: { postingDate: iso(p.date), ...(p.description.trim() ? { description: p.description.trim() } : {}) } }), onError,
    onSuccess: async (r) => { void message.success(`Đã tạo chứng từ đảo ${r.voucherNo}`); setReverse(null); await refresh(); } });

  const side = (r: Row, title: string) => (
    <div style={{ flex: 1, minWidth: 0 }} data-testid={`dup-${title}`}>
      <Descriptions size="small" column={1} bordered title={title}>
        <Descriptions.Item label="Chứng từ"><Link to="/chung-tu/$type/$id" params={{ type: r.voucherType, id: r.id }}>{r.voucherType} {r.voucherNo ?? '(chưa có số)'}</Link></Descriptions.Item>
        <Descriptions.Item label="Ngày ghi sổ">{formatVnDate(r.postingDate)}</Descriptions.Item>
        <Descriptions.Item label="Đối tượng">{r.partyName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Số tiền">{formatVnNumber(r.totalDebit)}</Descriptions.Item>
        <Descriptions.Item label="Diễn giải">{r.description ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Trạng thái"><Tag color={STATE_COLOR[r.state] ?? 'default'}>{STATE_LABEL[r.state] ?? r.state}</Tag></Descriptions.Item>
      </Descriptions>
      <Space style={{ marginTop: 8 }}>
        {r.state === 'draft' && can('voucher.delete') && <Popconfirm title="Hủy chứng từ nháp này?" okText="Hủy chứng từ" cancelText="Không" okButtonProps={{ danger: true }} onConfirm={() => discard.mutate(r)}>
          <Button danger loading={discard.isPending && discard.variables?.id === r.id}>Hủy nháp</Button></Popconfirm>}
        {r.state === 'posted' && can('voucher.post') && <Button danger onClick={() => { const today = todayVn(); setReverse({ row: r, date: dayjs(today >= r.postingDate ? today : r.postingDate), description: `Đảo chứng từ ${r.voucherNo ?? ''} ngày ${formatVnDate(r.postingDate)}` }); }}>Đảo chứng từ</Button>}
      </Space>
    </div>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="Khử trùng chứng từ">
        <Space wrap>
          <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
          <Button type="primary" loading={list.isFetching} onClick={() => { setAsked(range); }}>Tìm</Button>
          {can('catalog.view') && <Link to="/danh-muc/$name" params={{ name: 'voucher_dup_rule' }}>Quy tắc khử trùng</Link>}
        </Space>
        <p style={{ color: 'rgba(0,0,0,.45)', margin: '8px 0 0' }}>Tìm các cặp chứng từ cùng số tiền, gần ngày, cùng đối tượng và tài khoản đối ứng theo cặp loại chứng từ đã cấu hình (ví dụ Phiếu chi và Giấy báo nợ).</p>
      </Card>
      {list.error && <Alert type="error" showIcon message={(list.error as Error).message} />}
      {list.data?.hiddenBySensitive && <Alert type="warning" showIcon message="Không xét chứng từ có tài khoản công nợ phải thu, phải trả hoặc giá vốn mà bạn không có quyền xem; các cặp liên quan (nếu có) bị ẩn." />}
      {list.data?.truncated && <Alert type="warning" showIcon message="Chỉ hiển thị 500 cặp đầu tiên. Hãy xử lý bớt hoặc thu hẹp khoảng ngày rồi tìm lại." />}
      {asked && list.data && list.data.pairs.length === 0 && <Card><Empty description="Không có cặp chứng từ nghi trùng" /></Card>}
      {list.data?.pairs.map((p) => (
        <Card key={`${p.a.id}:${p.b.id}`} size="small" data-testid="dup-pair"
          title={<Space wrap>{p.reasons.map((x) => <Tag key={x} color="blue">{x}</Tag>)}</Space>}
          extra={<Popconfirm title="Hai chứng từ này không trùng nhau?" description="Cặp sẽ không hiện lại ở các lần tìm sau." okText="Không trùng" cancelText="Quay lại" onConfirm={() => ignore.mutate(p)}>
            <Button loading={ignore.isPending && ignore.variables === p}>Không trùng</Button></Popconfirm>}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{side(p.a, 'A')}{side(p.b, 'B')}</div>
        </Card>
      ))}
      <Modal open={!!reverse} title="Lập chứng từ đảo" okText="Lập chứng từ đảo" cancelText="Không" destroyOnHidden onCancel={() => setReverse(null)}
        okButtonProps={{ loading: doReverse.isPending, disabled: !reverse?.date }} onOk={() => { if (reverse) doReverse.mutate(reverse); }}>
        {reverse && <Space direction="vertical" style={{ width: '100%' }}>
          <label htmlFor="dup-reverse-date">Ngày hạch toán chứng từ đảo</label>
          <DatePicker id="dup-reverse-date" format="DD/MM/YYYY" allowClear={false} value={reverse.date} disabledDate={(d) => d.isBefore(dayjs(reverse.row.postingDate), 'day')} onChange={(d) => d && setReverse({ ...reverse, date: d })} />
          <label htmlFor="dup-reverse-desc">Diễn giải chứng từ đảo</label>
          <Input id="dup-reverse-desc" value={reverse.description} maxLength={500} onChange={(e) => setReverse({ ...reverse, description: e.target.value })} />
        </Space>}
      </Modal>
    </Space>
  );
}
