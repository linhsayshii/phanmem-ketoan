import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AutoComplete, Button, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber, parseVnNumber } from '@kt/domain';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';
import { FormModal } from '@kt/ui';

// TT 58/2026 Điều 9: sổ công nợ (S4a), TSCĐ (S4b), vốn chủ sở hữu (S4d), tài sản khác (mã 150 của B01-DNSN) và in chứng từ 01-TT, 02-TT, 01-VT, 02-VT. Cùng khuôn với các tab ghi sổ của HkdBooks.
const DATE = 'YYYY-MM-DD';
const money = (v: unknown, scale = 0) => (v === '' || v === null || v === undefined ? '' : formatVnNumber(String(v), scale));
const err = (e: unknown) => void message.error((e as Error).message);
const vndInput = (t: string, signedOk = false) => { const s = parseVnNumber(t.trim().replace(/^-/, '')); const neg = signedOk && t.trim().startsWith('-'); return s !== null && /^\d{1,16}$/.test(s) ? `${neg ? '-' : ''}${s}` : null; };
const decInput = (t: string) => { const s = t.trim().replace(',', '.'); return /^\d{1,3}(\.\d{1,4})?$/.test(s) ? s : null; };
const delBtn = (can: boolean, onConfirm: () => void) => can && <Popconfirm title="Xóa dòng này?" okText="Xóa" cancelText="Không" onConfirm={onConfirm}><Button size="small" danger type="link">Xóa</Button></Popconfirm>;
const MOVE: Record<string, string> = { opening: 'Số dư đầu', increase: 'Tăng', decrease: 'Giảm' };

