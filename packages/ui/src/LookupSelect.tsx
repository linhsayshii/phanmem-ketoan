import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Form, Input, Modal, Select, message, type SelectProps } from 'antd';
import { isLookupKey } from '@kt/domain';

export interface LookupRow { id: string | number; code: string; name: string; inactive?: boolean | undefined }
export interface LookupSelectProps extends Omit<SelectProps, 'options' | 'onChange' | 'value'> {
  catalog: string; value?: string | null | undefined; onChange?: ((code: string | null, row: LookupRow | null) => void) | undefined;
  valueField?: 'code' | 'id'; quickAddFields?: { key: string; label: string }[] | undefined;
  // includeInactive: bộ lọc báo cáo/sổ phải tìm được cả mã đã ngưng dùng nhưng còn phát sinh; nhập chứng từ thì chỉ mã đang dùng.
  includeInactive?: boolean | undefined;
  // fetcher nhận từ khóa và tín hiệu hủy (lần gõ sau hủy lần gõ trước); phải ổn định giữa các lần render (useMemo), nếu không danh sách nạp lại mỗi lần.
  fetcher?: (q: string, signal: AbortSignal) => Promise<LookupRow[]>; creator?: (catalog: string, body: Record<string, unknown>) => Promise<LookupRow>;
}
const defaultFetcherFor = (catalog: string, includeInactive: boolean) => async (q: string, signal: AbortSignal): Promise<LookupRow[]> => {
  const r = await fetch(`/api/catalogs/${catalog}?q=${encodeURIComponent(q)}&size=50${includeInactive ? '&active=all' : ''}`, { credentials: 'include', signal });
  if (!r.ok) return []; // phiên hết hạn / thiếu quyền: danh sách rỗng, không để `rows` thành undefined làm hỏng giao diện
  return ((await r.json()) as { rows: (LookupRow & { is_active?: boolean })[] }).rows.map(({ is_active, ...row }) => (is_active === false ? { ...row, inactive: true } : row));
};
const defaultCreator = async (catalog: string, body: Record<string, unknown>): Promise<LookupRow> => {
  const r = await fetch(`/api/catalogs/${catalog}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json()) as { error: { message: string } }).error.message);
  const { id } = (await r.json()) as { id: string };
  return { id, code: String(body['code']), name: String(body['name']) };
};
const QUICK = '__quick_add__';

export function LookupSelect({ catalog, value, onChange, valueField = 'code', quickAddFields, includeInactive = false, fetcher, creator = defaultCreator, ...rest }: LookupSelectProps) {
  const [rows, setRows] = useState<LookupRow[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const find = useMemo(() => fetcher ?? defaultFetcherFor(catalog, includeInactive), [fetcher, catalog, includeInactive]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const ctrl = useRef<AbortController>();
  const seq = useRef(0);
  // Chỉ kết quả của lần gõ mới nhất được áp dụng: phản hồi về muộn của lần cũ bị bỏ (và yêu cầu cũ bị hủy).
  const load = useCallback((q: string) => {
    const mine = ++seq.current; ctrl.current?.abort(); const c = new AbortController(); ctrl.current = c;
    find(q, c.signal).then((r) => { if (mine === seq.current) setRows(r); }).catch(() => { if (mine === seq.current) setRows([]); });
  }, [find]);
  const search = (q: string) => { clearTimeout(timer.current); timer.current = setTimeout(() => load(q), 250); };
  useEffect(() => { load(''); return () => { clearTimeout(timer.current); ctrl.current?.abort(); seq.current++; }; }, [load]);
  const options = [...rows.map((r) => ({ value: String(r[valueField]), label: `${r.code} - ${r.name}${r.inactive ? ' (ngưng dùng)' : ''}` })), ...(quickAddFields ? [{ value: QUICK, label: '+ Thêm nhanh…' }] : [])];
  return (
    <>
      <Select {...rest} showSearch filterOption={false} open={open} onOpenChange={setOpen} onSearch={search} {...(value == null ? {} : { value })} options={options}
        onKeyDown={(e) => { if (isLookupKey(e)) { e.preventDefault(); setOpen(true); } }}
        onChange={(v: string) => { if (v === QUICK) { setOpen(false); setAdding(true); return; } onChange?.(v ?? null, rows.find((r) => String(r[valueField]) === v) ?? null); }} allowClear />
      {quickAddFields && (
        <Modal title="Thêm nhanh" open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()} confirmLoading={saving} destroyOnHidden>
          <Form form={form} layout="vertical" onFinish={async (v) => {
            setSaving(true);
            let row: LookupRow;
            // lỗi (trùng mã, thiếu quyền...) thì báo và giữ hộp thoại mở để sửa
            try { row = await creator(catalog, v); } catch (e) { void message.error((e as Error).message); return; } finally { setSaving(false); }
            setRows((xs) => [row, ...xs]); onChange?.(String(row[valueField]), row); setAdding(false); form.resetFields();
          }}>
            {quickAddFields.map((f) => <Form.Item key={f.key} name={f.key} label={f.label} rules={[{ required: true }]}><Input /></Form.Item>)}
          </Form>
        </Modal>)}
    </>
  );
}
