import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DatePicker, Form, Input, Popconfirm, Select, Space, Table, Tabs, Tag, message } from 'antd';
import dayjs from 'dayjs';
import { Link } from '@tanstack/react-router';
import { formatVnDate, formatVnNumber, parseVnNumber } from '@kt/domain';
import { COLOR, PageHeader, Toolbar } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { NoFiscalYearNotice } from './NoFiscalYearNotice.js';
import { AssetTab, DebtTab, EquityTab, OtherAssetTab, VoucherButton } from './HkdDnsnTabs.js';

// Sổ hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026): ghi sổ đơn theo nhóm thuế, không có hệ thống tài khoản.
interface Catalog { regime: string; regimeLabel: string; fiscalYear: number; taxMethod: string | null; methods: { code: string; article: string; label: string; books: string[] }[]; items: { code: string; name: string; article: string; built: boolean; required: boolean; reason: string | null; kind: 'book' | 'report' }[] }
interface DocCol { key: string; label: string; type?: 'number' | 'date'; scale?: number }
interface Doc { title: string; formNo: string; issuedBy: string; subtitle: string; columns: DocCol[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown>; intro?: string[]; outro?: string[] }
interface Group { id: number; code: string; name: string; vatRate: string | null; incomeRate: string | null; isActive: boolean }
interface Entry { id: number; entryDate: string; docNo: string | null; description: string; kind: string; amount: string; groupId: number | null; expenseCat: string | null; taxType: string | null; openingRef: string | null; moneyAccount: string | null }
interface Item { id: number; code: string; name: string; unit: string; warehouse: string | null }
interface Move { id: number; itemId: number; moveDate: string; docNo: string | null; description: string; direction: string; quantity: string; unitPrice: string | null }
interface OtherTax { id: number; entryDate: string; description: string; taxKind: string; quantity: string | null; absRate: string | null; unitPrice: string | null; ratePct: string | null; otherAmount: string | null }

const KIND: Record<string, string> = { revenue: 'Doanh thu bán hàng hóa, dịch vụ', other_income: 'Thu nhập khác', expense: 'Chi phí', tax_paid: 'Thuế đã nộp', vat_input: 'Thuế GTGT đầu vào', vat_output: 'Thuế GTGT đầu ra', vat_refund: 'Thuế GTGT được hoàn', cash_in: 'Thu tiền (không phải doanh thu)', cash_out: 'Chi tiền (không phải chi phí)', opening: 'Số dư đầu' };
const CAT: Record<string, string> = { a: 'a) Nguyên liệu, vật liệu, nhiên liệu, năng lượng, hàng hóa', b: 'b) Tiền lương, tiền công, phụ cấp, bảo hiểm bắt buộc', c: 'c) Khấu hao tài sản cố định', d: 'd) Dịch vụ mua ngoài', dd: 'đ) Lãi tiền vay vốn sản xuất, kinh doanh', e: 'e) Chi khác phục vụ trực tiếp sản xuất, kinh doanh' };
const OPEN: Record<string, string> = { cash: 'Tiền (tiền mặt, tiền gửi)', vat_payable: 'Thuế GTGT còn phải nộp', vat_credit: 'Thuế GTGT còn được khấu trừ', income_tax: 'Thuế TNCN, TNDN còn phải nộp' };
const OTAX: Record<string, string> = { xnk_ttdb: 'Thuế xuất khẩu, nhập khẩu, tiêu thụ đặc biệt', env: 'Thuế bảo vệ môi trường', resource: 'Thuế tài nguyên', land: 'Thuế sử dụng đất', other: 'Thuế khác (nhập số thuế)' };
const DIR: Record<string, string> = { opening: 'Tồn đầu', in: 'Nhập', out: 'Xuất' };
const money = (v: unknown, scale = 0) => (v === '' || v === null || v === undefined ? '' : formatVnNumber(String(v), scale));
const vndInput = (t: string) => { const s = parseVnNumber(t.trim()); return s !== null && /^\d{1,16}$/.test(s) ? s : null; };
const decInput = (t: string) => { const s = t.trim().replace(',', '.'); return /^\d{1,16}(\.\d{1,4})?$/.test(s) ? s : null; };
const err = (e: unknown) => void message.error((e as Error).message);
const DATE = 'YYYY-MM-DD';

function useCatalog() { return useQuery({ queryKey: ['hkd-catalog'], retry: false, queryFn: () => api<Catalog>('/api/hkd/books') }); }

function DocView({ doc }: { doc: Doc }) {
  const cols = doc.columns.map((c) => ({ title: c.label, dataIndex: c.key, key: c.key, ...(c.type === 'number' ? { align: 'right' as const } : {}),
    render: (v: unknown, r: Record<string, unknown>) => { const t = c.type === 'number' ? money(v, c.scale ?? 0) : c.type === 'date' && v ? formatVnDate(String(v)) : String(v ?? ''); return r.isBold ? <b>{t}</b> : t; } }));
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ marginBottom: 2 }}>{doc.title.toUpperCase()}</h3>
      <div style={{ color: COLOR.textSecondary, marginBottom: 8 }}>Mẫu số {doc.formNo} {doc.issuedBy}. {doc.subtitle}</div>
      {doc.intro?.map((t) => <div key={t} style={{ color: COLOR.textSecondary }}>{t}</div>)}
      <Table size="small" bordered pagination={false} columns={cols} dataSource={doc.footer ? [...doc.rows, { ...doc.footer, isBold: true }] : doc.rows} rowKey={(_r, i) => String(i)} scroll={{ x: 'max-content' }} />
      {doc.outro?.map((t) => <Alert key={t} type="warning" showIcon style={{ marginTop: 8 }} message={t} />)}
    </div>
  );
}