// ---- In chứng từ ----
export type VoucherForm = '01-TT' | '02-TT' | '01-VT' | '02-VT';
const VOUCHER_NAME: Record<VoucherForm, string> = { '01-TT': 'Phiếu thu', '02-TT': 'Phiếu chi', '01-VT': 'Phiếu nhập kho', '02-VT': 'Phiếu xuất kho' };
export function VoucherButton({ form, entryId, docNo }: { form: VoucherForm; entryId?: number; docNo?: string | null }) {
  const [open, setOpen] = useState(false); const [f] = Form.useForm();
  const cash = form === '01-TT' || form === '02-TT'; const stockIn = form === '01-VT';
  const url = (format: 'html' | 'pdf') => {
    const q = new URLSearchParams(); if (cash) q.set('entryId', String(entryId)); else q.set('docNo', docNo ?? '');
    for (const [k, v] of Object.entries(f.getFieldsValue() as Record<string, string | undefined>)) if (v?.trim()) q.set(k, v.trim());
    q.set('format', format); return `/api/hkd/vouchers/${form}?${q.toString()}`;
  };
  if (!cash && !docNo) return null;
  return (
    <>
      <Button size="small" type="link" onClick={() => setOpen(true)}>In phiếu</Button>
      <Modal title={`${VOUCHER_NAME[form]} (mẫu ${form})`} open={open} destroyOnClose onCancel={() => setOpen(false)} footer={[
        <Button key="x" onClick={() => setOpen(false)}>Đóng</Button>,
        <Button key="h" onClick={() => window.open(url('html'), '_blank')}>Xem phiếu</Button>,
        <Button key="p" type="primary" onClick={() => window.open(url('pdf'), '_blank')}>In PDF</Button>]}>
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Phiếu in từ bút ghi sổ; các thông tin dưới đây chỉ dùng cho bản in, không lưu. Để trống thì bản in để chấm chấm cho người lập điền tay." />
        <Form form={f} name="hkdVoucher" layout="vertical">
          <Form.Item name="person" label={cash ? (form === '01-TT' ? 'Họ và tên người nộp tiền' : 'Họ và tên người nhận tiền') : stockIn ? 'Họ và tên người giao' : 'Họ và tên người nhận hàng'}><Input /></Form.Item>
          {(cash || form === '02-VT') && <Form.Item name="address" label={form === '02-VT' ? 'Địa chỉ (bộ phận)' : 'Địa chỉ'}><Input /></Form.Item>}
          {form !== '01-VT' && <Form.Item name="reason" label={form === '01-TT' ? 'Lý do nộp' : form === '02-TT' ? 'Lý do chi' : 'Lý do xuất kho'} extra="Để trống thì lấy diễn giải của bút ghi."><Input /></Form.Item>}
          {form === '01-VT' && <Form.Item name="basis" label="Theo (loại, số, ngày, nơi lập chứng từ)"><Input placeholder="hóa đơn số 12 ngày 05/07/2026 của Công ty X" /></Form.Item>}
          {!cash && <Form.Item name="warehouse" label="Kho" extra="Để trống thì lấy kho khai ở mặt hàng."><Input /></Form.Item>}
          {!cash && <Form.Item name="location" label="Địa điểm"><Input /></Form.Item>}
          {!cash && <Form.Item name="department" label="Bộ phận"><Input /></Form.Item>}
          <Form.Item name="attachments" label="Số chứng từ gốc kèm theo"><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// ---- S4a: công nợ ----
interface Debt { id: number; entryDate: string; docNo: string | null; description: string; party: string; side: string; kind: string; nature: string; amount: string }
const SIDE: Record<string, string> = { recv: 'Phải thu', pay: 'Phải trả' };
const DKIND: Record<string, string> = { opening: 'Số dư đầu', incur: 'Phát sinh', settle: 'Đã thu, đã trả' };
const NATURE: Record<string, string> = { trade: 'Mua bán hàng hóa, dịch vụ', loan: 'Vay, cho vay', advance: 'Tạm ứng', deposit: 'Ký quỹ, ký cược', payroll: 'Lương và các khoản theo lương', tax: 'Nghĩa vụ thuế (TNCN, xuất nhập khẩu...)', other: 'Khác' };

export function DebtTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const side = Form.useWatch('side', form) as string | undefined;
  const debts = useQuery({ queryKey: ['hkd-debts'], queryFn: () => api<Debt[]>('/api/hkd/debts') });
  const parties = useQuery({ queryKey: ['hkd-debt-parties'], queryFn: () => api<string[]>('/api/hkd/debt-parties') });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['hkd-debts'] }); void qc.invalidateQueries({ queryKey: ['hkd-debt-parties'] }); };
  const add = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/debts', { method: 'POST', json: v }), onSuccess: () => { refresh(); void message.success('Đã ghi công nợ'); form.setFieldsValue({ description: undefined, amount: undefined, docNo: undefined }); }, onError: err });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/hkd/debts/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: err });
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Sổ chi tiết thanh toán công nợ (S4a-DNSN): mỗi đối tượng một sổ. Ghi số dư đầu, khoản phát sinh phải thu hoặc phải trả, và số đã thu hoặc đã trả. Nghĩa vụ thuế khác (thuế TNCN, xuất nhập khẩu... không gồm GTGT, TNDN) chọn tính chất Nghĩa vụ thuế ở bên phải trả để vào mã 320 của B01-DNSN." />
      {can('sohkd.create') && (
        <Form form={form} name="hkdDebt" layout="inline" style={{ rowGap: 8 }} initialValues={{ entryDate: dayjs(), side: 'recv', kind: 'incur', nature: 'trade' }}
          onFinish={(v) => { const amount = vndInput(String(v.amount ?? '')); if (!amount) { void message.error('Số tiền VND phải là số nguyên tối đa 16 chữ số'); return; }
            add.mutate({ entryDate: (v.entryDate as dayjs.Dayjs).format(DATE), docNo: v.docNo || null, description: v.description, party: v.party, side: v.side, kind: v.kind, nature: v.side === 'pay' || v.nature !== 'tax' ? v.nature : 'other', amount }); }}>
          <Form.Item name="entryDate" label="Ngày" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="docNo" label="Số chứng từ"><Input style={{ width: 100 }} /></Form.Item>
          <Form.Item name="party" label="Đối tượng" rules={[{ required: true, message: 'Cần đối tượng công nợ' }]}><AutoComplete style={{ width: 180 }} options={(parties.data ?? []).map((p) => ({ value: p }))} filterOption={(i, o) => String(o?.value ?? '').toLowerCase().includes(i.toLowerCase())} /></Form.Item>
          <Form.Item name="side" label="Bên" rules={[{ required: true }]}><Select style={{ width: 110 }} options={Object.entries(SIDE).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="kind" label="Loại bút" rules={[{ required: true }]}><Select style={{ width: 150 }} options={Object.entries(DKIND).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="nature" label="Tính chất" rules={[{ required: true }]}><Select style={{ width: 230 }} options={Object.entries(NATURE).map(([value, label]) => ({ value, label, disabled: value === 'tax' && side === 'recv' }))} /></Form.Item>
          <Form.Item name="description" label="Diễn giải" rules={[{ required: true, message: 'Cần diễn giải' }]}><Input style={{ width: 200 }} /></Form.Item>
          <Form.Item name="amount" label="Số tiền" rules={[{ required: true }]}><Input style={{ width: 140 }} inputMode="numeric" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending}>Ghi công nợ</Button>
        </Form>
      )}
      <Table<Debt> size="small" bordered rowKey="id" loading={debts.isLoading} dataSource={debts.data ?? []} pagination={{ pageSize: 50 }}
        columns={[{ title: 'Ngày', dataIndex: 'entryDate', width: 100, render: formatVnDate }, { title: 'Số CT', dataIndex: 'docNo', width: 90 }, { title: 'Đối tượng', dataIndex: 'party', width: 170 },
          { title: 'Bên, loại bút', width: 240, render: (_v, r) => <Space size={4}><Tag color={r.side === 'recv' ? 'blue' : 'orange'}>{SIDE[r.side]}</Tag>{DKIND[r.kind]}{r.nature === 'tax' && <Tag>Thuế</Tag>}</Space> },
          { title: 'Diễn giải', dataIndex: 'description' }, { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 140, render: (v: string) => money(v) },
          { title: '', width: 70, render: (_v, r) => delBtn(can('sohkd.delete'), () => del.mutate(r.id)) }]} />
    </Space>
  );
}

