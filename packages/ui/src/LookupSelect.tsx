import { useEffect, useRef, useState } from 'react';
import { Form, Input, Modal, Select, type SelectProps } from 'antd';
import { isLookupKey } from '@kt/domain';

export interface LookupRow { id: string | number; code: string; name: string }
export interface LookupSelectProps extends Omit<SelectProps, 'options' | 'onChange' | 'value'> {
  catalog: string; value?: string | null | undefined; onChange?: ((code: string | null, row: LookupRow | null) => void) | undefined;
  valueField?: 'code' | 'id'; quickAddFields?: { key: string; label: string }[] | undefined;
  fetcher?: (catalog: string, q: string) => Promise<LookupRow[]>; creator?: (catalog: string, body: Record<string, unknown>) => Promise<LookupRow>;
}
const defaultFetcher = async (catalog: string, q: string): Promise<LookupRow[]> => {
  const r = await fetch(`/api/catalogs/${catalog}?q=${encodeURIComponent(q)}&size=50`, { credentials: 'include' });
  if (!r.ok) return []; // phiên hết hạn / thiếu quyền: danh sách rỗng, không để `rows` thành undefined làm hỏng giao diện
  return ((await r.json()) as { rows: LookupRow[] }).rows;
};
const defaultCreator = async (catalog: string, body: Record<string, unknown>): Promise<LookupRow> => {
  const r = await fetch(`/api/catalogs/${catalog}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json()) as { error: { message: string } }).error.message);
  const { id } = (await r.json()) as { id: string };
  return { id, code: String(body['code']), name: String(body['name']) };
};
const QUICK = '__quick_add__';

export function LookupSelect({ catalog, value, onChange, valueField = 'code', quickAddFields, fetcher = defaultFetcher, creator = defaultCreator, ...rest }: LookupSelectProps) {
  const [rows, setRows] = useState<LookupRow[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const search = (q: string) => { clearTimeout(timer.current); timer.current = setTimeout(() => { void fetcher(catalog, q).then(setRows); }, 150); };
  useEffect(() => { void fetcher(catalog, '').then(setRows); }, [catalog, fetcher]);
  const options = [...rows.map((r) => ({ value: String(r[valueField]), label: `${r.code} - ${r.name}` })), ...(quickAddFields ? [{ value: QUICK, label: '+ Thêm nhanh…' }] : [])];
  return (
    <>
      <Select {...rest} showSearch filterOption={false} open={open} onOpenChange={setOpen} onSearch={search} {...(value == null ? {} : { value })} options={options}
        onKeyDown={(e) => { if (isLookupKey(e)) { e.preventDefault(); setOpen(true); } }}
        onChange={(v: string) => { if (v === QUICK) { setOpen(false); setAdding(true); return; } onChange?.(v ?? null, rows.find((r) => String(r[valueField]) === v) ?? null); }} allowClear />
      {quickAddFields && (
        <Modal title="Thêm nhanh" open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()} destroyOnHidden>
          <Form form={form} layout="vertical" onFinish={async (v) => { const row = await creator(catalog, v); setRows((xs) => [row, ...xs]); onChange?.(String(row[valueField]), row); setAdding(false); form.resetFields(); }}>
            {quickAddFields.map((f) => <Form.Item key={f.key} name={f.key} label={f.label} rules={[{ required: true }]}><Input /></Form.Item>)}
          </Form>
        </Modal>)}
    </>
  );
}