function BooksTab({ cat }: { cat: Catalog }) {
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; dateFrom: string; dateTo: string }[]>('/api/fiscal-years') });
  const items = useQuery({ queryKey: ['hkd-items'], queryFn: () => api<Item[]>('/api/hkd/stock-items') });
  const fy = years.data?.find((y) => y.fiscalYear === cat.fiscalYear);
  const [code, setCode] = useState<string>(cat.items.find((i) => i.required && i.built)?.code ?? cat.items.find((i) => i.built)?.code ?? '');
  const [range, setRange] = useState<[string, string]>([dayjs().startOf('month').format(DATE), dayjs().endOf('month').format(DATE)]);
  const [itemId, setItemId] = useState<number | undefined>();
  const [party, setParty] = useState<string | undefined>();
  const parties = useQuery({ queryKey: ['hkd-debt-parties'], enabled: cat.regime === 'TT58', queryFn: () => api<string[]>('/api/hkd/debt-parties') });
  const check = useQuery({ queryKey: ['hkd-revenue-check', cat.fiscalYear], enabled: cat.regime === 'TT152', queryFn: () => api<{ revenue: string; messages: string[] }>(`/api/hkd/revenue-check?year=${cat.fiscalYear}`) });
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const isStock = code === 'S2d-HKD' || code === 'S2c-DNSN'; const isDebt = code === 'S4a-DNSN';
  const qs = (format: string) => `from=${range[0]}&to=${range[1]}${isStock && itemId ? `&itemId=${itemId}` : ''}${isDebt && party ? `&party=${encodeURIComponent(party)}` : ''}&format=${format}`;
  const view = useMutation({ mutationFn: () => api<{ docs: Doc[] }>(`/api/hkd/books/${code}?${qs('json')}`), onSuccess: (r) => setDocs(r.docs), onError: err });
  const sel = cat.items.find((i) => i.code === code);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Toolbar>
        <Select aria-label="Sổ hoặc báo cáo" style={{ width: 440 }} value={code} onChange={(v) => { setCode(v); setDocs(null); }}
          options={cat.items.map((i) => ({ value: i.code, disabled: !i.built, label: `${i.code}: ${i.name}${i.required ? ' (bắt buộc theo phương pháp đã chọn)' : ''}${i.built ? '' : ' (chưa dựng)'}` }))} />
        <DatePicker.RangePicker aria-label="Kỳ" format="DD/MM/YYYY" allowClear={false} value={[dayjs(range[0]), dayjs(range[1])]} onChange={(v) => v?.[0] && v[1] && setRange([v[0].format(DATE), v[1].format(DATE)])} />
        <Button onClick={() => fy && setRange([fy.dateFrom, fy.dateTo])} disabled={!fy}>Cả năm {cat.fiscalYear}</Button>
        {isStock && <Select allowClear placeholder="Mọi mặt hàng" style={{ width: 220 }} value={itemId} onChange={setItemId} options={(items.data ?? []).map((i) => ({ value: i.id, label: `${i.code} - ${i.name}` }))} />}
        {isDebt && <Select allowClear placeholder="Mọi đối tượng" aria-label="Đối tượng công nợ" style={{ width: 220 }} value={party} onChange={setParty} options={(parties.data ?? []).map((p) => ({ value: p, label: p }))} />}
        <Button type="primary" onClick={() => view.mutate()} loading={view.isPending} disabled={!code}>Xem sổ</Button>
        <Button onClick={() => window.open(`/api/hkd/books/${code}?${qs('pdf')}`, '_blank')} disabled={!code}>In PDF</Button>
        <Button onClick={() => window.open(`/api/hkd/books/${code}?${qs('xlsx')}`, '_blank')} disabled={!code}>Xuất Excel</Button>
      </Toolbar>
      {sel && <div style={{ color: COLOR.textSecondary }}>{sel.article} của thông tư. {cat.methods.find((m) => m.code === cat.taxMethod)?.label ? `Phương pháp nộp thuế năm ${cat.fiscalYear}: ${cat.methods.find((m) => m.code === cat.taxMethod)!.label}.` : 'Chưa chọn phương pháp nộp thuế (tab Cài đặt năm).'}</div>}
      {cat.regime === 'TT152' && check.data && <Alert type="info" showIcon message={`Doanh thu năm ${cat.fiscalYear} trên sổ: ${money(check.data.revenue)} đồng`} description={check.data.messages.map((m) => <div key={m}>{m}</div>)} />}
      {docs?.map((d, i) => <DocView key={i} doc={d} />)}
    </Space>
  );
}

