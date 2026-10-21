import { useRef, type ReactNode } from 'react';
import { Button, Modal, Popconfirm, Space, Upload, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { useNavigate } from '@tanstack/react-router';
import type { Dayjs } from 'dayjs';
import { LookupSelect, type LookupRow } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import type { GroupRow, TaxDefRow } from './invoiceCalc.js';

// Phần dùng chung của màn hình chứng từ (VoucherForm), màn hình hóa đơn (InvoiceForm) và bảng hóa đơn kê khai (DeclaredInvoices).
export const quickAdd = [{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }];
export const iso = (d: Dayjs) => d.format('YYYY-MM-DD');
export const text = (s?: string | null) => s?.trim() || null;

// Danh mục mã thuế (kèm phân bổ cho động cơ thuế) và nhóm hóa đơn kê khai; thay đổi hiếm nên nhớ một phút.
export const useTaxDefs = () => useQuery({ queryKey: ['tax-defs'], staleTime: 60_000, queryFn: () => api<TaxDefRow[]>('/api/invoices/tax-defs') });
export const useInvoiceGroups = () => useQuery({ queryKey: ['invoice-groups'], staleTime: 60_000, queryFn: async () => (await api<{ rows: GroupRow[] }>('/api/catalogs/invoice_group?size=100')).rows });
// Bộ tìm cho LookupSelect (tạo bằng useMemo: LookupSelect nạp lại khi fetcher đổi). Mã thuế: đang dùng và đúng phạm vi mua/bán; onlyVat chỉ mã GTGT.
export const taxFetcher = (defs: TaxDefRow[], scope: 'sale' | 'purchase', onlyVat = false) => async (q: string): Promise<LookupRow[]> => {
  const k = q.trim().toLowerCase();
  return defs.filter((d) => d.isActive && (d.scope === 'both' || d.scope === scope) && (!onlyVat || d.def.kind === 'vat') && (!k || d.code.toLowerCase().startsWith(k) || d.name.toLowerCase().includes(k)))
    .map((d) => ({ id: d.code, code: d.code, name: d.name }));
};
export const groupFetcher = (groups: GroupRow[], scope: 'sale' | 'purchase') => async (q: string): Promise<LookupRow[]> => {
  const k = q.trim().toLowerCase();
  return groups.filter((g) => g.scope === scope && (!k || g.code.toLowerCase().startsWith(k) || g.name.toLowerCase().includes(k))).map((g) => ({ id: `${g.scope}-${g.code}`, code: g.code, name: g.name }));
};

// Lỗi hiển thị cho người dùng: lỗi máy chủ kèm mã; lỗi form.validateFields() là đối tượng { errorFields } nên lấy chữ lỗi của trường đầu tiên (không để "[object Object]").
export const errorText = (e: unknown): string => e instanceof ApiError ? `${e.message} (${e.code})`
  : (e as { errorFields?: { errors: string[] }[] } | null)?.errorFields?.[0]?.errors[0] ?? (e instanceof Error ? e.message : String(e));

// Báo lỗi lưu chứng từ. INVOICE_DUPLICATE nêu số chứng từ đã nhập hóa đơn ("... đã nhập ở chứng từ HDM00007"): kèm nút mở chứng từ đó
// (tra số ra id qua danh sách chứng từ). Hóa đơn trùng ở một bản nháp chưa có số ("nháp (HDM)") hoặc trùng ngay trong chứng từ này thì chỉ có chữ.
export function reportError(e: unknown, navigate: ReturnType<typeof useNavigate>): void {
  const no = e instanceof ApiError && e.code === 'INVOICE_DUPLICATE' ? /ở chứng từ (?!nháp)(\S+)$/.exec(e.message)?.[1] : undefined;
  if (!no) { void message.error(errorText(e)); return; }
  const open = async () => {
    try {
      const r = await api<{ rows: { id: string; voucherType: string; voucherNo: string | null }[] }>(`/api/vouchers?q=${encodeURIComponent(no)}&size=5`);
      const hit = r.rows.find((x) => x.voucherNo === no);
      if (hit) void navigate({ to: '/chung-tu/$type/$id', params: { type: hit.voucherType, id: hit.id } }); else void message.warning(`Không tìm thấy chứng từ ${no}`);
    } catch (err) { void message.error(errorText(err)); }
  };
  void message.error({ duration: 10, content: <span>{errorText(e)} <Button type="link" size="small" onClick={() => void open()}>Mở chứng từ {no}</Button></span> });
}

// Hộp chọn từ danh mục khi bấm F4 trong ô của lưới: đưa con trỏ vào ô tìm ngay khi mở (antd Modal tự giữ tiêu điểm ở khung).
export function PickDialog({ open, catalog, fetcher, withQuickAdd, onPick, onClose }:
  { open: boolean; catalog: string; fetcher?: (q: string, signal: AbortSignal) => Promise<LookupRow[]>; withQuickAdd?: boolean; onPick: (code: string) => void; onClose: () => void }): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Chọn từ danh mục" destroyOnHidden afterOpenChange={(o) => { if (o) box.current?.querySelector('input')?.focus(); }}>
      {open && <div ref={box}><LookupSelect catalog={catalog} style={{ width: '100%' }} {...(fetcher ? { fetcher } : {})} {...(withQuickAdd ? { quickAddFields: quickAdd } : {})}
        onChange={(code) => { if (code !== null) onPick(code); onClose(); }} /></div>}
    </Modal>
  );
}

export function Attachments({ voucherId, canEdit }: { voucherId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['attachments', voucherId];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ id: string; fileName: string; bytes: number }[]>(`/api/vouchers/${voucherId}/attachments`) });
  const remove = (attId: string) => api(`/api/attachments/${attId}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: key })).catch((e: unknown) => void message.error((e as Error).message));
  return (
    <div style={{ marginTop: 16 }}>
      <Space wrap>
        <b>Đính kèm:</b>
        {(list.data ?? []).map((a) => <span key={a.id}><a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener">{a.fileName}</a> ({Math.ceil(a.bytes / 1024)} KB)
          {canEdit && <Popconfirm title="Xóa tệp đính kèm?" okText="Xóa" cancelText="Không" onConfirm={() => remove(a.id)}><Button type="link" size="small" danger aria-label={`Xóa ${a.fileName}`}>✕</Button></Popconfirm>}</span>)}
        {canEdit && <Upload showUploadList={false} customRequest={async ({ file, onSuccess, onError }) => {
          const fd = new FormData(); fd.append('file', file as File);
          const r = await fetch(`/api/vouchers/${voucherId}/attachments`, { method: 'POST', body: fd, credentials: 'include' });
          if (r.ok) { onSuccess?.(await r.json()); void qc.invalidateQueries({ queryKey: key }); }
          else { const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null; const msg = e?.error?.message ?? `Lỗi tải lên (${r.status})`; void message.error(msg); onError?.(new Error(msg)); } }}><Button size="small">Thêm tệp</Button></Upload>}
      </Space>
    </div>
  );
}