// ---- S4b: tài sản cố định ----
interface Asset { id: number; assetType: string; name: string; incDocNo: string | null; incDate: string; inUseMonth: string; cost: string; depRate: string; decDocNo: string | null; decDate: string | null; decReason: string | null }
const assetBody = (a: Asset, dec: { decDocNo: string | null; decDate: string | null; decReason: string | null }) => ({ assetType: a.assetType, name: a.name, incDocNo: a.incDocNo, incDate: a.incDate, inUseMonth: a.inUseMonth, cost: a.cost, depRate: a.depRate, ...dec });

export function AssetTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm(); const [fd] = Form.useForm();
  const [decOf, setDecOf] = useState<Asset | null>(null);
  const assets = useQuery({ queryKey: ['hkd-assets'], queryFn: () => api<Asset[]>('/api/hkd/fixed-assets') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hkd-assets'] });
  const add = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/fixed-assets', { method: 'POST', json: v }), onSuccess: () => { refresh(); void message.success('Đã ghi tăng TSCĐ'); form.setFieldsValue({ name: undefined, cost: undefined, incDocNo: undefined }); }, onError: err });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/hkd/fixed-assets/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: err });
  const dec = useMutation({ mutationFn: (p: { a: Asset; body: ReturnType<typeof assetBody> }) => api(`/api/hkd/fixed-assets/${p.a.id}`, { method: 'PUT', json: p.body }), onSuccess: () => { refresh(); setDecOf(null); void message.success('Đã ghi giảm TSCĐ'); }, onError: err });
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Sổ tài sản cố định (S4b-DNSN): mỗi tài sản một dòng, sổ in theo từng loại tài sản. Khấu hao tính đường thẳng tròn tháng theo tỷ lệ hằng năm, từ tháng đưa vào sử dụng, thôi từ tháng ghi giảm; tháng chưa kết thúc tại ngày cuối kỳ chưa tính. Giá trị còn lại của tài sản chưa ghi giảm vào mã 140 của B01-DNSN." />
      {can('sohkd.create') && (
        <Form form={form} name="hkdAsset" layout="inline" style={{ rowGap: 8 }} initialValues={{ incDate: dayjs(), inUseMonth: dayjs() }}
          onFinish={(v) => { const cost = vndInput(String(v.cost ?? '')); const rate = decInput(String(v.depRate ?? '')); if (!cost || rate === null) { void message.error('Nguyên giá là số nguyên VND; tỷ lệ khấu hao là phần trăm, tối đa 4 chữ số thập phân'); return; }
            add.mutate({ assetType: v.assetType, name: v.name, incDocNo: v.incDocNo || null, incDate: (v.incDate as dayjs.Dayjs).format(DATE), inUseMonth: (v.inUseMonth as dayjs.Dayjs).format('YYYY-MM'), cost, depRate: rate }); }}>
          <Form.Item name="assetType" label="Loại tài sản" rules={[{ required: true }]}><Input style={{ width: 140 }} placeholder="Máy móc thiết bị" /></Form.Item>
          <Form.Item name="name" label="Tên, đặc điểm, ký hiệu TSCĐ" rules={[{ required: true }]}><Input style={{ width: 220 }} /></Form.Item>
          <Form.Item name="incDocNo" label="Số CT ghi tăng"><Input style={{ width: 100 }} /></Form.Item>
          <Form.Item name="incDate" label="Ngày ghi tăng" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="inUseMonth" label="Tháng đưa vào sử dụng" rules={[{ required: true }]}><DatePicker picker="month" format="MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="cost" label="Nguyên giá" rules={[{ required: true }]}><Input style={{ width: 140 }} inputMode="numeric" /></Form.Item>
          <Form.Item name="depRate" label="Tỷ lệ khấu hao năm (%)" rules={[{ required: true }]}><Input style={{ width: 90 }} inputMode="decimal" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending}>Ghi tăng TSCĐ</Button>
        </Form>
      )}
      <Table<Asset> size="small" bordered rowKey="id" loading={assets.isLoading} dataSource={assets.data ?? []} pagination={{ pageSize: 50 }}
        columns={[{ title: 'Loại', dataIndex: 'assetType', width: 140 }, { title: 'Tên TSCĐ', dataIndex: 'name' }, { title: 'Ghi tăng', width: 150, render: (_v, r) => `${formatVnDate(r.incDate)}${r.incDocNo ? ` (${r.incDocNo})` : ''}` },
          { title: 'Đưa vào sử dụng', dataIndex: 'inUseMonth', width: 130, render: (m: string) => `${m.slice(5)}/${m.slice(0, 4)}` }, { title: 'Nguyên giá', dataIndex: 'cost', align: 'right', width: 130, render: (v: string) => money(v) },
          { title: 'Tỷ lệ %/năm', dataIndex: 'depRate', align: 'right', width: 100, render: (v: string) => money(v, 4) },
          { title: 'Ghi giảm', width: 200, render: (_v, r) => (r.decDate ? <span>{formatVnDate(r.decDate)}: {r.decReason}</span> : can('sohkd.update') && <Button size="small" type="link" onClick={() => { fd.resetFields(); fd.setFieldsValue({ decDate: dayjs() }); setDecOf(r); }}>Ghi giảm</Button>) },
          { title: '', width: 70, render: (_v, r) => delBtn(can('sohkd.delete'), () => del.mutate(r.id)) }]} />
      <FormModal title={`Ghi giảm TSCĐ: ${decOf?.name ?? ''}`} open={!!decOf} onCancel={() => setDecOf(null)} okText="Ghi giảm" cancelText="Hủy" confirmLoading={dec.isPending} onOk={() => fd.submit()} forceRender>
        <Form form={fd} name="hkdAssetDec" layout="vertical" onFinish={(v) => decOf && dec.mutate({ a: decOf, body: assetBody(decOf, { decDocNo: v.decDocNo || null, decDate: (v.decDate as dayjs.Dayjs).format(DATE), decReason: v.decReason }) })}>
          <Form.Item name="decDocNo" label="Số chứng từ ghi giảm"><Input /></Form.Item>
          <Form.Item name="decDate" label="Ngày ghi giảm" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="decReason" label="Lý do giảm TSCĐ" rules={[{ required: true, message: 'Cần lý do (nhượng bán, thanh lý...)' }]}><Input /></Form.Item>
        </Form>
      </FormModal>
    </Space>
  );
}

