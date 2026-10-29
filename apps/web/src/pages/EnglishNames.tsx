import { useEffect, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COLOR, PageHeader, Section, Toolbar } from '@kt/ui';
import { TRANSLATION_STATUS_LABELS, type TranslationStatus } from '@kt/domain';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

// Tên tiếng Anh của tài khoản và chỉ tiêu báo cáo cho bản in song ngữ. Bản dịch tham khảo, không phải dữ liệu pháp lý: 'Bản nháp' (chưa ai soát) hoặc 'Đã soát'.
interface Row { key: string; code: string; vi: string; en: string | null; status: TranslationStatus | null }
const REGIMES = ['TT133', 'TT99', 'TT200', 'TT58'];
const REPORTS = [{ value: 'B01', label: 'B01 - Báo cáo tình hình tài chính' }, { value: 'B02', label: 'B02 - Kết quả hoạt động kinh doanh' }, { value: 'B03', label: 'B03 - Lưu chuyển tiền tệ' }];
const STATUS_OPTIONS = (Object.keys(TRANSLATION_STATUS_LABELS) as TranslationStatus[]).map((value) => ({ value, label: TRANSLATION_STATUS_LABELS[value] }));

function Editor({ kind, regime, report }: { kind: 'accounts' | 'report-lines'; regime: string; report: string }) {
  const qc = useQueryClient(); const { can } = useAuth();
  const isAcc = kind === 'accounts';
  const canEdit = can(isAcc ? 'account.update' : 'report_def.update');
  const path = isAcc ? `/api/translations/accounts?regime=${regime}` : `/api/translations/report-lines?regime=${regime}&code=${report}`;
  const q = useQuery({ queryKey: ['translations', kind, regime, report], queryFn: () => api<Record<string, string | null>[]>(path), retry: false });
  const [rows, setRows] = useState<Row[]>([]); const [dirty, setDirty] = useState<Set<string>>(new Set());
  useEffect(() => {
    setRows((q.data ?? []).map((r) => isAcc ? { key: r['code']!, code: r['code']!, vi: r['name']!, en: r['nameEn'] ?? null, status: (r['status'] as TranslationStatus | null) ?? null }
      : { key: r['lineCode']!, code: r['lineCode']!, vi: r['label']!, en: r['labelEn'] ?? null, status: (r['status'] as TranslationStatus | null) ?? null })); setDirty(new Set());
  }, [q.data, isAcc]);
  const edit = (key: string, patch: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty((d) => new Set(d).add(key)); };
  const done = () => { void qc.invalidateQueries({ queryKey: ['translations'] }); };
  const save = useMutation({ mutationFn: () => {
    const items = rows.filter((r) => dirty.has(r.key)).map((r) => isAcc ? { code: r.code, nameEn: r.en?.trim() || null, status: r.status ?? 'draft' } : { lineCode: r.code, labelEn: r.en?.trim() || null, status: r.status ?? 'draft' });
    return api<{ count: number }>('/api/translations/' + kind, { method: 'PUT', json: isAcc ? { regime, items } : { regime, reportCode: report, items } });
  }, onSuccess: (r) => { void message.success(`Đã lưu ${r.count} dòng`); done(); }, onError: (e) => { void message.error((e as Error).message); } });
  const fill = useMutation({ mutationFn: () => api<{ count: number }>('/api/translations/fill-from-template', { method: 'POST', json: { regime, scope: kind } }),
    onSuccess: (r) => { void message.info(r.count ? `Đã điền ${r.count} dòng trống từ mẫu (bản nháp)` : 'Không còn dòng trống có trong mẫu hệ thống'); done(); }, onError: (e) => { void message.error((e as Error).message); } });
  const focusNext = (i: number) => { document.querySelector<HTMLInputElement>(`[data-en-row="${i + 1}"]`)?.focus(); };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Toolbar>
        {canEdit && <Popconfirm title="Điền tên tiếng Anh vào các dòng còn trống từ mẫu hệ thống?" okText="Điền" cancelText="Hủy" onConfirm={() => fill.mutate()}><Button loading={fill.isPending}>Điền chỗ trống từ mẫu</Button></Popconfirm>}
        {canEdit && <Button type="primary" disabled={!dirty.size} loading={save.isPending} onClick={() => save.mutate()}>Lưu ({dirty.size})</Button>}
        <span style={{ color: COLOR.textSecondary }}>Dòng để trống thì bản in dùng tiếng Việt.</span>
      </Toolbar>
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      <Section bodyPadding={0}>
        <Table<Row> size="small" bordered pagination={false} rowKey="key" loading={q.isLoading} dataSource={rows} scroll={{ y: 520 }}
          columns={[{ title: isAcc ? 'Số hiệu' : 'Mã số', dataIndex: 'code', width: 100 }, { title: 'Tiếng Việt', dataIndex: 'vi', width: 340 },
            { title: 'Tiếng Anh', render: (_, r, i) => <Input data-en-row={i} aria-label={`Tên tiếng Anh ${r.code}`} value={r.en ?? ''} disabled={!canEdit} onChange={(e) => edit(r.key, { en: e.target.value, status: r.status ?? 'draft' })} onPressEnter={() => focusNext(i)} /> },
            { title: 'Trạng thái', width: 150, render: (_, r) => (r.en ? <Select size="small" style={{ width: 120 }} aria-label={`Trạng thái ${r.code}`} value={r.status ?? 'draft'} disabled={!canEdit} options={STATUS_OPTIONS} onChange={(status) => edit(r.key, { status })} /> : <Tag>Chưa dịch</Tag>) }]} />
      </Section>
    </Space>
  );
}

export default function EnglishNamesPage() {
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; regime: string }[]>('/api/fiscal-years') });
  const [regime, setRegime] = useState<string | undefined>(); const [report, setReport] = useState('B01');
  const r = regime ?? years.data?.at(-1)?.regime ?? 'TT133';
  return (
    <div>
      <PageHeader
        title="Tên tiếng Anh"
        description="Bản dịch tham khảo, không phải bản dịch chính thức. Dùng cho bản in song ngữ Việt – Anh của sổ sách và báo cáo tài chính; sửa tay được, đặt trạng thái Đã soát khi kế toán đã kiểm tra."
      >
        <Toolbar>
          <span>Chế độ kế toán</span>
          <Select style={{ width: 120 }} value={r} onChange={setRegime} aria-label="Chế độ kế toán" options={REGIMES.map((x) => ({ value: x, label: x }))} />
        </Toolbar>
      </PageHeader>
      <Tabs items={[
        { key: 'accounts', label: 'Tài khoản', children: <Editor kind="accounts" regime={r} report={report} /> },
        { key: 'lines', label: 'Chỉ tiêu báo cáo', children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Toolbar>
              <span>Báo cáo</span>
              <Select style={{ width: 320 }} value={report} onChange={setReport} aria-label="Báo cáo" options={REPORTS} />
            </Toolbar>
            <Editor kind="report-lines" regime={r} report={report} />
          </Space>
        ) },
      ]} />
    </div>
  );
}
