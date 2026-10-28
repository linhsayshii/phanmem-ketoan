import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Empty, List, Modal, Space, Spin, Tag, Typography } from 'antd';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Gợi ý định khoản (mô hình thống kê cục bộ, học từ chứng từ đã ghi sổ của công ty). Chỉ gợi ý tài khoản Nợ/Có; người dùng bấm "Dùng" mới điền vào lưới, số tiền vẫn do người dùng nhập.
export interface SuggestFields { voucherType?: string | undefined; partyCode?: string | undefined; description?: string | undefined; amount?: string | undefined; postingDate?: string | undefined }
export interface SuggestLine { side: 'debit' | 'credit'; accountCode: string; accountName: string }
export interface Suggestion { signature: string; lines: SuggestLine[]; score: number; confidence: number; support: number; lastUsed: string; reasons: string[] }
interface Result { asOf: string; considered: number; suggestions: Suggestion[] }

export const useSuggest = () => useMutation({
  mutationFn: (f: SuggestFields) => api<Result>('/api/assistant/suggest-entry', { method: 'POST', json: {
    ...(f.voucherType && { voucherType: f.voucherType }), ...(f.partyCode && { partyCode: f.partyCode }), ...(f.description?.trim() && { description: f.description.trim() }),
    ...(f.amount && /^\d{1,16}$/.test(f.amount) && f.amount !== '0' && { amount: f.amount }), ...(f.postingDate && { asOf: f.postingDate }),
  } }),
});

const sorted = (ls: SuggestLine[]) => [...ls.filter((l) => l.side === 'debit'), ...ls.filter((l) => l.side === 'credit')];

export function SuggestList({ data, onApply }: { data: Result; onApply?: ((lines: SuggestLine[]) => void) | undefined }) {
  if (data.suggestions.length === 0) return <Empty data-testid="suggest-empty" description="Chưa đủ lịch sử để gợi ý: cần chứng từ đã ghi sổ cùng loại, cùng đối tượng hoặc có diễn giải gần giống" />;
  return (
    <List data-testid="suggest-list" dataSource={data.suggestions} renderItem={(s, i) => (
      <List.Item key={s.signature} data-testid="suggest-item" actions={onApply ? [<Button key="use" type={i === 0 ? 'primary' : 'default'} onClick={() => onApply(s.lines)}>Dùng gợi ý này</Button>] : []}>
        <List.Item.Meta
          title={<Space wrap><span>{i + 1}.</span>
            {sorted(s.lines).map((l) => <Tag key={l.side + l.accountCode} color={l.side === 'debit' ? 'blue' : 'volcano'} title={l.accountName}>{l.side === 'debit' ? 'Nợ' : 'Có'} {l.accountCode}{l.accountName ? ` · ${l.accountName}` : ''}</Tag>)}
            <Tag color={s.confidence >= 0.6 ? 'green' : s.confidence >= 0.3 ? 'gold' : 'default'}>{Math.round(s.confidence * 100)}%</Tag></Space>}
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>} />
      </List.Item>)} />
  );
}

// Nút ở form chứng từ: Ctrl+G hoặc bấm nút. Không đổi hành vi nhập liệu bàn phím sẵn có.
export function SuggestEntryButton({ getFields, onApply, enabled }: { getFields: () => SuggestFields; onApply: (lines: SuggestLine[]) => void; enabled: boolean }) {
  const { can } = useAuth(); const [open, setOpen] = useState(false); const q = useSuggest();
  const allowed = enabled && can('assistant.use') && can('voucher.view');
  const show = () => { q.mutate(getFields()); setOpen(true); };
  useEffect(() => {
    if (!allowed) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'g') return;
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return;
      e.preventDefault(); q.mutate(getFields()); setOpen(true);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [allowed, q, getFields]);
  if (!allowed) return null;
  return (<>
    <Button onClick={show} title="Gợi ý tài khoản Nợ/Có từ các chứng từ đã ghi sổ (Ctrl+G)">Gợi ý định khoản (Ctrl+G)</Button>
    <Modal open={open} onCancel={() => setOpen(false)} footer={null} title="Gợi ý định khoản" width={720} destroyOnHidden>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Gợi ý chỉ dựa trên chứng từ đã ghi sổ của công ty bạn đang xem được. Máy chỉ điền tài khoản; bạn nhập số tiền và kiểm tra trước khi lưu." />
      {q.isPending && <Spin />}
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      {q.data && <><Typography.Paragraph type="secondary">Đã xét {q.data.considered} chứng từ đến ngày {q.data.asOf}.</Typography.Paragraph>
        <SuggestList data={q.data} onApply={(ls) => { onApply(ls); setOpen(false); }} /></>}
    </Modal>
  </>);
}