// ---- S4d: vốn chủ sở hữu ----
interface Equity { id: number; entryDate: string; docNo: string | null; description: string; section: string; kind: string; amount: string }
const SECTION: Record<string, string> = { capital: 'Vốn góp của chủ sở hữu', retained: 'Lợi nhuận sau thuế chưa phân phối', funds: 'Các quỹ thuộc vốn chủ sở hữu' };

export function EquityTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const rows = useQuery({ queryKey: ['hkd-equity'], queryFn: () => api<Equity[]>('/api/hkd/equity') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hkd-equity'] });
  const add = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/equity', { method: 'POST', json: v }), onSuccess: () => { refresh(); void message.success('Đã ghi vốn chủ sở hữu'); form.setFieldsValue({ description: undefined, amount: undefined, docNo: undefined }); }, onError: err });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/hkd/equity/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: err });
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Sổ theo dõi vốn chủ sở hữu (S4d-DNSN): vốn góp, lợi nhuận sau thuế chưa phân phối, các quỹ. Số dư đầu và tăng, giảm trong kỳ. Lỗ lũy kế đầu kỳ nhập số âm ở số dư đầu của lợi nhuận chưa phân phối. Lợi nhuận sau thuế của năm không tự kết chuyển: ghi tăng vào đây thì mới vào mã 420 của B01-DNSN." />
      {can('sohkd.create') && (
        <Form form={form} name="hkdEquity" layout="inline" style={{ rowGap: 8 }} initialValues={{ entryDate: dayjs(), section: 'capital', kind: 'increase' }}
          onFinish={(v) => { const amount = vndInput(String(v.amount ?? ''), v.kind === 'opening' && v.section === 'retained'); if (!amount) { void message.error('Số tiền VND phải là số nguyên tối đa 16 chữ số'); return; }
            add.mutate({ entryDate: (v.entryDate as dayjs.Dayjs).format(DATE), docNo: v.docNo || null, description: v.description, section: v.section, kind: v.kind, amount }); }}>
          <Form.Item name="entryDate" label="Ngày" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="docNo" label="Số chứng từ"><Input style={{ width: 100 }} /></Form.Item>
          <Form.Item name="section" label="Phần" rules={[{ required: true }]}><Select style={{ width: 250 }} options={Object.entries(SECTION).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="kind" label="Loại bút" rules={[{ required: true }]}><Select style={{ width: 120 }} options={Object.entries(MOVE).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="description" label="Diễn giải" rules={[{ required: true, message: 'Cần diễn giải' }]}><Input style={{ width: 220 }} /></Form.Item>
          <Form.Item name="amount" label="Số tiền" rules={[{ required: true }]}><Input style={{ width: 140 }} inputMode="numeric" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending}>Ghi vốn chủ sở hữu</Button>
        </Form>
      )}
      <Table<Equity> size="small" bordered rowKey="id" loading={rows.isLoading} dataSource={rows.data ?? []} pagination={{ pageSize: 50 }}
        columns={[{ title: 'Ngày', dataIndex: 'entryDate', width: 100, render: formatVnDate }, { title: 'Số CT', dataIndex: 'docNo', width: 90 }, { title: 'Phần', dataIndex: 'section', width: 260, render: (s: string) => SECTION[s] },
          { title: 'Loại bút', dataIndex: 'kind', width: 110, render: (k: string) => MOVE[k] }, { title: 'Diễn giải', dataIndex: 'description' }, { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 140, render: (v: string) => money(v) },
          { title: '', width: 70, render: (_v, r) => delBtn(can('sohkd.delete'), () => del.mutate(r.id)) }]} />
    </Space>
  );
}

// ---- Tài sản khác (mã 150) ----
interface OtherAsset { id: number; entryDate: string; docNo: string | null; description: string; kind: string; amount: string }

export function OtherAssetTab() {
  const { can } = useAuth(); const qc = useQueryClient(); const [form] = Form.useForm();
  const rows = useQuery({ queryKey: ['hkd-other-assets'], queryFn: () => api<OtherAsset[]>('/api/hkd/other-assets') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hkd-other-assets'] });
  const add = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/hkd/other-assets', { method: 'POST', json: v }), onSuccess: () => { refresh(); void message.success('Đã ghi tài sản khác'); form.setFieldsValue({ description: undefined, amount: undefined, docNo: undefined }); }, onError: err });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/hkd/other-assets/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: err });
  const balance = (rows.data ?? []).reduce((a, r) => (r.kind === 'decrease' ? a - Number(r.amount) : a + Number(r.amount)), 0);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="Tài sản khác (mã 150 của B01-DNSN): tiền gửi có kỳ hạn, tiền gửi tiết kiệm... ngoài tiền, nợ phải thu, hàng tồn kho, TSCĐ. Thuế TNDN đã nộp lớn hơn phải nộp được cộng vào mã 150 tự động, không cần ghi ở đây." />
      {can('sohkd.create') && (
        <Form form={form} name="hkdOtherAsset" layout="inline" style={{ rowGap: 8 }} initialValues={{ entryDate: dayjs(), kind: 'increase' }}
          onFinish={(v) => { const amount = vndInput(String(v.amount ?? '')); if (!amount) { void message.error('Số tiền VND phải là số nguyên tối đa 16 chữ số'); return; }
            add.mutate({ entryDate: (v.entryDate as dayjs.Dayjs).format(DATE), docNo: v.docNo || null, description: v.description, kind: v.kind, amount }); }}>
          <Form.Item name="entryDate" label="Ngày" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" allowClear={false} /></Form.Item>
          <Form.Item name="docNo" label="Số chứng từ"><Input style={{ width: 100 }} /></Form.Item>
          <Form.Item name="kind" label="Loại bút" rules={[{ required: true }]}><Select style={{ width: 120 }} options={Object.entries(MOVE).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="description" label="Diễn giải" rules={[{ required: true, message: 'Cần diễn giải' }]}><Input style={{ width: 240 }} /></Form.Item>
          <Form.Item name="amount" label="Số tiền" rules={[{ required: true }]}><Input style={{ width: 140 }} inputMode="numeric" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending}>Ghi tài sản khác</Button>
        </Form>
      )}
      <Table<OtherAsset> size="small" bordered rowKey="id" loading={rows.isLoading} dataSource={rows.data ?? []} pagination={{ pageSize: 50 }}
        summary={() => <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={4}><b>Số dư hiện tại (mọi ngày)</b></Table.Summary.Cell><Table.Summary.Cell index={1} align="right"><b>{money(String(balance))}</b></Table.Summary.Cell><Table.Summary.Cell index={2} /></Table.Summary.Row>}
        columns={[{ title: 'Ngày', dataIndex: 'entryDate', width: 100, render: formatVnDate }, { title: 'Số CT', dataIndex: 'docNo', width: 90 }, { title: 'Loại bút', dataIndex: 'kind', width: 110, render: (k: string) => MOVE[k] }, { title: 'Diễn giải', dataIndex: 'description' },
          { title: 'Số tiền', dataIndex: 'amount', align: 'right', width: 140, render: (v: string) => money(v) }, { title: '', width: 70, render: (_v, r) => delBtn(can('sohkd.delete'), () => del.mutate(r.id)) }]} />
    </Space>
  );
}