function EntriesTab({ cat }: { cat: Catalog }) {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const [range, setRange] = useState<[string, string]>([dayjs().startOf('year').format(DATE), dayjs().endOf('year').format(DATE)]);
  const kind = Form.useWatch('kind', form) as string | undefined;
  const groups = useQuery({ queryKey: ['hkd-groups'], queryFn: () => api<Group[]>('/api/hkd/groups') });
  const entries = useQuery({ queryKey: ['hkd-entries', range], queryFn: () => api<Entry[]>(`/api/hkd/entries?from=${range[0]}&to=${range[1]}`) });
  const add = useMutation({
    mutationFn: (v: Record<string, unknown>) => api('/api/hkd/entries', { method: 'POST', json: v }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hkd-entries'] }); void message.success('Đã ghi sổ'); form.setFieldsValue({ description: undefined, amount: undefined, docNo: undefined }); }, onError: err });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/hkd/entries/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['hkd-entries'] }), onError: err });
  const submit = (v: Record<string, unknown>) => {
    const amount = vndInput(String(v.amount ?? '')); if (amount === null) { void message.error('Số tiền VND phải là số nguyên tối đa 16 chữ số'); return; }
    add.mutate({ entryDate: (v.entryDate as dayjs.Dayjs).format(DATE), docNo: v.docNo || null, description: v.description, kind: v.kind, amount, groupId: v.kind === 'revenue' ? v.groupId : null, expenseCat: v.kind === 'expense' ? v.expenseCat : null,
      taxType: v.kind === 'tax_paid' ? v.taxType : null, openingRef: v.kind === 'opening' ? v.openingRef : null, moneyAccount: v.moneyAccount || null });
  };
  const needMoney = kind === 'cash_in' || kind === 'cash_out' || (kind === 'opening' && form.getFieldValue('openingRef') === 'cash');
  const gname = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {can('sohkd.create') && (
        <Form form={form} layout="inline" onFinish={submit} initialValues={{ entryDate: dayjs(), kind: 'revenue' }} style={{ rowGap: 8 }}>
          <Form.Item name="entryDate" label="Ngày" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="docNo" label="Số chứng từ"><Input style={{ width: 110 }} /></Form.Item>
          <Form.Item name="kind" label="Loại" rules={[{ required: true }]}><Select style={{ width: 250 }} options={Object.entries(KIND).filter(([k]) => cat.regime === 'TT58' || !['vat_input', 'vat_output', 'vat_refund'].includes(k)).map(([value, label]) => ({ value, label }))} /></Form.Item>
          {kind === 'revenue' && <Form.Item name="groupId" label="Nhóm ngành nghề" rules={[{ required: true, message: 'Chọn nhóm (tạo ở tab Nhóm ngành nghề)' }]}><Select style={{ width: 200 }} options={(groups.data ?? []).filter((g) => g.isActive).map((g) => ({ value: g.id, label: g.name }))} /></Form.Item>}
          {kind === 'expense' && <Form.Item name="expenseCat" label="Khoản mục" rules={[{ required: true }]}><Select style={{ width: 280 }} options={Object.entries(CAT).map(([value, label]) => ({ value, label }))} /></Form.Item>}
          {kind === 'tax_paid' && <Form.Item name="taxType" label="Loại thuế" rules={[{ required: true }]}><Select style={{ width: 200 }} options={[{ value: 'vat', label: 'Thuế GTGT' }, { value: 'income', label: cat.regime === 'TT152' ? 'Thuế TNCN' : 'Thuế TNDN' }]} /></Form.Item>}
          {kind === 'opening' && <Form.Item name="openingRef" label="Khoản" rules={[{ required: true }]}><Select style={{ width: 240 }} options={Object.entries(OPEN).map(([value, label]) => ({ value, label }))} /></Form.Item>}
          <Form.Item name="moneyAccount" label="Tiền (TM hoặc tên ngân hàng)" rules={[{ required: needMoney, message: 'Nhập TM hoặc tên ngân hàng' }]} tooltip="Để trống nếu chưa thu, chi tiền; có giá trị thì bút ghi lên Sổ chi tiết tiền"><Input style={{ width: 130 }} /></Form.Item>
          <Form.Item name="description" label="Diễn giải" rules={[{ required: true, message: 'Cần diễn giải' }]}><Input style={{ width: 240 }} /></Form.Item>
          <Form.Item name="amount" label="Số tiền" rules={[{ required: true }]}><Input style={{ width: 150 }} inputMode="numeric" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending}>Ghi sổ</Button>
        </Form>
      )}
      <DatePicker.RangePicker aria-label="Kỳ xem" format="DD/MM/YYYY" allowClear={false} value={[dayjs(range[0]), dayjs(range[1])]} onChange={(v) => v?.[0] && v[1] && setRange([v[0].format(DATE), v[1].format(DATE)])} />
      <Table<Entry> size="small" bordered rowKey="id" loading={entries.isLoading} dataSource={entries.data ?? []} pagination={{ pageSize: 50 }}
        columns={[
          { title: 'Ngày', dataIndex: 'entryDate', width: 100, render: formatVnDate }, { title: 'Số CT', dataIndex: 'docNo', width: 100 },
          { title: 'Loại', dataIndex: 'kind', width: 220, render: (k: string, r) => <Space size={4}>{KIND[k]}{r.groupId && <Tag>{gname.get(r.groupId)}</Tag>}{r.expenseCat && <Tag>{r.expenseCat === 'dd' ? 'đ' : r.expenseCat}</Tag>}{r.moneyAccount && <Tag color="blue">{r.moneyAccount}</Tag>}</Space> },
          { title: 'Diễn giải', dataIndex: 'description' }, { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 150, render: (v: string) => money(v) },
          ...(cat.regime === 'TT58' ? [{ title: '', width: 80, render: (_v: unknown, r: Entry) => r.moneyAccount === 'TM' && (['revenue', 'other_income', 'cash_in'].includes(r.kind) ? <VoucherButton form="01-TT" entryId={r.id} /> : ['expense', 'tax_paid', 'cash_out'].includes(r.kind) ? <VoucherButton form="02-TT" entryId={r.id} /> : null) }] : []),
          { title: '', width: 70, render: (_v, r) => can('sohkd.delete') && <Popconfirm title="Xóa bút ghi này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><Button size="small" danger type="link">Xóa</Button></Popconfirm> },
        ]} />
    </Space>
  );
}

function GroupsTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const groups = useQuery({ queryKey: ['hkd-groups'], queryFn: () => api<Group[]>('/api/hkd/groups') });
  const save = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/groups', { method: 'POST', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hkd-groups'] }); form.resetFields(); void message.success('Đã thêm nhóm'); }, onError: err });
  const toggle = useMutation({ mutationFn: (g: Group) => api(`/api/hkd/groups/${g.id}`, { method: 'PUT', json: { code: g.code, name: g.name, vatRate: g.vatRate, incomeRate: g.incomeRate, isActive: !g.isActive } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['hkd-groups'] }), onError: err });
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Nhóm hàng hóa, dịch vụ, ngành nghề có cùng tỷ lệ % tính thuế. Tỷ lệ (ví dụ 1,5) do bạn khai theo văn bản thuế hiện hành; phần mềm không đặt sẵn tỷ lệ pháp lý." />
      {can('sohkd.config') && (
        <Form form={form} layout="inline" onFinish={(v) => save.mutate({ code: v.code, name: v.name, vatRate: v.vatRate ? decInput(String(v.vatRate)) : null, incomeRate: v.incomeRate ? decInput(String(v.incomeRate)) : null, isActive: true })} style={{ rowGap: 8 }}>
          <Form.Item name="code" label="Mã" rules={[{ required: true }]}><Input style={{ width: 100 }} /></Form.Item>
          <Form.Item name="name" label="Tên nhóm" rules={[{ required: true }]}><Input style={{ width: 260 }} /></Form.Item>
          <Form.Item name="vatRate" label="Tỷ lệ thuế GTGT (%)"><Input style={{ width: 90 }} inputMode="decimal" /></Form.Item>
          <Form.Item name="incomeRate" label="Tỷ lệ thuế TNCN, TNDN (%)"><Input style={{ width: 90 }} inputMode="decimal" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={save.isPending}>Thêm nhóm</Button>
        </Form>
      )}
      <Table<Group> size="small" bordered rowKey="id" dataSource={groups.data ?? []} pagination={false}
        columns={[{ title: 'Mã', dataIndex: 'code', width: 110 }, { title: 'Tên nhóm', dataIndex: 'name' }, { title: 'Thuế GTGT (%)', dataIndex: 'vatRate', align: 'right', width: 140, render: (v: string | null) => v ?? 'Chưa khai' },
          { title: 'Thuế TNCN, TNDN (%)', dataIndex: 'incomeRate', align: 'right', width: 170, render: (v: string | null) => v ?? 'Chưa khai' },
          { title: 'Trạng thái', dataIndex: 'isActive', width: 110, render: (a: boolean, g) => <Button size="small" type="link" disabled={!can('sohkd.config')} onClick={() => toggle.mutate(g)}>{a ? 'Đang dùng' : 'Ngừng dùng'}</Button> }]} />
    </Space>
  );
}

