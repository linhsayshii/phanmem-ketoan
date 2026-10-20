import { useCallback, useMemo } from 'react';
import { Alert, Button, DatePicker, Input, Select, Space, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ColDef, SuppressKeyboardEventParams } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber, voucherTypeDef, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, useHotkeys, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Row { id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; description: string | null; partyName: string | null; totalDebit: string }
export const STATE_LABEL: Record<string, string> = { draft: 'Nháp', posted: 'Đã ghi sổ', reversed: 'Đã đảo', cancelled: 'Đã hủy' };
const STATE_COLOR: Record<string, string> = { draft: 'default', posted: 'green', reversed: 'orange', cancelled: 'red' };
// Tên gọi trên menu và tiêu đề: bỏ phần chú thích trong ngoặc, vd. "Giấy báo Nợ (in Ủy nhiệm chi)" -> "Giấy báo Nợ".
export const typeLabel = (d: VoucherTypeDef): string => d.name.replace(/\s*\(.*\)$/, '');

export default function VoucherListPage() {
  const { type } = useParams({ strict: false }) as { type: string };
  const def = voucherTypeDef(type);
  return def ? <VoucherList key={def.code} def={def} /> : <Alert type="error" showIcon message={`Không có loại chứng từ "${type}"`} />;
}

function VoucherList({ def }: { def: VoucherTypeDef }) {
  const navigate = useNavigate(); const { me } = useAuth();
  const open = useCallback((id: string) => void navigate({ to: '/chung-tu/$type/$id', params: { type: def.code, id } }), [navigate, def.code]);
  const [f, setF] = useRememberedFilter(`vouchers:${def.code}`, { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), state: '' as string, q: '' }, `${me?.tenantId}:${me?.userId}`);
  const qs = new URLSearchParams({ type: def.code, from: f.from, to: f.to, size: '500', ...(f.state ? { state: f.state } : {}), ...(f.q ? { q: f.q } : {}) }).toString();
  const data = useQuery({ queryKey: ['vouchers', qs], queryFn: () => api<{ rows: Row[]; total: number }>(`/api/vouchers?${qs}`) });
  useHotkeys({ Insert: () => open('moi') });
  // Enter trên dòng đang chọn = mở chứng từ (lưới chỉ đọc nên KeyboardGrid không xử lý Enter)
  const openOnEnter = (p: SuppressKeyboardEventParams<Row>) => { if (p.event.type === 'keydown' && p.event.key === 'Enter' && p.data) { p.event.preventDefault(); open(p.data.id); return true; } return false; };
  const columns = useMemo(() => ([
    { field: 'postingDate', headerName: 'Ngày', width: 110, valueFormatter: (p) => formatVnDate(p.value as string) },
    { field: 'voucherNo', headerName: 'Số', width: 130, valueFormatter: (p) => (p.value as string | null) ?? '(nháp)' },
    { field: 'description', headerName: 'Diễn giải', flex: 1 }, { field: 'partyName', headerName: 'Đối tượng', width: 200 },
    { field: 'totalDebit', headerName: 'Số tiền', width: 140, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => formatVnNumber(p.value as string) },
    { field: 'state', headerName: 'Trạng thái', width: 120, cellRenderer: (p: { value: string }) => <Tag color={STATE_COLOR[p.value] ?? 'default'}>{STATE_LABEL[p.value]}</Tag> },
  ] satisfies ColDef<Row>[]).map((c): ColDef<Row> => ({ ...c, editable: false, suppressKeyboardEvent: openOnEnter, onCellDoubleClicked: (e) => { if (e.data) open(e.data.id); } })), [open]);
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <h2 style={{ margin: 0 }}>{typeLabel(def)}</h2>
        <DatePicker.RangePicker format="DD/MM/YYYY" value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r?.[0] && r[1] && setF({ ...f, from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} />
        <Select style={{ width: 140 }} value={f.state} onChange={(state) => setF({ ...f, state })} options={[{ value: '', label: 'Mọi trạng thái' }, ...Object.entries(STATE_LABEL).map(([value, label]) => ({ value, label }))]} />
        <Input.Search key={f.q} placeholder="Số, diễn giải, đối tượng" defaultValue={f.q} onSearch={(q) => setF({ ...f, q })} style={{ width: 260 }} allowClear />
        <Button type="primary" onClick={() => open('moi')}>Thêm (Insert)</Button>
        <span>{data.data?.total ?? 0} chứng từ</span>
      </Space>
      <KeyboardGrid<Row> rows={data.data?.rows ?? []} columns={columns}
        onRowsChange={() => undefined} addRowTemplate={() => ({} as Row)} readOnly height="calc(100vh - 180px)" />
    </>
  );
}