function StockTab({ regime }: { regime: string }) {
  const { can } = useAuth(); const qc = useQueryClient(); const [fi] = Form.useForm(); const [fm] = Form.useForm();
  const items = useQuery({ queryKey: ['hkd-items'], queryFn: () => api<Item[]>('/api/hkd/stock-items') });
  const moves = useQuery({ queryKey: ['hkd-moves'], queryFn: () => api<Move[]>('/api/hkd/stock-moves') });
  const dir = Form.useWatch('direction', fm) as string | undefined;
  const addItem = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/stock-items', { method: 'POST', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hkd-items'] }); fi.resetFields(); }, onError: err });
  const addMove = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/stock-moves', { method: 'POST', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hkd-moves'] }); fm.setFieldsValue({ quantity: undefined, unitPrice: undefined, description: undefined }); void message.success('Đã ghi'); }, onError: err });
  const delMove = useMutation({ mutationFn: (id: number) => api(`/api/hkd/stock-moves/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['hkd-moves'] }), onError: err });
  const name = new Map((items.data ?? []).map((i) => [i.id, `${i.code} - ${i.name}`]));
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Đơn giá xuất kho tính theo công thức của thông tư: (giá trị tồn đầu + giá trị nhập trong tháng) / (số lượng tồn đầu + số lượng nhập trong tháng), theo từng tháng dương lịch. Dòng xuất chỉ nhập số lượng." />
      {can('sohkd.create') && <>
        <Form form={fi} layout="inline" onFinish={(v) => addItem.mutate({ code: v.code, name: v.name, unit: v.unit, warehouse: v.warehouse || null })} style={{ rowGap: 8 }}>
          <Form.Item name="code" label="Mã" rules={[{ required: true }]}><Input style={{ width: 100 }} /></Form.Item><Form.Item name="name" label="Tên vật liệu, dụng cụ, sản phẩm, hàng hóa" rules={[{ required: true }]}><Input style={{ width: 260 }} /></Form.Item>
          <Form.Item name="unit" label="Đơn vị tính" rules={[{ required: true }]}><Input style={{ width: 80 }} /></Form.Item><Form.Item name="warehouse" label="Kho"><Input style={{ width: 120 }} /></Form.Item>
          <Button htmlType="submit" loading={addItem.isPending}>Thêm mặt hàng</Button>
        </Form>
        <Form form={fm} layout="inline" initialValues={{ moveDate: dayjs(), direction: 'in' }} style={{ rowGap: 8 }}
          onFinish={(v) => { const q = decInput(String(v.quantity ?? '')); const p = dir === 'out' ? null : decInput(String(v.unitPrice ?? '')); if (!q || (dir !== 'out' && p === null)) { void message.error('Số lượng và đơn giá không hợp lệ'); return; }
            addMove.mutate({ itemId: v.itemId, moveDate: (v.moveDate as dayjs.Dayjs).format(DATE), docNo: v.docNo || null, description: v.description, direction: v.direction, quantity: q, unitPrice: p }); }}>
          <Form.Item name="itemId" label="Mặt hàng" rules={[{ required: true }]}><Select style={{ width: 220 }} options={(items.data ?? []).map((i) => ({ value: i.id, label: `${i.code} - ${i.name}` }))} /></Form.Item>
          <Form.Item name="moveDate" label="Ngày" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="direction" label="Loại" rules={[{ required: true }]}><Select style={{ width: 100 }} options={Object.entries(DIR).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="docNo" label="Số CT"><Input style={{ width: 90 }} /></Form.Item><Form.Item name="description" label="Diễn giải" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
          <Form.Item name="quantity" label="Số lượng" rules={[{ required: true }]}><Input style={{ width: 90 }} inputMode="decimal" /></Form.Item>
          {dir !== 'out' && <Form.Item name="unitPrice" label="Đơn giá" rules={[{ required: true }]}><Input style={{ width: 110 }} inputMode="decimal" /></Form.Item>}
          <Button type="primary" htmlType="submit" loading={addMove.isPending}>Ghi</Button>
        </Form>
      </>}
      <Table<Move> size="small" bordered rowKey="id" dataSource={moves.data ?? []} pagination={{ pageSize: 50 }}
        columns={[{ title: 'Ngày', dataIndex: 'moveDate', width: 100, render: formatVnDate }, { title: 'Mặt hàng', dataIndex: 'itemId', render: (i: number) => name.get(i) }, { title: 'Loại', dataIndex: 'direction', width: 90, render: (d: string) => DIR[d] }, { title: 'Diễn giải', dataIndex: 'description' },
          { title: 'Số lượng', dataIndex: 'quantity', align: 'right', width: 110, render: (v: string) => money(v, 4) }, { title: 'Đơn giá', dataIndex: 'unitPrice', align: 'right', width: 120, render: (v: string | null) => (v ? money(v, 4) : '') },
          ...(regime === 'TT58' ? [{ title: '', width: 80, render: (_v: unknown, r: Move) => (r.direction === 'in' ? <VoucherButton form="01-VT" docNo={r.docNo} /> : r.direction === 'out' ? <VoucherButton form="02-VT" docNo={r.docNo} /> : null) }] : []),
          { title: '', width: 70, render: (_v, r) => can('sohkd.delete') && <Popconfirm title="Xóa dòng này?" okText="Xóa" cancelText="Không" onConfirm={() => delMove.mutate(r.id)}><Button size="small" danger type="link">Xóa</Button></Popconfirm> }]} />
    </Space>
  );
}

function OtherTaxTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const [range] = useState<[string, string]>([dayjs().startOf('year').format(DATE), dayjs().endOf('year').format(DATE)]);
  const kind = Form.useWatch('taxKind', form) as string | undefined;
  const rows = useQuery({ queryKey: ['hkd-other', range], queryFn: () => api<OtherTax[]>(`/api/hkd/other-taxes?from=${range[0]}&to=${range[1]}`) });
  const add = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/other-taxes', { method: 'POST', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hkd-other'] }); void message.success('Đã ghi'); }, onError: err });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/hkd/other-taxes/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['hkd-other'] }), onError: err });
  const n = (v: unknown) => (v ? decInput(String(v)) : null);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Sổ theo dõi nghĩa vụ thuế khác (xuất khẩu, nhập khẩu, tiêu thụ đặc biệt, bảo vệ môi trường, tài nguyên, sử dụng đất). Thuế suất nhập theo phần trăm; số thuế tính theo công thức của thông tư." />
      {can('sohkd.create') && (
        <Form form={form} layout="inline" initialValues={{ entryDate: dayjs(), taxKind: 'xnk_ttdb' }} style={{ rowGap: 8 }}
          onFinish={(v) => add.mutate({ entryDate: (v.entryDate as dayjs.Dayjs).format(DATE), description: v.description, taxKind: v.taxKind, quantity: n(v.quantity), absRate: n(v.absRate), unitPrice: n(v.unitPrice), ratePct: n(v.ratePct), otherAmount: v.taxKind === 'other' ? vndInput(String(v.otherAmount ?? '')) : null })}>
          <Form.Item name="entryDate" label="Ngày" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="taxKind" label="Loại thuế" rules={[{ required: true }]}><Select style={{ width: 300 }} options={Object.entries(OTAX).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="description" label="Giao dịch" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
          {kind === 'other' ? <Form.Item name="otherAmount" label="Số thuế" rules={[{ required: true }]}><Input style={{ width: 130 }} inputMode="numeric" /></Form.Item> : <>
            <Form.Item name="quantity" label="Lượng chịu thuế (1)"><Input style={{ width: 100 }} inputMode="decimal" /></Form.Item>
            {(kind === 'xnk_ttdb' || kind === 'env') && <Form.Item name="absRate" label="Mức thuế tuyệt đối (2)"><Input style={{ width: 100 }} inputMode="decimal" /></Form.Item>}
            {kind !== 'env' && <><Form.Item name="unitPrice" label="Giá tính thuế/đơn vị (3)"><Input style={{ width: 110 }} inputMode="decimal" /></Form.Item><Form.Item name="ratePct" label="Thuế suất % (4)"><Input style={{ width: 80 }} inputMode="decimal" /></Form.Item></>}</>}
          <Button type="primary" htmlType="submit" loading={add.isPending}>Ghi</Button>
        </Form>
      )}
      <Table<OtherTax> size="small" bordered rowKey="id" dataSource={rows.data ?? []} pagination={false}
        columns={[{ title: 'Ngày', dataIndex: 'entryDate', width: 100, render: formatVnDate }, { title: 'Loại thuế', dataIndex: 'taxKind', render: (k: string) => OTAX[k] }, { title: 'Giao dịch', dataIndex: 'description' },
          { title: 'Lượng', dataIndex: 'quantity', align: 'right', render: (v: string | null) => (v ? money(v, 4) : '') }, { title: 'Giá tính thuế', dataIndex: 'unitPrice', align: 'right', render: (v: string | null) => (v ? money(v, 4) : '') }, { title: 'Thuế suất %', dataIndex: 'ratePct', align: 'right' },
          { title: '', width: 70, render: (_v, r) => can('sohkd.delete') && <Popconfirm title="Xóa dòng này?" okText="Xóa" cancelText="Không" onConfirm={() => del.mutate(r.id)}><Button size="small" danger type="link">Xóa</Button></Popconfirm> }]} />
    </Space>
  );
}

function SettingsTab({ cat }: { cat: Catalog }) {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const st = useQuery({ queryKey: ['hkd-setting', cat.fiscalYear], queryFn: () => api<{ taxMethod: string | null; incomeTaxRate: string | null }>(`/api/hkd/settings/${cat.fiscalYear}`) });
  const save = useMutation({ mutationFn: (v: { taxMethod: string; incomeTaxRate: string | null }) => api(`/api/hkd/settings/${cat.fiscalYear}`, { method: 'PUT', json: v }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hkd-setting'] }); void qc.invalidateQueries({ queryKey: ['hkd-catalog'] }); void message.success('Đã lưu'); }, onError: err });
  if (st.isLoading) return null;
  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 640 }} initialValues={{ taxMethod: st.data?.taxMethod ?? undefined, incomeTaxRate: st.data?.incomeTaxRate ?? undefined }}
      onFinish={(v) => save.mutate({ taxMethod: v.taxMethod, incomeTaxRate: v.incomeTaxRate ? decInput(String(v.incomeTaxRate)) : null })}>
      <Form.Item name="taxMethod" label={`Phương pháp nộp thuế năm ${cat.fiscalYear} (quyết định bộ sổ phải dùng)`} rules={[{ required: true }]}>
        <Select disabled={!can('sohkd.config')} options={cat.methods.map((m) => ({ value: m.code, label: `${m.article}: ${m.label}` }))} /></Form.Item>
      <Form.Item name="incomeTaxRate" label="Thuế suất trên thu nhập tính thuế (%), dùng cho sổ chi tiết doanh thu, chi phí" extra="Khai theo văn bản thuế hiện hành; để trống thì thuế tính trên thu nhập tạm tính 0."><Input style={{ width: 140 }} inputMode="decimal" disabled={!can('sohkd.config')} /></Form.Item>
      {can('sohkd.config') && <Button type="primary" htmlType="submit" loading={save.isPending}>Lưu cài đặt</Button>}
    </Form>
  );
}

export default function HkdBooksPage() {
  const cat = useCatalog();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number }[]>('/api/fiscal-years') });
  // Chưa có năm nào: dùng thông báo chung. Đã có năm nhưng không phải TT 152/TT 58: giữ thông báo riêng nêu đúng chế độ cần.
  // Lỗi khác (mạng, quyền, máy chủ): nêu đúng lỗi, không báo "chưa có năm".
  const noRegimeYear = cat.error instanceof ApiError && cat.error.code === 'FISCAL_YEAR_NOT_FOUND';
  if (cat.isError && !noRegimeYear) return (
    <div><PageHeader title="Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ" />
      <Alert type="error" showIcon message="Không tải được danh mục sổ" description={cat.error.message} /></div>);
  if (cat.isError && years.isLoading) return null;
  if (cat.isError && years.data && !years.data.length) return (
    <div><PageHeader title="Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ" />
      <NoFiscalYearNotice purpose="ghi sổ hộ kinh doanh theo TT 152/2025 hoặc TT 58/2026" /></div>);
  if (cat.isError) return (
    <div><PageHeader title="Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ" />
      <Alert type="warning" showIcon message="Công ty chưa có năm tài chính theo TT 152/2025 hoặc TT 58/2026" description={<span>Tạo năm tài chính với chế độ này ở <Link to="/he-thong/tao-cong-ty">Tạo công ty mới</Link> hoặc <Link to="/he-thong/che-do-ke-toan">xem tình trạng chế độ</Link>.</span>} /></div>);
  if (!cat.data) return null;
  const c = cat.data;
  return (
    <div>
      <PageHeader title="Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ" description={`${c.regimeLabel}, năm tài chính ${c.fiscalYear}. Ghi sổ theo nhóm thuế, không có hệ thống tài khoản.`} />
      {!c.taxMethod && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Chưa chọn phương pháp nộp thuế cho năm này" description="Chọn ở tab Cài đặt năm để biết cần dùng những sổ nào." />}
      <Tabs items={[
        { key: 'books', label: 'Sổ và báo cáo', children: <BooksTab key={c.fiscalYear} cat={c} /> },
        { key: 'entries', label: 'Ghi sổ', children: <EntriesTab cat={c} /> },
        { key: 'groups', label: 'Nhóm ngành nghề', children: <GroupsTab /> },
        { key: 'stock', label: 'Kho', children: <StockTab regime={c.regime} /> },
        ...(c.regime === 'TT58' ? [
          { key: 'debts', label: 'Công nợ', children: <DebtTab /> },
          { key: 'assets', label: 'Tài sản cố định', children: <AssetTab /> },
          { key: 'equity', label: 'Vốn chủ sở hữu', children: <EquityTab /> },
          { key: 'otherAssets', label: 'Tài sản khác', children: <OtherAssetTab /> },
        ] : []),
        { key: 'other', label: 'Thuế khác', children: <OtherTaxTab /> },
        { key: 'settings', label: 'Cài đặt năm', children: <SettingsTab cat={c} /> },
      ]} />
    </div>
  );
}
